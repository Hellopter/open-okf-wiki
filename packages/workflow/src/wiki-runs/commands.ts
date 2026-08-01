/**
 * Durable WikiRuns command application (start / retry / rerun / cancel).
 * Owner binds db/workspace/emit/gate helpers — commands stay free of WikiRunsOwner.
 */

import { randomUUID } from "node:crypto";
import {
  contractForNode,
  RunCommand,
  RunCommandContext,
  RunCommandReceipt,
} from "@okf-wiki/contract";
import { CandidateReview } from "./candidate-review.js";
import { digest, now } from "./crypto-util.js";
import type { WikiRunsDbCtx } from "./ctx.js";
import { countModelWikiCandidates } from "./evaluation/candidate.js";
import {
  continueEvaluationRecovery,
  isRepairNodeKey,
  loadEvaluationPolicy,
} from "./repair-schedule.js";
import { pauseRun, resumeRun, submitRunRevision } from "./run-revision-coordinator.js";
import { applyRunCancelTransitions } from "./run-terminal.js";
import { asRow, asRows, requiredNumber, requiredText, type SqlRow } from "./sql.js";
import { CommandIdCollision, WikiRunsRequestError } from "./types.js";

/**
 * Command application always runs under the owner's outer BEGIN IMMEDIATE
 * (dispatch → applyCommand). Do not put `transaction` on this host — nested
 * BEGIN would throw. Scheduling is the owner's post-commit concern, not commands.
 */
export type CommandsHost = WikiRunsDbCtx & {
  activeAttempts: Map<string, AbortController>;
  currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
  currentNodeRow(runId: string, nodeKey: string): SqlRow | undefined;
  applyRerunAt(
    runId: string,
    nodeKey: string,
    generation: number,
    feedback?: string,
    opts?: { selfOnly?: boolean; excludeConsumer?: (nodeKey: string) => boolean },
  ): void;
  upstreamSealedOutputs(
    runId: string,
    nodeKey: string,
  ): Array<{ role: string; artifactId: string }>;
  abortRunAttempts(runId: string): void;
  withdrawOpenGates(runId: string): void;
  withdrawOpenGatesForNode(runId: string, nodeKey: string, generation: number): void;
  cancelPreApplyEffects(runId: string): void;
  cancelPreApplyEffectsForPublication(
    runId: string,
    publicationNodeKey: string,
    publicationNodeGeneration: number,
  ): void;
  /** Bound to gate-resolve.resolveGate by the owner. */
  resolveGate(
    command: Extract<RunCommand, { type: "resolve_gate" }>,
    context: RunCommandContext,
    payloadDigest: string,
  ): RunCommandReceipt;
};

export function applyCommand(
  host: CommandsHost,
  command: RunCommand,
  context: RunCommandContext,
): RunCommandReceipt {
  const payloadDigest = digest(command);
  const existing = asRow(
    host.db
      .prepare(
        "SELECT payload_digest, run_id, revision, accepted FROM commands WHERE workspace_id = ? AND command_id = ?",
      )
      .get(host.workspace.id, command.commandId),
  );
  if (existing) {
    if (requiredText(existing, "payload_digest") !== payloadDigest)
      throw new CommandIdCollision(command.commandId);
    return {
      commandId: command.commandId,
      runId: requiredText(existing, "run_id"),
      revision: requiredNumber(existing, "revision"),
      accepted: requiredNumber(existing, "accepted") === 1,
    };
  }

  if (command.type !== "start_run") {
    const run = asRow(
      host.db.prepare("SELECT revision FROM runs WHERE run_id = ?").get(command.runId),
    );
    if (!run) throw new WikiRunsRequestError("not_found", `run not found: ${command.runId}`);
    if (requiredNumber(run, "revision") !== command.expectedRevision) {
      throw new WikiRunsRequestError("stale_revision", "stale control revision");
    }
  }

  if (command.type === "retry_failed_node")
    return retryFailedNode(host, command, context, payloadDigest);
  if (command.type === "rerun_node") return rerunNode(host, command, context, payloadDigest);
  if (command.type === "continue_evaluation") {
    return continueEvaluation(host, command, context, payloadDigest);
  }
  if (command.type === "submit_run_revision") {
    return submitRunRevision(host, command, context, payloadDigest);
  }
  if (command.type === "pause_run") return pauseRun(host, command, context, payloadDigest);
  if (command.type === "resume_run") return resumeRun(host, command, context, payloadDigest);
  if (command.type === "create_review_thread") {
    return new CandidateReview(host).createThread(command, context, payloadDigest);
  }
  if (command.type === "resolve_review_thread") {
    return new CandidateReview(host).resolveThread(command, context, payloadDigest);
  }
  if (command.type === "request_repair") {
    return new CandidateReview(host).requestRepair(command, context, payloadDigest);
  }
  if (command.type === "resolve_gate") return host.resolveGate(command, context, payloadDigest);
  if (command.type === "cancel_run") return cancelRun(host, command, context, payloadDigest);
  if (command.type !== "start_run") {
    throw new WikiRunsRequestError(
      "invalid_request",
      `unknown WikiRuns command type: ${String((command as { type?: unknown }).type)}`,
    );
  }

  const runId = randomUUID();
  const timestamp = now();
  contractForNode("freeze", "freeze");
  // Hard-cut: StartRun always carries intent (schema-enforced).
  const intentJson = JSON.stringify(command.intent);
  host.db
    .prepare(
      `INSERT INTO runs (
          run_id, workspace_id, operator_session_id, definition_version, revision, state, cancel_requested,
          freeze_config_json, freeze_config_digest, intent_json,
          frozen_sources_json, frozen_skill_digest,
          pinned_sources_json, skill_digest, pinned_digest, created_at, updated_at
        ) VALUES (?, ?, ?, 5, 0, 'queued', 0, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      runId,
      host.workspace.id,
      context.sessionId ?? null,
      JSON.stringify(host.workspace),
      digest(host.workspace),
      intentJson,
      timestamp,
      timestamp,
    );
  host.db
    .prepare(
      `INSERT INTO nodes (
          run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
        ) VALUES (?, 'freeze', 'freeze', 'ready', 0, NULL, NULL, NULL)`,
    )
    .run(runId);
  const revision = host.emit(runId, "run.started");
  host.db
    .prepare(
      `INSERT INTO commands (
          workspace_id, command_id, payload_digest, actor_id, actor_kind, run_id, revision, accepted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      host.workspace.id,
      command.commandId,
      payloadDigest,
      context.actor.id,
      context.actor.kind,
      runId,
      revision,
    );
  return { commandId: command.commandId, runId, revision, accepted: true };
}

export function retryFailedNode(
  host: CommandsHost,
  command: Extract<RunCommand, { type: "retry_failed_node" }>,
  context: RunCommandContext,
  payloadDigest: string,
): RunCommandReceipt {
  const currentGeneration = host.currentNodeGeneration(command.runId, command.nodeKey);
  if (currentGeneration === undefined || currentGeneration !== command.generation) {
    throw new WikiRunsRequestError(
      "stale_revision",
      "retry target is stale: generation is not current",
    );
  }
  const node = asRow(
    host.db
      .prepare(
        `SELECT nodes.state, nodes.last_attempt_id, nodes.kind, attempts.state AS attempt_state,
                  attempts.input_digest, runs.pinned_digest, runs.state AS run_state
           FROM nodes JOIN attempts ON attempts.attempt_id = nodes.last_attempt_id
           JOIN runs ON runs.run_id = nodes.run_id
           WHERE nodes.run_id = ? AND nodes.node_key = ? AND nodes.generation = ?
             AND nodes.last_attempt_id = ? AND runs.cancel_requested = 0`,
      )
      .get(command.runId, command.nodeKey, command.generation, command.attemptId),
  );
  if (
    !node ||
    requiredText(node, "state") !== "failed" ||
    !["failed", "interrupted"].includes(requiredText(node, "attempt_state"))
  ) {
    throw new WikiRunsRequestError(
      "stale_revision",
      "retry target is stale or not a failed attempt",
    );
  }
  const runState = requiredText(node, "run_state");
  if (runState === "published")
    throw new WikiRunsRequestError(
      "conflict",
      "cannot retry a node on a published run; start a new run",
    );
  if (runState === "cancelled") {
    throw new WikiRunsRequestError("conflict", "cannot retry a node on a cancelled run");
  }
  // A pre-pin freeze has only live selectors, not immutable inputs. Retrying it
  // under the old digest would falsely claim reproducibility.
  if (command.nodeKey === "freeze" && node.pinned_digest === null)
    throw new WikiRunsRequestError(
      "conflict",
      "cannot retry a freeze before its inputs are pinned; start a new run",
    );
  // If any downstream Attempt already bound this generation's outputs, same-input
  // retry is no longer valid — operator must RerunNode (generation++ + invalidation).
  const consumers = lineageInvalidationClosure(
    host,
    command.runId,
    command.nodeKey,
    command.generation,
  );
  if (consumers.length > 0) {
    throw new WikiRunsRequestError(
      "conflict",
      "downstream already consumed this node's outputs; use RerunNode instead of RetryFailedNode",
    );
  }
  // Frozen input digest must still match current sealed upstreams (or prior attempt
  // inputs when freeze post-pin reuses pins). Changed lineage → RerunNode.
  if (command.nodeKey !== "freeze") {
    const priorDigest = requiredText(node, "input_digest");
    const liveDigest = liveInputDigest(host, command.runId, command.nodeKey);
    if (liveDigest !== priorDigest) {
      throw new WikiRunsRequestError(
        "stale_revision",
        "retry inputs are stale: sealed upstream lineage changed; use RerunNode",
      );
    }
  }
  requeueFailedNode(host, command.runId, command.nodeKey, command.generation, command.attemptId);
  const revision = host.emit(command.runId, "node.ready");
  recordCommand(host, command, context, payloadDigest, command.runId, revision);
  return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
}

/** Shared path for manual RetryFailedNode and research auto-retry. */
export function requeueFailedNode(
  host: Pick<CommandsHost, "db">,
  runId: string,
  nodeKey: string,
  generation: number,
  lastAttemptId: string,
): void {
  const timestamp = now();
  host.db
    .prepare(
      `UPDATE nodes SET state = 'ready', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ? AND last_attempt_id = ? AND state = 'failed'`,
    )
    .run(runId, nodeKey, generation, lastAttemptId);
  host.db
    .prepare(
      "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(timestamp, runId);
}

/** Digest of current sealed upstream envelope (same algorithm as first claim). */
export function liveInputDigest(host: CommandsHost, runId: string, nodeKey: string): string {
  const upstreams = host.upstreamSealedOutputs(runId, nodeKey);
  return digest(upstreams.map((input) => ({ role: input.role, artifactId: input.artifactId })));
}

export function cancelRun(
  host: CommandsHost,
  command: Extract<RunCommand, { type: "cancel_run" }>,
  context: RunCommandContext,
  payloadDigest: string,
): RunCommandReceipt {
  const run = asRow(
    host.db.prepare("SELECT cancel_requested, state FROM runs WHERE run_id = ?").get(command.runId),
  );
  if (!run) throw new WikiRunsRequestError("not_found", `run not found: ${command.runId}`);
  const state = requiredText(run, "state");
  if (
    !["queued", "running", "waiting_for_operator", "pausing", "paused", "cancelling"].includes(
      state,
    )
  )
    throw new WikiRunsRequestError("conflict", `cannot cancel run in terminal state: ${state}`);
  const timestamp = now();
  const result = applyRunCancelTransitions(host, {
    runId: command.runId,
    timestamp,
    reason: "cancel_requested",
    skipIfAlreadyRequested: true,
    requireActiveState: true,
  });
  // Shared path emits run.cancelled when it mutates; re-ack still emits for the receipt.
  const revision = result.didMutate ? result.revision : host.emit(command.runId, "run.cancelled");
  recordCommand(host, command, context, payloadDigest, command.runId, revision);
  return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
}

export function rerunNode(
  host: CommandsHost,
  command: Extract<RunCommand, { type: "rerun_node" }>,
  context: RunCommandContext,
  payloadDigest: string,
): RunCommandReceipt {
  const run = asRow(
    host.db.prepare("SELECT cancel_requested, state FROM runs WHERE run_id = ?").get(command.runId),
  );
  if (!run) throw new WikiRunsRequestError("not_found", `run not found: ${command.runId}`);
  if (requiredNumber(run, "cancel_requested") === 1)
    throw new WikiRunsRequestError("conflict", "cannot rerun a node on a cancelled run");
  const runState = requiredText(run, "state");
  if (runState === "published") {
    throw new WikiRunsRequestError("conflict", "cannot rerun a published run; start a new run");
  }
  if (runState === "cancelled") {
    throw new WikiRunsRequestError("conflict", "cannot rerun a node on a cancelled run");
  }
  if (isRepairNodeKey(command.nodeKey)) {
    throw new WikiRunsRequestError(
      "conflict",
      "cannot rerun a repair node; retry a failed repair or schedule a new repair through evaluation",
    );
  }
  if (command.nodeKey === "write.root") {
    const policy = loadEvaluationPolicy(host, command.runId);
    const candidates = countModelWikiCandidates(host, command.runId);
    if (candidates >= policy.maxCandidates) {
      throw new WikiRunsRequestError(
        "conflict",
        `cannot rerun write.root: wiki candidate cap reached (${candidates}/${policy.maxCandidates})`,
      );
    }
  }
  if (command.nodeKey === "plan" && hasMaterializedExecutionTopology(host, command.runId)) {
    throw new WikiRunsRequestError(
      "conflict",
      "cannot rerun plan after execution topology is materialized; start a new run instead",
    );
  }
  if (command.nodeKey === "plan") {
    host.withdrawOpenGatesForNode(command.runId, "gate.plan", command.generation);
    supersedeClaimableNode(host, command.runId, "gate.plan", command.generation);
  }

  applyRerunAt(host, command.runId, command.nodeKey, command.generation, command.feedback);
  const revision = host.emit(command.runId, "node.ready");
  recordCommand(host, command, context, payloadDigest, command.runId, revision);
  return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
}

function hasMaterializedExecutionTopology(host: Pick<CommandsHost, "db">, runId: string): boolean {
  // Before approval, the durable bootstrap contains only freeze, plan, and gate.plan.
  return Boolean(
    asRow(
      host.db
        .prepare(
          `SELECT 1 AS present FROM nodes
           WHERE run_id = ? AND node_key NOT IN ('freeze', 'plan', 'gate.plan')
           LIMIT 1`,
        )
        .get(runId),
    ),
  );
}

export function continueEvaluation(
  host: CommandsHost,
  command: Extract<RunCommand, { type: "continue_evaluation" }>,
  context: RunCommandContext,
  payloadDigest: string,
): RunCommandReceipt {
  const revision = continueEvaluationRecovery(host, command);
  recordCommand(host, command, context, payloadDigest, command.runId, revision);
  return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
}

export type ApplyRerunAtOptions = {
  /**
   * When true, only bump `nodeKey` (no attempt_inputs consumer lineage).
   * Used after repair.N to re-arm validate.pre / seats / reduce without
   * invalidating the just-succeeded repair stage (which consumed upstream outputs).
   */
  selfOnly?: boolean;
  /**
   * Drop lineage consumers whose node_key matches this predicate.
   * Ignored when selfOnly is true.
   */
  excludeConsumer?: (nodeKey: string) => boolean;
};

/**
 * Core RerunNode: generation++ on target + actual lineage consumers, withdraw
 * gates, cancel pre-apply effects, persist optional feedback on the new root gen.
 * Shared by the rerun_node command and publication-gate revise.
 */
export function applyRerunAt(
  host: CommandsHost,
  runId: string,
  nodeKey: string,
  generation: number,
  feedback?: string,
  opts?: ApplyRerunAtOptions,
): void {
  const current = host.currentNodeRow(runId, nodeKey);
  if (!current) {
    throw new WikiRunsRequestError(
      "stale_revision",
      `rerun target is stale: node not found: ${nodeKey}`,
    );
  }
  const liveGeneration = requiredNumber(current, "generation");
  if (liveGeneration !== generation)
    throw new WikiRunsRequestError(
      "stale_revision",
      "rerun target is stale: generation does not match",
    );

  const timestamp = now();
  const affected = opts?.selfOnly
    ? []
    : lineageInvalidationClosure(host, runId, nodeKey, generation).filter((item) =>
        opts?.excludeConsumer ? !opts.excludeConsumer(item.nodeKey) : true,
      );
  // Target is always included; downstream only when they consumed old outputs.
  const targets = new Map<string, { nodeKey: string; generation: number; kind: string }>();
  targets.set(`${nodeKey}@${generation}`, {
    nodeKey,
    generation,
    kind: requiredText(current, "kind"),
  });
  for (const item of affected) {
    targets.set(`${item.nodeKey}@${item.generation}`, item);
  }

  for (const target of targets.values()) {
    cancelNodeAttempts(host, runId, target.nodeKey, target.generation, "superseded");
    host.withdrawOpenGatesForNode(runId, target.nodeKey, target.generation);
    host.cancelPreApplyEffectsForPublication(runId, target.nodeKey, target.generation);
    // Old claimable generations must not remain ready/running beside gen+1.
    supersedeClaimableNode(host, runId, target.nodeKey, target.generation);
    const isRoot = target.nodeKey === nodeKey && target.generation === generation;
    const nextGeneration = target.generation + 1;
    // Avoid colliding if a higher generation already exists.
    const existingNext = asRow(
      host.db
        .prepare(
          "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
        )
        .get(runId, target.nodeKey, nextGeneration),
    );
    if (existingNext)
      throw new WikiRunsRequestError(
        "stale_revision",
        "rerun target is stale: newer generation already exists",
      );

    // Copy prior generation detail so definition question/lens/… survive gen bumps.
    // Root target: merge optional operator feedback into that detail (do not replace).
    const priorRow = asRow(
      host.db
        .prepare(
          "SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
        )
        .get(runId, target.nodeKey, target.generation),
    );
    const priorDetailJson =
      priorRow?.detail_json != null && priorRow.detail_json !== ""
        ? String(priorRow.detail_json)
        : null;
    let nextDetailJson: string | null = priorDetailJson;
    if (isRoot) {
      let base: Record<string, unknown> = {};
      if (priorDetailJson) {
        try {
          const parsed = JSON.parse(priorDetailJson) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            base = { ...(parsed as Record<string, unknown>) };
          }
        } catch {
          // Corrupt prior detail: start from empty and still persist feedback.
        }
      }
      if (feedback !== undefined) base.feedback = feedback;
      nextDetailJson = Object.keys(base).length > 0 ? JSON.stringify(base) : null;
    }

    contractForNode(target.kind, target.nodeKey);
    host.db
      .prepare(
        `INSERT INTO nodes (
            run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        runId,
        target.nodeKey,
        target.kind,
        isRoot ? "ready" : "invalidated",
        nextGeneration,
        nextDetailJson,
      );
  }

  host.db
    .prepare(
      "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(timestamp, runId);
}

/** Mark a replaced generation non-claimable; keep terminal succeeded/failed for audit. */
export function supersedeClaimableNode(
  host: Pick<CommandsHost, "db">,
  runId: string,
  nodeKey: string,
  generation: number,
): void {
  host.db
    .prepare(
      `UPDATE nodes SET state = 'cancelled', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ?
           AND state IN ('blocked', 'ready', 'running', 'waiting', 'invalidated')`,
    )
    .run(runId, nodeKey, generation);
}

/** Transitive consumers of `(nodeKey, generation)` outputs via attempt_inputs lineage. */
export function lineageInvalidationClosure(
  host: Pick<CommandsHost, "db" | "currentNodeGeneration">,
  runId: string,
  nodeKey: string,
  generation: number,
): Array<{ nodeKey: string; generation: number; kind: string }> {
  const result: Array<{ nodeKey: string; generation: number; kind: string }> = [];
  const queue: Array<{ nodeKey: string; generation: number }> = [{ nodeKey, generation }];
  const seen = new Set<string>([`${nodeKey}@${generation}`]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const consumers = asRows(
      host.db
        .prepare(
          `SELECT DISTINCT attempts.node_key, attempts.node_generation, nodes.kind
             FROM node_outputs
             JOIN attempt_inputs ON attempt_inputs.artifact_id = node_outputs.artifact_id
             JOIN attempts ON attempts.attempt_id = attempt_inputs.attempt_id
             JOIN nodes ON nodes.run_id = attempts.run_id
               AND nodes.node_key = attempts.node_key
               AND nodes.generation = attempts.node_generation
             WHERE node_outputs.run_id = ?
               AND node_outputs.node_key = ?
               AND node_outputs.node_generation = ?
               AND attempts.run_id = ?`,
        )
        .all(runId, current.nodeKey, current.generation, runId),
    );
    for (const consumer of consumers) {
      const consumerKey = requiredText(consumer, "node_key");
      const consumerGen = requiredNumber(consumer, "node_generation");
      // Only invalidate the still-current generation of each consumer key.
      const liveGen = host.currentNodeGeneration(runId, consumerKey);
      if (liveGen !== consumerGen) continue;
      const id = `${consumerKey}@${consumerGen}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const item = {
        nodeKey: consumerKey,
        generation: consumerGen,
        kind: requiredText(consumer, "kind"),
      };
      result.push(item);
      queue.push({ nodeKey: consumerKey, generation: consumerGen });
    }
  }
  return result;
}

export function cancelNodeAttempts(
  host: Pick<CommandsHost, "db" | "activeAttempts">,
  runId: string,
  nodeKey: string,
  generation: number,
  reason: string,
): void {
  const timestamp = now();
  const running = asRows(
    host.db
      .prepare(
        `SELECT attempt_id FROM attempts
           WHERE run_id = ? AND node_key = ? AND node_generation = ? AND state = 'running'`,
      )
      .all(runId, nodeKey, generation),
  );
  for (const attempt of running) {
    const attemptId = requiredText(attempt, "attempt_id");
    host.activeAttempts.get(attemptId)?.abort();
    host.db
      .prepare(
        "UPDATE attempts SET state = 'cancelled', error = ?, ended_at = ? WHERE attempt_id = ? AND state = 'running'",
      )
      .run(reason, timestamp, attemptId);
  }
  host.db
    .prepare(
      `UPDATE nodes SET current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ?`,
    )
    .run(runId, nodeKey, generation);
}

export function recordCommand(
  host: Pick<CommandsHost, "db" | "workspace">,
  command: RunCommand,
  context: RunCommandContext,
  payloadDigest: string,
  runId: string,
  revision: number,
): void {
  host.db
    .prepare(
      `INSERT INTO commands (
          workspace_id, command_id, payload_digest, actor_id, actor_kind, run_id, revision, accepted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      host.workspace.id,
      command.commandId,
      payloadDigest,
      context.actor.id,
      context.actor.kind,
      runId,
      revision,
    );
}
