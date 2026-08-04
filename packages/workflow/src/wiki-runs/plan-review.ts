/**
 * Operator plan-gate review materials: sealed Spec + ExecutionPlan projection.
 * Full bodies stay off the Run SSE snapshot (ADR 0035); this is an explicit read.
 * Wave 2: coverage rows, scouts summary, priorSpec, pageSetDiff (additive).
 * Wave 3: discoverySummary + soft semanticSufficiency from sealed DiscoveryMap.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertCoverage } from "@okf-wiki/contract/coverage";
import {
  assertSemanticSufficiency,
  type DiscoveryMap,
  type ExecutionPlan,
  ExecutionPlanSchema,
  parseDiscoveryMap,
  type SemanticSufficiencyResult,
  type WikiRunPlanReview,
  type WikiRunPlanReviewDiscoverySummary,
  WikiRunPlanReviewSchema,
  type WikiRunSpec,
  WikiRunSpecSchema,
} from "@okf-wiki/contract/wiki-runs";
import type { WorkspaceConfig } from "@okf-wiki/contract/workspace";
import { runWorkDir } from "@okf-wiki/core";
import {
  loadCoveragePlanFromArtifactRoot,
  pageSetDiffFromSpecs,
  readScoutsSummary,
  toContractCoveragePlan,
} from "./coverage-bridge.js";
import { DISCOVERY_MAP_FILE } from "./discovery-map-merge.js";
import { digest } from "./crypto-util.js";
import { asRow, requiredNumber, requiredText } from "./sql.js";
import { WikiRunsRequestError } from "./types.js";

const MAX_WORK_UNITS_IN_REVIEW = 32;

export type PlanReviewHost = {
  db: DatabaseSync;
  workspace: WorkspaceConfig;
  currentNodeGeneration?(runId: string, nodeKey: string): number | undefined;
};

/** Same binding formula as openPlanGate / onAttemptSucceeded. */
export function planGatePayloadDigest(specDigest: string, planDigest: string): string {
  return digest({ specDigest, planDigest });
}

/** Snapshot-safe detail written when a plan gate opens. */
export function planGateDetailFromSpec(spec: WikiRunSpec): {
  source: "plan";
  summary: string;
  domainCount: number;
  pageCount: number;
  openQuestionCount: number;
} {
  return {
    source: "plan",
    summary: spec.summary.trim().slice(0, 4_000),
    domainCount: spec.domains.length,
    pageCount: spec.pages.length,
    openQuestionCount: spec.openQuestions.length,
  };
}

type PlanArtifactRow = {
  artifactId: string;
  digest: string;
  relativePath: string;
  nodeGeneration?: number;
};

function latestPlanArtifact(
  db: DatabaseSync,
  runId: string,
  role: "spec" | "execution_plan",
): PlanArtifactRow | undefined {
  const row = asRow(
    db
      .prepare(
        `SELECT artifacts.artifact_id, artifacts.digest, artifacts.relative_path,
                node_outputs.node_generation AS node_generation
         FROM node_outputs
         JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
         JOIN (
           SELECT node_key, MAX(generation) AS generation FROM nodes
           WHERE run_id = ? AND node_key = 'plan' GROUP BY node_key
         ) cur ON cur.node_key = node_outputs.node_key
              AND cur.generation = node_outputs.node_generation
         WHERE node_outputs.run_id = ?
           AND node_outputs.node_key = 'plan'
           AND node_outputs.role = ?
         ORDER BY artifacts.sealed_at DESC
         LIMIT 1`,
      )
      .get(runId, runId, role),
  );
  if (!row) return undefined;
  return {
    artifactId: requiredText(row, "artifact_id"),
    digest: requiredText(row, "digest"),
    relativePath: requiredText(row, "relative_path"),
    nodeGeneration:
      row.node_generation !== null && row.node_generation !== undefined
        ? requiredNumber(row, "node_generation")
        : undefined,
  };
}

function loadSpecJson(
  workspace: WorkspaceConfig,
  runId: string,
  relativePath: string,
): WikiRunSpec | undefined {
  const runDir = runWorkDir(workspace.rootPath, runId);
  try {
    const raw = readFileSync(path.join(runDir, relativePath, "spec.json"), "utf8");
    return WikiRunSpecSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function loadExecutionPlanJson(
  workspace: WorkspaceConfig,
  runId: string,
  relativePath: string,
): ExecutionPlan | undefined {
  const runDir = runWorkDir(workspace.rootPath, runId);
  try {
    const raw = readFileSync(path.join(runDir, relativePath, "execution-plan.json"), "utf8");
    return ExecutionPlanSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function projectExecution(plan: ExecutionPlan) {
  return {
    workUnitCount: plan.workUnits.length,
    domainCount: plan.fanOut.domainCount,
    leafCount: plan.fanOut.leafCount,
    maxDomainFanOut: plan.fanOut.maxDomainFanOut,
    maxLeafFanOut: plan.fanOut.maxLeafFanOut,
    reviewLenses: plan.reviewLenses,
    workUnits: plan.workUnits.slice(0, MAX_WORK_UNITS_IN_REVIEW).map((unit) => ({
      id: unit.id,
      ...(unit.domainId ? { domainId: unit.domainId } : {}),
      scope: unit.scope,
      questionCount: unit.questions.length,
    })),
  };
}

/** Prior Spec from an earlier plan generation (revise path). */
function loadPriorSpec(
  host: PlanReviewHost,
  runId: string,
  currentGeneration: number | undefined,
): WikiRunSpec | undefined {
  if (currentGeneration === undefined || currentGeneration < 1) return undefined;
  for (let g = currentGeneration - 1; g >= 0; g -= 1) {
    const row = asRow(
      host.db
        .prepare(
          `SELECT artifacts.relative_path
           FROM node_outputs
           JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
           WHERE node_outputs.run_id = ?
             AND node_outputs.node_key = 'plan'
             AND node_outputs.node_generation = ?
             AND node_outputs.role = 'spec'
           LIMIT 1`,
        )
        .get(runId, g),
    );
    if (!row) continue;
    const spec = loadSpecJson(host.workspace, runId, requiredText(row, "relative_path"));
    if (spec) return spec;
  }
  return undefined;
}

function loadCoverageProjection(
  host: PlanReviewHost,
  runId: string,
  spec: WikiRunSpec,
): {
  coverage?: ReturnType<typeof assertCoverage>;
  coverageStopReason?: ReturnType<typeof assertCoverage>["stop_reason"];
} {
  const runDir = runWorkDir(host.workspace.rootPath, runId);
  // Prefer sealed freeze coverage_plan artifact.
  const sealed = asRow(
    host.db
      .prepare(
        `SELECT artifacts.relative_path
         FROM node_outputs
         JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
         JOIN (
           SELECT node_key, MAX(generation) AS generation FROM nodes
           WHERE run_id = ? AND node_key = 'freeze' GROUP BY node_key
         ) cur ON cur.node_key = node_outputs.node_key
              AND cur.generation = node_outputs.node_generation
         WHERE node_outputs.run_id = ?
           AND node_outputs.node_key = 'freeze'
           AND node_outputs.role = 'coverage_plan'
         LIMIT 1`,
      )
      .get(runId, runId),
  );
  const roots = [
    ...(sealed ? [path.join(runDir, requiredText(sealed, "relative_path"))] : []),
    path.join(runDir, "analysis"),
  ];
  for (const root of roots) {
    const corePlan = loadCoveragePlanFromArtifactRoot(root);
    if (!corePlan) continue;
    const contractPlan = toContractCoveragePlan(corePlan);
    if (contractPlan.requiredUnits.length === 0) {
      return {
        coverage: assertCoverage(spec, contractPlan, { throwOnGap: false }),
        coverageStopReason: "not_required",
      };
    }
    const result = assertCoverage(spec, contractPlan, { throwOnGap: false });
    return { coverage: result, coverageStopReason: result.stop_reason };
  }
  return {};
}

/** Build compact discovery counts from a sealed DiscoveryMap (payload-size friendly). */
export function discoverySummaryFromMap(map: DiscoveryMap): WikiRunPlanReviewDiscoverySummary {
  const crossSourceFlowCount = map.flows.filter((f) => f.crossSource).length;
  return {
    domainCount: map.domains.length,
    flowCount: map.flows.length,
    conceptCount: map.concepts.length,
    sourceCount: map.sources.length,
    crossSourceFlowCount,
    openQuestionCount: map.openQuestions.length,
    ...(map.scoutKinds.length > 0 ? { scoutKinds: [...map.scoutKinds] } : {}),
  };
}

function tryParseDiscoveryMapFile(filePath: string): DiscoveryMap | undefined {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return parseDiscoveryMap(raw);
  } catch {
    return undefined;
  }
}

/**
 * Load sealed DiscoveryMap for plan-review projection.
 * Prefer node_outputs role=discovery_map (plan.discover.reduce), then
 * analysis/discovery-map.json and inputs/discovery-map.json fallbacks.
 */
export function loadDiscoveryMapForPlanReview(
  host: PlanReviewHost,
  runId: string,
): DiscoveryMap | undefined {
  const runDir = runWorkDir(host.workspace.rootPath, runId);

  const sealed = asRow(
    host.db
      .prepare(
        `SELECT artifacts.relative_path
         FROM node_outputs
         JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
         WHERE node_outputs.run_id = ?
           AND node_outputs.role = 'discovery_map'
         ORDER BY artifacts.sealed_at DESC
         LIMIT 1`,
      )
      .get(runId),
  );

  const candidatePaths: string[] = [];
  if (sealed) {
    const rel = requiredText(sealed, "relative_path");
    const root = path.join(runDir, rel);
    // Artifact may be the file itself or a directory containing discovery-map.json.
    candidatePaths.push(
      root,
      path.join(root, DISCOVERY_MAP_FILE),
      path.join(root, "discovery_map.json"),
    );
  }
  candidatePaths.push(
    path.join(runDir, "analysis", DISCOVERY_MAP_FILE),
    path.join(runDir, "inputs", DISCOVERY_MAP_FILE),
  );

  for (const candidate of candidatePaths) {
    const map = tryParseDiscoveryMapFile(candidate);
    if (map) return map;
  }
  return undefined;
}

function loadDiscoveryProjection(
  host: PlanReviewHost,
  runId: string,
  spec: WikiRunSpec,
): {
  discoverySummary?: WikiRunPlanReviewDiscoverySummary;
  semanticSufficiency?: SemanticSufficiencyResult;
} {
  const map = loadDiscoveryMapForPlanReview(host, runId);
  if (!map) return {};
  const discoverySummary = discoverySummaryFromMap(map);
  const semanticSufficiency = assertSemanticSufficiency(
    map,
    {
      sourceCoverage: spec.sourceCoverage,
      repositoryMap: spec.repositoryMap,
      openQuestions: spec.openQuestions,
    },
    { sourceCount: map.sources.length },
    { throwOnGap: false },
  );
  return { discoverySummary, semanticSufficiency };
}

/**
 * Load sealed plan materials for operator document review.
 * When an open plan gate exists, payloadDigest must match that gate.
 */
export function readPlanReviewMaterials(
  host: PlanReviewHost,
  runId: string,
): WikiRunPlanReview {
  const run = asRow(host.db.prepare("SELECT run_id FROM runs WHERE run_id = ?").get(runId));
  if (!run) throw new WikiRunsRequestError("not_found", `run not found: ${runId}`);

  const specRow = latestPlanArtifact(host.db, runId, "spec");
  const planRow = latestPlanArtifact(host.db, runId, "execution_plan");
  if (!specRow || !planRow) {
    throw new WikiRunsRequestError("not_found", `spec not found: ${runId}`);
  }

  const spec = loadSpecJson(host.workspace, runId, specRow.relativePath);
  const executionPlan = loadExecutionPlanJson(host.workspace, runId, planRow.relativePath);
  if (!spec || !executionPlan) {
    throw new WikiRunsRequestError("not_found", `spec not found: ${runId}`);
  }

  const payloadDigest = planGatePayloadDigest(specRow.digest, planRow.digest);

  const openGate = asRow(
    host.db
      .prepare(
        `SELECT payload_digest FROM gates
         WHERE run_id = ? AND kind = 'plan' AND state = 'open'
         ORDER BY opened_at DESC LIMIT 1`,
      )
      .get(runId),
  );
  if (openGate) {
    const gateDigest = requiredText(openGate, "payload_digest");
    if (gateDigest !== payloadDigest) {
      throw new WikiRunsRequestError(
        "conflict",
        `plan review materials do not match open plan gate payload (${gateDigest.slice(0, 12)}…)`,
      );
    }
  }

  const priorSpec = loadPriorSpec(host, runId, specRow.nodeGeneration);
  const pageSetDiff = pageSetDiffFromSpecs(priorSpec, spec);
  const { coverage, coverageStopReason } = loadCoverageProjection(host, runId, spec);
  const { discoverySummary, semanticSufficiency } = loadDiscoveryProjection(host, runId, spec);
  const runDir = runWorkDir(host.workspace.rootPath, runId);
  const scouts = readScoutsSummary(path.join(runDir, "analysis"));

  return WikiRunPlanReviewSchema.parse({
    runId,
    payloadDigest,
    specDigest: specRow.digest,
    planDigest: planRow.digest,
    spec,
    execution: projectExecution(executionPlan),
    artifact: {
      specArtifactId: specRow.artifactId,
      planArtifactId: planRow.artifactId,
    },
    ...(coverage ? { coverage, coverageStopReason } : {}),
    ...(scouts
      ? {
          scoutsSummary: {
            kinds: scouts.kinds,
            receiptCount: scouts.receiptCount,
            scouts: scouts.scouts,
          },
        }
      : {}),
    ...(priorSpec ? { priorSpec } : {}),
    ...(pageSetDiff ? { pageSetDiff } : {}),
    ...(discoverySummary ? { discoverySummary } : {}),
    ...(semanticSufficiency ? { semanticSufficiency } : {}),
  });
}
