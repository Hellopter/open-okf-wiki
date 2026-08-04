/**
 * Attempt input binding: which sealed artifacts a node mounts at claim time.
 * Topology special cases (repair baseline, prior_spec, wiki_tree carry-forward)
 * live here — artifacts.ts owns prepare / seal / CAS / orphan only.
 */

import {
  type BoundInput,
  contractForNode,
  inputRoleMatches,
  RepairRequestSchema,
  validateBoundInputs,
} from "@okf-wiki/contract/wiki-runs";
import type { WikiRunsCasCtx } from "./ctx.js";
import { upstreamKeys } from "./dag.js";
import { wikiCandidateById } from "./evaluation/candidate.js";
import { isRepairNodeKey, REPAIR_NODE_PREFIX } from "./repair-schedule.js";
import { asRow, asRows, requiredNumber, requiredText } from "./sql.js";

export function copyAttemptInputs(
  host: Pick<WikiRunsCasCtx, "db">,
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
  host: Pick<WikiRunsCasCtx, "db" | "currentNodeGeneration">,
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
  const boundInputs: BoundInput[] = asRows(
    host.db
      .prepare(
        `SELECT attempt_inputs.role, artifacts.kind
         FROM attempt_inputs
         JOIN artifacts ON artifacts.artifact_id = attempt_inputs.artifact_id
         WHERE attempt_inputs.attempt_id = ?
         ORDER BY attempt_inputs.role`,
      )
      .all(attemptId),
  ).map((row) => ({ role: requiredText(row, "role"), kind: requiredText(row, "kind") }));
  validateBoundInputs(contract, boundInputs);
}

/** Succeeded node outputs at a fixed generation (not necessarily current max). */
export function nodeOutputsAtGeneration(
  host: Pick<WikiRunsCasCtx, "db">,
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
  host: Pick<WikiRunsCasCtx, "db" | "currentNodeGeneration">,
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
  host: Pick<WikiRunsCasCtx, "db">,
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
  host: Pick<WikiRunsCasCtx, "db" | "currentNodeGeneration">,
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
  host: Pick<WikiRunsCasCtx, "db" | "currentNodeGeneration">,
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
  host: Pick<WikiRunsCasCtx, "db">,
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
  host: Pick<WikiRunsCasCtx, "db">,
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
  host: Pick<WikiRunsCasCtx, "db" | "currentNodeGeneration">,
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
  host: Pick<WikiRunsCasCtx, "db" | "currentNodeGeneration">,
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
  host: Pick<WikiRunsCasCtx, "db" | "currentNodeGeneration">,
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
      output.role === "prior_wiki" ||
      output.role === "coverage_inventory" ||
      output.role === "coverage_plan" ||
      output.role === "boundary_index"
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

  // Plan revise (gen>0): bind prior sealed Spec as prior_spec (ADR 0036 / 0040).
  if (nodeKey === "plan") {
    const generation = host.currentNodeGeneration(runId, "plan");
    if (generation !== undefined && generation > 0) {
      for (let g = generation - 1; g >= 0; g -= 1) {
        for (const output of nodeOutputsAtGeneration(host, runId, "plan", g)) {
          if (output.role === "spec") {
            add("prior_spec", output.artifactId);
            break;
          }
        }
        if (byRole.has("prior_spec")) break;
      }
    }

    // Durable plan.scout receipts (like domain binds leaf research).
    // Prefer edge-upstream outputs; also scan all succeeded plan.scout.* nodes
    // so light-path / partial U1 graphs still project sealed scouts into plan.
    bindSucceededPlanScoutReceipts(host, runId, add);
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
    "prior_spec",
    "coverage_inventory",
    "coverage_plan",
    "boundary_index",
    "discovery_map",
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

/**
 * Bind succeeded plan.scout.* scout_receipt outputs into the plan envelope.
 * Roles are namespaced `plan.scout.<slug>:scout_receipt` so multiple scouts
 * do not collide (mirrors research.leaf.*:research on domain).
 */
function bindSucceededPlanScoutReceipts(
  host: Pick<WikiRunsCasCtx, "db" | "currentNodeGeneration">,
  runId: string,
  add: (role: string, artifactId: string) => void,
): void {
  const scoutKeys = asRows(
    host.db
      .prepare(
        `SELECT DISTINCT node_key FROM nodes
         WHERE run_id = ? AND kind = 'plan.scout'
         ORDER BY node_key`,
      )
      .all(runId),
  ).map((row) => requiredText(row, "node_key"));

  for (const scoutKey of scoutKeys) {
    // Prefer latest succeeded generation (re-arm may leave current gen empty).
    for (const output of latestSucceededOutputs(host, runId, scoutKey)) {
      if (output.role === "scout_receipt") {
        add(`${scoutKey}:scout_receipt`, output.artifactId);
      }
    }
  }
}
