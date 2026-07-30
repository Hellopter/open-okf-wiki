/**
 * Gate resolve + decision handlers (plan / operator_input / publication / fix).
 * Expire of stale open gates lives here because it re-enters resolveGate.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type RunCommand,
  type RunCommandContext,
  type RunCommandReceipt,
} from "@okf-wiki/contract";
import { runWorkDir } from "@okf-wiki/core";
import type { WikiRunsDbCtx } from "./ctx.js";
import { artifactId, digest, now } from "./crypto-util.js";
import {
  materializeDefinitionV1Graph,
  planNodeKeyForGate,
  unlockReadyNodes,
} from "./dag.js";
import { withdrawOpenGates } from "./gate-open.js";
import { scheduleReviewRepair } from "./repair-schedule.js";
import { applyRunCancelTransitions } from "./run-terminal.js";
import { asRow, asRows, requiredNumber, requiredText, type SqlRow } from "./sql.js";

/**
 * Full resolve surface: decision handlers need rerun/cancel/command recording.
 * Open helpers take narrower picks from gate-open.ts.
 */
export type GatesHost = WikiRunsDbCtx & {
  currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
  currentNodeRow(runId: string, nodeKey: string): SqlRow | undefined;
  abortRunAttempts(runId: string): void;
  cancelPreApplyEffects(runId: string): void;
  applyRerunAt(
    runId: string,
    nodeKey: string,
    generation: number,
    feedback?: string,
    opts?: { selfOnly?: boolean; excludeConsumer?: (nodeKey: string) => boolean },
  ): void;
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

  // Plan/fix/publication gates own dedicated gate.* nodes that succeed on resolve.
  // operator_input attaches to the Pi node: gen N stays non-succeeded (waiting) so
  // downstream unlock cannot race; gen N+1 re-runs with frozen inputs + answer.
  if (command.gateKind !== "operator_input") {
    host.db
      .prepare(
        `UPDATE nodes SET state = 'succeeded', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ? AND state IN ('waiting', 'ready', 'running')`,
      )
      .run(command.runId, nodeKey, nodeGeneration);
  }

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
    case "fix":
      applyFixGateDecision(host, command, nodeKey, nodeGeneration, timestamp);
      break;
  }

  const revision = host.emit(command.runId, "gate.resolved");
  host.recordCommand(command, context, payloadDigest, command.runId, revision);
  return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
}

/**
 * Single plan-accepted path: materialize Definition v1, mark running, unlock, emit.
 * Used by ResolveGate(plan approve) and planConfirm===false auto-approve.
 */
export function onPlanAccepted(
  host: WikiRunsDbCtx & {
    currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
  },
  runId: string,
  relativePath: string,
  timestamp: string,
): void {
  materializeDefinitionV1Graph(host, runId, relativePath);
  host.db
    .prepare(
      "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(timestamp, runId);
  unlockReadyNodes(host, runId);
  host.emit(runId, "node.ready");
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
    onPlanAccepted(host, command.runId, requiredText(spec, "relative_path"), timestamp);
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

/**
 * Seal the operator answer as an `operator_input` Artifact, keep the old Attempt
 * suspended (audit-only), and unlock a new generation Attempt that binds the
 * parent frozen inputs + answer. Restart never resumes the old Pi worker.
 */
export function applyOperatorInputGateDecision(
  host: GatesHost,
  command: Extract<RunCommand, { type: "resolve_gate" }>,
  gateNodeKey: string,
  gateNodeGeneration: number,
  timestamp: string,
): void {
  if (command.decision !== "answer")
    throw new Error(`unsupported operator_input decision: ${command.decision}`);
  const answer = command.answer?.trim();
  if (!answer) throw new Error("operator_input answer requires non-empty answer text");

  const current = host.currentNodeRow(command.runId, gateNodeKey);
  if (!current) throw new Error("operator_input node not found");
  const generation = requiredNumber(current, "generation");
  if (generation !== gateNodeGeneration) {
    throw new Error("operator_input gate is stale: node generation was replaced");
  }
  if (requiredText(current, "state") !== "waiting") {
    throw new Error("operator_input node is not waiting for an answer");
  }

  // Parent Attempt must remain suspended (not re-run / not failed).
  const parentAttemptId =
    (current.last_attempt_id != null && String(current.last_attempt_id).trim()) ||
    (current.current_attempt_id != null && String(current.current_attempt_id).trim()) ||
    "";
  if (!parentAttemptId) throw new Error("operator_input parent attempt not found");
  const parentAttempt = asRow(
    host.db
      .prepare(`SELECT attempt_id, state, node_generation FROM attempts WHERE attempt_id = ?`)
      .get(parentAttemptId),
  );
  if (!parentAttempt || requiredText(parentAttempt, "state") !== "suspended") {
    throw new Error("operator_input parent attempt is not suspended");
  }
  if (requiredNumber(parentAttempt, "node_generation") !== gateNodeGeneration) {
    throw new Error("operator_input parent attempt generation mismatch");
  }

  const nextGen = generation + 1;
  const existingNext = asRow(
    host.db
      .prepare(
        "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
      )
      .get(command.runId, gateNodeKey, nextGen),
  );
  if (existingNext) {
    throw new Error("operator_input answer is stale: newer generation already exists");
  }

  // Seal answer bytes under run artifacts/ (sync: resolveGate runs inside BEGIN IMMEDIATE).
  const payload = {
    version: 1 as const,
    kind: "operator_input" as const,
    answer,
    gateId: command.gateId,
    nodeKey: gateNodeKey,
    nodeGeneration: gateNodeGeneration,
    parentAttemptId,
    decidedAt: timestamp,
    actor: "operator",
  };
  const contentDigest = digest(payload);
  const artId = artifactId(command.runId, "operator_input", contentDigest);
  const relativePath = `artifacts/operator_input-${contentDigest}`;
  const destDir = path.join(runWorkDir(host.workspace.rootPath, command.runId), relativePath);
  mkdirSync(destDir, { recursive: true });
  writeFileSync(
    path.join(destDir, "operator-input.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );

  host.db
    .prepare(
      `INSERT INTO artifacts (artifact_id, run_id, kind, digest, relative_path, producer_attempt_id, sealed_at)
       VALUES (?, ?, 'operator_input', ?, ?, ?, ?)
       ON CONFLICT(artifact_id) DO NOTHING`,
    )
    .run(artId, command.runId, contentDigest, relativePath, parentAttemptId, timestamp);

  // Preserve prior definition detail (question/lens/…) and attach continuation pointers.
  let priorDetail: Record<string, unknown> = {};
  if (current.detail_json != null && current.detail_json !== "") {
    try {
      const parsed = JSON.parse(String(current.detail_json)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        priorDetail = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      priorDetail = {};
    }
  }
  const nextDetail = {
    ...priorDetail,
    parentAttemptId,
    operatorInputArtifactId: artId,
    operatorInputGateId: command.gateId,
  };

  // Old gen stays waiting (non-succeeded) so unlockReadyNodes cannot treat it as done.
  host.db
    .prepare(
      `INSERT INTO nodes (
        run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
      ) VALUES (?, ?, ?, 'ready', ?, NULL, NULL, ?)`,
    )
    .run(
      command.runId,
      gateNodeKey,
      requiredText(current, "kind"),
      nextGen,
      JSON.stringify(nextDetail),
    );

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

/**
 * Fix gate decisions after review.reduce sealed defects:
 * - pass — accept wiki; unlock validate.final
 * - deny — mark run failed
 * - fix — schedule repair.review.N (kind=repair) with optional notes under maxRepairRounds
 * - revise — re-open gate.fix at gen+1 with notes baked into payload digest
 */
export function applyFixGateDecision(
  host: GatesHost,
  command: Extract<RunCommand, { type: "resolve_gate" }>,
  gateNodeKey: string,
  gateNodeGeneration: number,
  timestamp: string,
): void {
  if (command.decision === "pass") {
    host.db
      .prepare(
        "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, command.runId);
    unlockReadyNodes(host, command.runId);
    host.emit(command.runId, "node.ready");
    return;
  }

  if (command.decision === "deny") {
    host.db
      .prepare("UPDATE runs SET state = 'failed', updated_at = ? WHERE run_id = ?")
      .run(timestamp, command.runId);
    return;
  }

  if (command.decision === "revise") {
    if (!command.feedback?.trim()) {
      throw new Error("fix gate revise requires feedback");
    }
    const nextGen = gateNodeGeneration + 1;
    const existingNext = asRow(
      host.db
        .prepare(
          "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
        )
        .get(command.runId, gateNodeKey, nextGen),
    );
    if (existingNext) throw new Error("fix gate revise is stale: newer generation already exists");

    const newPayloadDigest = digest({
      priorPayloadDigest: command.payloadDigest,
      notes: command.feedback.trim(),
      revisedAt: timestamp,
    });
    const detailJson = JSON.stringify({
      feedback: command.feedback.trim(),
      priorPayloadDigest: command.payloadDigest,
      source: "review",
    });

    host.db
      .prepare(
        `INSERT INTO nodes (
          run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
        ) VALUES (?, ?, 'gate.fix', 'waiting', ?, NULL, NULL, ?)`,
      )
      .run(command.runId, gateNodeKey, nextGen, detailJson);

    const gateId = randomUUID();
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
        command.runId,
        gateNodeKey,
        nextGen,
        newPayloadDigest,
        detailJson,
        timestamp,
        command.runId,
      );
    host.db
      .prepare(
        "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, command.runId);
    host.emit(command.runId, "gate.opened");
    return;
  }

  if (command.decision === "fix") {
    scheduleReviewRepair(host, command, timestamp);
    return;
  }

  throw new Error(`unsupported fix gate decision: ${command.decision}`);
}

/**
 * Auto-deny open plan/publication/fix gates older than workspace.limits.gateTimeoutSeconds.
 * 0 / unset disables. Called from owner schedule/dispatch/read so long waits still expire
 * when any control activity (or Run poll) occurs.
 */
export function expireStaleOpenGates(host: GatesHost): number {
  const timeoutSec = host.workspace.limits?.gateTimeoutSeconds ?? 0;
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return 0;
  const cutoffMs = Date.now() - timeoutSec * 1_000;
  const open = asRows(
    host.db
      .prepare(
        `SELECT gate_id, run_id, kind, payload_digest, opened_at
         FROM gates WHERE state = 'open' AND kind IN ('plan', 'publication', 'fix')
         ORDER BY opened_at, gate_id`,
      )
      .all(),
  );
  let expired = 0;
  for (const row of open) {
    const openedAt = requiredText(row, "opened_at");
    const openedMs = Date.parse(openedAt);
    if (!Number.isFinite(openedMs) || openedMs > cutoffMs) continue;
    const gateId = requiredText(row, "gate_id");
    const runId = requiredText(row, "run_id");
    const kind = requiredText(row, "kind") as "plan" | "publication" | "fix";
    const payloadDigest = requiredText(row, "payload_digest");
    const commandId = `gate-timeout:${gateId}`;
    // plan/publication deny with "deny"; fix gate uses "deny" as well (abandon).
    const command = {
      type: "resolve_gate" as const,
      commandId,
      runId,
      gateId,
      gateKind: kind,
      decision: "deny" as const,
      payloadDigest,
    };
    try {
      // command.payloadDigest is the sealed gate payload; recordCommand uses digest(command).
      resolveGate(
        host,
        command,
        {
          workspaceId: host.workspace.id,
          actor: { id: "system-gate-timeout", kind: "local_operator" },
        },
        digest(command),
      );
      expired += 1;
    } catch {
      // Stale race / already closed — ignore and continue.
    }
  }
  return expired;
}
