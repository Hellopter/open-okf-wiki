/**
 * Ready-node claim, attempt execution (Pi + mechanical), fail/retry, abort.
 * Owner binds db/workspace/transaction/emit — scheduler stays free of WikiRunsOwner.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  type AttemptMetrics,
  type BoundInput,
  contractForNode,
  type PiAttemptArtifactDescriptor,
  type PiAttemptExecutor,
  type PiAttemptFailureClass,
  type PiAttemptInput,
  type PiAttemptNodeDetail,
  PiAttemptNodeDetailSchema,
  type PiAttemptOutcome,
  validateBoundInputs,
  type WikiRunArtifactKind,
} from "@okf-wiki/contract";
import { runWorkDir } from "@okf-wiki/core";
import { isGateKind, isMechanicalAttemptKind, isPiAttemptKind } from "../execution-graph.js";
import {
  graphRoleForNodeKind,
  mergeAttemptMetrics,
  metricsOf,
  normalizeAttemptMetrics,
  wallTimeMsFromStarted,
  writeAttemptMetrics,
} from "./attempt-metrics.js";
import { canClaimKind } from "./concurrency.js";
import { digest, now } from "./crypto-util.js";
import type { WikiRunsCasCtx } from "./ctx.js";
import { unlockReadyNodes } from "./dag.js";
import { openOperatorInputGate } from "./gate-open.js";
import {
  openMechanicalEvaluationRecovery,
  scheduleMechanicalRepair,
  shouldAutoMechanicalRepair,
} from "./repair-schedule.js";
import { asRow, asRows, requiredNumber, requiredText, type SqlRow } from "./sql.js";
import { appendAttemptFailureTranscript } from "./transcript-io.js";
import type {
  ArtifactPreparation,
  ClaimedFreeze,
  ClaimedNode,
  TrustedFrozenInputs,
} from "./types.js";
import { RESEARCH_AUTO_RETRY_KINDS, RESEARCH_AUTO_RETRY_MAX_ATTEMPTS } from "./types.js";

export type SchedulerHost = WikiRunsCasCtx & {
  closed: boolean;
  piAttemptExecutor?: PiAttemptExecutor;
  activeAttempts: Map<string, AbortController>;
  activeExecutions: Map<string, Promise<void>>;
  upstreamsSucceeded(runId: string, nodeKey: string): boolean;
  upstreamSealedOutputs(
    runId: string,
    nodeKey: string,
  ): Array<{ role: string; artifactId: string }>;
  copyAttemptInputs(attemptId: string, inputs: Array<{ role: string; artifactId: string }>): void;
  bindAttemptInputs(attemptId: string, runId: string, nodeKey: string): void;
  executeFreeze(claim: ClaimedFreeze): Promise<void>;
  executeMechanical(claim: ClaimedNode, signal: AbortSignal): Promise<PiAttemptOutcome>;
  prepareUnsealedArtifact(
    claim: ClaimedNode,
    descriptor: PiAttemptArtifactDescriptor,
  ): Promise<ArtifactPreparation | undefined>;
  sealPreparation(runId: string, preparation: ArtifactPreparation): Promise<void>;
  /**
   * Compile ExecutionPlan from sealed Spec and prepare as unsealed artifact.
   * Throws on fan-out over-cap (plan attempt fails).
   */
  preparePlanExecutionPlan(
    claim: ClaimedNode,
    preparations: ArtifactPreparation[],
  ): Promise<ArtifactPreparation | undefined>;
  /** CAS + gate open / unlock / plan accept (attempt-success single entry). */
  commitSuccessfulAttempt(
    claim: ClaimedNode,
    preparations: ArtifactPreparation[],
    metrics?: AttemptMetrics,
  ): void;
  /** Persist sealed failure evidence without falsely succeeding the Attempt. */
  commitFailedAttemptArtifacts(claim: ClaimedNode, preparations: ArtifactPreparation[]): void;
  orphanPreparedArtifacts(attemptId: string): void;
  requeueFailedNode(
    runId: string,
    nodeKey: string,
    generation: number,
    lastAttemptId: string,
  ): void;
  trustedPinnedInputs(runId: string): TrustedFrozenInputs | undefined;
  attemptInputDigest(attemptId: string): string;
  /**
   * Durable RerunNode core (generation++ + lineage invalidation + optional feedback).
   * Used by auto mechanical repair to re-arm validate.* + downstream after scheduling repair.N.
   */
  applyRerunAt(
    runId: string,
    nodeKey: string,
    generation: number,
    feedback?: string,
    opts?: { selfOnly?: boolean; excludeConsumer?: (nodeKey: string) => boolean },
  ): void;
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
      const claim = host.transaction(() => {
        return claimReadyNode(host);
      });
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
export function runningCountByKind(host: SchedulerHost, runId?: string): Map<string, number> {
  const counts = new Map<string, number>();
  const runFilter = runId ? "AND nodes.run_id = ?" : "";
  const rows = asRows(
    host.db
      .prepare(
        `SELECT kind, COUNT(*) AS count FROM nodes
         WHERE state = 'running'
           ${runFilter}
           AND generation = (
             SELECT MAX(n2.generation) FROM nodes n2
             WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
           )
         GROUP BY kind`,
      )
      .all(...(runId ? [runId] : [])),
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
  const freeze = claimNodeByKey(host, "freeze", "freeze");
  if (freeze) return freeze;

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
         ORDER BY runs.updated_at, runs.created_at, nodes.node_key`,
      )
      .all(),
  );
  // Mechanical first so validate/publish never stall behind optional Pi.
  const ordered = [
    ...ready.filter((row) => isMechanicalAttemptKind(requiredText(row, "kind"))),
    ...ready.filter((row) => isPiAttemptKind(requiredText(row, "kind"))),
  ];
  for (const row of ordered) {
    const runId = requiredText(row, "run_id");
    const kind = requiredText(row, "kind");
    const nodeKey = requiredText(row, "node_key");
    const workspace = host.workspaceForRun(runId);
    if (nodeKey === "freeze") continue;
    if (isGateKind(kind)) continue;
    if (isPiAttemptKind(kind) && !host.piAttemptExecutor) continue;
    const activeAttemptCount = requiredNumber(
      asRow(
        host.db
          .prepare("SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND state = 'running'")
          .get(runId),
      ) ?? {},
      "count",
    );
    if (activeAttemptCount >= workspace.orchestration.maxConcurrentAttempts) continue;
    if (!canClaimKind(workspace, kind, runningCountByKind(host, runId))) continue;
    const activeRuns = requiredNumber(
      asRow(
        host.db
          .prepare(`SELECT COUNT(DISTINCT run_id) AS count FROM attempts WHERE state = 'running'`)
          .get(),
      ) ?? {},
      "count",
    );
    const runHasAttempt = Boolean(
      asRow(
        host.db
          .prepare(
            "SELECT 1 AS present FROM attempts WHERE run_id = ? AND state = 'running' LIMIT 1",
          )
          .get(runId),
      ),
    );
    if (!runHasAttempt && activeRuns >= workspace.orchestration.maxActiveRuns) continue;
    if (!host.upstreamsSucceeded(runId, nodeKey)) continue;
    const claim = claimPreparedRow(host, row);
    if (claim) return claim;
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
  const runId = requiredText(node, "run_id");
  const workspace = host.workspaceForRun(runId);
  const activeAttemptCount = requiredNumber(
    asRow(
      host.db
        .prepare("SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND state = 'running'")
        .get(runId),
    ) ?? {},
    "count",
  );
  if (activeAttemptCount >= workspace.orchestration.maxConcurrentAttempts) return undefined;
  if (!canClaimKind(workspace, kind, runningCountByKind(host, runId))) return undefined;
  const activeRuns = requiredNumber(
    asRow(
      host.db
        .prepare("SELECT COUNT(DISTINCT run_id) AS count FROM attempts WHERE state = 'running'")
        .get(),
    ) ?? {},
    "count",
  );
  const runHasAttempt = Boolean(
    asRow(
      host.db
        .prepare("SELECT 1 AS present FROM attempts WHERE run_id = ? AND state = 'running' LIMIT 1")
        .get(runId),
    ),
  );
  if (!runHasAttempt && activeRuns >= workspace.orchestration.maxActiveRuns) {
    return undefined;
  }
  if (nodeKey !== "freeze" && !host.upstreamsSucceeded(requiredText(node, "run_id"), nodeKey)) {
    return undefined;
  }
  return claimPreparedRow(host, node);
}

export function claimPreparedRow(host: SchedulerHost, node: SqlRow): ClaimedNode | undefined {
  const runId = requiredText(node, "run_id");
  const nodeKey = requiredText(node, "node_key");
  const kind = requiredText(node, "kind");
  contractForNode(kind, nodeKey);
  const generation = requiredNumber(node, "generation");
  const attemptId = randomUUID();
  const upstreams = host.upstreamSealedOutputs(runId, nodeKey);
  // Freeze has no sealed upstreams; every other node needs at least freeze pins
  // (or explicit edge outputs) before claim.
  if (nodeKey !== "freeze" && upstreams.length === 0 && !host.upstreamsSucceeded(runId, nodeKey)) {
    return undefined;
  }
  // RetryFailedNode / research auto-retry: reuse the exact failed Attempt's
  // input_digest + attempt_inputs rather than re-picking "current latest".
  // Operator-input continuation: reuse suspended parent inputs + sealed answer.
  const retrySource = retrySourceAttempt(host, runId, nodeKey, generation);
  const operatorSource = retrySource
    ? undefined
    : operatorContinuationSource(host, runId, nodeKey, generation);
  const frozenSource = retrySource ?? operatorSource;
  const inputDigest = frozenSource
    ? frozenSource.inputDigest
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
  if (frozenSource) {
    host.copyAttemptInputs(attemptId, frozenSource.inputs);
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
  if (!["failed", "interrupted", "suspended"].includes(requiredText(attempt, "state")))
    return undefined;
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

/**
 * After ResolveGate(operator_input answer): new generation detail_json carries
 * parentAttemptId + operatorInputArtifactId so claim reuses frozen inputs + answer.
 */
function operatorContinuationSource(
  host: SchedulerHost,
  runId: string,
  nodeKey: string,
  generation: number,
): { inputDigest: string; inputs: Array<{ role: string; artifactId: string }> } | undefined {
  const node = asRow(
    host.db
      .prepare("SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
      .get(runId, nodeKey, generation),
  );
  if (!node || node.detail_json == null || node.detail_json === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(node.detail_json));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const detail = parsed as Record<string, unknown>;
  const parentAttemptId =
    typeof detail.parentAttemptId === "string" ? detail.parentAttemptId.trim() : "";
  const operatorInputArtifactId =
    typeof detail.operatorInputArtifactId === "string" ? detail.operatorInputArtifactId.trim() : "";
  if (!parentAttemptId || !operatorInputArtifactId) return undefined;

  const parent = asRow(
    host.db
      .prepare(`SELECT attempt_id, state, node_key, run_id FROM attempts WHERE attempt_id = ?`)
      .get(parentAttemptId),
  );
  if (!parent) return undefined;
  if (requiredText(parent, "run_id") !== runId) return undefined;
  if (requiredText(parent, "node_key") !== nodeKey) return undefined;
  if (requiredText(parent, "state") !== "suspended") return undefined;

  const artifact = asRow(
    host.db
      .prepare(`SELECT artifact_id, kind FROM artifacts WHERE artifact_id = ? AND run_id = ?`)
      .get(operatorInputArtifactId, runId),
  );
  if (!artifact || requiredText(artifact, "kind") !== "operator_input") return undefined;

  const parentInputs = asRows(
    host.db
      .prepare(`SELECT role, artifact_id FROM attempt_inputs WHERE attempt_id = ? ORDER BY role`)
      .all(parentAttemptId),
  ).map((row) => ({
    role: requiredText(row, "role"),
    artifactId: requiredText(row, "artifact_id"),
  }));
  // Drop any prior operator_input so the sealed answer is authoritative.
  const inputs = [
    ...parentInputs.filter((item) => item.role !== "operator_input"),
    { role: "operator_input", artifactId: operatorInputArtifactId },
  ].sort((a, b) => a.role.localeCompare(b.role));
  return {
    inputDigest: digest(inputs.map((item) => ({ role: item.role, artifactId: item.artifactId }))),
    inputs,
  };
}

/**
 * Durable pause: Attempt=suspended, Node=waiting, Gate(operator_input)=open,
 * Run=waiting_for_operator. Old Pi worker is discarded; resume is a new Attempt.
 */
export function suspendForOperatorInput(
  host: SchedulerHost,
  claim: ClaimedNode,
  outcome: Extract<PiAttemptOutcome, { type: "gate_requested" }>,
  transcriptPrep: ArtifactPreparation | undefined,
  metrics?: AttemptMetrics,
): void {
  if (!host.isCurrent(claim)) return;
  const timestamp = now();
  const inputDigest = host.attemptInputDigest(claim.attemptId);

  // Optionally seal the gate_requested transcript as an audit artifact (not a success output).
  if (transcriptPrep) {
    host.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, run_id, kind, digest, relative_path, producer_attempt_id, sealed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO NOTHING`,
      )
      .run(
        transcriptPrep.artifactId,
        claim.runId,
        transcriptPrep.kind,
        transcriptPrep.digest,
        transcriptPrep.relativePath,
        claim.attemptId,
        timestamp,
      );
    host.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'committed' WHERE preparation_id = ? AND state = 'prepared'",
      )
      .run(transcriptPrep.preparationId);
  }

  host.db
    .prepare(
      `UPDATE attempts SET state = 'suspended', ended_at = ?
       WHERE attempt_id = ? AND state = 'running'`,
    )
    .run(timestamp, claim.attemptId);
  const resolved = mergeAttemptMetrics(metrics, {
    role: graphRoleForNodeKind(claim.kind),
    wallTimeMs: wallTimeMsFromStarted(host.db, claim.attemptId, timestamp),
    stopReason: "gate_requested",
  });
  writeAttemptMetrics(host.db, claim.attemptId, resolved);

  // Keep last_attempt_id for UI; clear current so isCurrent fails for late commits.
  host.db
    .prepare(
      `UPDATE nodes SET state = 'waiting', current_attempt_id = NULL, last_attempt_id = ?
       WHERE run_id = ? AND node_key = ? AND generation = ? AND current_attempt_id = ?`,
    )
    .run(claim.attemptId, claim.runId, claim.nodeKey, claim.nodeGeneration, claim.attemptId);

  openOperatorInputGate({ db: host.db, emit: (runId, type) => host.emit(runId, type) }, claim, {
    question: outcome.question,
    context: outcome.context,
    inputDigest,
    timestamp,
  });
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
    const outcomeMetrics = normalizeAttemptMetrics(
      "metrics" in outcome ? outcome.metrics : undefined,
    );
    if (outcome.type === "failed") {
      const preparations: ArtifactPreparation[] = [];
      for (const descriptor of outcome.unsealedArtifacts ?? []) {
        const preparation = await host.prepareUnsealedArtifact(claim, descriptor);
        if (!preparation) return;
        await host.sealPreparation(claim.runId, preparation);
        preparations.push(preparation);
      }
      if (host.closed || !host.isCurrent(claim)) return;
      if (preparations.length > 0) {
        host.transaction(() => host.commitFailedAttemptArtifacts(claim, preparations));
      }
      // Preserve typed failureClass + optional metrics for L_control / observation.
      throw Object.assign(new Error(outcome.error), {
        failureClass: outcome.failureClass,
        ...(preparations.length > 0
          ? {
              failureArtifacts: Object.fromEntries(
                preparations.map((preparation) => [preparation.role, preparation.artifactId]),
              ),
            }
          : {}),
        ...(outcomeMetrics ? { metrics: outcomeMetrics } : {}),
      });
    }
    if (outcome.type === "gate_requested") {
      // Phase 4: durable operator_input HITL — suspend, do not throw/fail.
      let transcriptPrep: ArtifactPreparation | undefined;
      if (outcome.transcript) {
        transcriptPrep = await host.prepareUnsealedArtifact(claim, outcome.transcript);
        if (transcriptPrep) {
          await host.sealPreparation(claim.runId, transcriptPrep);
        }
      }
      if (host.closed || !host.isCurrent(claim)) return;
      host.transaction(() =>
        suspendForOperatorInput(host, claim, outcome, transcriptPrep, outcomeMetrics),
      );
      return;
    }
    if (outcome.type !== "succeeded") throw new Error("unexpected attempt outcome");

    const preparations: ArtifactPreparation[] = [];
    for (const descriptor of outcome.unsealedArtifacts) {
      const preparation = await host.prepareUnsealedArtifact(claim, descriptor);
      if (!preparation) return;
      await host.sealPreparation(claim.runId, preparation);
      preparations.push(preparation);
    }
    // Phase 1: compile + seal ExecutionPlan before plan gate / auto-approve.
    if (claim.kind === "plan") {
      const planPrep = await host.preparePlanExecutionPlan(claim, preparations);
      if (planPrep) {
        await host.sealPreparation(claim.runId, planPrep);
        preparations.push(planPrep);
      }
    }
    if (host.closed || !host.isCurrent(claim)) return;
    host.transaction(() => host.commitSuccessfulAttempt(claim, preparations, outcomeMetrics));
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
 * Ensure session.jsonl contains a terminal record for failed attempts without
 * rewriting the append-only Pi trace or crossing its reader retention limit.
 * Uses the real error message so operators see why the Attempt failed.
 */
async function ensureAttemptFailureTranscript(
  host: SchedulerHost,
  claim: ClaimedNode,
  error: unknown,
): Promise<void> {
  const sessionPath = path.join(
    runWorkDir(host.workspace.rootPath, claim.runId),
    "attempts",
    claim.attemptId,
    "session.jsonl",
  );
  // Host product errors are secret-free; generic Error.message is sliced.
  const message =
    error instanceof Error ? error.message : error !== undefined ? String(error) : "";
  await appendAttemptFailureTranscript({
    sessionPath,
    summary: message.slice(0, 4_000),
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
 * Dynamic graph nodes own execution semantics in this row, so they fail closed
 * rather than letting Pi invent missing scope, questions, or repair intent.
 */
export function loadPiAttemptNodeDetail(
  host: Pick<SchedulerHost, "db">,
  runId: string,
  nodeKey: string,
  generation: number,
  kind: PiAttemptInput["node"]["kind"],
): PiAttemptNodeDetail | undefined {
  const row = asRow(
    host.db
      .prepare("SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
      .get(runId, nodeKey, generation),
  );
  if (!row) return requireDynamicNodeDetail(kind, nodeKey, undefined, "row is missing");
  const raw = row.detail_json;
  if (raw == null || raw === "") {
    return requireDynamicNodeDetail(kind, nodeKey, undefined, "detail_json is missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return requireDynamicNodeDetail(kind, nodeKey, undefined, "detail_json is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return requireDynamicNodeDetail(kind, nodeKey, undefined, "detail_json is not an object");
  }
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
  if (typeof rowObj.seatIndex === "number") candidate.seatIndex = rowObj.seatIndex;
  if (typeof rowObj.critical === "boolean") candidate.critical = rowObj.critical;
  if (typeof rowObj.workUnitId === "string") candidate.workUnitId = rowObj.workUnitId;
  if (typeof rowObj.adaptRound === "number") candidate.adaptRound = rowObj.adaptRound;
  if (typeof rowObj.feedback === "string") candidate.feedback = rowObj.feedback;
  // Structured RepairRequest from scheduleMechanicalRepair / scheduleOperatorRepair.
  if (rowObj.repairRequest != null && typeof rowObj.repairRequest === "object") {
    candidate.repairRequest = rowObj.repairRequest;
  }
  const result = PiAttemptNodeDetailSchema.safeParse(candidate);
  if (!result.success) {
    return requireDynamicNodeDetail(kind, nodeKey, undefined, "detail_json has invalid fields");
  }
  const detail = Object.keys(result.data).length > 0 ? result.data : undefined;
  return requireDynamicNodeDetail(kind, nodeKey, detail);
}

function dynamicDetailError(kind: string, nodeKey: string, reason: string): never {
  throw new Error(`${kind}/${nodeKey} requires valid sealed detail_json: ${reason}`);
}

function detailString(
  detail: PiAttemptNodeDetail,
  field: "domainId" | "question" | "scope" | "title" | "lens",
): boolean {
  const value = detail[field];
  return typeof value === "string" && value.trim().length > 0;
}

/** Enforce the detail fields the dynamic NodeContract cannot express as artifacts. */
function requireDynamicNodeDetail(
  kind: PiAttemptInput["node"]["kind"],
  nodeKey: string,
  detail: PiAttemptNodeDetail | undefined,
  invalidReason?: string,
): PiAttemptNodeDetail | undefined {
  if (!isDynamicPiNodeKind(kind)) return detail;
  if (!detail) dynamicDetailError(kind, nodeKey, invalidReason ?? "detail_json is empty");

  if (kind === "research.leaf") {
    for (const field of ["domainId", "question", "scope"] as const) {
      if (!detailString(detail, field))
        dynamicDetailError(kind, nodeKey, `missing detail.${field}`);
    }
  }
  if (kind === "research.domain") {
    for (const field of ["domainId", "title", "scope"] as const) {
      if (!detailString(detail, field))
        dynamicDetailError(kind, nodeKey, `missing detail.${field}`);
    }
    if (
      !Array.isArray(detail.questions) ||
      detail.questions.length === 0 ||
      !detail.questions.every((question) => typeof question === "string" && question.trim())
    ) {
      dynamicDetailError(kind, nodeKey, "missing detail.questions");
    }
  }
  if (kind === "review.seat") {
    if (!detailString(detail, "lens")) dynamicDetailError(kind, nodeKey, "missing detail.lens");
    if (!Number.isInteger(detail.seatIndex) || (detail.seatIndex ?? -1) < 0) {
      dynamicDetailError(kind, nodeKey, "missing detail.seatIndex");
    }
  }
  if (kind === "repair" && !detail.repairRequest) {
    dynamicDetailError(kind, nodeKey, "missing detail.repairRequest");
  }
  if (kind === "plan.adapt") {
    const round = /^plan\.adapt\.([1-2])$/.exec(nodeKey)?.[1];
    if (!round || detail.adaptRound !== Number(round)) {
      dynamicDetailError(kind, nodeKey, "missing or mismatched detail.adaptRound");
    }
  }
  return detail;
}

function isDynamicPiNodeKind(
  kind: PiAttemptInput["node"]["kind"],
): kind is "research.leaf" | "research.domain" | "review.seat" | "repair" | "plan.adapt" {
  return (
    kind === "research.leaf" ||
    kind === "research.domain" ||
    kind === "review.seat" ||
    kind === "repair" ||
    kind === "plan.adapt"
  );
}

export function buildPiAttemptInput(host: SchedulerHost, claim: ClaimedNode): PiAttemptInput {
  const workspace = host.workspaceForRun(claim.runId);
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
  validateBoundInputs(
    contractForNode(claim.kind, claim.nodeKey),
    sealedInputs.map((input): BoundInput => ({ role: input.role, kind: input.artifact.kind })),
  );
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
    for (const source of workspace.sources) {
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
    kind,
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
    workspace,
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

function failureArtifactIdOf(error: unknown, role: string): string | undefined {
  if (!error || typeof error !== "object" || !("failureArtifacts" in error)) return undefined;
  const artifacts = (error as { failureArtifacts?: unknown }).failureArtifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return undefined;
  const artifactId = (artifacts as Record<string, unknown>)[role];
  return typeof artifactId === "string" && artifactId.trim() ? artifactId : undefined;
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
  const mechanicalReportArtifactId = failureArtifactIdOf(error, "validate_report");
  host.db
    .prepare(
      `UPDATE attempts SET state = 'failed', error = ?, failure_class = ?, ended_at = ?
       WHERE attempt_id = ? AND state = 'running'`,
    )
    .run(message, failureClass ?? null, timestamp, claim.attemptId);
  const resolved = mergeAttemptMetrics(metricsOf(error), {
    role: graphRoleForNodeKind(claim.kind),
    wallTimeMs: wallTimeMsFromStarted(host.db, claim.attemptId, timestamp),
    stopReason: failureClass ?? "failed",
  });
  writeAttemptMetrics(host.db, claim.attemptId, resolved);
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

  // A publication CAS conflict is an explicit operator decision point, not a
  // failed Run. mechanicalPublish has reopened the payload-bound gate and
  // preserved the candidate; leave publish blocked until that decision.
  if (claim.kind === "publish" && failureClass === "publication_conflict") {
    host.db
      .prepare(
        `UPDATE nodes SET state = 'blocked', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ?`,
      )
      .run(claim.runId, claim.nodeKey, claim.nodeGeneration);
    return;
  }

  // Research read-only auto-retry: re-queue same generation with exact input digest.
  if (shouldAutoRetryResearch(host, claim, message, failureClass)) {
    host.requeueFailedNode(claim.runId, claim.nodeKey, claim.nodeGeneration, claim.attemptId);
    host.emit(claim.runId, "node.ready");
    return;
  }

  // Mechanical model repair: schedule a dedicated repair.N stage with
  // validation feedback under EvaluationPolicy.mechanical.modelRepairBudget
  // (default 0; host autofix preferred). Independent of research L_control and council.
  // Does NOT disguise fix as write.root (write stays at its successful generation).
  if (shouldAutoMechanicalRepair(host, claim, message, failureClass)) {
    if (scheduleMechanicalRepair(host, claim, message, mechanicalReportArtifactId)) {
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
    const recovery = openMechanicalEvaluationRecovery(
      host,
      claim,
      message,
      failureClass,
      mechanicalReportArtifactId,
    );
    host.db
      .prepare("UPDATE runs SET state = 'failed', updated_at = ? WHERE run_id = ?")
      .run(timestamp, claim.runId);
    if (recovery) host.emit(claim.runId, "evaluation.recovery_available");
  } else {
    // Re-evaluate unlock in case other branches can proceed without this node.
    unlockReadyNodes(host, claim.runId);
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
  if (host.workspaceForRun(claim.runId).limits.retry.enabled === false) return false;
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
