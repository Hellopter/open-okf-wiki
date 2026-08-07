/**
 * Injectable agent runner for session orchestration.
 *
 * Production: Pi `createAgentSession` + wiki tools + structured_output.
 * Tests: createMockAgentRunner.
 *
 * No dependency on pi-dynamic-workflows.
 */

import {
  calculateContextTokens,
  createAgentSession,
  estimateTokens,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  WikiAgentRole,
  WikiContextUsage,
  WikiObservationEntry,
  WikiTokenUsage,
} from "./types.js";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

export interface WikiAgentRunRequest {
  agentId: string;
  label: string;
  phase: string;
  role: WikiAgentRole;
  prompt: string;
  /** JSON schema object for structured_output. */
  schema?: Record<string, unknown>;
  unitIds?: string[];
  pagePaths?: string[];
  signal: AbortSignal;
  tools: ToolDefinition[];
  cwd: string;
  /** Called with display-safe session observations as they appear. */
  onHistory?: (entry: WikiObservationEntry) => void;
}

export interface WikiAgentRunResult {
  status: "ok" | "failed" | "blocked" | string;
  summary?: string;
  [key: string]: unknown;
}

export interface WikiAgentRunner {
  run(req: WikiAgentRunRequest): Promise<WikiAgentRunResult | null>;
}

export interface PiAgentRunnerOptions {
  cwd: string;
  tools: ToolDefinition[];
  mainModel?: string;
  modelRegistry?: unknown;
}

function normalizeResult(value: unknown): WikiAgentRunResult {
  if (value == null) return { status: "failed", summary: "Agent returned empty result" };
  if (typeof value === "string") return { status: "ok", summary: value };
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const status = typeof obj.status === "string" && obj.status.length > 0 ? obj.status : "ok";
    return { ...obj, status } as WikiAgentRunResult;
  }
  return { status: "ok", summary: String(value) };
}

function isAbortLike(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

const MAX_OBSERVATION_TEXT = 4_000;
const MAX_OBSERVATION_FIELD = 320;

function clippedString(value: unknown, max = MAX_OBSERVATION_FIELD): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = clippedString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function toolTarget(args: unknown): { path?: string; query?: string } {
  const record = recordOf(args);
  return {
    path: firstString(record, ["path", "file_path", "filePath", "filename", "fileName"]),
    query: firstString(record, ["query", "pattern", "search", "term"]),
  };
}

function toolError(result: unknown): string | undefined {
  const direct = clippedString(result);
  if (direct) return direct;
  const record = recordOf(result);
  const directField = firstString(record, ["error", "errorMessage", "message", "stderr", "text"]);
  if (directField) return directField;
  if (Array.isArray(record?.content)) {
    for (const content of record.content) {
      const text = clippedString(content) ?? firstString(recordOf(content), ["text", "error", "message"]);
      if (text) return text;
    }
  }
  return undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeUsage(value: unknown): WikiTokenUsage | undefined {
  const usage = recordOf(value);
  if (!usage) return undefined;
  const input = numberOrZero(usage.input);
  const output = numberOrZero(usage.output);
  const cacheRead = numberOrZero(usage.cacheRead);
  const cacheWrite = numberOrZero(usage.cacheWrite);
  const total = numberOrZero(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && total === 0) return undefined;
  return { input, output, cacheRead, cacheWrite, total };
}

type PiAgentMessage = Parameters<typeof estimateTokens>[0];
type PiUsage = Parameters<typeof calculateContextTokens>[0];

interface ContextSession {
  messages: readonly PiAgentMessage[];
  model?: { contextWindow?: number };
}

function contextForTokens(tokens: number, contextWindow?: number): WikiContextUsage {
  const validWindow = contextWindow && contextWindow > 0 ? contextWindow : undefined;
  return {
    tokens,
    contextWindow: validWindow,
    percent: validWindow ? Math.round((tokens / validWindow) * 100) : undefined,
  };
}

function sessionContext(
  session: ContextSession | undefined,
): WikiContextUsage | undefined {
  if (!session) return undefined;
  const messages = session.messages;
  let lastUsageIndex: number | undefined;
  let usageTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
    const usage = "usage" in message ? (message.usage as PiUsage | undefined) : undefined;
    if (!usage) continue;
    const tokens = calculateContextTokens(usage);
    if (tokens <= 0) continue;
    lastUsageIndex = index;
    usageTokens = tokens;
    break;
  }

  const start = lastUsageIndex === undefined ? 0 : lastUsageIndex + 1;
  let trailingTokens = 0;
  for (let index = start; index < messages.length; index += 1) {
    trailingTokens += estimateTokens(messages[index]);
  }
  return contextForTokens(usageTokens + trailingTokens, session.model?.contextWindow);
}

function assistantText(content: unknown): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              block && typeof block === "object" && "text" in block
                ? String((block as { text?: string }).text ?? "")
                : "",
            )
            .join("")
        : "";
  return text ? text.slice(0, MAX_OBSERVATION_TEXT) : undefined;
}

function buildPrompt(req: WikiAgentRunRequest): string {
  if (!req.schema) return req.prompt;
  return [
    req.prompt,
    "",
    "Final output contract:",
    "- Your final action MUST be a structured_output tool call.",
    "- The structured_output arguments are the return value of this subagent.",
    "- Do not emit a prose final answer instead of structured_output.",
    "- If you need to inspect files first, do so, then call structured_output exactly once.",
  ].join("\n");
}

/**
 * Default production runner: one short-lived Pi AgentSession per task.
 */
export function createPiAgentRunner(options: PiAgentRunnerOptions): WikiAgentRunner {
  return {
    async run(req: WikiAgentRunRequest): Promise<WikiAgentRunResult | null> {
      const capture: StructuredOutputCapture = { called: false, value: undefined };
      const customTools: ToolDefinition[] = [...(req.tools?.length ? req.tools : options.tools)];
      if (req.schema) {
        customTools.push(
          createStructuredOutputTool({
            schema: req.schema,
            capture,
          }),
        );
      }

      const agentDir = getAgentDir();
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      let unsub: (() => void) | undefined;

      try {
        const created = await createAgentSession({
          cwd: req.cwd || options.cwd,
          agentDir,
          customTools,
          // Disable default bash/read/etc.; only our sandboxed wiki tools + structured_output.
          noTools: "builtin",
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.create(req.cwd || options.cwd, agentDir),
          excludeTools: ["workflow", "workflow_control", "bash"],
        });
        session = created.session;

        if (req.onHistory) {
          unsub = session.subscribe((event) => {
            try {
              const type = (event as { type?: string }).type;
              const timestamp = Date.now();
              if (type === "tool_execution_start") {
                const e = event as {
                  toolName: string;
                  toolCallId: string;
                  args: unknown;
                };
                const target = toolTarget(e.args);
                req.onHistory?.({
                  role: "tool",
                  kind: "tool_start",
                  toolName: e.toolName,
                  toolCallId: e.toolCallId,
                  ...target,
                  timestamp,
                });
              } else if (type === "tool_execution_end") {
                const e = event as {
                  toolName: string;
                  toolCallId: string;
                  result: unknown;
                  isError: boolean;
                };
                if (e.toolName === "structured_output" && !e.isError) {
                  req.onHistory?.({
                    role: "system",
                    kind: "structured_output",
                    toolName: e.toolName,
                    toolCallId: e.toolCallId,
                    timestamp,
                  });
                } else {
                  req.onHistory?.({
                    role: "tool",
                    kind: "tool_end",
                    toolName: e.toolName,
                    toolCallId: e.toolCallId,
                    isError: e.isError,
                    error: e.isError ? toolError(e.result) : undefined,
                    timestamp,
                  });
                }
              } else if (type === "message_end") {
                const e = event as {
                  message?: { role?: string; content?: unknown; usage?: unknown };
                };
                if (e.message?.role === "assistant") {
                  const text = assistantText(e.message.content);
                  const usage = normalizeUsage(e.message.usage);
                  const context = sessionContext(session);
                  if (text || usage || context) {
                    req.onHistory?.({
                      role: "assistant",
                      kind: "text",
                      text,
                      usage,
                      context,
                      timestamp,
                    });
                  }
                }
              } else if (type === "auto_retry_start") {
                const e = event as {
                  attempt: number;
                  maxAttempts: number;
                  delayMs: number;
                  errorMessage: string;
                };
                req.onHistory?.({
                  role: "system",
                  kind: "retry_start",
                  attempt: e.attempt,
                  maxAttempts: e.maxAttempts,
                  delayMs: e.delayMs,
                  error: clippedString(e.errorMessage),
                  timestamp,
                });
              } else if (type === "auto_retry_end") {
                const e = event as { success: boolean; attempt: number; finalError?: string };
                req.onHistory?.({
                  role: "system",
                  kind: "retry_end",
                  success: e.success,
                  attempt: e.attempt,
                  error: clippedString(e.finalError),
                  timestamp,
                });
              } else if (type === "compaction_start") {
                const e = event as { reason: "manual" | "threshold" | "overflow" };
                req.onHistory?.({
                  role: "system",
                  kind: "compaction_start",
                  reason: e.reason,
                  timestamp,
                });
              } else if (type === "compaction_end") {
                const e = event as {
                  reason: "manual" | "threshold" | "overflow";
                  aborted: boolean;
                  errorMessage?: string;
                  result?: {
                    tokensBefore?: number;
                    estimatedTokensAfter?: number;
                    usage?: unknown;
                  };
                };
                const tokensBefore = nonNegativeNumber(e.result?.tokensBefore);
                const tokensAfter = nonNegativeNumber(e.result?.estimatedTokensAfter);
                req.onHistory?.({
                  role: "system",
                  kind: "compaction_end",
                  reason: e.reason,
                  aborted: e.aborted,
                  success: !e.aborted && !e.errorMessage,
                  isError: Boolean(e.errorMessage),
                  error: clippedString(e.errorMessage),
                  tokensBefore,
                  tokensAfter,
                  usage: normalizeUsage(e.result?.usage),
                  // SessionManager's branch can still reflect the pre-compaction
                  // turn here; Pi's result is the authoritative post-summary size.
                  context: tokensAfter !== undefined
                    ? contextForTokens(tokensAfter, session?.model?.contextWindow)
                    : sessionContext(session),
                  timestamp,
                });
              } else if (type === "summarization_retry_scheduled") {
                const e = event as {
                  attempt: number;
                  maxAttempts: number;
                  delayMs: number;
                  errorMessage: string;
                };
                req.onHistory?.({
                  role: "system",
                  kind: "summarization_retry",
                  attempt: e.attempt,
                  maxAttempts: e.maxAttempts,
                  delayMs: e.delayMs,
                  error: clippedString(e.errorMessage),
                  timestamp,
                });
              } else if (type === "summarization_retry_finished") {
                req.onHistory?.({
                  role: "system",
                  kind: "retry_end",
                  success: true,
                  timestamp,
                });
              }
            } catch {
              // observation must not break the agent
            }
          });
        }

        const onAbort = (): void => {
          try {
            // session.abort() cancels an active turn/retry, while compaction and
            // branch summary use their own controllers inside Pi.
            session?.abortCompaction();
            session?.abortBranchSummary();
            session?.abortRetry();
            void session?.abort().catch(() => undefined);
          } catch {
            // ignore
          }
        };
        if (req.signal.aborted) onAbort();
        else req.signal.addEventListener("abort", onAbort, { once: true });

        try {
          await session.prompt(buildPrompt(req));
        } finally {
          req.signal.removeEventListener("abort", onAbort);
        }

        if (req.schema) {
          if (capture.called) return normalizeResult(capture.value);
          return { status: "failed", summary: "Subagent did not produce structured_output" };
        }
        return { status: "ok", summary: "done" };
      } catch (err) {
        if (isAbortLike(err, req.signal)) {
          throw err instanceof Error ? err : new Error(String(err));
        }
        const message = err instanceof Error ? err.message : String(err);
        return { status: "failed", summary: message };
      } finally {
        try {
          unsub?.();
        } catch {
          // ignore
        }
        try {
          session?.dispose();
        } catch {
          // ignore
        }
      }
    },
  };
}

/** @deprecated Use createPiAgentRunner — kept as alias during rename. */
export const createWorkflowAgentRunner = createPiAgentRunner;
export type WorkflowAgentRunnerOptions = PiAgentRunnerOptions;

/** Test helper: fully deterministic runner driven by a handler function. */
export function createMockAgentRunner(
  handler: (
    req: WikiAgentRunRequest,
  ) => Promise<WikiAgentRunResult | null> | WikiAgentRunResult | null,
): WikiAgentRunner {
  return {
    async run(req: WikiAgentRunRequest): Promise<WikiAgentRunResult | null> {
      return await handler(req);
    },
  };
}
