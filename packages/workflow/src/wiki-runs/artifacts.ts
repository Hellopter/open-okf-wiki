/**
 * Artifact prepare / seal / commit (bytes + CAS) and attempt input binding.
 * Control-flow after success (gates, unlock, plan accept) lives in attempt-success.ts.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  type AttemptMetrics,
  contractForNode,
  inputRoleMatches,
  type MergedDefectReport,
  MergedDefectReportSchema,
  type PiAttemptArtifactDescriptor,
  RepairRequestSchema,
  validateBoundInputs,
  validateNodeOutputs,
} from "@okf-wiki/contract";
import { EMPTY_PUBLICATION_DIGEST, runWorkDir } from "@okf-wiki/core";
import {
  graphRoleForNodeKind,
  mergeAttemptMetrics,
  wallTimeMsFromStarted,
  writeAttemptMetrics,
} from "./attempt-metrics.js";
import { artifactId, digest, now } from "./crypto-util.js";
import type { WikiRunsCasCtx } from "./ctx.js";
import { upstreamKeys } from "./dag.js";
import {
  producedByForNode,
  registerWikiCandidate,
  wikiCandidateById,
} from "./evaluation/candidate.js";
import { durableFsyncPath, manifestFor } from "./fs-util.js";
import { isRepairNodeKey, REPAIR_NODE_PREFIX } from "./repair-schedule.js";
import { asRow, asRows, requiredNumber, requiredText } from "./sql.js";
import type { ArtifactPreparation, ClaimedNode } from "./types.js";

/** Bytes/CAS surface — no gate open or unlock callbacks. */
export type ArtifactsHost = WikiRunsCasCtx;

type CandidateEvidenceMap = {
  version: 1;
  candidateDigest: string;
  pages: Array<{
    pagePath: string;
    contentDigest: string;
    evidence: Array<{ line: number; source: string }>;
  }>;
};

function contentDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function evidenceForPage(content: string): Array<{ line: number; source: string }> {
  const evidence: Array<{ line: number; source: string }> = [];
  for (const [index, line] of content.replace(/\r\n/g, "\n").split("\n").entries()) {
    for (const source of line.matchAll(/(?:repo:[^\s)\]]+|https?:\/\/[^\s)\]]+)/g)) {
      evidence.push({ line: index + 1, source: source[0] });
    }
  }
  return evidence;
}

function evidenceMapForCandidate(root: string, candidateDigest: string): CandidateEvidenceMap {
  const pages: CandidateEvidenceMap["pages"] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile() && relativePath.endsWith(".md")) {
        const content = readFileSync(path.join(directory, entry.name), "utf8");
        pages.push({
          pagePath: relativePath,
          contentDigest: contentDigest(content),
          evidence: evidenceForPage(content),
        });
        if (pages.length > 2_000) throw new Error("candidate tree exceeds page limit");
      }
    }
  };
  visit(root, "");
  return {
    version: 1,
    candidateDigest,
    pages: pages.sort((left, right) => left.pagePath.localeCompare(right.pagePath)),
  };
}

export function copyAttemptInputs(
  host: Pick<ArtifactsHost, "db">,
  attemptId: string,
  inputs: Array<{ role: string; artifactId: string }>,
): void {
  for (const input of inputs) {
    host.db
      .prepare(
        `INSERT INTO attempt_inputs (attempt_id, role, artifact_id) VALUES (?, ?, ?)
         ON CONFLICT(attempt_id, role) DO NOTHING`,
      )
      .run(attemptId, input.role, input.artifactId);
  }
}

/**
 * In the claim transaction, freeze current-generation upstream outputs into
 * immutable attempt_inputs. Also bind ambient freeze sources/skill and plan
 * spec for post-plan nodes so each Attempt has a complete sealed envelope.
 *
 * Phase 2: after binding, validate against NodeContract (fail closed on missing
 * required roles — not silent empty).
 */
export function bindAttemptInputs(
  host: Pick<ArtifactsHost, "db" | "currentNodeGeneration">,
  attemptId: string,
  runId: string,
  nodeKey: string,
): void {
  const kindRow = asRow(
    host.db
      .prepare(
        `SELECT kind FROM nodes
         WHERE run_id = ? AND node_key = ?
         ORDER BY generation DESC LIMIT 1`,
      )
      .get(runId, nodeKey),
  );
  const kind = kindRow ? requiredText(kindRow, "kind") : nodeKey;
  const contract = contractForNode(kind, nodeKey);
  for (const input of upstreamSealedOutputs(host, runId, nodeKey)) {
    if (!contract.requiredInputs.some((requirement) => inputRoleMatches(requirement, input.role))) {
      continue;
    }
    host.db
      .prepare(
        `INSERT INTO attempt_inputs (attempt_id, role, artifact_id) VALUES (?, ?, ?)
         ON CONFLICT(attempt_id, role) DO NOTHING`,
      )
      .run(attemptId, input.role, input.artifactId);
  }
  const boundRoles = asRows(
    host.db
      .prepare(`SELECT role FROM attempt_inputs WHERE attempt_id = ? ORDER BY role`)
      .all(attemptId),
  ).map((row) => requiredText(row, "role"));
  validateBoundInputs(contract, boundRoles);
}

/** Succeeded node outputs at a fixed generation (not necessarily current max). */
export function nodeOutputsAtGeneration(
  host: Pick<ArtifactsHost, "db">,
  runId: string,
  nodeKey: string,
  generation: number,
): Array<{ role: string; artifactId: string }> {
  const node = asRow(
    host.db
      .prepare("SELECT state FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
      .get(runId, nodeKey, generation),
  );
  if (!node || requiredText(node, "state") !== "succeeded") return [];
  return asRows(
    host.db
      .prepare(
        `SELECT role, artifact_id FROM node_outputs
         WHERE run_id = ? AND node_key = ? AND node_generation = ?
         ORDER BY role`,
      )
      .all(runId, nodeKey, generation),
  ).map((row) => ({
    role: requiredText(row, "role"),
    artifactId: requiredText(row, "artifact_id"),
  }));
}

export function nodeOutputsAtCurrentGen(
  host: Pick<ArtifactsHost, "db" | "currentNodeGeneration">,
  runId: string,
  nodeKey: string,
): Array<{ role: string; artifactId: string }> {
  const generation = host.currentNodeGeneration(runId, nodeKey);
  if (generation === undefined) return [];
  return nodeOutputsAtGeneration(host, runId, nodeKey, generation);
}

/**
 * Outputs from the latest *succeeded* generation of a node (not merely max gen).
 * Used after re-arm when current gen is invalidated without outputs yet.
 */
export function latestSucceededOutputs(
  host: Pick<ArtifactsHost, "db">,
  runId: string,
  nodeKey: string,
): Array<{ role: string; artifactId: string }> {
  const row = asRow(
    host.db
      .prepare(
        `SELECT MAX(generation) AS generation FROM nodes
         WHERE run_id = ? AND node_key = ? AND state = 'succeeded'`,
      )
      .get(runId, nodeKey),
  );
  if (!row || row.generation === null || row.generation === undefined) return [];
  return nodeOutputsAtGeneration(host, runId, nodeKey, requiredNumber(row, "generation"));
}

/**
 * Whether write.root's current generation carries repair feedback (operator or
 * auto hard-validate) so we should bind a prior wiki_tree for repair mode.
 */
function writeRootNeedsPriorWiki(
  host: Pick<ArtifactsHost, "db" | "currentNodeGeneration">,
  runId: string,
  generation: number,
): boolean {
  if (generation > 0) return true;
  const row = asRow(
    host.db
      .prepare("SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
      .get(runId, "write.root", generation),
  );
  if (!row || row.detail_json == null || row.detail_json === "") return false;
  try {
    const parsed = JSON.parse(String(row.detail_json)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const feedback = (parsed as Record<string, unknown>).feedback;
    return typeof feedback === "string" && feedback.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Latest succeeded prior write.root / repair wiki_tree for repair reruns.
 * Walks write.root generations below `generation`, then repair current gen.
 */
function priorWriteWikiTree(
  host: Pick<ArtifactsHost, "db" | "currentNodeGeneration">,
  runId: string,
  generation: number,
): { role: string; artifactId: string } | undefined {
  for (let g = generation - 1; g >= 0; g -= 1) {
    for (const output of nodeOutputsAtGeneration(host, runId, "write.root", g)) {
      if (output.role === "wiki_tree") return output;
    }
  }
  for (const output of nodeOutputsAtCurrentGen(host, runId, "repair")) {
    if (output.role === "wiki_tree") return output;
  }
  return undefined;
}

/** Parse N from `repair.N`; undefined when the key is not a product repair stage. */
export function parseRepairRound(nodeKey: string): number | undefined {
  if (!isRepairNodeKey(nodeKey)) return undefined;
  const suffix = nodeKey.slice(REPAIR_NODE_PREFIX.length);
  if (!/^\d+$/.test(suffix)) return undefined;
  const n = Number.parseInt(suffix, 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

function wikiTreeFromLatestSucceeded(
  host: Pick<ArtifactsHost, "db">,
  runId: string,
  nodeKey: string,
): { role: string; artifactId: string } | undefined {
  for (const output of latestSucceededOutputs(host, runId, nodeKey)) {
    if (output.role === "wiki_tree") return output;
  }
  return undefined;
}

/**
 * Product `repair.N` node keys for a run, highest round first (numeric N).
 * When `beforeRound` is set, only include rounds strictly less than that value.
 */
function repairKeysDesc(
  host: Pick<ArtifactsHost, "db">,
  runId: string,
  beforeRound?: number,
): string[] {
  const keys = asRows(
    host.db
      .prepare(
        `SELECT DISTINCT node_key FROM nodes
         WHERE run_id = ? AND node_key LIKE 'repair.%'`,
      )
      .all(runId),
  ).map((row) => requiredText(row, "node_key"));
  return keys
    .map((key) => ({ key, n: parseRepairRound(key) }))
    .filter((item): item is { key: string; n: number } => {
      if (item.n === undefined) return false;
      if (beforeRound !== undefined && item.n >= beforeRound) return false;
      return true;
    })
    .sort((a, b) => b.n - a.n)
    .map((item) => item.key);
}

/**
 * Load the current repair generation's durable request. The request is the
 * run-local provenance declaration for its exact wiki_tree baseline.
 */
function repairRequestForNode(
  host: Pick<ArtifactsHost, "db" | "currentNodeGeneration">,
  runId: string,
  nodeKey: string,
) {
  const generation = host.currentNodeGeneration(runId, nodeKey);
  if (generation === undefined) {
    throw new Error(`repair ${nodeKey} has no current generation`);
  }
  const row = asRow(
    host.db
      .prepare(
        `SELECT detail_json FROM nodes
         WHERE run_id = ? AND node_key = ? AND generation = ?`,
      )
      .get(runId, nodeKey, generation),
  );
  if (!row?.detail_json) {
    throw new Error(`repair ${nodeKey} is missing its persisted repair request`);
  }
  try {
    const parsed = JSON.parse(String(row.detail_json)) as { repairRequest?: unknown };
    return RepairRequestSchema.parse(parsed.repairRequest);
  } catch (error) {
    throw new Error(
      `repair ${nodeKey} has an invalid persisted repair request: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Exact sealed wiki_tree baseline for a repair stage `repair.N`.
 *
 * The RepairRequest's baselineCandidateId is the sole source of truth. The
 * candidate table and artifacts table make that relationship both durable and
 * inspectable before it is frozen again in attempt_inputs at claim time.
 */
export function baselineWikiForRepair(
  host: Pick<ArtifactsHost, "db" | "currentNodeGeneration">,
  runId: string,
  nodeKey: string,
): { role: string; artifactId: string } | undefined {
  if (!isRepairNodeKey(nodeKey)) return undefined;
  const request = repairRequestForNode(host, runId, nodeKey);
  const candidateId = request.baselineCandidateId.trim();
  if (!candidateId || candidateId === "pending") {
    throw new Error(`repair ${nodeKey} has no resolved baseline candidate`);
  }
  const candidate = wikiCandidateById(host, runId, candidateId);
  if (!candidate) {
    throw new Error(`repair ${nodeKey} references unavailable baseline candidate ${candidateId}`);
  }
  const artifact = asRow(
    host.db
      .prepare(
        `SELECT artifact_id FROM artifacts
         WHERE run_id = ? AND artifact_id = ? AND kind = 'wiki_tree'`,
      )
      .get(runId, candidate.artifactId),
  );
  if (!artifact) {
    throw new Error(
      `repair ${nodeKey} baseline candidate ${candidateId} does not reference a sealed wiki_tree`,
    );
  }
  return { role: "wiki_tree", artifactId: candidate.artifactId };
}

export function upstreamSealedOutputs(
  host: Pick<ArtifactsHost, "db" | "currentNodeGeneration">,
  runId: string,
  nodeKey: string,
): Array<{ role: string; artifactId: string }> {
  if (nodeKey === "freeze") return [];

  const byRole = new Map<string, string>();
  const add = (role: string, artifactId: string) => {
    if (!byRole.has(role)) byRole.set(role, artifactId);
  };

  // Ambient freeze + plan pins for every post-freeze node (well-known roles only).
  for (const output of nodeOutputsAtCurrentGen(host, runId, "freeze")) {
    if (
      output.role === "sources" ||
      output.role === "skill" ||
      output.role === "frozen_run_manifest" ||
      output.role === "prior_wiki"
    ) {
      add(output.role, output.artifactId);
    }
  }
  if (nodeKey !== "plan") {
    for (const output of nodeOutputsAtCurrentGen(host, runId, "plan")) {
      if (output.role === "spec") add(output.role, output.artifactId);
      if (output.role === "execution_plan") add(output.role, output.artifactId);
    }
  }

  const edgeUps = upstreamKeys(host, runId, nodeKey);
  const effectiveUps = edgeUps.length > 0 ? edgeUps : nodeKey === "plan" ? ["freeze"] : [];

  const wellKnown = new Set([
    "sources",
    "skill",
    "spec",
    "execution_plan",
    "frozen_run_manifest",
    "prior_wiki",
    "wiki_tree",
    "defects",
    "publication_candidate",
    "operator_input",
  ]);
  for (const fromKey of effectiveUps) {
    for (const output of nodeOutputsAtCurrentGen(host, runId, fromKey)) {
      // Prefer well-known roles; namespace the rest. Skip freeze attempt_output noise.
      if (output.role === "attempt_output") continue;
      if (wellKnown.has(output.role)) {
        add(output.role, output.artifactId);
      } else {
        add(`${fromKey}:${output.role}`, output.artifactId);
      }
    }
  }

  // Repair input is selected only by its persisted baseline candidate. Do not
  // let the generic carry-forward scan replace that durable provenance with a
  // newer, unrelated tree.
  if (isRepairNodeKey(nodeKey)) {
    const baseline = baselineWikiForRepair(host, runId, nodeKey);
    if (baseline) byRole.set("wiki_tree", baseline.artifactId);
  }

  // Carry forward the latest wiki_tree for validate/review/prepare/publish when
  // edges only reference intermediate nodes that re-emit it.
  // Prefer refined trees (repair.N / validate) over write.root so model repair
  // progress is not lost when seats do not re-emit wiki_tree.
  if (!byRole.has("wiki_tree")) {
    const repairKeys = repairKeysDesc(host, runId);
    for (const key of [
      ...repairKeys,
      "repair",
      "validate.final",
      "validate.pre",
      "review.reduce",
      "write.root",
    ]) {
      // Prefer latest *succeeded* gen (re-arm may leave current gen without outputs).
      const outputs = isRepairNodeKey(key)
        ? latestSucceededOutputs(host, runId, key)
        : nodeOutputsAtCurrentGen(host, runId, key);
      for (const output of outputs) {
        if (output.role === "wiki_tree") add("wiki_tree", output.artifactId);
      }
      if (byRole.has("wiki_tree")) break;
    }
  }

  // validate.* after multi-round repair: prefer highest-N succeeded repair.N wiki
  // (still beats write.root; leaves pure write.root path when no repair exists).
  if (nodeKey.startsWith("validate.")) {
    for (const key of repairKeysDesc(host, runId)) {
      const found = wikiTreeFromLatestSucceeded(host, runId, key);
      if (found) {
        byRole.set("wiki_tree", found.artifactId);
        break;
      }
    }
  }

  // review.seat.* re-review: bind prior defects for differential priorBlocking prompts.
  if (nodeKey.startsWith("review.seat.") && !byRole.has("defects")) {
    for (const output of latestSucceededOutputs(host, runId, "review.reduce")) {
      if (output.role === "defects") {
        add("defects", output.artifactId);
        break;
      }
    }
  }

  // write.root repair reruns (gen>0 or detail.feedback): bind prior succeeded
  // wiki_tree so the writer can read existing staging (operator Rerun / legacy HV).
  if (nodeKey === "write.root" && !byRole.has("wiki_tree")) {
    const generation = host.currentNodeGeneration(runId, nodeKey);
    if (generation !== undefined && writeRootNeedsPriorWiki(host, runId, generation)) {
      const prior = priorWriteWikiTree(host, runId, generation);
      if (prior) add("wiki_tree", prior.artifactId);
    }
  }

  // Carry publication_candidate across gate.publication → publish (edge skips prepare).
  if (
    (nodeKey === "publish" || nodeKey === "gate.publication") &&
    !byRole.has("publication_candidate")
  ) {
    for (const output of nodeOutputsAtCurrentGen(host, runId, "prepare.publication")) {
      if (output.role === "publication_candidate") {
        add("publication_candidate", output.artifactId);
      }
    }
  }

  // A failed validate node has no succeeded generation to traverse. Repair.N
  // therefore binds its explicit sealed report reference from RepairRequest.
  if (isRepairNodeKey(nodeKey)) {
    const generation = host.currentNodeGeneration(runId, nodeKey);
    const detail =
      generation === undefined
        ? undefined
        : asRow(
            host.db
              .prepare(
                "SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
              )
              .get(runId, nodeKey, generation),
          );
    if (detail?.detail_json) {
      try {
        const parsed = JSON.parse(String(detail.detail_json)) as { repairRequest?: unknown };
        const request = RepairRequestSchema.parse(parsed.repairRequest);
        if (request.mechanicalReportArtifactId) {
          const report = asRow(
            host.db
              .prepare(
                "SELECT artifact_id FROM artifacts WHERE run_id = ? AND artifact_id = ? AND kind = 'receipt'",
              )
              .get(runId, request.mechanicalReportArtifactId),
          );
          if (!report)
            throw new Error("repair references an unavailable mechanical report artifact");
          add("mechanical_report", request.mechanicalReportArtifactId);
        }
      } catch (error) {
        throw new Error(
          `repair has invalid sealed MechanicalReport reference: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return [...byRole.entries()]
    .map(([role, artifactId]) => ({ role, artifactId }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

export async function prepareUnsealedArtifact(
  host: ArtifactsHost,
  claim: ClaimedNode,
  descriptor: PiAttemptArtifactDescriptor,
): Promise<ArtifactPreparation | undefined> {
  const stageParent = path.join(
    runWorkDir(host.workspace.rootPath, claim.runId),
    "attempts",
    claim.attemptId,
    "seal-stage",
  );
  await mkdir(stageParent, { recursive: true });
  const stageDir = path.join(stageParent, `${descriptor.role}-${randomUUID()}`);
  await mkdir(stageDir, { recursive: true });
  if (descriptor.directory) {
    await cp(descriptor.sourcePath, stageDir, {
      recursive: true,
      dereference: false,
      errorOnExist: false,
    });
  } else {
    const base =
      descriptor.kind === "spec"
        ? "spec.json"
        : descriptor.kind === "execution_plan"
          ? "execution-plan.json"
          : path.basename(descriptor.sourcePath) || `${descriptor.role}.json`;
    await cp(descriptor.sourcePath, path.join(stageDir, base), { dereference: false });
  }
  // Content-only identity: ignore any prior `.okf-artifact-manifest.json` that may
  // have been copied when repair/refresh seeded from an already-sealed wiki_tree.
  // Verify uses the same filter; including the sidecar here makes seal overwrite it
  // and then fail final verification ("sealed artifact verification failed").
  const manifest = await manifestFor(stageDir, true);
  const manifestDigest = digest(manifest);
  const preparation: ArtifactPreparation = {
    artifactId: artifactId(claim.runId, descriptor.kind, manifestDigest),
    digest: manifestDigest,
    kind: descriptor.kind,
    preparationId: randomUUID(),
    relativePath: `artifacts/${descriptor.kind}-${manifestDigest}`,
    role: descriptor.role,
    sourceDirectory: stageDir,
  };
  return host.transaction(() => {
    if (!host.isCurrent(claim)) return undefined;
    host.db
      .prepare(
        `INSERT INTO artifact_preparations (
          preparation_id, attempt_id, run_id, node_key, node_generation, artifact_id, kind, role,
          manifest_digest, relative_path, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared')`,
      )
      .run(
        preparation.preparationId,
        claim.attemptId,
        claim.runId,
        claim.nodeKey,
        claim.nodeGeneration,
        preparation.artifactId,
        preparation.kind,
        preparation.role,
        preparation.digest,
        preparation.relativePath,
      );
    return preparation;
  });
}

/**
 * Load a sealed MergedDefectReport from a review.reduce defects preparation.
 * Prefers sourceDirectory (still present at commit), then sealed relative path.
 */
export function loadSealedDefectsReport(
  host: Pick<ArtifactsHost, "workspace">,
  runId: string,
  preparation: ArtifactPreparation | undefined,
): MergedDefectReport | undefined {
  if (!preparation) return undefined;
  const candidates: string[] = [];
  if (preparation.sourceDirectory) {
    candidates.push(path.join(preparation.sourceDirectory, "defects.json"));
    candidates.push(preparation.sourceDirectory);
  }
  const sealedRoot = path.join(
    runWorkDir(host.workspace.rootPath, runId),
    preparation.relativePath,
  );
  candidates.push(path.join(sealedRoot, "defects.json"), sealedRoot);
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const report = MergedDefectReportSchema.safeParse(parsed);
      if (report.success) return report.data;
    } catch {
      // Try next path.
    }
  }
  return undefined;
}

/**
 * CAS commit of sealed artifact bytes into artifacts/node_outputs and mark
 * attempt + node succeeded. Returns false when the claim is no longer current
 * (preparations orphaned). Does not open gates or unlock — see attempt-success.
 * Optional metrics are best-effort and never block the commit.
 */
export function commitNodeArtifacts(
  host: Pick<ArtifactsHost, "db" | "emit" | "isCurrent" | "workspace">,
  claim: ClaimedNode,
  preparations: ArtifactPreparation[],
  metrics?: AttemptMetrics,
): boolean {
  if (!host.isCurrent(claim)) {
    host.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(claim.attemptId);
    return false;
  }
  validateNodeOutputs(
    contractForNode(claim.kind, claim.nodeKey),
    preparations.map((preparation) => ({ role: preparation.role, kind: preparation.kind })),
  );
  const timestamp = now();
  for (const preparation of preparations) {
    host.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, digest, relative_path, producer_attempt_id, sealed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO NOTHING`,
      )
      .run(
        preparation.artifactId,
        claim.runId,
        preparation.kind,
        preparation.digest,
        preparation.relativePath,
        claim.attemptId,
        timestamp,
      );
    host.db
      .prepare(
        `INSERT INTO node_outputs (run_id, node_key, node_generation, role, artifact_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, node_key, node_generation, role) DO NOTHING`,
      )
      .run(
        claim.runId,
        claim.nodeKey,
        claim.nodeGeneration,
        preparation.role,
        preparation.artifactId,
      );
    // Always register WikiCandidate identity when a wiki_tree is committed (truth).
    // maxCandidates is enforced when scheduling repair, not here.
    if (preparation.role === "wiki_tree" || preparation.kind === "wiki_tree") {
      const candidate = registerWikiCandidate(host, {
        runId: claim.runId,
        digest: preparation.digest,
        artifactId: preparation.artifactId,
        producedBy: producedByForNode(claim.kind, claim.nodeKey),
        createdAt: timestamp,
        producerNodeKey: claim.nodeKey,
        producerAttemptId: claim.attemptId,
      });
      const parent = candidate.parentCandidateId
        ? asRow(
            host.db
              .prepare(
                `SELECT digest, artifact_id FROM wiki_candidates WHERE run_id = ? AND candidate_id = ?`,
              )
              .get(claim.runId, candidate.parentCandidateId),
          )
        : undefined;
      const candidateRoot = path.resolve(
        runWorkDir(host.workspace.rootPath, claim.runId),
        preparation.relativePath,
      );
      const evidenceMap = evidenceMapForCandidate(candidateRoot, candidate.digest);
      const evidenceDigest = digest(evidenceMap);
      const evidenceArtifactId = artifactId(claim.runId, "evidence_map", evidenceDigest);
      const evidenceRelativePath = `artifacts/evidence-map-${evidenceDigest}`;
      const evidenceDirectory = path.join(
        runWorkDir(host.workspace.rootPath, claim.runId),
        evidenceRelativePath,
      );
      mkdirSync(evidenceDirectory, { recursive: true });
      writeFileSync(
        path.join(evidenceDirectory, "evidence-map.json"),
        `${JSON.stringify(evidenceMap)}\n`,
        "utf8",
      );
      host.db
        .prepare(
          `INSERT INTO artifacts (artifact_id, run_id, kind, digest, relative_path, producer_attempt_id, sealed_at)
           VALUES (?, ?, 'evidence_map', ?, ?, ?, ?)
           ON CONFLICT(artifact_id) DO NOTHING`,
        )
        .run(
          evidenceArtifactId,
          claim.runId,
          evidenceDigest,
          evidenceRelativePath,
          claim.attemptId,
          timestamp,
        );
      // A parent wiki_tree is the baseline artifact. The initial candidate is
      // anchored to the empty published digest and therefore has no local baseline artifact.
      host.db
        .prepare(
          `INSERT INTO candidate_review_artifacts (
             run_id, candidate_digest, baseline_digest, baseline_artifact_id, evidence_digest, evidence_artifact_id
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, candidate_digest) DO NOTHING`,
        )
        .run(
          claim.runId,
          candidate.digest,
          parent ? requiredText(parent, "digest") : EMPTY_PUBLICATION_DIGEST,
          parent ? requiredText(parent, "artifact_id") : null,
          evidenceDigest,
          evidenceArtifactId,
        );
    }
  }
  host.db
    .prepare(
      "UPDATE attempts SET state = 'succeeded', ended_at = ? WHERE attempt_id = ? AND state = 'running'",
    )
    .run(timestamp, claim.attemptId);
  const resolved = mergeAttemptMetrics(metrics, {
    role: graphRoleForNodeKind(claim.kind),
    wallTimeMs: wallTimeMsFromStarted(host.db, claim.attemptId, timestamp),
    stopReason: "succeeded",
  });
  writeAttemptMetrics(host.db, claim.attemptId, resolved);
  host.db
    .prepare(
      `UPDATE nodes SET state = 'succeeded', current_attempt_id = NULL
       WHERE run_id = ? AND node_key = ? AND generation = ? AND current_attempt_id = ?`,
    )
    .run(claim.runId, claim.nodeKey, claim.nodeGeneration, claim.attemptId);
  host.db
    .prepare(
      "UPDATE artifact_preparations SET state = 'committed' WHERE attempt_id = ? AND state = 'prepared'",
    )
    .run(claim.attemptId);
  host.emit(claim.runId, "attempt.succeeded");
  return true;
}

/**
 * Commit sealed evidence produced by a failed Attempt without changing its
 * terminal state. Validation reports are evidence, not successful validation.
 */
export function commitFailedAttemptArtifacts(
  host: Pick<ArtifactsHost, "db" | "isCurrent">,
  claim: ClaimedNode,
  preparations: ArtifactPreparation[],
): boolean {
  if (!host.isCurrent(claim)) {
    host.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(claim.attemptId);
    return false;
  }
  const timestamp = now();
  for (const preparation of preparations) {
    host.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, digest, relative_path, producer_attempt_id, sealed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO NOTHING`,
      )
      .run(
        preparation.artifactId,
        claim.runId,
        preparation.kind,
        preparation.digest,
        preparation.relativePath,
        claim.attemptId,
        timestamp,
      );
    host.db
      .prepare(
        `INSERT INTO node_outputs (run_id, node_key, node_generation, role, artifact_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, node_key, node_generation, role) DO NOTHING`,
      )
      .run(
        claim.runId,
        claim.nodeKey,
        claim.nodeGeneration,
        preparation.role,
        preparation.artifactId,
      );
  }
  host.db
    .prepare(
      "UPDATE artifact_preparations SET state = 'committed' WHERE attempt_id = ? AND state = 'prepared'",
    )
    .run(claim.attemptId);
  return true;
}

export async function sealPreparation(
  host: Pick<ArtifactsHost, "workspace">,
  runId: string,
  preparation: ArtifactPreparation,
): Promise<void> {
  const runDir = runWorkDir(host.workspace.rootPath, runId);
  const destination = path.join(runDir, preparation.relativePath);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  if (!(await verifyArtifact(destination, preparation.digest))) {
    const temporary = await mkdtemp(path.join(parent, ".artifact-"));
    try {
      await cp(preparation.sourceDirectory, temporary, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
      });
      // Same content-only filter as prepare + verify (see prepareUnsealedArtifact).
      const manifest = await manifestFor(temporary, true);
      if (digest(manifest) !== preparation.digest)
        throw new Error(`${preparation.role} changed after preparation`);
      await writeFile(
        path.join(temporary, ".okf-artifact-manifest.json"),
        `${JSON.stringify(manifest)}\n`,
        "utf8",
      );
      await syncTree(temporary);
      await rename(temporary, destination);
      await syncDirectory(parent);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  if (!(await verifyArtifact(destination, preparation.digest))) {
    throw new Error(`sealed artifact verification failed: ${preparation.artifactId}`);
  }
}

export async function verifyArtifact(directory: string, expectedDigest: string): Promise<boolean> {
  const info = await lstat(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info?.isDirectory()) return false;
  try {
    const manifest = manifestFor(directory, true);
    const sealedManifest = JSON.parse(
      await readFile(path.join(directory, ".okf-artifact-manifest.json"), "utf8"),
    ) as unknown;
    return digest(await manifest) === expectedDigest && digest(sealedManifest) === expectedDigest;
  } catch {
    return false;
  }
}

export async function syncTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(child);
    else if (entry.isFile()) await durableFsyncPath(child);
  }
  await syncDirectory(directory);
}

export async function syncDirectory(directory: string): Promise<void> {
  // Directory fsync is a POSIX durability hint; Windows often returns EPERM.
  if (process.platform === "win32") return;
  await durableFsyncPath(directory);
}

export function orphanPreparedArtifacts(host: Pick<ArtifactsHost, "db">, attemptId: string): void {
  host.db
    .prepare(
      "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
    )
    .run(attemptId);
}
