/**
 * Operator plan-gate review materials: sealed Spec + ExecutionPlan projection.
 * Full bodies stay off the Run SSE snapshot (ADR 0035); this is an explicit read.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type ExecutionPlan,
  ExecutionPlanSchema,
  type WikiRunPlanReview,
  WikiRunPlanReviewSchema,
  type WikiRunSpec,
  WikiRunSpecSchema,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { runWorkDir } from "@okf-wiki/core";
import { digest } from "./crypto-util.js";
import { asRow, requiredText } from "./sql.js";
import { WikiRunsRequestError } from "./types.js";

const MAX_WORK_UNITS_IN_REVIEW = 32;

export type PlanReviewHost = {
  db: DatabaseSync;
  workspace: WorkspaceConfig;
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
};

function latestPlanArtifact(
  db: DatabaseSync,
  runId: string,
  role: "spec" | "execution_plan",
): PlanArtifactRow | undefined {
  const row = asRow(
    db
      .prepare(
        `SELECT artifacts.artifact_id, artifacts.digest, artifacts.relative_path
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
  });
}


