import type { WikiArtifactRef, WikiArtifactStore } from "./artifact-store.js";
import {
  boundedDelegateSummary,
  WikiTaskExecutionError,
  WikiTaskPauseError,
  type WikiDelegateBatchReceipt,
  type WikiDelegateError,
  type WikiDelegateGap,
  type WikiDelegateReceipt,
  type WikiDelegateRole,
  type WikiDelegateTask,
  type WikiTaskFailureCode,
} from "./delegate-contracts.js";

export interface WikiLeafTaskContext {
  runId: string;
  attempt: number;
  cwd: string;
  sourceRoots: Record<string, string>;
  contextArtifacts: Record<string, WikiArtifactRef>;
  candidateWikiRoot?: string;
  signal: AbortSignal;
}

export interface WikiLeafResult {
  summary: string;
  markdown: string;
  coverage?: string[];
  gaps?: WikiDelegateGap[];
  status?: "complete" | "incomplete";
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
  baseRetryDelayMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export class WikiTaskRuntime {
  private readonly gate: SharedAdmissionGate;
  private readonly contextArtifacts: Record<string, WikiArtifactRef>;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly baseRetryDelayMs: number;

  constructor(private readonly options: WikiTaskRuntimeOptions) {
    this.gate = new SharedAdmissionGate(options.concurrency ?? 2, options.now);
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.contextArtifacts = { ...options.contextArtifacts };
  }

  async delegate(tasks: readonly WikiDelegateTask[], signal: AbortSignal): Promise<WikiDelegateBatchReceipt> {
    validateBatch(tasks, this.options);
    for (const task of tasks) {
      for (const ref of task.contextRefs) {
        if (!Object.hasOwn(this.contextArtifacts, ref)) throw new Error(`Delegate task ${task.id} requests undeclared context artifact: ${ref}`);
      }
    }
    const receipts = await Promise.all(tasks.map(async (task) => await this.execute(task, signal)));
    for (const value of receipts) {
      const output = value.outputs.at(-1);
      if (output) this.contextArtifacts[value.id] = output;
    }
    const pause = receipts.find((receipt) => receipt.error?.code === "quota" || receipt.error?.code === "usage_limit")?.error;
    if (pause && (pause.code === "quota" || pause.code === "usage_limit")) {
      throw new WikiTaskPauseError(pause.code, pause.message, pause.retryAfterMs);
    }
    const complete = receipts.filter((receipt) => receipt.status === "complete").length;
    return {
      status: complete === receipts.length ? "complete" : complete > 0 ? "partial" : "failed",
      receipts,
    };
  }

  private async execute(task: WikiDelegateTask, signal: AbortSignal): Promise<WikiDelegateReceipt> {
    let lastFailure: ClassifiedFailure | undefined;
    const acceptedOutputs: WikiArtifactRef[] = [];
    const acceptedCoverage = new Set<string>();
    const acceptedGaps: WikiDelegateGap[] = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let release: (() => void) | undefined;
      try {
        release = await this.gate.acquire(signal);
        const result = await this.options.agent.run(task, this.contextFor(task, attempt, signal));
        const output = await this.persist(task, attempt, result.markdown);
        return receipt(task, result.status ?? "complete", result.summary, [...acceptedOutputs, output], [...acceptedCoverage, ...(result.coverage ?? [])], [...acceptedGaps, ...(result.gaps ?? [])], undefined, attempt);
      } catch (error) {
        let failure = classifyTaskFailure(error, signal.aborted);
        lastFailure = failure;
        const partial = partialResult(error);
        if (partial.markdown) {
          try {
            acceptedOutputs.push(await this.persist(task, attempt, partial.markdown));
            for (const value of partial.coverage ?? []) acceptedCoverage.add(value);
            acceptedGaps.push(...(partial.gaps ?? []));
          } catch (artifactError) {
            failure = classifyTaskFailure(artifactError);
            lastFailure = failure;
          }
        }
        if (failure.code === "quota" || failure.code === "usage_limit") {
          return receipt(task, "failed", failure.message, acceptedOutputs, [...acceptedCoverage], acceptedGaps, failure, attempt);
        }
        const mayRetry = failure.retryable && attempt === 1;
        if (!mayRetry) {
          const status = acceptedOutputs.length > 0 || failure.code === "timeout" || failure.code === "context_exhausted"
            ? "incomplete"
            : "failed";
          return receipt(task, status, failure.message, acceptedOutputs, [...acceptedCoverage], acceptedGaps, failure, attempt);
        }
        if (failure.code === "rate_limit") this.gate.reportPressure(failure.retryAfterMs ?? this.baseRetryDelayMs);
        release?.();
        release = undefined;
        const delay = failure.code === "rate_limit" && failure.retryAfterMs !== undefined
          ? failure.retryAfterMs
          : Math.floor(this.random() * this.baseRetryDelayMs);
        await this.sleep(delay, signal);
      } finally {
        release?.();
      }
    }
    return receipt(task, acceptedOutputs.length ? "incomplete" : "failed", lastFailure?.message ?? "Task failed", acceptedOutputs, [...acceptedCoverage], acceptedGaps, lastFailure, 2);
  }

  private contextFor(task: WikiDelegateTask, attempt: number, signal: AbortSignal): WikiLeafTaskContext {
    return {
      runId: this.options.runId,
      attempt,
      cwd: this.options.cwd,
      sourceRoots: Object.fromEntries(task.sourceScopeIds.map((id) => [id, this.options.sourceScopes[id]])),
      contextArtifacts: Object.fromEntries(task.contextRefs.map((id) => [id, this.contextArtifacts[id]])),
      candidateWikiRoot: this.options.candidateWikiRoot,
      signal,
    };
  }

  private async persist(task: WikiDelegateTask, attempt: number, markdown: string): Promise<WikiArtifactRef> {
    try {
      return await this.options.artifactStore.write({
        runId: this.options.runId,
        nodeId: task.id,
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
}

function validateBatch(tasks: readonly WikiDelegateTask[], options: WikiTaskRuntimeOptions): void {
  if (tasks.length === 0) throw new Error("wiki_delegate requires at least one task");
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
    for (const value of task.writePaths ?? []) {
      if (!/^wiki\/(?!.*(?:^|\/)\.\.?\/)[^\\]+\.md$/.test(value)) throw new Error(`Unsafe Wiki write path: ${value}`);
      if (writes.has(value)) throw new Error(`Delegate writePaths overlap within batch: ${value}`);
      writes.add(value);
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
  };
}

interface ClassifiedFailure extends WikiDelegateError {}

export function classifyTaskFailure(error: unknown, aborted = false): ClassifiedFailure {
  if (aborted) return classified("cancelled", messageOf(error), false);
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
  if (/context (?:window|length)|context.*exhaust|overflow|compaction failed/i.test(message)) return classified("context_exhausted", message, true);
  if (/timed? out|timeout/i.test(message)) return classified("timeout", message, true);
  if (/\b401\b|unauthorized|invalid api key/i.test(message)) return classified("unauthorized", message, false);
  if (/\b403\b|forbidden/i.test(message)) return classified("forbidden", message, false);
  if (/invalid request|schema|validation/i.test(message)) return classified(/schema|validation/i.test(message) ? "schema" : "invalid_request", message, false);
  return classified("unknown", message, false);
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
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new WikiTaskExecutionError("Task cancelled", "cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.push({ ...waiter, resolve: (release) => {
        signal.removeEventListener("abort", abort);
        resolve(release);
      } });
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
