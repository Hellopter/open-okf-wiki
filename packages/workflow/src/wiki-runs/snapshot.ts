/**
 * Pure WikiRunSnapshot projection from SQLite (secret-free, ADR 0035).
 */

import type { DatabaseSync } from "node:sqlite";
import {
  type RunIntent,
  RunIntentSchema,
  WIKI_RUNS_SCHEMA,
  type WikiRunAttempt,
  type WikiRunGateDetail,
  type WikiRunNode,
  type WikiRunNodeKind,
  type WikiRunSnapshot,
  WikiRunSnapshotSchema,
} from "@okf-wiki/contract";
import { projectAttemptMetrics } from "./attempt-metrics.js";
import { labelForNode, parentKeyForNode, parseNodeDetail } from "./node-label.js";
import { asRow, asRows, parseJson, requiredNumber, requiredText } from "./sql.js";
import { WikiRunsRequestError } from "./types.js";

/** Parse the required StartRun intent from the durable run record. */
function parseRunIntent(raw: unknown): RunIntent {
  if (raw == null || raw === "") throw new Error("run has no sealed intent");
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return RunIntentSchema.parse(parsed);
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
  for (const key of ["domainCount", "pageCount", "openQuestionCount"] as const) {
    const value = row[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      out[key] = value;
    }
  }
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
  if (!run) throw new WikiRunsRequestError("not_found", `run not found: ${runId}`);
  const definitionVersion = requiredNumber(run, "definition_version");
  if (definitionVersion !== 5) {
    throw new Error(`unsupported WikiRuns definition version for run ${runId}`);
  }

  const edges = asRows(
    db
      .prepare("SELECT from_key, to_key FROM node_edges WHERE run_id = ? ORDER BY from_key, to_key")
      .all(runId),
  ).map((edge) => ({ from: requiredText(edge, "from_key"), to: requiredText(edge, "to_key") }));

  // Inbound edges: to_key → from_key[] (for parentKey projection).
  const inboundByTo = new Map<string, string[]>();
  for (const edge of edges) {
    const { from, to } = edge;
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
    db
      .prepare("SELECT * FROM attempts WHERE run_id = ? ORDER BY started_at, attempt_id")
      .all(runId),
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
  // WikiCandidate lineage (table may be empty on older DBs / pre-write runs).
  let candidates: WikiRunSnapshot["candidates"];
  try {
    candidates = asRows(
      db
        .prepare(
          `SELECT wiki_candidates.candidate_id, wiki_candidates.digest, wiki_candidates.artifact_id,
                  wiki_candidates.parent_candidate_id, wiki_candidates.produced_by,
                  wiki_candidates.round, wiki_candidates.created_at,
                  candidate_review_artifacts.baseline_digest,
                  candidate_review_artifacts.baseline_artifact_id,
                  candidate_review_artifacts.evidence_digest,
                  candidate_review_artifacts.evidence_artifact_id
           FROM wiki_candidates
           LEFT JOIN candidate_review_artifacts
             ON candidate_review_artifacts.run_id = wiki_candidates.run_id
            AND candidate_review_artifacts.candidate_digest = wiki_candidates.digest
           WHERE wiki_candidates.run_id = ?
           ORDER BY round ASC, created_at ASC`,
        )
        .all(runId),
    ).map((row) => ({
      candidateId: requiredText(row, "candidate_id"),
      digest: requiredText(row, "digest"),
      artifactId: requiredText(row, "artifact_id"),
      producedBy: requiredText(
        row,
        "produced_by",
      ) as WikiRunSnapshot["candidates"][number]["producedBy"],
      round: requiredNumber(row, "round"),
      ...(row.parent_candidate_id != null && String(row.parent_candidate_id).trim()
        ? { parentCandidateId: String(row.parent_candidate_id).trim() }
        : {}),
      ...(row.created_at != null && String(row.created_at).trim()
        ? { createdAt: String(row.created_at).trim() }
        : {}),
      ...(row.baseline_digest != null && String(row.baseline_digest).trim()
        ? { baselineDigest: String(row.baseline_digest).trim() }
        : {}),
      ...(row.baseline_artifact_id != null && String(row.baseline_artifact_id).trim()
        ? { baselineArtifactId: String(row.baseline_artifact_id).trim() }
        : {}),
      ...(row.evidence_digest != null && String(row.evidence_digest).trim()
        ? { evidenceDigest: String(row.evidence_digest).trim() }
        : {}),
      ...(row.evidence_artifact_id != null && String(row.evidence_artifact_id).trim()
        ? { evidenceArtifactId: String(row.evidence_artifact_id).trim() }
        : {}),
    }));
  } catch {
    candidates = [];
  }
  let evaluationRecoveries: WikiRunSnapshot["evaluationRecoveries"];
  try {
    evaluationRecoveries = asRows(
      db
        .prepare(
          `SELECT recovery_id, candidate_id, source, repair_request_json, report_artifact_id, reason, created_at
           FROM evaluation_recoveries WHERE run_id = ? AND state = 'open' ORDER BY created_at`,
        )
        .all(runId),
    ).map((row) => {
      const repairRequest = parseJson<{ requestId?: unknown }>(
        requiredText(row, "repair_request_json"),
      );
      return {
        recoveryId: requiredText(row, "recovery_id"),
        candidateId: requiredText(row, "candidate_id"),
        source: requiredText(row, "source") as "mechanical" | "semantic",
        repairRequestId:
          typeof repairRequest.requestId === "string" && repairRequest.requestId.trim()
            ? repairRequest.requestId
            : "unknown",
        ...(row.report_artifact_id != null && String(row.report_artifact_id).trim()
          ? { reportArtifactId: String(row.report_artifact_id).trim() }
          : {}),
        reason: requiredText(row, "reason"),
        createdAt: requiredText(row, "created_at"),
      };
    });
  } catch {
    evaluationRecoveries = undefined;
  }
  const revisions = asRows(
    db
      .prepare(
        `SELECT revision_id, kind, content, command_id, actor_id, created_at, applied_at
         FROM run_revisions WHERE run_id = ? ORDER BY created_at, revision_id`,
      )
      .all(runId),
  ).map((row) => ({
    revisionId: requiredText(row, "revision_id"),
    kind: "scope_change" as const,
    content: requiredText(row, "content"),
    commandId: requiredText(row, "command_id"),
    actorId: requiredText(row, "actor_id"),
    createdAt: requiredText(row, "created_at"),
    ...(row.applied_at != null ? { appliedAt: String(row.applied_at) } : {}),
  }));
  const reviewThreads = asRows(
    db
      .prepare(
        `SELECT thread_id, candidate_digest, page_path, start_line, end_line, selected_text_digest,
                body, state, author_id, created_at, resolved_at
         FROM review_threads WHERE run_id = ? ORDER BY created_at, thread_id`,
      )
      .all(runId),
  ).map((row) => ({
    threadId: requiredText(row, "thread_id"),
    candidateDigest: requiredText(row, "candidate_digest"),
    pagePath: requiredText(row, "page_path"),
    startLine: requiredNumber(row, "start_line"),
    endLine: requiredNumber(row, "end_line"),
    selectedTextDigest: requiredText(row, "selected_text_digest"),
    body: requiredText(row, "body"),
    state: requiredText(row, "state") as "open" | "resolved" | "superseded",
    authorId: requiredText(row, "author_id"),
    createdAt: requiredText(row, "created_at"),
    ...(row.resolved_at != null ? { resolvedAt: String(row.resolved_at) } : {}),
  }));
  return WikiRunSnapshotSchema.parse({
    schema: WIKI_RUNS_SCHEMA,
    definitionVersion,
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
    edges,
    attempts,
    gates,
    candidates,
    revisions,
    reviewThreads,
    ...(evaluationRecoveries && evaluationRecoveries.length > 0 ? { evaluationRecoveries } : {}),
    effects,
    createdAt: requiredText(run, "created_at"),
    updatedAt: requiredText(run, "updated_at"),
  });
}
