import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { isContextBudgetMessage, WikiAgentContextBudgetError, WikiAgentProtocolError } from "./agent-errors.js";
import {
  submissionContractGuidance,
  submissionFor,
  type SubmissionCollector,
} from "./agent-submissions.js";
import { workflowTools, workspaceToolPolicy } from "./agent-tools.js";
import type {
  WikiAgentExecutionRequest,
  WikiAgentExecutionResult,
  WikiAgentExecutor,
  WikiNodeHistoryEntry,
  WikiNodeMetrics,
  WikiRunSnapshot,
} from "./workflow-types.js";

export { WikiAgentProtocolError, WikiAgentContextBudgetError } from "./agent-errors.js";

/**
 * Bounded follow-up budgets inside a single node attempt (executor layers only).
 * Engine node requeue is a separate outer layer — see execute() retry-layer comment.
 */
/** Context overflow is never salvaged inside an already-expanded session. */
export const SALVAGE_MAX = 0;
export const CORRECTION_MAX = 1;
const CLEANUP_IDLE_TIMEOUT_MS = 250;

export const PI_SESSION_POLICY = Object.freeze({
  compaction: Object.freeze({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
  retry: Object.freeze({
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2_000,
    provider: Object.freeze({ maxRetries: 0, maxRetryDelayMs: 60_000 }),
  }),
});

function piSessionPolicy(maxAutoRetries: number) {
  return {
    ...PI_SESSION_POLICY,
    retry: { ...PI_SESSION_POLICY.retry, maxRetries: maxAutoRetries },
  };
}

export interface PiAgentExecutorOptions {
  /** The selected Pi model supplied by the extension context, when available. */
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  /** Resolve Pi's current selection immediately before each child session starts. */
  getModel?: () => Model<any> | undefined;
  getThinkingLevel?: () => ThinkingLevel | undefined;
  /** Global child-session cap for this workflow runtime. */
  maxConcurrentAgents?: number;
  /** Hard wall-clock deadline for one isolated node session. */
  nodeTimeoutMs?: number;
  /** Test seam for the Pi SDK session factory. */
  createSession?: (options: CreateAgentSessionOptions) => ReturnType<typeof createAgentSession>;
}

/**
 * Pi-native child-agent executor. Each workflow node receives a fresh in-memory
 * AgentSession so its transcript can compact and retry without contaminating a
 * sibling node. Only bounded node summaries are retained by the workflow run.
 */
export class PiAgentExecutor implements WikiAgentExecutor {
  private readonly options: PiAgentExecutorOptions;
  private readonly gate: PiRuntimeGate;
  private readonly sessionReleases = new WeakMap<AgentSession, () => void>();
  private nodeTimeoutMs: number;
  private maxAutoRetries: number = PI_SESSION_POLICY.retry.maxRetries;
  private rateLimitCooldownMs = 15_000;

  constructor(options: PiAgentExecutorOptions = {}) {
    if (options.nodeTimeoutMs !== undefined && (!Number.isFinite(options.nodeTimeoutMs) || options.nodeTimeoutMs < 1_000)) {
      throw new Error("nodeTimeoutMs must be at least 1000");
    }
    this.options = options;
    this.gate = new PiRuntimeGate(options.maxConcurrentAgents ?? 2);
    this.nodeTimeoutMs = options.nodeTimeoutMs ?? 20 * 60_000;
  }

  setMaxConcurrentAgents(value: number): void {
    this.gate.setNormalLimit(value);
  }

  setRuntimePolicy(policy: Pick<WikiRunSnapshot["policy"], "quality" | "runtime">): void {
    this.setMaxConcurrentAgents(policy.runtime.maxConcurrentAgents);
    this.nodeTimeoutMs = policy.runtime.nodeTimeoutSeconds * 1_000;
    this.maxAutoRetries = policy.runtime.maxAutoRetries;
    this.rateLimitCooldownMs = policy.runtime.rateLimitCooldownSeconds * 1_000;
    this.gate.clearProviderPressure();
  }

  /**
   * Retry layers (innermost → outermost), each bounded:
   *
   * 1. **Pi auto-retry** — `session.setAutoRetryEnabled(true)`. Handles transient
   *    provider/stream failures inside the session. The Pi SDK only exposes an
   *    on/off toggle (maxRetries comes from settings); we leave it enabled and
   *    count attempts via `auto_retry_*` / `summarization_retry_*` events →
   *    `metrics.autoRetries`.
   * 2. **Context overflow** — terminates the expanded session immediately. The
   *    engine may retry once in a fresh, narrower node session; this executor
   *    never adds more context to the failed session.
   * 3. **Correction follow-up** — at most {@link CORRECTION_MAX} turn when a
   *    required submission is missing or was rejected (except validator_infrastructure)
   *    → `metrics.correctionAttempts`.
   * 4. **Node requeue (engine)** — outside this executor; `classifyNodeFailure` /
   *    engine may re-run the whole node up to policy max attempts. Do not join
   *    that path from here.
   */
  async execute(request: WikiAgentExecutionRequest): Promise<WikiAgentExecutionResult> {
    const submission = submissionFor(request);
    const session = await this.createIsolatedSession(request, submission);
    session.setAutoCompactionEnabled(true);
    // Layer 1: Pi auto-retry. No public maxAttempts setter on AgentSession — enable only.
    session.setAutoRetryEnabled(true);
    const history: WikiNodeHistoryEntry[] = [];
    const toolTargets = new Map<string, { target?: string; summary?: string }>();
    // Submission-tool rejections are corrected by the model in the same turn.
    // This counter only covers a model that ended without a required submission.
    let correctionAttempts = 0;
    const retryLayers = () => ({ salvageAttempts: 0, correctionAttempts });
    const streamOutput = new StreamingOutput();
    const unsubscribe = session.subscribe((event) => this.handleEvent(session, event, request, history, toolTargets, streamOutput));
    const abort = () => { abortSession(session); };
    request.signal.addEventListener("abort", abort, { once: true });
    const timeoutMs = this.nodeTimeoutMs;
    let timeout: NodeJS.Timeout | undefined;
    let sessionSettled = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        abortSession(session);
        reject(new Error(`Wiki agent session timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      if (request.signal.aborted) throw new Error("Workflow node was cancelled");
      request.onActivity?.({ state: "running", message: "Running" });
      await Promise.race([session.prompt(request.prompt), deadline]);
      await Promise.race([session.waitForIdle(), deadline]);
      sessionSettled = true;
      if (request.signal.aborted) throw new Error("Workflow node was cancelled");

      let output = retainedOutput(session.getLastAssistantText() ?? "");
      request.onOutput?.(output);

      // A recorded submission wins over residual session errors (e.g. late overflow).
      if (submission?.value !== undefined) {
        return finishSuccess(session, request, submission.value, output, history, retryLayers());
      }

      // Never append a salvage/correction turn to an already overflowing session.
      if (isContextBudgetMessage(session.state.errorMessage)) {
        throw new WikiAgentContextBudgetError(
          output,
          retainedHistory(history),
          session.state.errorMessage ?? "Context budget exceeded",
        );
      }

      // Layer 3: correction — one turn for missing/invalid required submission.
      if (submission && submission.value === undefined && correctionAttempts < CORRECTION_MAX) {
        if (submission.exhausted || submission.failure?.code === "validator_infrastructure") {
          throw new WikiAgentProtocolError(submission.toolNames, output, retainedHistory(history), submission.failure);
        }
        correctionAttempts += 1;
        const requiredTools = submission.toolNames.join(" or ");
        request.onActivity?.({ state: "waiting", message: `Waiting for ${requiredTools}` }, { correctionAttempts });
        const correction = submission.failure ? ` The prior submission was rejected: ${submission.failure.message}` : "";
        const correctionAction = submission.toolNames[0] === "wiki_submit_page"
          ? "Fix every reported issue in the assigned page before resubmitting."
          : "Correct every returned issue, update staging when needed, and call the terminal tool again with its role-specific payload; do not write a handoff file or reply with JSON text.";
        const contracts = submission.toolNames.map((toolName) => `${toolName}: ${submissionContractGuidance(toolName)}`).join(" ");
        sessionSettled = false;
        await Promise.race([
          session.followUp(`Do not explain or return JSON as text. Use the available staging and query tools as needed, then call exactly one terminal tool: ${requiredTools}.${correction} ${contracts} ${correctionAction} After acceptance, stop.`),
          deadline,
        ]);
        await Promise.race([session.waitForIdle(), deadline]);
        sessionSettled = true;
        if (request.signal.aborted) throw new Error("Workflow node was cancelled");
        output = retainedOutput(session.getLastAssistantText() ?? "");
        request.onOutput?.(output);

        if (submission.value !== undefined) {
          return finishSuccess(session, request, submission.value, output, history, retryLayers());
        }
        if (isContextBudgetMessage(session.state.errorMessage)) {
          throw new WikiAgentContextBudgetError(
            output,
            retainedHistory(history),
            session.state.errorMessage ?? "Context budget exceeded",
          );
        }
        throw new WikiAgentProtocolError(submission.toolNames, output, retainedHistory(history), submission.failure);
      }

      if (session.state.errorMessage) throw new Error(session.state.errorMessage);
      return finishSuccess(session, request, submission?.value, output, history, retryLayers());
    } finally {
      if (timeout) clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
      try {
        unsubscribe();
      } catch {
        // Best-effort: disposal below remains mandatory even for a bad listener.
      }
      if (!sessionSettled) abortSession(session);
      await waitForIdleBounded(session, CLEANUP_IDLE_TIMEOUT_MS);
      try {
        // Agent has reset() when idle — clear transcript before dispose.
        (session as { agent?: { reset?: () => void } }).agent?.reset?.();
      } catch {
        // Best-effort: never block dispose on reset failures.
      }
      try {
        session.dispose();
      } finally {
        this.sessionReleases.get(session)?.();
        this.sessionReleases.delete(session);
      }
    }
  }

  private async createIsolatedSession(request: WikiAgentExecutionRequest, submission?: SubmissionCollector): Promise<AgentSession> {
    if (request.role === "researcher" && !request.readRoots?.length) {
      throw new Error("Workflow configuration error: researcher requests require at least one source root");
    }
    const toolPolicy = await workspaceToolPolicy(request.cwd, request.candidateWikiRoot);
    const agentDir = getAgentDir();
    // Pin workflow child behavior without reading or mutating the user's Pi settings.
    const settingsManager = SettingsManager.inMemory(piSessionPolicy(this.maxAutoRetries));
    const resourceLoader = new DefaultResourceLoader({
      cwd: toolPolicy.workspaceRoot,
      agentDir,
      settingsManager,
      // Workflow children never load the host extension, skills, or prompts.
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
    });
    await resourceLoader.reload();

    const customTools = workflowTools(
      toolPolicy,
      request.role,
      submission,
      request.writePaths,
      request.readRoots,
      request.wikiReadPaths,
      request.researchCatalog,
      request.writerStagingWikiRoot,
    );
    const release = await this.gate.acquire(request.signal);
    let result: Awaited<ReturnType<typeof createAgentSession>>;
    try {
      result = await (this.options.createSession ?? createAgentSession)({
        cwd: toolPolicy.workspaceRoot,
        model: this.options.getModel?.() ?? this.options.model,
        thinkingLevel: this.options.getThinkingLevel?.() ?? this.options.thinkingLevel,
        sessionManager: SessionManager.inMemory(toolPolicy.workspaceRoot),
        settingsManager,
        resourceLoader,
        // These guarded definitions are the complete child-agent tool surface.
        // Deriving the allowlist from them prevents a custom tool being registered
        // yet silently hidden from the model.
        noTools: "builtin",
        tools: customTools.map((tool) => tool.name),
        customTools,
      });
    } catch (error) {
      release();
      throw error;
    }
    if (submission && submission.toolNames.some((toolName) => !result.session.getActiveToolNames().includes(toolName))) {
      try {
        result.session.dispose();
      } finally {
        release();
      }
      throw new Error(`Workflow configuration error: ${submission.toolNames.join(" and ")} must be active for ${request.node.kind}`);
    }
    this.sessionReleases.set(result.session, release);
    return result.session;
  }

  private handleEvent(
    session: AgentSession,
    event: AgentSessionEvent,
    request: WikiAgentExecutionRequest,
    history: WikiNodeHistoryEntry[],
    toolTargets: Map<string, { target?: string; summary?: string }>,
    streamOutput: StreamingOutput,
  ): void {
    switch (event.type) {
      case "compaction_start":
        request.onActivity?.({ state: "compacting", message: `Compacting (${event.reason})` }, { compactions: 1 });
        return;
      case "compaction_end":
        request.onActivity?.({
          state: event.aborted ? "waiting" : "running",
          message: event.errorMessage ?? (event.aborted ? "Compaction interrupted" : "Compaction completed"),
        });
        return;
      // Layer 1 metrics: each scheduled auto-retry increments metrics.autoRetries (engine merges incrementally).
      case "auto_retry_start":
        this.gate.reportProviderPressure(event.errorMessage, event.delayMs, this.rateLimitCooldownMs);
        request.onActivity?.({
          state: "retrying",
          message: event.errorMessage,
          retryAttempt: event.attempt,
          retryMaxAttempts: event.maxAttempts,
          retryDelayMs: event.delayMs,
        }, { autoRetries: 1 });
        return;
      case "auto_retry_end":
        request.onActivity?.({ state: event.success ? "running" : "waiting", message: event.finalError });
        return;
      case "summarization_retry_scheduled":
        request.onActivity?.({
          state: "retrying",
          message: `Retrying summary: ${event.errorMessage}`,
          retryAttempt: event.attempt,
          retryMaxAttempts: event.maxAttempts,
          retryDelayMs: event.delayMs,
        }, { autoRetries: 1 });
        return;
      case "summarization_retry_attempt_start":
        request.onActivity?.({ state: "retrying", message: `Retrying ${event.source} summary` });
        return;
      case "summarization_retry_finished":
        request.onActivity?.({ state: "running", message: "Summary retry completed" });
        return;
      case "message_update":
        {
          const output = streamOutput.update(event);
          if (output) request.onOutput?.(output);
        }
        request.onActivity?.({ state: "running", message: "Streaming response" }, metricsFromSession(session));
        return;
      case "message_end": {
        const text = assistantText(event.message);
        if (text) appendHistory(history, request, { at: new Date().toISOString(), kind: "message", text });
        const messageError = assistantError(event.message);
        if (messageError) appendHistory(history, request, { at: new Date().toISOString(), kind: "error", text: messageError, isError: true });
        return;
      }
      case "tool_execution_start":
        {
          const target = toolTarget(event.args);
          const summary = toolCallSummary(event.toolName, event.args);
          toolTargets.set(event.toolCallId, { target, summary });
          appendHistory(history, request, {
            at: new Date().toISOString(),
            kind: "tool_call",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            target,
            summary,
            text: compactJson(event.args),
          });
        }
        request.onActivity?.({ state: "running", message: `Using ${event.toolName}` });
        return;
      case "tool_execution_end":
        {
          const source = toolTargets.get(event.toolCallId);
          const text = toolResultText(event.result);
          appendHistory(history, request, {
            at: new Date().toISOString(),
            kind: event.isError ? "error" : "tool_result",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            target: source?.target,
            summary: event.isError ? firstLine(text) : toolResultSummary(event.toolName, text, source?.summary),
            text,
            isError: event.isError,
          });
          toolTargets.delete(event.toolCallId);
        }
        return;
      default:
        return;
    }
  }
}

function abortSession(session: AgentSession): void {
  void session.abort().catch(() => {
    // Best-effort: bounded idle drain and dispose still run after abort failure.
  });
}

async function waitForIdleBounded(session: AgentSession, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      session.waitForIdle().catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class PiRuntimeGate {
  private active = 0;
  private pressureUntil = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];

  constructor(private normalLimit: number) {
    if (!Number.isInteger(normalLimit) || normalLimit < 1 || normalLimit > 4) {
      throw new Error("maxConcurrentAgents must be an integer from 1 to 4");
    }
  }

  setNormalLimit(value: number): void {
    if (!Number.isInteger(value) || value < 1 || value > 4) {
      throw new Error("maxConcurrentAgents must be an integer from 1 to 4");
    }
    this.normalLimit = value;
    this.drain();
  }

  clearProviderPressure(): void {
    this.pressureUntil = 0;
    this.drain();
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new Error("Workflow node was cancelled");
    if (this.active < this.limit()) return this.take();
    return await new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Workflow node was cancelled"));
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  reportProviderPressure(message: string, retryDelayMs: number, cooldownMs: number): void {
    if (!/\b429\b|too many requests|rate limit|overloaded/i.test(message)) return;
    this.pressureUntil = Math.max(this.pressureUntil, Date.now() + Math.max(cooldownMs, retryDelayMs));
  }

  private limit(): number {
    return Date.now() < this.pressureUntil ? 1 : this.normalLimit;
  }

  private take(): () => void {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.active < this.limit()) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve(this.take());
    }
  }
}

export function createPiAgentExecutor(options: PiAgentExecutorOptions = {}): PiAgentExecutor {
  return new PiAgentExecutor(options);
}

function finishSuccess(
  session: AgentSession,
  request: WikiAgentExecutionRequest,
  result: unknown,
  output: string,
  history: WikiNodeHistoryEntry[],
  retryLayers: { salvageAttempts: number; correctionAttempts: number },
): WikiAgentExecutionResult {
  const stats = session.getSessionStats();
  const context = session.getContextUsage();
  const metrics: Partial<WikiNodeMetrics> = {
    ...metricsFromStats(stats, context, session),
    salvageAttempts: retryLayers.salvageAttempts,
    correctionAttempts: retryLayers.correctionAttempts,
  };
  request.onActivity?.({ state: "completed", message: "Completed" }, metrics);
  return {
    result,
    output,
    history: retainedHistory(history),
    metrics,
  };
}

const MAX_HISTORY_ENTRIES = 32;
const MAX_HISTORY_ENTRY_CHARS = 2_000;
const MAX_HISTORY_CHARS = 12 * 1024;
const MAX_STREAM_OUTPUT_CHARS = 8 * 1024;
const MAX_FINAL_OUTPUT_CHARS = 50 * 1024;

class StreamingOutput {
  private value = "";

  update(event: Extract<AgentSessionEvent, { type: "message_update" }>): string {
    const update = event.assistantMessageEvent;
    if (update?.type === "text_delta") {
      this.value = retainedText(`${this.value}${update.delta}`, MAX_STREAM_OUTPUT_CHARS);
    } else {
      this.value = retainedText(assistantText(event.message), MAX_STREAM_OUTPUT_CHARS);
    }
    return this.value;
  }
}

function retainedOutput(output: string): string {
  return retainedText(output, MAX_FINAL_OUTPUT_CHARS);
}

function appendHistory(
  history: WikiNodeHistoryEntry[],
  request: WikiAgentExecutionRequest,
  entry: WikiNodeHistoryEntry,
): void {
  history.push({ ...entry, text: retainedText(entry.text, MAX_HISTORY_ENTRY_CHARS) });
  const retained = retainedHistory(history);
  history.splice(0, history.length, ...retained);
  request.onHistory?.(retained);
}

function retainedHistory(history: WikiNodeHistoryEntry[]): WikiNodeHistoryEntry[] {
  const retained: WikiNodeHistoryEntry[] = [];
  let chars = 0;
  for (const entry of history.slice(-MAX_HISTORY_ENTRIES).reverse()) {
    const remaining = MAX_HISTORY_CHARS - chars;
    if (remaining <= 0) break;
    const text = retainedText(entry.text, remaining);
    retained.unshift({ ...entry, text });
    chars += text.length;
  }
  return retained;
}

function retainedText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 40) return text.slice(-limit);
  let retainedLength = limit;
  let marker = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    marker = `[... ${text.length - retainedLength} earlier characters omitted ...]\n`;
    const nextLength = Math.max(0, limit - marker.length);
    if (nextLength === retainedLength) break;
    retainedLength = nextLength;
  }
  return `${marker}${text.slice(-retainedLength)}`;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function toolResultText(value: unknown): string {
  if (!value || typeof value !== "object") return compactJson(value);
  const result = value as { content?: unknown };
  if (!Array.isArray(result.content)) return compactJson(value);
  const text = result.content
    .map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : "")
    .filter(Boolean)
    .join("\n");
  return text || compactJson(value);
}

function toolTarget(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file", "directory"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return undefined;
}

function toolCallSummary(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  if ((toolName === "grep" || toolName === "find") && typeof record.pattern === "string") return record.pattern;
  return undefined;
}

function toolResultSummary(toolName: string, text: string, callSummary?: string): string {
  if (toolName === "grep" || toolName === "find" || toolName === "ls") {
    const count = text.split("\n").filter(Boolean).length;
    return count ? `${count} result${count === 1 ? "" : "s"}` : "No results";
  }
  return callSummary ?? "Completed";
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object"
      && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("");
}

function assistantError(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as { role?: unknown; errorMessage?: unknown };
  return value.role === "assistant" && typeof value.errorMessage === "string" && value.errorMessage.trim()
    ? value.errorMessage
    : undefined;
}

function metricsFromSession(session: AgentSession): Partial<WikiNodeMetrics> {
  return metricsFromStats(session.getSessionStats(), session.getContextUsage(), session);
}

function metricsFromStats(
  stats: ReturnType<AgentSession["getSessionStats"]>,
  context: ReturnType<AgentSession["getContextUsage"]>,
  session: AgentSession,
): Partial<WikiNodeMetrics> {
  const tokens = stats.tokens;
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
    totalTokens: tokens.total,
    cost: stats.cost,
    model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
    contextTokens: context?.tokens ?? undefined,
    contextWindow: context?.contextWindow,
    contextPercent: context?.percent ?? undefined,
    contextEstimated: context?.tokens !== undefined && context.tokens !== null,
  };
}
