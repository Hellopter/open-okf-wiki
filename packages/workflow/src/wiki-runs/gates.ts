/**
 * Gate open / resolve / withdraw and Definition v1 graph unlock helpers.
 * Owner binds db/workspace/emit — gates stay free of WikiRunsOwner.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type RunCommand,
  type RunCommandContext,
  type RunCommandReceipt,
  type WikiRunEvent,
  WikiRunSpecSchema,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { EMPTY_PUBLICATION_DIGEST, runWorkDir } from "@okf-wiki/core";
import { buildDefinitionV1Graph, isGateKind } from "../definition-v1.js";
import { digest, now } from "./crypto-util.js";
import { applyRunCancelTransitions } from "./run-terminal.js";
import { asRow, asRows, requiredNumber, requiredText, type SqlRow } from "./sql.js";
import type { ArtifactPreparation, ClaimedNode } from "./types.js";

export type GatesHost = {
  workspace: WorkspaceConfig;
  db: DatabaseSync;
  emit(runId: string, type: WikiRunEvent["type"]): number;
  currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
  currentNodeRow(runId: string, nodeKey: string): SqlRow | undefined;
  abortRunAttempts(runId: string): void;
  cancelPreApplyEffects(runId: string): void;
  applyRerunAt(runId: string, nodeKey: string, generation: number, feedback?: string): void;
  recordCommand(
    command: RunCommand,
    context: RunCommandContext,
    payloadDigest: string,
    runId: string,
    revision: number,
  ): void;
};

export function resolveGate(
  host: GatesHost,
  command: Extract<RunCommand, { type: "resolve_gate" }>,
  context: RunCommandContext,
  payloadDigest: string,
): RunCommandReceipt {
  const run = asRow(
    host.db
      .prepare("SELECT cancel_requested, state FROM runs WHERE run_id = ?")
      .get(command.runId),
  );
  if (!run) throw new Error(`run not found: ${command.runId}`);
  if (requiredNumber(run, "cancel_requested") === 1)
    throw new Error("cannot resolve gate on a cancelled run");
  const gate = asRow(
    host.db
      .prepare(
        `SELECT gate_id, run_id, node_key, node_generation, kind, state, payload_digest
         FROM gates WHERE gate_id = ? AND run_id = ?`,
      )
      .get(command.gateId, command.runId),
  );
  if (!gate) throw new Error(`gate not found: ${command.gateId}`);
  if (requiredText(gate, "state") !== "open") throw new Error("gate is stale or already closed");
  if (requiredText(gate, "kind") !== command.gateKind)
    throw new Error("gate kind does not match the open gate");
  if (requiredText(gate, "payload_digest") !== command.payloadDigest)
    throw new Error("gate payload digest does not match the open gate");
  const nodeKey = requiredText(gate, "node_key");
  const nodeGeneration = requiredNumber(gate, "node_generation");
  const currentGen = host.currentNodeGeneration(command.runId, nodeKey);
  if (currentGen !== nodeGeneration)
    throw new Error("gate is stale: node generation was replaced");

  const timestamp = now();
  const decision = {
    commandId: command.commandId,
    decision: command.decision,
    payloadDigest: command.payloadDigest,
    decidedAt: timestamp,
  };
  const detail =
    command.feedback !== undefined
      ? { feedback: command.feedback }
      : command.answer !== undefined
        ? { answer: command.answer }
        : null;
  host.db
    .prepare(
      `UPDATE gates SET state = 'resolved', decision_json = ?, detail_json = ?
       WHERE gate_id = ? AND state = 'open'`,
    )
    .run(
      JSON.stringify(decision),
      detail === null ? null : JSON.stringify(detail),
      command.gateId,
    );
  const updated = asRow(
    host.db.prepare("SELECT state FROM gates WHERE gate_id = ?").get(command.gateId),
  );
  if (!updated || requiredText(updated, "state") !== "resolved")
    throw new Error("gate is stale or already closed");

  host.db
    .prepare(
      `UPDATE nodes SET state = 'succeeded', current_attempt_id = NULL
       WHERE run_id = ? AND node_key = ? AND generation = ? AND state IN ('waiting', 'ready', 'running')`,
    )
    .run(command.runId, nodeKey, nodeGeneration);

  switch (command.gateKind) {
    case "plan":
      applyPlanGateDecision(host, command, nodeKey, nodeGeneration, timestamp);
      break;
    case "operator_input":
      applyOperatorInputGateDecision(host, command, nodeKey, nodeGeneration, timestamp);
      break;
    case "publication":
      applyPublicationGateDecision(host, command, timestamp);
      break;
  }

  const revision = host.emit(command.runId, "gate.resolved");
  host.recordCommand(command, context, payloadDigest, command.runId, revision);
  return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
}

export function applyPlanGateDecision(
  host: GatesHost,
  command: Extract<RunCommand, { type: "resolve_gate" }>,
  gateNodeKey: string,
  gateNodeGeneration: number,
  timestamp: string,
): void {
  if (command.decision === "approve") {
    const planKey = planNodeKeyForGate(host, command.runId, gateNodeKey);
    const planGen = host.currentNodeGeneration(command.runId, planKey);
    if (planGen === undefined) throw new Error("plan node not found for approve");
    const spec = asRow(
      host.db
        .prepare(
          `SELECT node_outputs.artifact_id, artifacts.relative_path
           FROM node_outputs
           JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
           WHERE node_outputs.run_id = ?
             AND node_outputs.node_key = ?
             AND node_outputs.node_generation = ?
             AND (node_outputs.role = 'spec' OR artifacts.kind = 'spec')
           LIMIT 1`,
        )
        .get(command.runId, planKey, planGen),
    );
    if (!spec) {
      throw new Error("plan approve requires a sealed Spec artifact");
    }
    materializeDefinitionV1Graph(host, command.runId, requiredText(spec, "relative_path"));
    host.db
      .prepare(
        "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, command.runId);
    unlockReadyNodes(host, command.runId);
    host.emit(command.runId, "node.ready");
    return;
  }
  if (command.decision === "revise") {
    const planKey = planNodeKeyForGate(host, command.runId, gateNodeKey);
    const planGen = host.currentNodeGeneration(command.runId, planKey);
    if (planGen === undefined) throw new Error("plan node not found for revise");
    const plan = asRow(
      host.db
        .prepare("SELECT kind FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
        .get(command.runId, planKey, planGen),
    );
    if (!plan) throw new Error("plan node not found for revise");
    host.db
      .prepare(
        `INSERT INTO nodes (
          run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
        ) VALUES (?, ?, ?, 'ready', ?, NULL, NULL, ?)`,
      )
      .run(
        command.runId,
        planKey,
        requiredText(plan, "kind"),
        planGen + 1,
        command.feedback !== undefined ? JSON.stringify({ feedback: command.feedback }) : null,
      );
    host.db
      .prepare(
        "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, command.runId);
    host.emit(command.runId, "node.ready");
    return;
  }
  if (command.decision === "deny") {
    // Deny applies CancelRun transitions; the gate stays resolved (not withdrawn).
    // No requireActiveState: historical plan-deny updates cancel_requested by run_id only.
    applyRunCancelTransitions(
      {
        db: host.db,
        emit: (runId, type) => host.emit(runId, type),
        abortRunAttempts: (runId) => host.abortRunAttempts(runId),
        withdrawOpenGates: (runId) => withdrawOpenGates(host, runId),
        cancelPreApplyEffects: (runId) => host.cancelPreApplyEffects(runId),
      },
      {
        runId: command.runId,
        timestamp,
        reason: "plan_denied",
        preserveNode: { nodeKey: gateNodeKey, generation: gateNodeGeneration },
      },
    );
    return;
  }
  throw new Error(`unsupported plan gate decision: ${command.decision}`);
}

export function applyOperatorInputGateDecision(
  host: GatesHost,
  command: Extract<RunCommand, { type: "resolve_gate" }>,
  gateNodeKey: string,
  _gateNodeGeneration: number,
  timestamp: string,
): void {
  if (command.decision !== "answer")
    throw new Error(`unsupported operator_input decision: ${command.decision}`);
  // Continuation node shares the gate's node key family; bump generation so a new
  // attempt can claim with the sealed answer as input (execution is T3).
  const current = host.currentNodeRow(command.runId, gateNodeKey);
  if (!current) throw new Error("operator_input node not found");
  const generation = requiredNumber(current, "generation");
  host.db
    .prepare(
      `INSERT INTO nodes (
        run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
      ) VALUES (?, ?, ?, 'ready', ?, NULL, NULL, NULL)`,
    )
    .run(command.runId, gateNodeKey, requiredText(current, "kind"), generation + 1);
  host.db
    .prepare(
      "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(timestamp, command.runId);
  host.emit(command.runId, "node.ready");
}

export function applyPublicationGateDecision(
  host: GatesHost,
  command: Extract<RunCommand, { type: "resolve_gate" }>,
  timestamp: string,
): void {
  if (command.decision === "approve") {
    // ResolveGate(approve) only advances the payload-bound effect prepared → candidate_ready.
    const effect = asRow(
      host.db
        .prepare(
          `SELECT effect_key, state, publication_node_key, publication_node_generation
           FROM effects
           WHERE run_id = ? AND gate_id = ? AND state = 'prepared'`,
        )
        .get(command.runId, command.gateId),
    );
    if (!effect) throw new Error("publication effect not found for approved gate");
    const pubKey = requiredText(effect, "publication_node_key");
    const pubGen = requiredNumber(effect, "publication_node_generation");
    const liveGen = host.currentNodeGeneration(command.runId, pubKey);
    if (liveGen !== pubGen) {
      throw new Error(
        `publication effect generation ${pubGen} is stale (current ${liveGen ?? "none"})`,
      );
    }
    const cas = host.db
      .prepare(
        `UPDATE effects SET state = 'candidate_ready'
         WHERE effect_key = ? AND state = 'prepared'`,
      )
      .run(requiredText(effect, "effect_key"));
    if (cas.changes !== 1) {
      throw new Error("publication effect could not transition to candidate_ready");
    }
    // Unlock publish after gate.publication is already marked succeeded above.
    unlockReadyNodes(host, command.runId);
    host.db
      .prepare(
        "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, command.runId);
    host.emit(command.runId, "effect.candidate_ready");
    return;
  }
  if (command.decision === "revise") {
    // Publication revise: cancel pre-apply effect, then Rerun write.root (repair path)
    // with feedback so validate/review/publication lineage is invalidated (ADR 0035).
    const effect = asRow(
      host.db
        .prepare(
          `SELECT publication_node_key, publication_node_generation, effect_key, state
           FROM effects WHERE run_id = ? AND gate_id = ?`,
        )
        .get(command.runId, command.gateId),
    );
    if (effect) {
      if (["prepared", "candidate_ready"].includes(requiredText(effect, "state"))) {
        host.db
          .prepare(
            "UPDATE effects SET state = 'cancelled' WHERE effect_key = ? AND state IN ('prepared', 'candidate_ready')",
          )
          .run(requiredText(effect, "effect_key"));
      }
    }
    const writeGen = host.currentNodeGeneration(command.runId, "write.root");
    if (writeGen !== undefined) {
      host.applyRerunAt(command.runId, "write.root", writeGen, command.feedback);
    } else if (effect) {
      // Fallback when write.root is absent: bump the publication-owning node alone.
      const pubKey = requiredText(effect, "publication_node_key");
      const pubGen = requiredNumber(effect, "publication_node_generation");
      host.applyRerunAt(command.runId, pubKey, pubGen, command.feedback);
    } else {
      throw new Error("publication revise requires write.root or a publication effect");
    }
    host.emit(command.runId, "node.ready");
    return;
  }
  if (command.decision === "deny") {
    host.db
      .prepare(
        `UPDATE effects SET state = 'cancelled'
         WHERE run_id = ? AND gate_id = ? AND state IN ('prepared', 'candidate_ready')`,
      )
      .run(command.runId, command.gateId);
    host.db
      .prepare("UPDATE runs SET state = 'completed_unpublished', updated_at = ? WHERE run_id = ?")
      .run(timestamp, command.runId);
    host.emit(command.runId, "run.completed_unpublished");
    return;
  }
  throw new Error(`unsupported publication gate decision: ${command.decision}`);
}

export function planNodeKeyForGate(
  host: Pick<GatesHost, "db">,
  runId: string,
  gateNodeKey: string,
): string {
  if (gateNodeKey === "gate.plan" || gateNodeKey.startsWith("gate.plan")) return "plan";
  const plan = asRow(
    host.db
      .prepare(
        `SELECT node_key FROM nodes WHERE run_id = ? AND kind = 'plan'
         ORDER BY generation DESC LIMIT 1`,
      )
      .get(runId),
  );
  if (plan) return requiredText(plan, "node_key");
  return "plan";
}

/** Load a sealed Spec JSON from an artifact relative path under the run work dir. */
export function loadSpecFromArtifact(
  host: Pick<GatesHost, "workspace">,
  runId: string,
  relativePath: string,
) {
  const runDir = runWorkDir(host.workspace.rootPath, runId);
  const artifactRoot = path.join(runDir, relativePath);
  const candidates = [
    path.join(artifactRoot, "spec.json"),
    artifactRoot,
    path.join(artifactRoot, "analysis", "spec.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = WikiRunSpecSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * After plan approve: materialize Definition v1 research → write → validate →
 * review → prepare → gate.publication → publish with durable edges.
 */
/**
 * Insert Definition v1 nodes/edges from a sealed Spec path.
 * Caller sets run state and calls unlockReadyNodes + emit as needed.
 */
export function materializeDefinitionV1Graph(
  host: Pick<GatesHost, "db" | "workspace">,
  runId: string,
  relativePath: string,
): void {
  const spec = loadSpecFromArtifact(host, runId, relativePath);
  if (!spec) throw new Error("plan approve requires a parseable sealed Spec");
  const graph = buildDefinitionV1Graph(spec, {
    reviewCouncilSize: host.workspace.orchestration?.reviewCouncilSize,
  });
  for (const node of graph.nodes) {
    const existing = asRow(
      host.db
        .prepare(
          "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? AND generation = 0",
        )
        .get(runId, node.key),
    );
    if (existing) continue;
    // Gates wait; everything else starts blocked until unlockReadyNodes.
    const initialState = isGateKind(node.kind) ? "blocked" : "blocked";
    host.db
      .prepare(
        `INSERT INTO nodes (
          run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
        ) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)`,
      )
      .run(
        runId,
        node.key,
        node.kind,
        initialState,
        node.detail ? JSON.stringify(node.detail) : null,
      );
  }
  for (const edge of graph.edges) {
    host.db
      .prepare(
        `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, ?)
         ON CONFLICT(run_id, from_key, to_key) DO NOTHING`,
      )
      .run(runId, edge.from, edge.to);
  }
}

/**
 * Promote blocked/invalidated nodes whose current-generation upstreams have all
 * succeeded. After RerunNode, invalidated gen+1 descendants re-enter ready this way.
 * Gate nodes stay blocked/waiting until their predecessor opens them explicitly.
 */
export function unlockReadyNodes(
  host: Pick<GatesHost, "db" | "currentNodeGeneration">,
  runId: string,
): void {
  const candidates = asRows(
    host.db
      .prepare(
        `SELECT nodes.node_key, nodes.kind, nodes.generation, nodes.state
         FROM nodes
         WHERE nodes.run_id = ?
           AND nodes.state IN ('blocked', 'invalidated')
           AND nodes.generation = (
             SELECT MAX(n2.generation) FROM nodes n2
             WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
           )`,
      )
      .all(runId),
  );
  for (const row of candidates) {
    const nodeKey = requiredText(row, "node_key");
    const kind = requiredText(row, "kind");
    const generation = requiredNumber(row, "generation");
    const priorState = requiredText(row, "state");
    if (isGateKind(kind)) continue;
    if (!upstreamsSucceeded(host, runId, nodeKey)) continue;
    host.db
      .prepare(
        `UPDATE nodes SET state = 'ready', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ? AND state = ?`,
      )
      .run(runId, nodeKey, generation, priorState);
  }
}

export function upstreamKeys(
  host: Pick<GatesHost, "db">,
  runId: string,
  nodeKey: string,
): string[] {
  return asRows(
    host.db
      .prepare(
        "SELECT from_key FROM node_edges WHERE run_id = ? AND to_key = ? ORDER BY from_key",
      )
      .all(runId, nodeKey),
  ).map((row) => requiredText(row, "from_key"));
}

export function upstreamsSucceeded(
  host: Pick<GatesHost, "db" | "currentNodeGeneration">,
  runId: string,
  nodeKey: string,
): boolean {
  const upstreams = upstreamKeys(host, runId, nodeKey);
  // Hard-coded bootstrap edges for freeze→plan before node_edges exist.
  if (upstreams.length === 0) {
    if (nodeKey === "plan") {
      const freezeGen = host.currentNodeGeneration(runId, "freeze");
      if (freezeGen === undefined) return false;
      const freeze = asRow(
        host.db
          .prepare(
            "SELECT state FROM nodes WHERE run_id = ? AND node_key = 'freeze' AND generation = ?",
          )
          .get(runId, freezeGen),
      );
      return Boolean(freeze && requiredText(freeze, "state") === "succeeded");
    }
    return true;
  }
  for (const fromKey of upstreams) {
    const gen = host.currentNodeGeneration(runId, fromKey);
    if (gen === undefined) return false;
    const node = asRow(
      host.db
        .prepare("SELECT state FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
        .get(runId, fromKey, gen),
    );
    if (!node || requiredText(node, "state") !== "succeeded") return false;
  }
  return true;
}

export function withdrawOpenGates(host: Pick<GatesHost, "db" | "emit">, runId: string): void {
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
  host: Pick<GatesHost, "db" | "emit">,
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
  host: Pick<GatesHost, "db" | "emit">,
  claim: ClaimedNode,
  specPayloadDigest: string,
  timestamp: string,
): void {
  const gateId = randomUUID();
  const gateNodeKey = "gate.plan";
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
 * Recover the live baseline captured during prepare.publication.
 * Prefers the attempt-private stage copy, then the sealed receipt artifact.
 * Falls back to the canonical empty-tree digest (not 64 zero hex).
 */
export function readPublicationBaseline(
  host: Pick<GatesHost, "workspace">,
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

export function openPublicationGate(
  host: Pick<GatesHost, "db" | "emit" | "currentNodeGeneration">,
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
