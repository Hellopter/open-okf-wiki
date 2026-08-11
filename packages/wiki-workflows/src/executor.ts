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
import {
  isContextBudgetMessage,
  WikiAgentContextBudgetError,
  WikiAgentProtocolError,
} from "./agent-errors.js";
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
} from "./workflow-types.js";

export { WikiAgentProtocolError, WikiAgentContextBudgetError } from "./agent-errors.js";

export interface PiAgentExecutorOptions {
  /** The selected Pi model supplied by the extension context, when available. */
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  /** Resolve Pi's current selection immediately before each child session starts. */
  getModel?: () => Model<any> | undefined;
  getThinkingLevel?: () => ThinkingLevel | undefined;
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

  constructor(options: PiAgentExecutorOptions = {}) {
    this.options = options;
  }

  async execute(request: WikiAgentExecutionRequest): Promise<WikiAgentExecutionResult> {
    const submission = submissionFor(request);
    const session = await this.createIsolatedSession(request, submission);
    session.setAutoCompactionEnabled(true);
    session.setAutoRetryEnabled(true);
    const history: WikiNodeHistoryEntry[] = [];
    const toolTargets = new Map<string, { target?: string; summary?: string }>();
    const unsubscribe = session.subscribe((event) => this.handleEvent(session, event, request, history, toolTargets));
    const abort = () => { void session.abort(); };
    request.signal.addEventListener("abort", abort, { once: true });

    try {
      request.onActivity?.({ state: "running", message: "Running" });
      await session.prompt(request.prompt);
      await session.waitForIdle();
      if (request.signal.aborted) throw new Error("Workflow node was cancelled");

      let output = session.getLastAssistantText() ?? "";
      request.onOutput?.(output);

      // A recorded submission wins over residual session errors (e.g. late overflow).
      if (submission?.value !== undefined) {
        return finishSuccess(session, request, submission.value, output, history);
      }

      // Context pressure: one salvage turn to write handoff + submit without more exploration.
      if (isContextBudgetMessage(session.state.errorMessage)) {
        request.onActivity?.({ state: "waiting", message: "Recovering from context pressure" });
        await session.followUp(contextSalvagePrompt(submission?.toolName));
        await session.waitForIdle();
        if (request.signal.aborted) throw new Error("Workflow node was cancelled");
        output = session.getLastAssistantText() ?? "";
        request.onOutput?.(output);
        if (submission?.value !== undefined) {
          return finishSuccess(session, request, submission.value, output, history);
        }
        throw new WikiAgentContextBudgetError(
          output,
          retainedHistory(history),
          session.state.errorMessage ?? "Context budget exceeded",
        );
      }

      if (submission && submission.value === undefined) {
        if (submission.failure?.code === "validator_infrastructure") {
          throw new WikiAgentProtocolError(submission.toolName, output, retainedHistory(history), submission.failure);
        }
        request.onActivity?.({ state: "waiting", message: `Waiting for ${submission.toolName}` });
        const correction = submission.failure ? ` The prior submission was rejected: ${submission.failure.message}` : "";
        const correctionAction = submission.toolName === "wiki_submit_page"
          ? "Fix every reported issue in the assigned page before resubmitting."
          : "Rewrite the complete handoff artifact before resubmitting; do not reply with JSON text.";
        await session.followUp(`Before completing this node, submit a valid final result with ${submission.toolName}.${correction} ${submissionContractGuidance(submission.toolName)} ${correctionAction} After it is recorded, stop.`);
        await session.waitForIdle();
        if (request.signal.aborted) throw new Error("Workflow node was cancelled");
        output = session.getLastAssistantText() ?? "";
        request.onOutput?.(output);

        if (submission.value !== undefined) {
          return finishSuccess(session, request, submission.value, output, history);
        }
        if (isContextBudgetMessage(session.state.errorMessage)) {
          throw new WikiAgentContextBudgetError(
            output,
            retainedHistory(history),
            session.state.errorMessage ?? "Context budget exceeded",
          );
        }
        throw new WikiAgentProtocolError(submission.toolName, output, retainedHistory(history), submission.failure);
      }

      if (session.state.errorMessage) throw new Error(session.state.errorMessage);
      return finishSuccess(session, request, submission?.value, output, history);
    } finally {
      request.signal.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }
  }

  private async createIsolatedSession(request: WikiAgentExecutionRequest, submission?: SubmissionCollector): Promise<AgentSession> {
    if (request.role === "researcher" && !request.readRoots?.length) {
      throw new Error("Workflow configuration error: researcher requests require at least one source root");
    }
    if (request.role !== "writer" && !request.artifactWritePath) {
      throw new Error(`Workflow configuration error: ${request.role} requests require an artifact write path`);
    }
    const toolPolicy = await workspaceToolPolicy(request.cwd);
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(toolPolicy.workspaceRoot, agentDir);
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
      request.artifactPaths,
      request.wikiReadPaths,
      request.artifactWritePath,
    );
    const result = await (this.options.createSession ?? createAgentSession)({
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
    if (submission && !result.session.getActiveToolNames().includes(submission.toolName)) {
      result.session.dispose();
      throw new Error(`Workflow configuration error: ${submission.toolName} is not active for ${request.node.kind}`);
    }
    return result.session;
  }

  private handleEvent(
    session: AgentSession,
    event: AgentSessionEvent,
    request: WikiAgentExecutionRequest,
    history: WikiNodeHistoryEntry[],
    toolTargets: Map<string, { target?: string; summary?: string }>,
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
      case "auto_retry_start":
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
          const output = assistantText(event.message);
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

export function createPiAgentExecutor(options: PiAgentExecutorOptions = {}): PiAgentExecutor {
  return new PiAgentExecutor(options);
}

function finishSuccess(
  session: AgentSession,
  request: WikiAgentExecutionRequest,
  result: unknown,
  output: string,
  history: WikiNodeHistoryEntry[],
): WikiAgentExecutionResult {
  const stats = session.getSessionStats();
  const context = session.getContextUsage();
  request.onActivity?.({ state: "completed", message: "Completed" }, metricsFromSession(session));
  return {
    result,
    output,
    history: retainedHistory(history),
    metrics: metricsFromStats(stats, context, session),
  };
}

function contextSalvagePrompt(toolName: string | undefined): string {
  const submit = toolName ?? "the required wiki_submit_* tool";
  if (toolName === "wiki_submit_page") {
    return [
      "Stop exploring and stop calling survey tools (read/grep/find/ls).",
      "Finish the assigned Wiki page with write/edit only.",
      `Submit immediately with ${submit}.`,
      "Do not expand scope. After a successful submit, stop.",
    ].join(" ");
  }
  return [
    "Stop exploring and stop calling survey tools (read/grep/find/ls).",
    "Write the complete handoff artifact now with wiki_write_handoff.",
    `Submit immediately with ${submit}.`,
    "For research: cite evidence only from files you already read in this session; do not invent ranges.",
    "Do not expand scope. After a successful submit, stop.",
  ].join(" ");
}

const MAX_HISTORY_ENTRIES = 48;
const MAX_HISTORY_ENTRY_CHARS = 2_000;
const MAX_HISTORY_CHARS = 24 * 1024;

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
