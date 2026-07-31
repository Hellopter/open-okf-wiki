/**
 * Open / withdraw plan, publication, and fix gates (and clean auto-pass).
 * Expire lives with resolve (calls resolveGate) — see gate-resolve.ts.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { contractForNode, type WorkspaceConfig } from "@okf-wiki/contract";
import { EMPTY_PUBLICATION_DIGEST, runWorkDir } from "@okf-wiki/core";
import { digest } from "./crypto-util.js";
import type { WikiRunsDbCtx } from "./ctx.js";
import { unlockReadyNodes } from "./dag.js";
import { asRow, asRows } from "./sql.js";
import type { ArtifactPreparation, ClaimedNode } from "./types.js";

/** Minimal surface for gate open / withdraw. */
export type GateOpenHost = Pick<WikiRunsDbCtx, "db" | "emit"> & {
  currentNodeGeneration?(runId: string, nodeKey: string): number | undefined;
  workspace?: WorkspaceConfig;
};

export function withdrawOpenGates(host: Pick<GateOpenHost, "db" | "emit">, runId: string): void {
  const open = asRows(
    host.db.prepare("SELECT gate_id FROM gates WHERE run_id = ? AND state = 'open'").all(runId),
  );
  if (open.length === 0) return;
  host.db
    .prepare("UPDATE gates SET state = 'withdrawn' WHERE run_id = ? AND state = 'open'")
    .run(runId);
  host.emit(runId, "gate.withdrawn");
}

export function withdrawOpenGatesForNode(
  host: Pick<GateOpenHost, "db" | "emit">,
  runId: string,
  nodeKey: string,
  generation: number,
): void {
  const open = asRows(
    host.db
      .prepare(
        `SELECT gate_id FROM gates
         WHERE run_id = ? AND node_key = ? AND node_generation = ? AND state = 'open'`,
      )
      .all(runId, nodeKey, generation),
  );
  if (open.length === 0) return;
  host.db
    .prepare(
      `UPDATE gates SET state = 'withdrawn'
       WHERE run_id = ? AND node_key = ? AND node_generation = ? AND state = 'open'`,
    )
    .run(runId, nodeKey, generation);
  host.emit(runId, "gate.withdrawn");
}

export function openPlanGate(
  host: Pick<GateOpenHost, "db" | "emit">,
  claim: ClaimedNode,
  specPayloadDigest: string,
  timestamp: string,
): void {
  const gateId = randomUUID();
  const gateNodeKey = "gate.plan";
  contractForNode("gate.plan", gateNodeKey);
  const existingGateNode = asRow(
    host.db
      .prepare(
        "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
      )
      .get(claim.runId, gateNodeKey, claim.nodeGeneration),
  );
  if (!existingGateNode) {
    host.db
      .prepare(
        `INSERT INTO nodes (
          run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
        ) VALUES (?, ?, 'gate.plan', 'waiting', ?, NULL, NULL, NULL)`,
      )
      .run(claim.runId, gateNodeKey, claim.nodeGeneration);
  } else {
    host.db
      .prepare(
        `UPDATE nodes SET state = 'waiting', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ?`,
      )
      .run(claim.runId, gateNodeKey, claim.nodeGeneration);
  }
  host.db
    .prepare(
      `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, ?)
       ON CONFLICT(run_id, from_key, to_key) DO NOTHING`,
    )
    .run(claim.runId, claim.nodeKey, gateNodeKey);
  host.db
    .prepare(
      `INSERT INTO gates (
        gate_id, run_id, node_key, node_generation, kind, state, payload_digest,
        decision_json, detail_json, opened_at, opened_revision
      ) VALUES (?, ?, ?, ?, 'plan', 'open', ?, NULL, NULL, ?,
        (SELECT revision FROM runs WHERE run_id = ?))`,
    )
    .run(
      gateId,
      claim.runId,
      gateNodeKey,
      claim.nodeGeneration,
      specPayloadDigest,
      timestamp,
      claim.runId,
    );
  host.db
    .prepare(
      "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(timestamp, claim.runId);
  host.emit(claim.runId, "gate.opened");
}

/**
 * Open gate.fix after review.reduce sealed blocking defects.
 * payloadDigest binds the sealed defects receipt (or a hash of the report).
 * detailJson may carry operator-facing summary (blocking count, clean flag).
 */
export function openFixGate(
  host: Pick<WikiRunsDbCtx, "db" | "emit"> & {
    currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
  },
  claim: ClaimedNode,
  defectsPayloadDigest: string,
  timestamp: string,
  detail?: { summary?: string; clean?: boolean; blockingCount?: number },
): void {
  const gateId = randomUUID();
  const gateNodeKey = "gate.fix";
  contractForNode("gate.fix", gateNodeKey);
  const gateGen = host.currentNodeGeneration(claim.runId, gateNodeKey) ?? 0;
  const existingGateNode = asRow(
    host.db
      .prepare(
        "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
      )
      .get(claim.runId, gateNodeKey, gateGen),
  );
  const detailJson =
    detail !== undefined
      ? JSON.stringify({
          source: "review",
          summary: detail.summary,
          clean: detail.clean === true,
          blockingCount: detail.blockingCount ?? 0,
        })
      : null;
  if (!existingGateNode) {
    host.db
      .prepare(
        `INSERT INTO nodes (
          run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
        ) VALUES (?, ?, 'gate.fix', 'waiting', ?, NULL, NULL, ?)`,
      )
      .run(claim.runId, gateNodeKey, gateGen, detailJson);
  } else {
    host.db
      .prepare(
        `UPDATE nodes SET state = 'waiting', current_attempt_id = NULL, detail_json = COALESCE(?, detail_json)
         WHERE run_id = ? AND node_key = ? AND generation = ?`,
      )
      .run(detailJson, claim.runId, gateNodeKey, gateGen);
  }
  host.db
    .prepare(
      `INSERT INTO gates (
        gate_id, run_id, node_key, node_generation, kind, state, payload_digest,
        decision_json, detail_json, opened_at, opened_revision
      ) VALUES (?, ?, ?, ?, 'fix', 'open', ?, NULL, ?, ?,
        (SELECT revision FROM runs WHERE run_id = ?))`,
    )
    .run(
      gateId,
      claim.runId,
      gateNodeKey,
      gateGen,
      defectsPayloadDigest,
      detailJson,
      timestamp,
      claim.runId,
    );
  host.db
    .prepare(
      "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(timestamp, claim.runId);
  host.emit(claim.runId, "gate.opened");
}

/**
 * Clean review path: mark gate.fix succeeded without operator HITL and unlock
 * validate.final. Called from attempt-success when sealed defects are clean.
 */
export function autoPassFixGate(
  host: Pick<WikiRunsDbCtx, "db" | "emit"> & {
    currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
  },
  runId: string,
  timestamp: string,
): void {
  const gateNodeKey = "gate.fix";
  contractForNode("gate.fix", gateNodeKey);
  const gateGen = host.currentNodeGeneration(runId, gateNodeKey) ?? 0;
  const existing = asRow(
    host.db
      .prepare("SELECT state FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
      .get(runId, gateNodeKey, gateGen),
  );
  if (!existing) {
    host.db
      .prepare(
        `INSERT INTO nodes (
          run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
        ) VALUES (?, ?, 'gate.fix', 'succeeded', ?, NULL, NULL, ?)`,
      )
      .run(
        runId,
        gateNodeKey,
        gateGen,
        JSON.stringify({ source: "review", clean: true, autoPass: true }),
      );
  } else {
    host.db
      .prepare(
        `UPDATE nodes SET state = 'succeeded', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ?
           AND state IN ('blocked', 'waiting', 'ready', 'running')`,
      )
      .run(runId, gateNodeKey, gateGen);
  }
  unlockReadyNodes(host, runId);
  host.db
    .prepare(
      "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(timestamp, runId);
  host.emit(runId, "node.ready");
}

/**
 * Recover the live baseline captured during prepare.publication.
 * Prefers the attempt-private stage copy, then the sealed receipt artifact.
 * Falls back to the canonical empty-tree digest (not 64 zero hex).
 */
export function readPublicationBaseline(
  host: { workspace: WorkspaceConfig },
  runId: string,
  preparations: ArtifactPreparation[],
): string {
  const metaPrep = preparations.find((item) => item.role === "candidate_meta");
  if (!metaPrep) return EMPTY_PUBLICATION_DIGEST;
  const candidates: string[] = [];
  if (metaPrep.sourceDirectory) {
    candidates.push(path.join(metaPrep.sourceDirectory, "candidate-meta.json"));
    candidates.push(metaPrep.sourceDirectory);
  }
  const sealedRoot = path.join(runWorkDir(host.workspace.rootPath, runId), metaPrep.relativePath);
  candidates.push(path.join(sealedRoot, "candidate-meta.json"), sealedRoot);
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, "utf8");
      const meta = JSON.parse(raw) as { expectedLiveDigest?: string };
      if (
        typeof meta.expectedLiveDigest === "string" &&
        /^[a-f0-9]{64}$/i.test(meta.expectedLiveDigest)
      ) {
        return meta.expectedLiveDigest;
      }
    } catch {
      // Try the next candidate path.
    }
  }
  return EMPTY_PUBLICATION_DIGEST;
}

/**
 * Open an operator_input gate on the *current Pi node* (no separate gate.* node).
 * Payload binds question/context, producer attempt, generation, and input digest.
 * Caller must already have set Attempt=suspended and Node=waiting.
 */
export function openOperatorInputGate(
  host: Pick<GateOpenHost, "db" | "emit">,
  claim: ClaimedNode,
  input: {
    question: string;
    context?: string;
    inputDigest: string;
    timestamp: string;
  },
): string {
  const gateId = randomUUID();
  const question = input.question.trim().slice(0, 1_000);
  const context = input.context !== undefined ? input.context.trim().slice(0, 4_000) : undefined;
  const payloadDigest = digest({
    kind: "operator_input",
    question,
    ...(context ? { context } : {}),
    attemptId: claim.attemptId,
    nodeKey: claim.nodeKey,
    generation: claim.nodeGeneration,
    inputDigest: input.inputDigest,
  });
  const detailJson = JSON.stringify({
    source: "operator_input",
    summary: question,
    ...(context ? { context } : {}),
    attemptId: claim.attemptId,
    nodeKey: claim.nodeKey,
    generation: claim.nodeGeneration,
  });
  host.db
    .prepare(
      `INSERT INTO gates (
        gate_id, run_id, node_key, node_generation, kind, state, payload_digest,
        decision_json, detail_json, opened_at, opened_revision
      ) VALUES (?, ?, ?, ?, 'operator_input', 'open', ?, NULL, ?, ?,
        (SELECT revision FROM runs WHERE run_id = ?))`,
    )
    .run(
      gateId,
      claim.runId,
      claim.nodeKey,
      claim.nodeGeneration,
      payloadDigest,
      detailJson,
      input.timestamp,
      claim.runId,
    );
  host.db
    .prepare(
      "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(input.timestamp, claim.runId);
  host.emit(claim.runId, "gate.opened");
  return gateId;
}

export function openPublicationGate(
  host: Pick<WikiRunsDbCtx, "db" | "emit"> & {
    currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
  },
  claim: ClaimedNode,
  candidate: ArtifactPreparation,
  expectedLiveDigest: string,
  timestamp: string,
): void {
  const gateId = randomUUID();
  const gateNodeKey = "gate.publication";
  const gateGen = host.currentNodeGeneration(claim.runId, gateNodeKey) ?? 0;
  host.db
    .prepare(
      `UPDATE nodes SET state = 'waiting', current_attempt_id = NULL
       WHERE run_id = ? AND node_key = ? AND generation = ?`,
    )
    .run(claim.runId, gateNodeKey, gateGen);
  // Gate payload binds candidate + baseline + effect identity + owning generation.
  const effectKey = `publish:${claim.runId}:${claim.nodeGeneration}:${candidate.digest}`;
  const requestDigest = digest({
    effectKey,
    candidateArtifactId: candidate.artifactId,
    candidateDigest: candidate.digest,
    expectedLiveDigest,
    publicationNodeKey: claim.nodeKey,
    publicationNodeGeneration: claim.nodeGeneration,
  });
  host.db
    .prepare(
      `INSERT INTO effects (
        effect_key, run_id, publication_node_key, publication_node_generation, gate_id, state,
        request_digest, expected_live_digest, candidate_artifact_id, candidate_digest, observed_outcome
      ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, NULL)`,
    )
    .run(
      effectKey,
      claim.runId,
      claim.nodeKey,
      claim.nodeGeneration,
      gateId,
      requestDigest,
      expectedLiveDigest,
      candidate.artifactId,
      candidate.digest,
    );
  host.db
    .prepare(
      `INSERT INTO gates (
        gate_id, run_id, node_key, node_generation, kind, state, payload_digest,
        decision_json, detail_json, opened_at, opened_revision
      ) VALUES (?, ?, ?, ?, 'publication', 'open', ?, NULL, NULL, ?,
        (SELECT revision FROM runs WHERE run_id = ?))`,
    )
    .run(gateId, claim.runId, gateNodeKey, gateGen, requestDigest, timestamp, claim.runId);
  host.db
    .prepare(
      "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(timestamp, claim.runId);
  host.emit(claim.runId, "effect.prepared");
  host.emit(claim.runId, "gate.opened");
}
