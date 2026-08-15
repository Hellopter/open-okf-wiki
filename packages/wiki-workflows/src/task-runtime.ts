import type { WikiArtifactRef, WikiArtifactStore } from "./artifact-store.js";
import {
  boundedDelegateSummary,
  WikiTaskExecutionError,
  WikiTaskPauseError,
  type WikiDelegateBatchSnapshot,
  type WikiDelegateError,
  type WikiDelegateGap,
  type WikiDelegateReceipt,
  type WikiDelegateRole,
  type WikiDelegateTask,
  type WikiTaskFailureCode,
} from "./delegate-contracts.js";
import { budgetExhaustedCode, isWikiBudgetExhaustedError, WikiBudgetExhaustedError } from "./failures.js";
import { WIKI_MANUAL_PAUSE } from "./producer-types.js";
import type {
  WikiAgentTarget,
  WikiAgentTelemetry,
  WikiContextStats,
  WikiTaskRuntimeState,
  WikiTaskRuntimeTaskState,
} from "./producer-types.js";
import type { WikiReviewResult } from "./workflow-state.js";

type WikiObservabilityHealth = { target: WikiAgentTarget; status: "degraded" | "healthy"; at: string; message?: string };
import { isSafeWikiPagePath } from "./wiki-path.js";

export type WikiTaskProgressPhase = "queued" | "start" | "update" | "end";

export interface WikiTaskProgressEvent {
  readonly batchId: number;
  phase: WikiTaskProgressPhase;
  task: WikiDelegateTask;
  receipt?: WikiDelegateReceipt; // required on end
  usage?: WikiContextStats;
  telemetry?: WikiAgentTelemetry;
}

export interface WikiLeafTaskContext {
  runId: string;
  batch: number;
  attempt: number;
  cwd: string;
  sourceRoots: Record<string, string>;
  contextArtifacts: Record<string, WikiArtifactRef>;
  sessionFile?: string;
  candidateWikiRoot?: string;
  signal: AbortSignal;
  onTelemetry?: (telemetry: WikiAgentTelemetry) => void | Promise<void>;
  reportObservability?: (input: WikiObservabilityHealth) => void | Promise<void>;
}

export interface WikiLeafResult {
  summary: string;
  markdown: string;
  coverage?: string[];
  gaps?: WikiDelegateGap[];
  status?: "complete" | "incomplete";
  usage?: WikiContextStats;
  review?: WikiReviewResult;
}

export interface WikiLeafAgent {
  run(task: WikiDelegateTask, context: WikiLeafTaskContext): Promise<WikiLeafResult>;
}

export interface WikiTaskRuntimeOptions {
  runId: string;
  cwd: string;
  sourceScopes: Readonly<Record<string, string>>;
  contextArtifacts?: Readonly<Record<string, WikiArtifactRef>>;
  candidateWikiRoot?: string;
  artifactStore: WikiArtifactStore;
  agent: WikiLeafAgent;
  concurrency?: number;
  maxDelegatedTasks?: number;
  maxDelegateBatches?: number;
  restoredState?: WikiTaskRuntimeState;
  onStateChanged?: (state: WikiTaskRuntimeState) => void | Promise<void>;
  writeLease?: WikiWritePathLease;
  transientRetries?: number;
  baseRetryDelayMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onTask?: (event: WikiTaskProgressEvent) => void | Promise<void>;
  reportObservability?: (input: WikiObservabilityHealth) => void | Promise<void>;
}

export class WikiTaskRuntime {
  private readonly gate: SharedAdmissionGate;
  private readonly writePaths: WikiWritePathLease;
  private readonly contextArtifacts: Record<string, WikiArtifactRef>;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly baseRetryDelayMs: number;
  private readonly transientRetries: number;
  private readonly onTask?: (event: WikiTaskProgressEvent) => void | Promise<void>;
  private readonly onStateChanged?: (state: WikiTaskRuntimeState) => void | Promise<void>;
  private readonly batches = new Map<number, AsyncBatch>();
  private readonly maxDelegatedTasks: number;
  private readonly maxDelegateBatches: number;
  private delegatedTasks = 0;
  private delegateBatches = 0;
  private nextBatchId = 1;
  private stateChain = Promise.resolve();
  private stateFailure: unknown;

  constructor(private readonly options: WikiTaskRuntimeOptions) {
    this.gate = new SharedAdmissionGate(options.concurrency ?? 2, options.now);
    this.writePaths = options.writeLease ?? new WikiWritePathLease();
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.transientRetries = options.transientRetries ?? 1;
    this.maxDelegatedTasks = options.maxDelegatedTasks ?? Number.POSITIVE_INFINITY;
    this.maxDelegateBatches = options.maxDelegateBatches ?? Number.POSITIVE_INFINITY;
    if (!Number.isInteger(this.transientRetries) || this.transientRetries < 0) throw new Error("transientRetries must be a non-negative integer");
    if (!Number.isFinite(this.baseRetryDelayMs) || this.baseRetryDelayMs < 0) throw new Error("baseRetryDelayMs must be non-negative");
    validateLimit(this.maxDelegatedTasks, "maxDelegatedTasks");
    validateLimit(this.maxDelegateBatches, "maxDelegateBatches");
    this.contextArtifacts = Object.fromEntries(Object.values(options.contextArtifacts ?? {}).map((ref) => [ref.nodeId, ref]));
    this.onTask = options.onTask;
    this.onStateChanged = options.onStateChanged;
    if (options.restoredState) this.restore(options.restoredState);
  }

  async start(tasks: readonly WikiDelegateTask[], signal: AbortSignal): Promise<{ batchId: number }> {
    this.assertStateHealthy();
    validateBatch(tasks, this.options);
    for (const task of tasks) {
      for (const ref of task.contextRefs) {
        if (!Object.hasOwn(this.contextArtifacts, ref)) throw new Error(`Delegate task ${task.id} requests undeclared context artifact: ${ref}`);
      }
    }
    if (tasks.some((task) => task.role === "review")) {
      this.writePaths.assertReviewAllowed();
      const pendingWrite = [...this.batches.values()].some((batch) => [...batch.records.values()].some(
        (record) => record.state.task.role === "write" && record.state.phase !== "terminal",
      ));
      if (pendingWrite || tasks.some((task) => task.role === "write")) throw new Error("Wiki review is blocked while delegated Wiki writes are pending");
    }
    if (this.delegateBatches >= this.maxDelegateBatches) {
      throw new WikiBudgetExhaustedError(
        `Delegate batch limit exhausted (${this.maxDelegateBatches})`,
        "delegate_batches_exhausted",
        { limit: this.maxDelegateBatches },
      );
    }
    if (this.delegatedTasks + tasks.length > this.maxDelegatedTasks) {
      throw new WikiBudgetExhaustedError(
        `Delegated task limit exhausted (${this.maxDelegatedTasks})`,
        "delegated_tasks_exhausted",
        { limit: this.maxDelegatedTasks, delegatedTasks: this.delegatedTasks, requestedTasks: tasks.length },
      );
    }

    if (!Number.isSafeInteger(this.nextBatchId)) throw new Error("Delegate batch identity is exhausted");
    for (const task of tasks) artifactNodeId(this.nextBatchId, task.id);
    const batchId = this.nextBatchId++;
    const records = new Map(tasks.map((task) => [task.id, createAsyncTask({
      task,
      phase: "queued",
      attempt: 0,
      collected: false,
    })] as const));
    const batch: AsyncBatch = { id: batchId, records };
    this.batches.set(batchId, batch);
    this.delegatedTasks += records.size;
    this.delegateBatches += 1;
    await this.stateChanged();
    void this.launchBatch(batch, signal);
    return { batchId };
  }

  async resume(signal: AbortSignal): Promise<void> {
    this.assertStateHealthy();
    let changed = false;
    for (const batch of this.batches.values()) {
      for (const record of batch.records.values()) {
        if (record.state.phase === "paused") {
          record.state.phase = "running";
          delete record.state.pause;
          changed = true;
        }
        if (record.state.phase !== "terminal" && !record.launched && record.settled) resetAsyncTask(record);
      }
    }
    if (changed) await this.stateChanged();
    for (const batch of this.batches.values()) {
      if ([...batch.records.values()].some((record) => record.state.phase !== "terminal" && !record.launched)) {
        void this.launchBatch(batch, signal);
      }
    }
  }

  async collect(
    batchId: number,
    options: { until: "any" | "all"; timeoutSeconds: number },
    signal?: AbortSignal,
  ): Promise<WikiDelegateBatchSnapshot> {
    const batch = this.requireBatch(batchId);
    this.assertStateHealthy();
    validateCollectOptions(options);
    if (!this.collectSatisfied(batch, options.until) && options.timeoutSeconds > 0) {
      await waitWithTimeout(this.waitForCollect(batch, options.until), options.timeoutSeconds * 1_000, signal);
    }
    const result = this.snapshot(batch);
    this.throwForPause(batch);
    let changed = false;
    for (const record of batch.records.values()) {
      if (record.state.phase === "terminal" && !record.state.collected) {
        record.state.collected = true;
        changed = true;
      }
    }
    if (changed) await this.stateChanged();
    return result;
  }

  async cancel(batchId: number, taskIds?: readonly string[], reason = "Delegate task cancelled"): Promise<WikiDelegateBatchSnapshot> {
    const batch = this.requireBatch(batchId);
    this.assertStateHealthy();
    const ids = taskIds === undefined ? [...batch.records.keys()] : [...new Set(taskIds)];
    for (const id of ids) {
      if (!batch.records.has(id)) throw new Error(`Unknown delegate task ${id} in batch ${batchId}`);
    }
    const cancellation = new WikiTaskExecutionError(reason.trim() || "Delegate task cancelled", "cancelled");
    const directlyCancelled: AsyncTask[] = [];
    for (const id of ids) {
      const record = batch.records.get(id)!;
      if (record.state.phase === "terminal") continue;
      if (record.launched) record.controller.abort(cancellation);
      else {
        const failure = classifyTaskFailure(cancellation);
        record.state.phase = "terminal";
        record.state.receipt = receiptFromState(record.state, failure);
        delete record.state.pause;
        delete record.state.partial;
        record.launched = true;
        settleAsyncTask(record);
        directlyCancelled.push(record);
      }
    }
    if (directlyCancelled.length) {
      await this.stateChanged();
      for (const record of directlyCancelled) {
        await this.fireProgress({ batchId, phase: "end", task: record.state.task, receipt: terminalReceipt(record.state) });
      }
    }
    await Promise.all(ids.map((id) => batch.records.get(id)!.done));
    const result = this.snapshot(batch);
    this.throwForPause(batch);
    let changed = false;
    for (const record of batch.records.values()) {
      if (record.state.phase === "terminal" && !record.state.collected) {
        record.state.collected = true;
        changed = true;
      }
    }
    if (changed) await this.stateChanged();
    return result;
  }

  assertFinishable(): void {
    this.assertStateHealthy();
    for (const batch of this.batches.values()) {
      for (const record of batch.records.values()) {
        const pause = record.state.pause;
        if (record.state.phase === "paused" && pause && (pause.code === "quota" || pause.code === "usage_limit")) {
          throw new WikiTaskPauseError(pause.code, pause.message, pause.retryAfterMs);
        }
      }
    }
    if (this.writePaths.hasActive()) throw new Error("wiki_finish is blocked while Wiki writes are active");
    for (const batch of this.batches.values()) {
      for (const record of batch.records.values()) {
        if (record.state.phase !== "terminal") throw new Error("wiki_finish requires every delegated task to reach a terminal state");
        if (!record.state.collected) throw new Error("wiki_finish requires every terminal delegated receipt to be collected");
      }
    }
  }

  private async launchBatch(batch: AsyncBatch, signal: AbortSignal): Promise<void> {
    for (const record of batch.records.values()) {
      if (record.launched || record.state.phase === "terminal") continue;
      record.launched = true;
      await this.fireProgress({ batchId: batch.id, phase: "queued", task: record.state.task });
      void this.launchTask(batch, record, signal);
    }
  }

  private async launchTask(batch: AsyncBatch, record: AsyncTask, runSignal: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([runSignal, record.controller.signal]);
    let releaseWrites: (() => void) | undefined;
    let outcome: TaskExecutionOutcome;
    try {
      if (record.state.task.role === "review") {
        this.writePaths.assertReviewAllowed();
        const pendingWrite = [...this.batches.values()].some((candidate) => [...candidate.records.values()].some(
          (other) => other !== record && other.state.task.role === "write" && other.state.phase !== "terminal",
        ));
        if (pendingWrite) throw new Error("Wiki review is blocked while delegated Wiki writes are pending");
      }
      releaseWrites = await this.writePaths.acquire(record.state.task.writePaths ?? [], signal);
      outcome = await this.execute(record, batch.id, signal);
    } catch (error) {
      const interruption = pauseInterruption(signal);
      if (interruption !== undefined) outcome = { kind: "paused", pause: interruption.pause };
      else {
        const failure = classifyTaskFailure(signal.aborted ? signal.reason ?? error : error, signal.aborted);
        outcome = { kind: "terminal", receipt: receiptFromState(record.state, failure) };
      }
    } finally {
      releaseWrites?.();
    }
    if (outcome!.kind === "paused") {
      record.state.phase = record.state.attempt > 0 ? "paused" : "queued";
      if (outcome!.pause) record.state.pause = outcome!.pause;
      else delete record.state.pause;
      delete record.state.receipt;
      record.state.collected = false;
      record.launched = false;
      try {
        await this.stateChanged();
      } catch {
        /* collect/assertFinishable surface durable state failures */
      }
      settleAsyncTask(record);
      return;
    }
    record.state.phase = "terminal";
    record.state.receipt = outcome!.receipt;
    delete record.state.pause;
    delete record.state.partial;
    try {
      await this.stateChanged();
    } catch {
      /* collect/assertFinishable surface durable state failures */
    }
    const output = outcome!.receipt.outputs.at(-1);
    if (output) this.contextArtifacts[output.nodeId] = output;
    await this.fireProgress({
      batchId: batch.id,
      phase: "end",
      task: record.state.task,
      receipt: outcome!.receipt,
      usage: outcome!.usage,
      telemetry: outcome!.telemetry,
    });
    settleAsyncTask(record);
  }

  private collectSatisfied(batch: AsyncBatch, until: "any" | "all"): boolean {
    const records = [...batch.records.values()];
    return until === "all"
      ? records.every((record) => record.state.phase === "terminal") || records.some((record) => record.state.phase === "paused")
      : records.some((record) => record.state.phase === "paused" || (record.state.phase === "terminal" && !record.state.collected));
  }

  private async waitForCollect(batch: AsyncBatch, until: "any" | "all"): Promise<void> {
    while (!this.collectSatisfied(batch, until)) {
      const pending = [...batch.records.values()].filter((record) => record.state.phase !== "terminal" && !record.settled);
      if (pending.length === 0) return;
      await Promise.race(pending.map((record) => record.done));
    }
  }

  private requireBatch(batchId: number): AsyncBatch {
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error(`Unknown delegate batch: ${batchId}`);
    return batch;
  }

  private snapshot(batch: AsyncBatch): WikiDelegateBatchSnapshot {
    const states = [...batch.records.values()].map((record) => record.state);
    const receipts = states.flatMap((state) => state.phase === "terminal" ? [terminalReceipt(state)] : []);
    const pendingTaskIds = states.filter((state) => state.phase !== "terminal").map((state) => state.task.id);
    const complete = receipts.filter((value) => value.status === "complete").length;
    return {
      batchId: batch.id,
      status: pendingTaskIds.length > 0 ? "running" : (complete === receipts.length ? "complete" : complete > 0 ? "partial" : "failed"),
      receipts,
      pendingTaskIds,
    };
  }

  private throwForPause(batch: AsyncBatch): void {
    const pause = [...batch.records.values()].find((record) => record.state.phase === "paused" && record.state.pause)?.state.pause;
    if (pause && (pause.code === "quota" || pause.code === "usage_limit")) {
      throw new WikiTaskPauseError(pause.code, pause.message, pause.retryAfterMs);
    }
  }

  private restore(input: WikiTaskRuntimeState): void {
    const state = cloneRuntimeState(input);
    validateRestoredState(state);
    this.nextBatchId = state.batches.reduce((maximum, batch) => Math.max(maximum, batch.batchId + 1), 1);
    this.delegatedTasks = state.batches.reduce((total, batch) => total + batch.tasks.length, 0);
    this.delegateBatches = state.batches.length;
    for (const savedBatch of state.batches) {
      const records = new Map(savedBatch.tasks.map((saved) => [saved.task.id, createAsyncTask(saved)] as const));
      this.batches.set(savedBatch.batchId, { id: savedBatch.batchId, records });
      for (const saved of savedBatch.tasks) {
        if (saved.phase !== "terminal") continue;
        const output = terminalReceipt(saved).outputs.at(-1);
        if (output) this.contextArtifacts[output.nodeId] = output;
      }
    }
    for (const savedBatch of state.batches) {
      validateBatch(savedBatch.tasks.map((saved) => saved.task), this.options);
      for (const saved of savedBatch.tasks) {
        for (const ref of saved.task.contextRefs) {
          if (!Object.hasOwn(this.contextArtifacts, ref)) throw new Error(`Restored delegate task ${saved.task.id} requests undeclared context artifact: ${ref}`);
        }
      }
    }
  }

  private async stateChanged(): Promise<void> {
    this.assertStateHealthy();
    if (!this.onStateChanged) return;
    const state = this.runtimeState();
    const operation = this.stateChain.then(async () => await this.onStateChanged!(state));
    this.stateChain = operation.catch((error) => {
      this.stateFailure ??= error;
    });
    await operation;
  }

  private runtimeState(): WikiTaskRuntimeState {
    return cloneRuntimeState({
      batches: [...this.batches.values()].map((batch) => ({
        batchId: batch.id,
        tasks: [...batch.records.values()].map((record) => record.state),
      })),
    });
  }

  private assertStateHealthy(): void {
    if (this.stateFailure !== undefined) throw this.stateFailure;
  }

  private async execute(record: AsyncTask, batch: number, signal: AbortSignal): Promise<TaskExecutionOutcome> {
    const task = record.state.task;
    let lastFailure: ClassifiedFailure | undefined;
    const acceptedOutputs = [...(record.state.partial?.outputs ?? [])];
    const acceptedCoverage = new Set(record.state.partial?.coverage ?? []);
    const acceptedGaps = [...(record.state.partial?.gaps ?? [])];
    const maxAttempts = this.transientRetries + 1;
    let attempt = record.state.phase === "running" ? record.state.attempt : record.state.attempt + 1;
    let resumeCurrentAttempt = record.state.phase === "running";
    for (; attempt <= maxAttempts; attempt += 1) {
      if (!resumeCurrentAttempt) {
        record.state.phase = "running";
        record.state.attempt = attempt;
        record.state.sessionFile = undefined;
        await this.stateChanged();
      }
      resumeCurrentAttempt = false;
      let release: (() => void) | undefined;
      let latestTelemetry: WikiAgentTelemetry | undefined;
      const onTelemetry = async (checkpoint: WikiAgentTelemetry): Promise<void> => {
        latestTelemetry = checkpoint;
        if (checkpoint.sessionFile && checkpoint.sessionFile !== record.state.sessionFile) {
          record.state.sessionFile = checkpoint.sessionFile;
          await this.stateChanged();
        }
        await this.fireProgress({
          batchId: batch,
          phase: "update",
          task,
          telemetry: checkpoint,
        });
      };
      try {
        release = await this.gate.acquire(signal);
        const startedTelemetry: WikiAgentTelemetry = {
          target: { kind: "task", batch, taskId: task.id },
          attempt,
          sampledAt: new Date((this.options.now ?? Date.now)()).toISOString(),
          activity: "starting",
          activeTools: [],
        };
        await this.fireProgress({ batchId: batch, phase: "start", task, telemetry: startedTelemetry });
        const result = await this.options.agent.run(task, this.contextFor(task, batch, attempt, signal, onTelemetry, record.state.sessionFile));
        const output = await this.persist(task, batch, attempt, result.markdown);
        const successReceipt = receipt(task, result.status ?? "complete", result.summary, [...acceptedOutputs, output], [...acceptedCoverage, ...(result.coverage ?? [])], [...acceptedGaps, ...(result.gaps ?? [])], undefined, attempt, result.review);
        return { kind: "terminal", receipt: successReceipt, usage: result.usage ?? latestTelemetry?.usage, telemetry: latestTelemetry };
      } catch (error) {
        if (pauseInterruption(signal) !== undefined) throw error;
        let failure = classifyTaskFailure(error, signal.aborted);
        lastFailure = failure;
        const partial = partialResult(error);
        if (partial.markdown) {
          try {
            acceptedOutputs.push(await this.persist(task, batch, attempt, partial.markdown));
            for (const value of partial.coverage ?? []) acceptedCoverage.add(value);
            acceptedGaps.push(...(partial.gaps ?? []));
            record.state.partial = { outputs: [...acceptedOutputs], coverage: [...acceptedCoverage], gaps: [...acceptedGaps] };
            await this.stateChanged();
          } catch (artifactError) {
            failure = classifyTaskFailure(artifactError);
            lastFailure = failure;
          }
        }
        if (failure.code === "quota" || failure.code === "usage_limit") {
          record.state.partial = { outputs: [...acceptedOutputs], coverage: [...acceptedCoverage], gaps: [...acceptedGaps] };
          return { kind: "paused", pause: failure };
        }
        const mayRetry = failure.retryable && attempt < maxAttempts;
        if (!mayRetry) {
          const status = acceptedOutputs.length > 0 || failure.code === "timeout" || failure.code === "context_exhausted"
            ? "incomplete"
            : "failed";
          const terminalReceipt = receipt(task, status, failure.message, acceptedOutputs, [...acceptedCoverage], acceptedGaps, failure, attempt);
          return { kind: "terminal", receipt: terminalReceipt, usage: latestTelemetry?.usage, telemetry: latestTelemetry };
        }
        if (failure.code === "rate_limit") this.gate.reportPressure(failure.retryAfterMs ?? this.baseRetryDelayMs);
        release?.();
        release = undefined;
        const delay = failure.code === "rate_limit" && failure.retryAfterMs !== undefined
          ? failure.retryAfterMs
          : Math.floor(this.random() * this.baseRetryDelayMs * (2 ** Math.max(0, attempt - 1)));
        record.state.phase = "queued";
        record.state.attempt = attempt;
        record.state.sessionFile = undefined;
        await this.stateChanged();
        await this.sleep(delay, signal);
      } finally {
        release?.();
      }
    }
    const fallbackReceipt = receipt(task, acceptedOutputs.length ? "incomplete" : "failed", lastFailure?.message ?? "Task failed", acceptedOutputs, [...acceptedCoverage], acceptedGaps, lastFailure, maxAttempts);
    return { kind: "terminal", receipt: fallbackReceipt };
  }

  private contextFor(
    task: WikiDelegateTask,
    batch: number,
    attempt: number,
    signal: AbortSignal,
    onTelemetry: (telemetry: WikiAgentTelemetry) => void | Promise<void>,
    sessionFile?: string,
  ): WikiLeafTaskContext {
    return {
      runId: this.options.runId,
      batch,
      attempt,
      cwd: this.options.cwd,
      sourceRoots: Object.fromEntries(task.sourceScopeIds.map((id) => [id, this.options.sourceScopes[id]])),
      contextArtifacts: Object.fromEntries(task.contextRefs.map((id) => [id, this.contextArtifacts[id]])),
      sessionFile,
      candidateWikiRoot: this.options.candidateWikiRoot,
      signal,
      onTelemetry,
      reportObservability: this.options.reportObservability,
    };
  }

  private async persist(task: WikiDelegateTask, batch: number, attempt: number, markdown: string): Promise<WikiArtifactRef> {
    try {
      return await this.options.artifactStore.write({
        runId: this.options.runId,
        nodeId: artifactNodeId(batch, task.id),
        attempt,
        // The current artifact store assigns Markdown media type to research.
        // Receipt.role carries the task meaning; the payload remains model-friendly Markdown.
        kind: "research",
        content: markdown.endsWith("\n") ? markdown : `${markdown}\n`,
      });
    } catch (error) {
      throw new WikiTaskExecutionError("Could not persist task artifact", "artifact_io", { cause: error });
    }
  }

  private async fireProgress(event: WikiTaskProgressEvent): Promise<void> {
    try {
      await this.onTask?.(event);
    } catch {
      /* observability must not fail the task */
    }
  }
}

interface AsyncTask {
  state: WikiTaskRuntimeTaskState;
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
  launched: boolean;
  settled: boolean;
}

interface AsyncBatch {
  id: number;
  records: Map<string, AsyncTask>;
}

type TaskExecutionOutcome = {
  kind: "terminal";
  receipt: WikiDelegateReceipt;
  usage?: WikiContextStats;
  telemetry?: WikiAgentTelemetry;
} | {
  kind: "paused";
  pause?: WikiDelegateError;
};

function createAsyncTask(input: WikiTaskRuntimeTaskState): AsyncTask {
  const deferred = promiseWithResolvers<void>();
  const state = structuredClone(input);
  const settled = state.phase === "terminal";
  if (settled) deferred.resolve();
  return {
    state,
    controller: new AbortController(),
    done: deferred.promise,
    resolveDone: deferred.resolve,
    launched: state.phase === "terminal",
    settled,
  };
}

function resetAsyncTask(record: AsyncTask): void {
  const deferred = promiseWithResolvers<void>();
  record.done = deferred.promise;
  record.resolveDone = deferred.resolve;
  record.settled = false;
}

function settleAsyncTask(record: AsyncTask): void {
  if (record.settled) return;
  record.settled = true;
  record.resolveDone();
}

function terminalReceipt(state: WikiTaskRuntimeTaskState): WikiDelegateReceipt {
  if (state.phase !== "terminal" || !state.receipt) throw new Error(`Terminal task ${state.task.id} requires a receipt`);
  return state.receipt;
}

function promiseWithResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((value) => { resolve = value; });
  return { promise, resolve };
}

function cloneRuntimeState(state: WikiTaskRuntimeState): WikiTaskRuntimeState {
  return structuredClone(state);
}

function validateRestoredState(state: WikiTaskRuntimeState): void {
  const batchIds = new Set<number>();
  for (const batch of state.batches) {
    if (!Number.isSafeInteger(batch.batchId) || batch.batchId < 1 || batchIds.has(batch.batchId)) throw new Error(`Invalid or duplicate restored batch id: ${batch.batchId}`);
    batchIds.add(batch.batchId);
    const taskIds = new Set<string>();
    for (const saved of batch.tasks) {
      artifactNodeId(batch.batchId, saved.task.id);
      if (taskIds.has(saved.task.id)) throw new Error(`Duplicate restored task id in batch ${batch.batchId}: ${saved.task.id}`);
      taskIds.add(saved.task.id);
      if (!Number.isInteger(saved.attempt) || saved.attempt < 0) throw new Error(`Invalid restored attempt for task ${saved.task.id}`);
      if ((saved.phase === "running" || saved.phase === "paused") && saved.attempt < 1) throw new Error(`${saved.phase} restored task ${saved.task.id} requires an attempt`);
      if (saved.phase === "terminal" && !saved.receipt) throw new Error(`Terminal restored task ${saved.task.id} requires a receipt`);
      if (saved.phase !== "terminal" && saved.receipt) throw new Error(`Non-terminal restored task ${saved.task.id} cannot have a receipt`);
      if (saved.phase !== "terminal" && saved.collected) throw new Error(`Non-terminal restored task ${saved.task.id} cannot be collected`);
      if (saved.phase !== "paused" && saved.pause) throw new Error(`Only paused restored task ${saved.task.id} may have pause details`);
      if (saved.receipt && (saved.receipt.id !== saved.task.id || saved.receipt.role !== saved.task.role)) {
        throw new Error(`Restored receipt identity does not match task ${saved.task.id}`);
      }
    }
  }
}

function receiptFromState(state: WikiTaskRuntimeTaskState, failure: ClassifiedFailure): WikiDelegateReceipt {
  const partial = state.partial;
  const outputs = partial?.outputs ?? [];
  const status = outputs.length > 0 || failure.code === "timeout" || failure.code === "context_exhausted" ? "incomplete" : "failed";
  return receipt(state.task, status, failure.message, outputs, partial?.coverage ?? [], partial?.gaps ?? [], failure, Math.max(1, state.attempt));
}

function pauseInterruption(signal: AbortSignal): { pause?: WikiDelegateError } | undefined {
  if (!signal.aborted) return undefined;
  if (signal.reason instanceof WikiTaskPauseError) {
    return {
      pause: {
        code: signal.reason.reason,
        message: signal.reason.message,
        retryable: false,
        retryAfterMs: signal.reason.retryAfterMs,
      },
    };
  }
  return signal.reason === WIKI_MANUAL_PAUSE ? {} : undefined;
}

function artifactNodeId(batchId: number, taskId: string): string {
  const value = `b${batchId}-${taskId}`;
  if (value.length > 128) throw new Error(`Delegate task ${taskId} produces an oversized artifact handle`);
  return value;
}

function validateLimit(value: number, name: string): void {
  if (value !== Number.POSITIVE_INFINITY && (!Number.isInteger(value) || value < 1)) throw new Error(`${name} must be a positive integer`);
}

function validateCollectOptions(options: { until: "any" | "all"; timeoutSeconds: number }): void {
  if (options.until !== "any" && options.until !== "all") throw new Error("collect until must be any or all");
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 0 || options.timeoutSeconds > 60) {
    throw new Error("collect timeoutSeconds must be between 0 and 60");
  }
}

async function waitWithTimeout(completion: Promise<void>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new WikiTaskExecutionError("Collect cancelled", "cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  const aborted = signal && new Promise<void>((_resolve, reject) => {
    const onAbort = () => reject(new WikiTaskExecutionError("Collect cancelled", "cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race(aborted ? [completion, timeout, aborted] : [completion, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort?.();
  }
}

function validateBatch(tasks: readonly WikiDelegateTask[], options: WikiTaskRuntimeOptions): void {
  if (tasks.length === 0) throw new Error("Delegation requires at least one task");
  const ids = new Set<string>();
  const writes = new Set<string>();
  for (const task of tasks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(task.id) || ids.has(task.id)) throw new Error(`Invalid or duplicate delegate task id: ${task.id}`);
    ids.add(task.id);
    if (!task.instruction.trim()) throw new Error(`Delegate task ${task.id} requires an instruction`);
    for (const scope of task.sourceScopeIds) {
      if (!Object.hasOwn(options.sourceScopes, scope)) throw new Error(`Delegate task ${task.id} requests undeclared source scope: ${scope}`);
    }
    if (task.role === "write" && !task.writePaths?.length) throw new Error(`Write task ${task.id} requires writePaths`);
    if (task.role !== "write" && task.writePaths?.length) throw new Error(`Only write tasks may declare writePaths: ${task.id}`);
    if (task.role === "review" && !task.reviewPaths?.length) throw new Error(`Review task ${task.id} requires reviewPaths`);
    if (task.role !== "review" && task.reviewPaths?.length) throw new Error(`Only review tasks may declare reviewPaths: ${task.id}`);
    for (const value of task.writePaths ?? []) {
      const relative = typeof value === "string" && value.startsWith("wiki/") ? value.slice("wiki/".length) : undefined;
      if (!isSafeWikiPagePath(relative)) throw new Error(`Unsafe Wiki write path: ${value}`);
      if (writes.has(value)) throw new Error(`Delegate writePaths overlap within batch: ${value}`);
      writes.add(value);
    }
    for (const value of task.reviewPaths ?? []) {
      const relative = typeof value === "string" && value.startsWith("wiki/") ? value.slice("wiki/".length) : undefined;
      if (!isSafeWikiPagePath(relative)) throw new Error(`Unsafe Wiki review path: ${value}`);
    }
  }
}

function receipt(
  task: WikiDelegateTask,
  status: WikiDelegateReceipt["status"],
  summary: string,
  outputs: WikiArtifactRef[],
  coverage: string[] = [],
  gaps: WikiDelegateGap[] = [],
  failure?: ClassifiedFailure,
  attempts = 1,
  review?: WikiReviewResult,
): WikiDelegateReceipt {
  return {
    id: task.id,
    role: task.role,
    status,
    summary: boundedDelegateSummary(summary),
    outputs,
    coverage: [...new Set(coverage)],
    gaps,
    error: failure && { code: failure.code, message: failure.message, retryable: failure.retryable, retryAfterMs: failure.retryAfterMs },
    attempts,
    ...(review ? { review } : {}),
  };
}

interface ClassifiedFailure extends WikiDelegateError {}

export function classifyTaskFailure(error: unknown, aborted = false): ClassifiedFailure {
  if (aborted) return classified("cancelled", messageOf(error), false);
  if (isWikiBudgetExhaustedError(error)) return classified(budgetExhaustedCode(error), messageOf(error), false);
  if (error instanceof WikiTaskExecutionError && error.code) {
    return classified(error.code, error.message, retryableCode(error.code), error.options.retryAfterMs);
  }
  const value = error && typeof error === "object" ? error as { code?: unknown; status?: unknown; statusCode?: unknown; retryAfterMs?: unknown } : {};
  const status = numberValue(value.status) ?? numberValue(value.statusCode);
  const code = typeof value.code === "string" ? value.code.toLowerCase() : "";
  const retryAfterMs = numberValue(value.retryAfterMs);
  if (status === 429) return classified("rate_limit", messageOf(error), true, retryAfterMs);
  if (status === 401) return classified("unauthorized", messageOf(error), false);
  if (status === 403) return classified("forbidden", messageOf(error), false);
  if (status !== undefined && status >= 500 && status <= 504) return classified("server_error", messageOf(error), true);
  if (["econnreset", "etimedout", "eai_again"].includes(code)) return classified("network_reset", messageOf(error), true);
  const message = messageOf(error);
  if (/usage limit|quota exceeded|insufficient[_ -]?quota|billing|credit balance/i.test(message)) {
    const failureCode: WikiTaskFailureCode = /billing|credit balance/i.test(message)
      ? "billing"
      : /usage limit/i.test(message) ? "usage_limit" : "quota";
    return classified(failureCode, message, false, retryAfterMs);
  }
  if (/\b429\b|too many requests|rate limit/i.test(message)) return classified("rate_limit", message, true, retryAfterMs);
  if (/\b50[0-4]\b|internal server error|service unavailable|bad gateway|gateway timeout/i.test(message)) return classified("server_error", message, true);
  if (/econnreset|socket hang up|connection reset/i.test(message)) return classified("network_reset", message, true);
  if (isContextOverflowMessage(message)) return classified("context_exhausted", message, true);
  if (/timed? out|timeout/i.test(message)) return classified("timeout", message, true);
  if (/\b401\b|unauthorized|invalid api key/i.test(message)) return classified("unauthorized", message, false);
  if (/\b403\b|forbidden/i.test(message)) return classified("forbidden", message, false);
  // Provider HTTP 400 is often a transient gateway fault (empty body, "Invalid Request",
  // DashScope/Qwen parameter wrapping). Retry it. Local schema/validation still fail closed.
  if (status === 400 || /\b400\b|bad request/i.test(message)) return classified("server_error", message, true, retryAfterMs);
  if (/invalid request|schema|validation/i.test(message)) return classified(/schema|validation/i.test(message) ? "schema" : "invalid_request", message, false);
  return classified("unknown", message, false);
}

function isContextOverflowMessage(message: string): boolean {
  return /context (?:window|length)|context.*exhaust|overflow|compaction failed|range of input length should be|4(?:00|13)\s*(?:status code)?\s*\(no body\)/i.test(message);
}

function classified(code: WikiTaskFailureCode, message: string, retryable: boolean, retryAfterMs?: number): ClassifiedFailure {
  return { code, message, retryable, retryAfterMs };
}

function retryableCode(code: WikiTaskFailureCode): boolean {
  return ["rate_limit", "server_error", "network_reset", "timeout", "context_exhausted"].includes(code);
}

function partialResult(error: unknown): { markdown?: string; coverage?: string[]; gaps?: WikiDelegateGap[] } {
  return error instanceof WikiTaskExecutionError ? {
    markdown: error.options.partialMarkdown,
    coverage: error.options.coverage,
    gaps: error.options.gaps,
  } : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new WikiTaskExecutionError("Task cancelled", "cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new WikiTaskExecutionError("Task cancelled", "cancelled"));
    }, { once: true });
  });
}

export class WikiWritePathLease {
  private readonly active = new Set<string>();
  private readonly waiters: Array<{
    paths: string[];
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    onAbort: () => void;
  }> = [];

  async acquire(paths: readonly string[], signal: AbortSignal): Promise<() => void> {
    if (paths.length === 0) return () => {};
    if (signal.aborted) throw new WikiTaskExecutionError("Task cancelled", "cancelled");
    const requested = [...paths];
    if (this.available(requested)) return this.take(requested);
    return await new Promise<() => void>((resolve, reject) => {
      const waiter = {
        paths: requested,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new WikiTaskExecutionError("Task cancelled", "cancelled"));
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  hasActive(): boolean {
    return this.active.size > 0;
  }

  assertReviewAllowed(): void {
    if (this.hasActive()) throw new Error("Wiki review is blocked while Wiki writes are active");
  }

  private available(paths: readonly string[]): boolean {
    return paths.every((path) => !this.active.has(path));
  }

  private take(paths: readonly string[]): () => void {
    for (const path of paths) this.active.add(path);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const path of paths) this.active.delete(path);
      this.drain();
    };
  }

  private drain(): void {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index]!;
      if (!this.available(waiter.paths)) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(this.take(waiter.paths));
    }
  }
}

class SharedAdmissionGate {
  private active = 0;
  private pressureUntil = 0;
  private readonly waiters: Array<{ resolve: (release: () => void) => void; signal: AbortSignal }> = [];

  constructor(private readonly normalLimit: number, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(normalLimit) || normalLimit < 1) throw new Error("concurrency must be a positive integer");
  }

  reportPressure(delayMs: number): void {
    this.pressureUntil = Math.max(this.pressureUntil, this.now() + Math.max(0, delayMs));
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new WikiTaskExecutionError("Task cancelled", "cancelled");
    if (this.active < this.limit()) return this.take();
    return await new Promise<() => void>((resolve, reject) => {
      const waiter = { resolve, signal };
      const abort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new WikiTaskExecutionError("Task cancelled", "cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      waiter.resolve = (release) => {
        signal.removeEventListener("abort", abort);
        resolve(release);
      };
      this.waiters.push(waiter);
    });
  }

  private limit(): number { return this.now() < this.pressureUntil ? 1 : this.normalLimit; }
  private take(): () => void {
    this.active += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active -= 1;
      while (this.waiters.length && this.active < this.limit()) this.waiters.shift()!.resolve(this.take());
    };
  }
}
