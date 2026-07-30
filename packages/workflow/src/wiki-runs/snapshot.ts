/**
 * Pure WikiRunSnapshot projection from SQLite (secret-free, ADR 0035).
 */

import type { DatabaseSync } from "node:sqlite";
import {
  type RunIntent,
  RunIntentSchema,
  type WikiRunAttempt,
  type WikiRunGateDetail,
  type WikiRunNode,
  type WikiRunNodeKind,
  type WikiRunSnapshot,
  WikiRunSnapshotSchema,
  WIKI_RUNS_SCHEMA,
} from "@okf-wiki/contract";
import { projectAttemptMetrics } from "./attempt-metrics.js";
import { labelForNode, parentKeyForNode, parseNodeDetail } from "./node-label.js";
import { asRow, asRows, parseJson, requiredNumber, requiredText } from "./sql.js";

/** Parse durable runs.intent_json into secret-free RunIntent (null if missing/corrupt). */
function parseRunIntent(raw: unknown): RunIntent | null {
  if (raw == null || raw === "") return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const result = RunIntentSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Narrow gate detail_json into secret-free WikiRunGateDetail. */
function parseGateDetail(raw: unknown): WikiRunGateDetail | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const out: WikiRunGateDetail = {};
  if (typeof row.source === "string" && row.source.trim())
    out.source = row.source.trim().slice(0, 100);
  if (typeof row.summary === "string" && row.summary.trim())
    out.summary = row.summary.trim().slice(0, 4_000);
  if (typeof row.clean === "boolean") out.clean = row.clean;
  if (
    typeof row.blockingCount === "number" &&
    Number.isInteger(row.blockingCount) &&
    row.blockingCount >= 0
  ) {
    out.blockingCount = row.blockingCount;
  }
  if (typeof row.feedback === "string" && row.feedback.trim())
    out.feedback = row.feedback.trim().slice(0, 4_000);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Prefer a single semantic parent for UI hierarchy:
 * research.leaf → research.domain; research.domain → plan; else first inbound edge.
 */
function pickParentFromEdges(
  kind: WikiRunNodeKind,
  _key: string,
  inbound: string[],
): string | undefined {
  if (inbound.length === 0) return undefined;
  if (kind === "research.leaf") {
    const domain = inbound.find((k) => k.startsWith("research.domain."));
    if (domain) return domain;
  }
  if (kind === "research.domain") {
    if (inbound.includes("plan")) return "plan";
  }
  // Avoid gate self-noise: prefer non-gate parents when multiple.
  const nonGate = inbound.find((k) => !k.startsWith("gate."));
  return nonGate ?? inbound[0];
}

/** Build a validated WikiRunSnapshot for one run from the control-plane DB. */
export function buildSnapshot(db: DatabaseSync, runId: string): WikiRunSnapshot {
  const run = asRow(db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId));
  if (!run) throw new Error(`run not found: ${runId}`);

  // Inbound edges: to_key → from_key[] (for parentKey projection).
  const inboundByTo = new Map<string, string[]>();
  for (const edge of asRows(
    db
      .prepare("SELECT from_key, to_key FROM node_edges WHERE run_id = ?")
      .all(runId),
  )) {
    const from = requiredText(edge, "from_key");
    const to = requiredText(edge, "to_key");
    const list = inboundByTo.get(to) ?? [];
    list.push(from);
    inboundByTo.set(to, list);
  }

  const nodes: WikiRunNode[] = asRows(
    db
      .prepare(
        `SELECT nodes.* FROM nodes
         JOIN (SELECT node_key, MAX(generation) AS generation FROM nodes WHERE run_id = ? GROUP BY node_key) current
           ON current.node_key = nodes.node_key AND current.generation = nodes.generation
         WHERE nodes.run_id = ? ORDER BY nodes.node_key`,
      )
      .all(runId, runId),
  ).map((node) => {
    const key = requiredText(node, "node_key");
    const kind = requiredText(node, "kind") as WikiRunNodeKind;
    const detailRaw =
      node.detail_json == null || node.detail_json === ""
        ? undefined
        : parseJson<unknown>(node.detail_json as string);
    const detail = parseNodeDetail(detailRaw);
    const edgeParent = pickParentFromEdges(kind, key, inboundByTo.get(key) ?? []);
    const parentKey = parentKeyForNode(kind, key, detail, edgeParent);
    const label = labelForNode(kind, key, detail);
    return {
      key,
      kind,
      state: requiredText(node, "state") as WikiRunNode["state"],
      generation: requiredNumber(node, "generation"),
      currentAttemptId: node.current_attempt_id as string | null,
      lastAttemptId: node.last_attempt_id as string | null,
      outputs: asRows(
        db
          .prepare(
            `SELECT node_outputs.role, artifacts.artifact_id, artifacts.kind, artifacts.digest, artifacts.sealed_at
             FROM node_outputs JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
             WHERE node_outputs.run_id = ? AND node_outputs.node_key = ? AND node_outputs.node_generation = ?
             ORDER BY node_outputs.role`,
          )
          .all(runId, key, requiredNumber(node, "generation")),
      ).map((output) => ({
        role: requiredText(output, "role"),
        artifact: {
          artifactId: requiredText(output, "artifact_id"),
          kind: requiredText(output, "kind") as WikiRunNode["outputs"][number]["artifact"]["kind"],
          digest: requiredText(output, "digest"),
          sealedAt: requiredText(output, "sealed_at"),
        },
      })),
      label,
      ...(parentKey ? { parentKey } : {}),
      ...(detail ? { detail } : {}),
    };
  });
  /**
   * Slim attempts projection for snapshots embedded in every SSE/event (not full audit).
   *
   * Policy (least-breaking for inspector / retry UI):
   * 1. All attempts whose node_generation matches the node's *current* generation
   *    (includes same-gen auto-retry / manual RetryFailedNode history).
   * 2. Plus any still-running attempts (stale-gen edge during abort windows).
   * 3. Plus, per nodeKey, up to FAILED_HISTORY_CAP older failed/interrupted attempts
   *    (newest first) so fix-gate / inspector retain recent failure context after Rerun.
   *
   * Full attempt rows remain in SQLite; conversation bytes via readAttemptTranscript.
   * Do not drop snapshot from WikiRunEventSchema — Web replaces projection by event id.
   */
  const FAILED_HISTORY_CAP = 3;
  const currentGenByNode = new Map(nodes.map((n) => [n.key, n.generation]));
  const allAttemptRows = asRows(
    db.prepare("SELECT * FROM attempts WHERE run_id = ? ORDER BY started_at, attempt_id").all(runId),
  );
  const selectedAttemptIds = new Set<string>();
  const mappedAttempts: WikiRunAttempt[] = [];
  const olderFailedByNode = new Map<string, WikiRunAttempt[]>();

  for (const attempt of allAttemptRows) {
    const failureClassRaw =
      attempt.failure_class == null || attempt.failure_class === ""
        ? undefined
        : String(attempt.failure_class).trim();
    const metrics = projectAttemptMetrics(attempt);
    const projected: WikiRunAttempt = {
      attemptId: requiredText(attempt, "attempt_id"),
      nodeKey: requiredText(attempt, "node_key"),
      nodeGeneration: requiredNumber(attempt, "node_generation"),
      runIndex: requiredNumber(attempt, "run_index"),
      state: requiredText(attempt, "state") as WikiRunAttempt["state"],
      inputDigest: requiredText(attempt, "input_digest"),
      error: attempt.error as string | null,
      ...(failureClassRaw ? { failureClass: failureClassRaw } : {}),
      startedAt: requiredText(attempt, "started_at"),
      endedAt: attempt.ended_at as string | null,
      ...(metrics ? { metrics } : {}),
    };
    const currentGen = currentGenByNode.get(projected.nodeKey);
    const isCurrentGen = currentGen !== undefined && projected.nodeGeneration === currentGen;
    const isRunning = projected.state === "running";
    if (isCurrentGen || isRunning || projected.state === "suspended") {
      // Always keep suspended attempts (operator_input pause audit) even after gen bump.
      selectedAttemptIds.add(projected.attemptId);
      mappedAttempts.push(projected);
      continue;
    }
    if (projected.state === "failed" || projected.state === "interrupted") {
      const list = olderFailedByNode.get(projected.nodeKey) ?? [];
      list.push(projected);
      olderFailedByNode.set(projected.nodeKey, list);
    }
  }

  // Older failed/interrupted: keep the newest FAILED_HISTORY_CAP per nodeKey.
  for (const list of olderFailedByNode.values()) {
    const newestFirst = [...list].sort((a, b) => {
      const byEnd = (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt);
      if (byEnd !== 0) return byEnd;
      return b.attemptId.localeCompare(a.attemptId);
    });
    for (const older of newestFirst.slice(0, FAILED_HISTORY_CAP)) {
      if (selectedAttemptIds.has(older.attemptId)) continue;
      selectedAttemptIds.add(older.attemptId);
      mappedAttempts.push(older);
    }
  }

  const attempts = mappedAttempts.sort((a, b) => {
    const byStart = a.startedAt.localeCompare(b.startedAt);
    if (byStart !== 0) return byStart;
    return a.attemptId.localeCompare(b.attemptId);
  });
  const sources =
    run.pinned_sources_json === null ? null : parseJson<unknown>(run.pinned_sources_json);
  const gates = asRows(
    db.prepare("SELECT * FROM gates WHERE run_id = ? ORDER BY opened_at, gate_id").all(runId),
  ).map((gate) => {
    const rawDetail =
      gate.detail_json == null || gate.detail_json === ""
        ? undefined
        : parseJson<unknown>(gate.detail_json as string);
    const detail = parseGateDetail(rawDetail);
    return {
      gateId: requiredText(gate, "gate_id"),
      nodeKey: requiredText(gate, "node_key"),
      nodeGeneration: requiredNumber(gate, "node_generation"),
      kind: requiredText(gate, "kind") as WikiRunSnapshot["gates"][number]["kind"],
      state: requiredText(gate, "state") as WikiRunSnapshot["gates"][number]["state"],
      payloadDigest: requiredText(gate, "payload_digest"),
      decision:
        gate.decision_json === null
          ? null
          : parseJson<WikiRunSnapshot["gates"][number]["decision"]>(gate.decision_json),
      openedAt: requiredText(gate, "opened_at"),
      ...(detail ? { detail } : {}),
    };
  });
  const effects = asRows(
    db.prepare("SELECT * FROM effects WHERE run_id = ? ORDER BY effect_key").all(runId),
  ).map((effect) => ({
    effectKey: requiredText(effect, "effect_key"),
    publicationNodeKey: requiredText(effect, "publication_node_key"),
    publicationNodeGeneration: requiredNumber(effect, "publication_node_generation"),
    gateId: requiredText(effect, "gate_id"),
    state: requiredText(effect, "state") as WikiRunSnapshot["effects"][number]["state"],
    requestDigest: requiredText(effect, "request_digest"),
    expectedLiveDigest: requiredText(effect, "expected_live_digest"),
    candidateArtifactId: requiredText(effect, "candidate_artifact_id"),
    candidateDigest: requiredText(effect, "candidate_digest"),
  }));
  return WikiRunSnapshotSchema.parse({
    schema: WIKI_RUNS_SCHEMA,
    definitionVersion: 2,
    runId: requiredText(run, "run_id"),
    workspaceId: requiredText(run, "workspace_id"),
    revision: requiredNumber(run, "revision"),
    state: requiredText(run, "state"),
    cancelRequested: requiredNumber(run, "cancel_requested") === 1,
    intent: parseRunIntent(run.intent_json),
    pinnedInputs:
      sources === null
        ? null
        : {
            sources,
            skillDigest: requiredText(run, "skill_digest"),
            digest: requiredText(run, "pinned_digest"),
          },
    nodes,
    attempts,
    gates,
    effects,
    createdAt: requiredText(run, "created_at"),
    updatedAt: requiredText(run, "updated_at"),
  });
}
