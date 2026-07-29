/**
 * Ready-node claim, attempt execution (Pi + mechanical), fail/retry, abort.
 * Owner binds db/workspace/transaction/emit — scheduler stays free of WikiRunsOwner.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  PiAttemptArtifactDescriptor,
  PiAttemptExecutor,
  PiAttemptInput,
  PiAttemptOutcome,
  WikiRunArtifactKind,
  WikiRunEvent,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import { runWorkDir } from "@okf-wiki/core";
import {
  isGateKind,
  isMechanicalAttemptKind,
  isPiAttemptKind,
} from "../definition-v1.js";
import { canClaimKind } from "./concurrency.js";
import { digest, now } from "./crypto-util.js";
import { asRow, asRows, requiredNumber, requiredText, type SqlRow } from "./sql.js";
import { writeConversationTranscript } from "./transcript-io.js";
import type {
  ArtifactPreparation,
  ClaimedFreeze,
  ClaimedNode,
  TrustedFrozenInputs,
} from "./types.js";
import {
  RESEARCH_AUTO_RETRY_KINDS,
  RESEARCH_AUTO_RETRY_MAX_ATTEMPTS,
} from "./types.js";

export type SchedulerHost = {
  workspace: WorkspaceConfig;
  db: DatabaseSync;
  closed: boolean;
  piAttemptExecutor?: PiAttemptExecutor;
  activeAttempts: Map<string, AbortController>;
  activeExecutions: Map<string, Promise<void>>;
  transaction<T>(work: () => T): T;
  emit(runId: string, type: WikiRunEvent["type"]): number;
  isCurrent(claim: ClaimedNode): boolean;
  upstreamsSucceeded(runId: string, nodeKey: string): boolean;
  upstreamSealedOutputs(
    runId: string,
    nodeKey: string,
  ): Array<{ role: string; artifactId: string }>;
  copyAttemptInputs(
    attemptId: string,
    inputs: Array<{ role: string; artifactId: string }>,
  ): void;
  bindAttemptInputs(attemptId: string, runId: string, nodeKey: string): void;
  executeFreeze(claim: ClaimedFreeze): Promise<void>;
  executeMechanical(claim: ClaimedNode, signal: AbortSignal): Promise<PiAttemptOutcome>;
  prepareUnsealedArtifact(
    claim: ClaimedNode,
    descriptor: PiAttemptArtifactDescriptor,
  ): Promise<ArtifactPreparation | undefined>;
  sealPreparation(runId: string, preparation: ArtifactPreparation): Promise<void>;
  commitNodeArtifacts(claim: ClaimedNode, preparations: ArtifactPreparation[]): void;
  orphanPreparedArtifacts(attemptId: string): void;
  requeueFailedNode(
    runId: string,
    nodeKey: string,
    generation: number,
    lastAttemptId: string,
  ): void;
  unlockReadyNodes(runId: string): void;
  trustedPinnedInputs(runId: string): TrustedFrozenInputs | undefined;
  attemptInputDigest(attemptId: string): string;
};

/**
 * Drain ready claims until the owner closes or the queue is empty.
 *
 * Independent ready nodes (multi-domain leaves, review seats, …) run under
 * workspace.orchestration concurrency — not one-at-a-time serial await.
 */
export async function runScheduler(host: SchedulerHost): Promise<void> {
  const pending = new Set<Promise<void>>();

  const launch = (claim: ClaimedNode): void => {
    const execution =
      claim.kind === "freeze" ? host.executeFreeze(claim) : executeClaimed(host, claim);
    host.activeExecutions.set(claim.attemptId, execution);
    const tracked = execution.finally(() => {
      host.activeExecutions.delete(claim.attemptId);
      pending.delete(tracked);
    });
    pending.add(tracked);
  };

  while (!host.closed) {
    // Fill free concurrency slots while ready work remains.
    while (!host.closed) {
      const claim = host.transaction(() => claimReadyNode(host));
      if (!claim) break;
      launch(claim);
    }

    if (pending.size === 0) return;

    // Wait for at least one Attempt to finish, then re-fill (unlock may add ready nodes).
    await Promise.race(pending);
  }

  if (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}

/**
 * Count in-flight Attempts by kind for concurrency gates.
 * Uses durable `nodes.state = 'running'` so each claim transaction sees prior claims.
 */
export function runningCountByKind(host: SchedulerHost): Map<string, number> {
  const counts = new Map<string, number>();
  const rows = asRows(
    host.db
      .prepare(
        `SELECT kind, COUNT(*) AS count FROM nodes
         WHERE state = 'running'
           AND generation = (
             SELECT MAX(n2.generation) FROM nodes n2
             WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
           )
         GROUP BY kind`,
      )
      .all(),
  );
  for (const row of rows) {
    counts.set(requiredText(row, "kind"), requiredNumber(row, "count"));
  }
  return counts;
}

/**
 * Claim any ready node at max generation with sealed upstreams.
 * Prefer freeze, then mechanical, then Pi (when executor is wired).
 * Skips kinds already at workspace.orchestration concurrency.
 */
export function claimReadyNode(host: SchedulerHost): ClaimedNode | undefined {
  const running = runningCountByKind(host);

  if (canClaimKind(host.workspace, "freeze", running)) {
    const freeze = claimNodeByKey(host, "freeze", "freeze");
    if (freeze) return freeze;
  }

  const ready = asRows(
    host.db
      .prepare(
        `SELECT nodes.run_id, nodes.node_key, nodes.kind, nodes.generation, runs.created_at
         FROM nodes JOIN runs ON runs.run_id = nodes.run_id
         WHERE nodes.state = 'ready'
           AND runs.cancel_requested = 0
           AND runs.state IN ('queued', 'running')
           AND nodes.generation = (
             SELECT MAX(n2.generation) FROM nodes n2
             WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
           )
         ORDER BY runs.created_at, nodes.node_key`,
      )
      .all(),
  );
  // Mechanical first so validate/publish never stall behind optional Pi.
  const ordered = [
    ...ready.filter((row) => isMechanicalAttemptKind(requiredText(row, "kind"))),
    ...ready.filter((row) => isPiAttemptKind(requiredText(row, "kind"))),
  ];
  for (const row of ordered) {
    const kind = requiredText(row, "kind");
    const nodeKey = requiredText(row, "node_key");
    if (nodeKey === "freeze") continue;
    if (isGateKind(kind)) continue;
    if (isPiAttemptKind(kind) && !host.piAttemptExecutor) continue;
    if (!canClaimKind(host.workspace, kind, running)) continue;
    if (!host.upstreamsSucceeded(requiredText(row, "run_id"), nodeKey)) continue;
    const claim = claimPreparedRow(host, row);
    if (claim) {
      // Reserve the slot in this transaction fill pass so sibling claims see it.
      running.set(kind, (running.get(kind) ?? 0) + 1);
      return claim;
    }
  }
  return undefined;
}

export function claimNodeByKey(
  host: SchedulerHost,
  nodeKey: string,
  kind: string,
): ClaimedNode | undefined {
  const node = asRow(
    host.db
      .prepare(
        `SELECT nodes.run_id, nodes.node_key, nodes.kind, nodes.generation, runs.created_at,
                runs.freeze_config_digest
         FROM nodes JOIN runs ON runs.run_id = nodes.run_id
         WHERE nodes.node_key = ? AND nodes.kind = ? AND nodes.state = 'ready'
           AND runs.cancel_requested = 0 AND runs.state IN ('queued', 'running')
           AND nodes.generation = (
             SELECT MAX(n2.generation) FROM nodes n2
             WHERE n2.run_id = nodes.run_id AND n2.node_key = ?
           )
         ORDER BY runs.created_at LIMIT 1`,
      )
      .get(nodeKey, kind, nodeKey),
  );
  if (!node) return undefined;
  if (nodeKey !== "freeze" && !host.upstreamsSucceeded(requiredText(node, "run_id"), nodeKey)) {
    return undefined;
  }
  return claimPreparedRow(host, node);
}

export function claimPreparedRow(host: SchedulerHost, node: SqlRow): ClaimedNode | undefined {
  const runId = requiredText(node, "run_id");
  const nodeKey = requiredText(node, "node_key");
  const kind = requiredText(node, "kind");
  const generation = requiredNumber(node, "generation");
  const attemptId = randomUUID();
  const upstreams = host.upstreamSealedOutputs(runId, nodeKey);
  // Freeze has no sealed upstreams; every other node needs at least freeze pins
  // (or explicit edge outputs) before claim.
  if (
    nodeKey !== "freeze" &&
    upstreams.length === 0 &&
    !host.upstreamsSucceeded(runId, nodeKey)
  ) {
    return undefined;
  }
  // RetryFailedNode / research auto-retry: reuse the exact failed Attempt's
  // input_digest + attempt_inputs rather than re-picking "current latest".
  const retrySource = retrySourceAttempt(host, runId, nodeKey, generation);
  const inputDigest = retrySource
    ? retrySource.inputDigest
    : nodeKey === "freeze" && typeof node.freeze_config_digest === "string"
      ? requiredText(node, "freeze_config_digest")
      : digest(upstreams.map((input) => ({ role: input.role, artifactId: input.artifactId })));
  const timestamp = now();
  const runIndexRow = asRow(
    host.db
      .prepare("SELECT COUNT(*) + 1 AS run_index FROM attempts WHERE run_id = ? AND node_key = ?")
      .get(runId, nodeKey),
  );
  host.db
    .prepare(
      `INSERT INTO attempts (
        attempt_id, run_id, node_key, node_generation, run_index, state, input_digest, error, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, ?, NULL)`,
    )
    .run(
      attemptId,
      runId,
      nodeKey,
      generation,
      requiredNumber(runIndexRow ?? {}, "run_index"),
      inputDigest,
      timestamp,
    );
  if (retrySource) {
    host.copyAttemptInputs(attemptId, retrySource.inputs);
  } else {
    host.bindAttemptInputs(attemptId, runId, nodeKey);
  }
  host.db
    .prepare(
      `UPDATE nodes SET state = 'running', current_attempt_id = ?, last_attempt_id = ?
       WHERE run_id = ? AND node_key = ? AND generation = ? AND state = 'ready'`,
    )
    .run(attemptId, attemptId, runId, nodeKey, generation);
  host.db
    .prepare("UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ?")
    .run(timestamp, runId);
  host.emit(runId, "attempt.started");
  return { attemptId, nodeGeneration: generation, nodeKey, kind, runId };
}

/**
 * When the current generation's last Attempt failed/interrupted, a re-claim is a
 * Retry: copy that Attempt's frozen input envelope verbatim.
 */
function retrySourceAttempt(
  host: SchedulerHost,
  runId: string,
  nodeKey: string,
  generation: number,
): { inputDigest: string; inputs: Array<{ role: string; artifactId: string }> } | undefined {
  const node = asRow(
    host.db
      .prepare(
        "SELECT last_attempt_id FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
      )
      .get(runId, nodeKey, generation),
  );
  if (!node || node.last_attempt_id === null) return undefined;
  const lastAttemptId = requiredText(node, "last_attempt_id");
  const attempt = asRow(
    host.db
      .prepare(`SELECT input_digest, state, node_generation FROM attempts WHERE attempt_id = ?`)
      .get(lastAttemptId),
  );
  if (!attempt) return undefined;
  if (requiredNumber(attempt, "node_generation") !== generation) return undefined;
  if (!["failed", "interrupted"].includes(requiredText(attempt, "state"))) return undefined;
  const inputs = asRows(
    host.db
      .prepare(`SELECT role, artifact_id FROM attempt_inputs WHERE attempt_id = ? ORDER BY role`)
      .all(lastAttemptId),
  ).map((row) => ({
    role: requiredText(row, "role"),
    artifactId: requiredText(row, "artifact_id"),
  }));
  return { inputDigest: requiredText(attempt, "input_digest"), inputs };
}

export function abortRunAttempts(host: SchedulerHost, runId: string): void {
  for (const [attemptId, controller] of host.activeAttempts) {
    if (attemptRunId(host, attemptId) === runId) controller.abort();
  }
}

export function abortActiveAttempts(host: SchedulerHost): void {
  for (const controller of host.activeAttempts.values()) controller.abort();
}

export function attemptRunId(host: SchedulerHost, attemptId: string): string | undefined {
  const attempt = asRow(
    host.db.prepare("SELECT run_id FROM attempts WHERE attempt_id = ?").get(attemptId),
  );
  return attempt === undefined ? undefined : requiredText(attempt, "run_id");
}

export async function waitForRunExecution(host: SchedulerHost, runId: string): Promise<void> {
  const executions = [...host.activeExecutions.entries()]
    .filter(([attemptId]) => attemptRunId(host, attemptId) === runId)
    .map(([, execution]) => execution);
  await Promise.all(executions);
}

/** Generic non-freeze attempt: Pi kinds via executor, mechanical kinds in-process. */
export async function executeClaimed(host: SchedulerHost, claim: ClaimedNode): Promise<void> {
  const controller = new AbortController();
  host.activeAttempts.set(claim.attemptId, controller);
  try {
    if (host.closed || !host.isCurrent(claim)) return;
    const outcome = isMechanicalAttemptKind(claim.kind)
      ? await host.executeMechanical(claim, controller.signal)
      : await executePi(host, claim, controller.signal);
    if (host.closed || !host.isCurrent(claim)) return;
    if (outcome.type === "failed") throw new Error(outcome.error);
    if (outcome.type === "gate_requested") {
      throw new Error(`${claim.kind} must not request an inline gate`);
    }
    if (outcome.type !== "succeeded") throw new Error("unexpected attempt outcome");

    const preparations: ArtifactPreparation[] = [];
    for (const descriptor of outcome.unsealedArtifacts) {
      const preparation = await host.prepareUnsealedArtifact(claim, descriptor);
      if (!preparation) return;
      await host.sealPreparation(claim.runId, preparation);
      preparations.push(preparation);
    }
    if (host.closed || !host.isCurrent(claim)) return;
    host.transaction(() => host.commitNodeArtifacts(claim, preparations));
  } catch (error) {
    if (host.closed) return;
    // Best-effort: leave a readable conversation row when Pi/mechanical failed
    // without sealing a transcript (mechanical cancel, missing executor, …).
    await ensureAttemptFailureTranscript(host, claim, error).catch(() => undefined);
    host.transaction(() => failNode(host, claim, error));
  } finally {
    host.activeAttempts.delete(claim.attemptId);
    host.transaction(() => host.orphanPreparedArtifacts(claim.attemptId));
  }
}

/**
 * Ensure session.jsonl exists for failed attempts so Node details is not empty.
 * Preserves any live JSONL already written by the Pi sink.
 */
async function ensureAttemptFailureTranscript(
  host: SchedulerHost,
  claim: ClaimedNode,
  error: unknown,
): Promise<void> {
  const message =
    error instanceof Error ? error.message.slice(0, 4_000) : `${claim.nodeKey} failed`;
  const sessionPath = path.join(
    runWorkDir(host.workspace.rootPath, claim.runId),
    "attempts",
    claim.attemptId,
    "session.jsonl",
  );
  await writeConversationTranscript({
    sessionPath,
    nodeKey: claim.nodeKey,
    summary: `Error: ${message}`,
    preserveExisting: true,
    meta: { mode: "failed", kind: claim.kind, error: message },
  });
}

export async function executePi(
  host: SchedulerHost,
  claim: ClaimedNode,
  signal: AbortSignal,
): Promise<PiAttemptOutcome> {
  if (!host.piAttemptExecutor) {
    return {
      type: "failed",
      error: `${claim.kind} requires a PiAttemptExecutor`,
      failureClass: "infrastructure",
    };
  }
  const input = buildPiAttemptInput(host, claim);
  return host.piAttemptExecutor(input, signal);
}

export function buildPiAttemptInput(host: SchedulerHost, claim: ClaimedNode): PiAttemptInput {
  const runDir = runWorkDir(host.workspace.rootPath, claim.runId);
  const attemptDir = path.join(runDir, "attempts", claim.attemptId);
  const workDir = path.join(attemptDir, "work");
  const sessionPath = path.join(attemptDir, "session.jsonl");
  const sealedRows = asRows(
    host.db
      .prepare(
        `SELECT attempt_inputs.role, artifacts.artifact_id, artifacts.kind, artifacts.digest,
                artifacts.relative_path, artifacts.sealed_at
         FROM attempt_inputs
         JOIN artifacts ON artifacts.artifact_id = attempt_inputs.artifact_id
         WHERE attempt_inputs.attempt_id = ?
         ORDER BY attempt_inputs.role`,
      )
      .all(claim.attemptId),
  );
  const sealedInputs = sealedRows.map((row) => ({
    role: requiredText(row, "role"),
    readOnlyPath: path.join(runDir, requiredText(row, "relative_path")),
    artifact: {
      artifactId: requiredText(row, "artifact_id"),
      kind: requiredText(row, "kind") as WikiRunArtifactKind,
      digest: requiredText(row, "digest"),
      sealedAt: requiredText(row, "sealed_at"),
    },
  }));
  const sourcesInput = sealedInputs.find((item) => item.role === "sources");
  const skillInput = sealedInputs.find((item) => item.role === "skill");
  if (!sourcesInput || !skillInput) {
    throw new Error(`${claim.nodeKey} requires sealed sources and skill inputs`);
  }
  const pinned = host.trustedPinnedInputs(claim.runId);
  const sourcePaths: Record<string, string> = {};
  if (pinned) {
    for (const source of pinned.sources as Array<{ id: string }>) {
      sourcePaths[source.id] = path.join(sourcesInput.readOnlyPath, source.id);
    }
  } else {
    for (const source of host.workspace.sources) {
      sourcePaths[source.id] = path.join(sourcesInput.readOnlyPath, source.id);
    }
  }
  const runIndexRow = asRow(
    host.db.prepare("SELECT run_index FROM attempts WHERE attempt_id = ?").get(claim.attemptId),
  );
  const kind = claim.kind as PiAttemptInput["node"]["kind"];
  return {
    runId: claim.runId,
    attemptId: claim.attemptId,
    node: {
      key: claim.nodeKey,
      kind,
      generation: claim.nodeGeneration,
      runIndex: requiredNumber(runIndexRow ?? { run_index: 1 }, "run_index"),
    },
    inputDigest: host.attemptInputDigest(claim.attemptId),
    workspace: host.workspace,
    sealedInputs,
    attemptDir,
    workDir,
    sessionPath,
    skillPath: skillInput.readOnlyPath,
    sourcePaths,
  };
}

export function failNode(host: SchedulerHost, claim: ClaimedNode, error: unknown): void {
  if (!host.isCurrent(claim)) return;
  const timestamp = now();
  const message =
    error instanceof Error ? error.message.slice(0, 4_000) : `${claim.nodeKey} failed`;
  host.db
    .prepare(
      "UPDATE attempts SET state = 'failed', error = ?, ended_at = ? WHERE attempt_id = ? AND state = 'running'",
    )
    .run(message, timestamp, claim.attemptId);
  host.db
    .prepare(
      `UPDATE nodes SET state = 'failed', current_attempt_id = NULL
       WHERE run_id = ? AND node_key = ? AND generation = ? AND current_attempt_id = ?`,
    )
    .run(claim.runId, claim.nodeKey, claim.nodeGeneration, claim.attemptId);
  host.db
    .prepare(
      "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
    )
    .run(claim.attemptId);
  host.emit(claim.runId, "attempt.failed");

  // Research read-only auto-retry: re-queue same generation with exact input digest.
  // Validate dirty / write / review stay manual (RetryFailedNode or RerunNode/wiki_repair).
  if (shouldAutoRetryResearch(host, claim, message)) {
    host.requeueFailedNode(claim.runId, claim.nodeKey, claim.nodeGeneration, claim.attemptId);
    host.emit(claim.runId, "node.ready");
    return;
  }

  // Siblings may still be ready; only fail the run when nothing else can progress.
  const hasWork = asRow(
    host.db
      .prepare(
        `SELECT 1 AS present FROM nodes
         WHERE run_id = ? AND state IN ('ready', 'running', 'waiting', 'blocked')
           AND generation = (
             SELECT MAX(n2.generation) FROM nodes n2
             WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
           )
         LIMIT 1`,
      )
      .get(claim.runId),
  );
  if (!hasWork) {
    host.db
      .prepare("UPDATE runs SET state = 'failed', updated_at = ? WHERE run_id = ?")
      .run(timestamp, claim.runId);
  } else {
    // Re-evaluate unlock in case other branches can proceed without this node.
    host.unlockReadyNodes(claim.runId);
    host.db
      .prepare(
        "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0 AND state NOT IN ('waiting_for_operator', 'cancelling', 'cancelled')",
      )
      .run(timestamp, claim.runId);
  }
}

/**
 * Limited auto-retry for research.leaf / research.domain only.
 * Budget: RESEARCH_AUTO_RETRY_MAX_ATTEMPTS total Attempts per generation.
 * Non-retryable: cancel, budget, capacity, and explicit policy signals.
 */
export function shouldAutoRetryResearch(
  host: SchedulerHost,
  claim: ClaimedNode,
  message: string,
): boolean {
  if (!RESEARCH_AUTO_RETRY_KINDS.has(claim.kind)) return false;
  // Align with workspace.limits.retry.enabled — off means no control-plane auto-requeue.
  if (host.workspace.limits.retry.enabled === false) return false;
  if (host.closed) return false;
  const run = asRow(
    host.db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?").get(claim.runId),
  );
  if (!run || requiredNumber(run, "cancel_requested") === 1) return false;
  if (
    /cancel/i.test(message) ||
    /budget exhausted|token budget/i.test(message) ||
    /capacity|context overflow|context.?length/i.test(message) ||
    /insufficient_quota|quota exceeded|billing/i.test(message)
  ) {
    return false;
  }
  const countRow = asRow(
    host.db
      .prepare(
        `SELECT COUNT(*) AS count FROM attempts
         WHERE run_id = ? AND node_key = ? AND node_generation = ?
           AND state IN ('failed', 'interrupted', 'cancelled')`,
      )
      .get(claim.runId, claim.nodeKey, claim.nodeGeneration),
  );
  const failedCount = requiredNumber(countRow ?? { count: 0 }, "count");
  // failedCount includes this just-failed Attempt; allow one more total Attempt.
  return failedCount < RESEARCH_AUTO_RETRY_MAX_ATTEMPTS;
}
