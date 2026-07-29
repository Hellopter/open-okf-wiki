/**
 * Pure WikiRunSnapshot projection from SQLite (secret-free, ADR 0035).
 */

import type { DatabaseSync } from "node:sqlite";
import {
  type WikiRunAttempt,
  type WikiRunNode,
  type WikiRunSnapshot,
  WikiRunSnapshotSchema,
} from "@okf-wiki/contract";
import { asRow, asRows, parseJson, requiredNumber, requiredText } from "./sql.js";

/** Build a validated WikiRunSnapshot for one run from the control-plane DB. */
export function buildSnapshot(db: DatabaseSync, runId: string): WikiRunSnapshot {
  const run = asRow(db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId));
  if (!run) throw new Error(`run not found: ${runId}`);
  const nodes: WikiRunNode[] = asRows(
    db
      .prepare(
        `SELECT nodes.* FROM nodes
         JOIN (SELECT node_key, MAX(generation) AS generation FROM nodes WHERE run_id = ? GROUP BY node_key) current
           ON current.node_key = nodes.node_key AND current.generation = nodes.generation
         WHERE nodes.run_id = ? ORDER BY nodes.node_key`,
      )
      .all(runId, runId),
  ).map((node) => ({
    key: requiredText(node, "node_key"),
    kind: requiredText(node, "kind") as WikiRunNode["kind"],
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
        .all(runId, requiredText(node, "node_key"), requiredNumber(node, "generation")),
    ).map((output) => ({
      role: requiredText(output, "role"),
      artifact: {
        artifactId: requiredText(output, "artifact_id"),
        kind: requiredText(output, "kind") as WikiRunNode["outputs"][number]["artifact"]["kind"],
        digest: requiredText(output, "digest"),
        sealedAt: requiredText(output, "sealed_at"),
      },
    })),
  }));
  const attempts: WikiRunAttempt[] = asRows(
    db.prepare("SELECT * FROM attempts WHERE run_id = ? ORDER BY started_at, attempt_id").all(runId),
  ).map((attempt) => ({
    attemptId: requiredText(attempt, "attempt_id"),
    nodeKey: requiredText(attempt, "node_key"),
    nodeGeneration: requiredNumber(attempt, "node_generation"),
    runIndex: requiredNumber(attempt, "run_index"),
    state: requiredText(attempt, "state") as WikiRunAttempt["state"],
    inputDigest: requiredText(attempt, "input_digest"),
    error: attempt.error as string | null,
    startedAt: requiredText(attempt, "started_at"),
    endedAt: attempt.ended_at as string | null,
  }));
  const sources =
    run.pinned_sources_json === null ? null : parseJson<unknown>(run.pinned_sources_json);
  const gates = asRows(
    db.prepare("SELECT * FROM gates WHERE run_id = ? ORDER BY opened_at, gate_id").all(runId),
  ).map((gate) => ({
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
  }));
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
    schema: "okf.wiki-runs/v1",
    definitionVersion: 1,
    runId: requiredText(run, "run_id"),
    workspaceId: requiredText(run, "workspace_id"),
    revision: requiredNumber(run, "revision"),
    state: requiredText(run, "state"),
    cancelRequested: requiredNumber(run, "cancel_requested") === 1,
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
