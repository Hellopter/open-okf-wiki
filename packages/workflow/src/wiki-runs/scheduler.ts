/**
 * Ready-node claim, attempt execution (Pi + mechanical), fail/retry, abort.
 * Owner binds db/workspace/transaction/emit — scheduler stays free of WikiRunsOwner.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type PiAttemptArtifactDescriptor,
  type PiAttemptExecutor,
  type PiAttemptFailureClass,
  type PiAttemptInput,
  type PiAttemptNodeDetail,
  type PiAttemptOutcome,
  PiAttemptNodeDetailSchema,
  type WikiRunArtifactKind,
  type WikiRunEvent,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { runWorkDir } from "@okf-wiki/core";
import {
  isGateKind,
  isMechanicalAttemptKind,
  isPiAttemptKind,
} from "../definition-v1.js";
import { canClaimKind } from "./concurrency.js";
import { digest, now } from "./crypto-util.js";
import { loadSpecFromArtifact } from "./gates.js";
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

/** Feedback prefix used to count prior auto hard-validate repairs (legacy write.root + repair.hv). */
export const HARD_VALIDATE_REPAIR_FEEDBACK_PREFIX = "Hard-validate repair (";

/** Dedicated auto hard-validate repair node keys: `repair.hv.1`, `repair.hv.2`, … */
export const HARD_VALIDATE_REPAIR_NODE_PREFIX = "repair.hv.";

/** Validate kinds that may trigger durable auto hard-validate repair via repair.hv.N. */
const HARD_VALIDATE_REPAIR_KINDS: ReadonlySet<string> = new Set([
  "validate.pre",
  "validate.final",
]);

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
  /**
   * Durable RerunNode core (generation++ + lineage invalidation + optional feedback).
   * Used by auto hard-validate repair to re-arm validate.* + downstream after scheduling repair.hv.N.
   */
  applyRerunAt(runId: string, nodeKey: string, generation: number, feedback?: string): void;
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
    if (outcome.type === "failed") {
      // Preserve typed failureClass for L_control research auto-retry policy.
      throw Object.assign(new Error(outcome.error), { failureClass: outcome.failureClass });
    }
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

/**
 * Load secret-free node detail from nodes.detail_json for this generation.
 * Invalid / unknown JSON is dropped so a corrupt row cannot break the claim.
 */
export function loadPiAttemptNodeDetail(
  host: Pick<SchedulerHost, "db">,
  runId: string,
  nodeKey: string,
  generation: number,
): PiAttemptNodeDetail | undefined {
  const row = asRow(
    host.db
      .prepare(
        "SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
      )
      .get(runId, nodeKey, generation),
  );
  if (!row) return undefined;
  const raw = row.detail_json;
  if (raw == null || raw === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const rowObj = parsed as Record<string, unknown>;
  // Pick known keys only — detail_json may carry extras from older writers.
  const candidate: Record<string, unknown> = {};
  if (typeof rowObj.domainId === "string") candidate.domainId = rowObj.domainId;
  if (typeof rowObj.title === "string") candidate.title = rowObj.title;
  if (typeof rowObj.scope === "string") candidate.scope = rowObj.scope;
  if (typeof rowObj.question === "string") candidate.question = rowObj.question;
  if (typeof rowObj.questionIndex === "number") candidate.questionIndex = rowObj.questionIndex;
  if (Array.isArray(rowObj.questions)) candidate.questions = rowObj.questions;
  if (typeof rowObj.lens === "string") candidate.lens = rowObj.lens;
  if (typeof rowObj.critical === "boolean") candidate.critical = rowObj.critical;
  if (typeof rowObj.feedback === "string") candidate.feedback = rowObj.feedback;
  const result = PiAttemptNodeDetailSchema.safeParse(candidate);
  return result.success && Object.keys(result.data).length > 0 ? result.data : undefined;
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
  const detail = loadPiAttemptNodeDetail(
    host,
    claim.runId,
    claim.nodeKey,
    claim.nodeGeneration,
  );
  return {
    runId: claim.runId,
    attemptId: claim.attemptId,
    node: {
      key: claim.nodeKey,
      kind,
      generation: claim.nodeGeneration,
      runIndex: requiredNumber(runIndexRow ?? { run_index: 1 }, "run_index"),
      ...(detail ? { detail } : {}),
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

/** Extract typed failureClass from a failed outcome Error or plain object. */
export function failureClassOf(error: unknown): string | undefined {
  if (error && typeof error === "object" && "failureClass" in error) {
    const value = (error as { failureClass?: unknown }).failureClass;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  return undefined;
}

/**
 * Classes L_control may auto-requeue for research.leaf/domain (same input_digest).
 * Transport after L0 exhaustion maps to infrastructure (or transient when present).
 * capacity / budget / policy / cancel / provider never auto-requeue.
 */
const RESEARCH_AUTO_RETRY_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "transient",
  "infrastructure",
]);

/** Typed classes that must never auto-requeue (even if message looks flaky). */
const RESEARCH_NO_AUTO_RETRY_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "capacity",
  "budget",
  "policy",
  "cancelled",
  "cancel",
  "provider",
]);

export function failNode(host: SchedulerHost, claim: ClaimedNode, error: unknown): void {
  if (!host.isCurrent(claim)) return;
  const timestamp = now();
  const message =
    error instanceof Error ? error.message.slice(0, 4_000) : `${claim.nodeKey} failed`;
  const failureClass = failureClassOf(error);
  host.db
    .prepare(
      `UPDATE attempts SET state = 'failed', error = ?, failure_class = ?, ended_at = ?
       WHERE attempt_id = ? AND state = 'running'`,
    )
    .run(message, failureClass ?? null, timestamp, claim.attemptId);
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
  if (shouldAutoRetryResearch(host, claim, message, failureClass)) {
    host.requeueFailedNode(claim.runId, claim.nodeKey, claim.nodeGeneration, claim.attemptId);
    host.emit(claim.runId, "node.ready");
    return;
  }

  // Mechanical hard-validate repair: schedule a dedicated repair.hv.N stage with
  // validation feedback under sealed Spec acceptance.maxHardValidateRepairRounds
  // (default 2). Independent of research L_control and council maxRepairRounds.
  // Does NOT disguise fix as write.root (write stays at its successful generation).
  if (shouldAutoHardValidateRepair(host, claim, message, failureClass)) {
    if (scheduleHardValidateRepair(host, claim, message)) {
      host.emit(claim.runId, "node.ready");
      return;
    }
  }

  // Siblings may still be ready/running, or an open gate may be waiting.
  // Do not count 'blocked' alone as progress — a failed critical-path node leaves
  // downstream blocked forever; without ready/running/waiting work the run is failed.
  const hasWork = asRow(
    host.db
      .prepare(
        `SELECT 1 AS present FROM nodes
         WHERE run_id = ? AND state IN ('ready', 'running', 'waiting')
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
 * Clear transport / infrastructure message patterns used only when failureClass
 * is missing (legacy bare Errors). Product defects must not match.
 */
const RESEARCH_AUTO_RETRY_MESSAGE_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /\b(?:429|500|502|503|529)\b/,
  /\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|\bENOTFOUND\b|\bEPIPE\b/,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
  /\boverloaded\b/i,
  /service unavailable/i,
  /bad gateway/i,
  /internal server error/i,
  /connection (?:closed|reset|refused|error)/i,
  /\binfrastructure\b/i,
  /\btransient\b/i,
];

/**
 * Limited auto-retry for research.leaf / research.domain only.
 * Budget: RESEARCH_AUTO_RETRY_MAX_ATTEMPTS total Attempts per generation.
 * Prefer typed failureClass; missing class is fail-closed unless the message
 * clearly matches transport/infrastructure patterns (never bare product errors
 * like "requires sealed sources").
 * Allow: transient, infrastructure. Deny: capacity, budget, policy, cancel, provider.
 */
export function shouldAutoRetryResearch(
  host: SchedulerHost,
  claim: ClaimedNode,
  message: string,
  failureClass?: string | PiAttemptFailureClass,
): boolean {
  if (!RESEARCH_AUTO_RETRY_KINDS.has(claim.kind)) return false;
  // Align with workspace.limits.retry.enabled — off means no control-plane auto-requeue.
  if (host.workspace.limits.retry.enabled === false) return false;
  if (host.closed) return false;
  const run = asRow(
    host.db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?").get(claim.runId),
  );
  if (!run || requiredNumber(run, "cancel_requested") === 1) return false;

  const cls = failureClass?.trim().toLowerCase();
  if (cls) {
    if (RESEARCH_NO_AUTO_RETRY_FAILURE_CLASSES.has(cls)) return false;
    if (!RESEARCH_AUTO_RETRY_FAILURE_CLASSES.has(cls)) return false;
  } else {
    // Fail-closed when failureClass was not plumbed: only clear transport/infra
    // messages may requeue. Bare product errors never auto-requeue.
    if (!RESEARCH_AUTO_RETRY_MESSAGE_PATTERNS.some((p) => p.test(message))) {
      return false;
    }
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

/**
 * Latest write.root generation (max generation row), if the node exists.
 * Required for auto hard-validate repair (wiki input source must exist).
 */
export function currentWriteRootGeneration(
  host: Pick<SchedulerHost, "db">,
  runId: string,
): number | undefined {
  const row = asRow(
    host.db
      .prepare(
        `SELECT MAX(generation) AS generation FROM nodes
         WHERE run_id = ? AND node_key = 'write.root'`,
      )
      .get(runId),
  );
  if (!row || row.generation === null) return undefined;
  return requiredNumber(row, "generation");
}

/**
 * Load sealed Spec acceptance.maxHardValidateRepairRounds (default 2).
 * Reads plan node_outputs role=spec → artifact relative_path → loadSpecFromArtifact.
 */
export function loadHardValidateBudget(
  host: Pick<SchedulerHost, "db" | "workspace">,
  runId: string,
): number {
  const plan = asRow(
    host.db
      .prepare(
        `SELECT node_outputs.node_generation, artifacts.relative_path
         FROM node_outputs
         JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
         WHERE node_outputs.run_id = ?
           AND node_outputs.node_key = 'plan'
           AND node_outputs.role = 'spec'
         ORDER BY node_outputs.node_generation DESC
         LIMIT 1`,
      )
      .get(runId),
  );
  if (!plan) return 2;
  const relativePath = requiredText(plan, "relative_path");
  const spec = loadSpecFromArtifact({ workspace: host.workspace }, runId, relativePath);
  const budget = spec?.acceptance?.maxHardValidateRepairRounds;
  return typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : 2;
}

/**
 * Count prior auto hard-validate repairs.
 * Prefer dedicated `repair.hv.N` nodes; fall back to legacy write.root detail
 * (old runs that disguised HV repair as write.root rerun).
 */
export function countAutoHardValidateRepairs(
  host: Pick<SchedulerHost, "db">,
  runId: string,
): number {
  const hvRow = asRow(
    host.db
      .prepare(
        `SELECT COUNT(DISTINCT node_key) AS count FROM nodes
         WHERE run_id = ? AND node_key LIKE 'repair.hv.%'`,
      )
      .get(runId),
  );
  const hvCount = requiredNumber(hvRow ?? { count: 0 }, "count");
  if (hvCount > 0) return hvCount;

  // Legacy: write.root generations whose detail_json carried HV feedback.
  const rows = asRows(
    host.db
      .prepare(
        `SELECT detail_json FROM nodes
         WHERE run_id = ? AND node_key = 'write.root' AND detail_json IS NOT NULL`,
      )
      .all(runId),
  );
  let count = 0;
  for (const row of rows) {
    const raw = row.detail_json;
    if (raw == null || raw === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      // Fall back to raw substring match for corrupt-but-prefixed detail.
      if (
        String(raw).includes(`"autoHardValidate":true`) ||
        String(raw).includes(HARD_VALIDATE_REPAIR_FEEDBACK_PREFIX)
      ) {
        count += 1;
      }
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const detail = parsed as Record<string, unknown>;
    if (detail.autoHardValidate === true) {
      count += 1;
      continue;
    }
    if (
      typeof detail.feedback === "string" &&
      detail.feedback.startsWith(HARD_VALIDATE_REPAIR_FEEDBACK_PREFIX)
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Insert a dedicated `repair.hv.N` stage, wire edges, and re-arm the failed
 * validate node (gen+1) so it waits for repair — without putting feedback on
 * validate or re-running write.root.
 *
 * Returns true when the repair stage was scheduled.
 */
export function scheduleHardValidateRepair(
  host: SchedulerHost,
  claim: ClaimedNode,
  message: string,
): boolean {
  if (currentWriteRootGeneration(host, claim.runId) === undefined) return false;

  const budget = loadHardValidateBudget(host, claim.runId);
  const prior = countAutoHardValidateRepairs(host, claim.runId);
  const round = prior + 1;
  const key = `${HARD_VALIDATE_REPAIR_NODE_PREFIX}${round}`;
  const feedback = [
    `${HARD_VALIDATE_REPAIR_FEEDBACK_PREFIX}round ${round}/${budget}):`,
    message,
  ].join("\n");
  const detailJson = JSON.stringify({
    autoHardValidate: true,
    feedback,
    source: "hard_validate",
    round,
    validateNodeKey: claim.nodeKey,
  });

  try {
    const existing = asRow(
      host.db
        .prepare(
          "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? LIMIT 1",
        )
        .get(claim.runId, key),
    );
    if (existing) return false;

    host.db
      .prepare(
        `INSERT INTO nodes (
            run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
          ) VALUES (?, ?, 'repair', 'ready', 0, NULL, NULL, ?)`,
      )
      .run(claim.runId, key, detailJson);

    // write.root → repair.hv.n (wiki input); repair.hv.n → validate (must wait).
    host.db
      .prepare(
        `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, 'write.root', ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(claim.runId, key);
    host.db
      .prepare(
        `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(claim.runId, key, claim.nodeKey);

    // Re-arm validate + downstream at gen+1 (invalidated until repair succeeds).
    // Do NOT put feedback on the validate node.
    host.applyRerunAt(claim.runId, claim.nodeKey, claim.nodeGeneration);
    host.unlockReadyNodes(claim.runId);
    const timestamp = now();
    host.db
      .prepare(
        "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
    return true;
  } catch {
    // Stale gen / constraint / missing write: fall through to normal fail-run path.
    return false;
  }
}

/**
 * Durable auto hard-validate repair after validate.pre / validate.final fails
 * with repairable schema/quality errors (message contains `validation failed:`).
 * Not for missing wiki_tree infrastructure.
 * Budget: sealed Spec acceptance.maxHardValidateRepairRounds (default 2).
 */
export function shouldAutoHardValidateRepair(
  host: SchedulerHost,
  claim: ClaimedNode,
  message: string,
  failureClass?: string | PiAttemptFailureClass,
): boolean {
  if (!HARD_VALIDATE_REPAIR_KINDS.has(claim.kind)) return false;
  if (host.closed) return false;
  const run = asRow(
    host.db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?").get(claim.runId),
  );
  if (!run || requiredNumber(run, "cancel_requested") === 1) return false;

  // Infrastructure (missing wiki_tree, …) never auto-repairs.
  const cls = failureClass?.trim().toLowerCase();
  if (cls === "infrastructure" || cls === "cancelled" || cls === "cancel") return false;
  if (cls === "capacity" || cls === "budget" || cls === "policy" || cls === "provider") {
    return false;
  }

  // Prefer typed schema/quality; also accept classic validation-failed messages.
  const isSchema = cls === "schema" || cls === "quality";
  const isValidationMessage = /validation failed:/i.test(message);
  if (!isSchema && !isValidationMessage) return false;

  if (currentWriteRootGeneration(host, claim.runId) === undefined) return false;

  const budget = loadHardValidateBudget(host, claim.runId);
  if (budget <= 0) return false;
  const prior = countAutoHardValidateRepairs(host, claim.runId);
  return prior < budget;
}
