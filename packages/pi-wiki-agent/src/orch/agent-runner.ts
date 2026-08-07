/**
 * Injectable agent runner for session orchestration.
 *
 * Production: Pi `createAgentSession` + wiki tools + structured_output.
 * Tests: createMockAgentRunner.
 *
 * No dependency on pi-dynamic-workflows.
 */

import {
  createAgentSession,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { WikiAgentRole } from "./types.js";
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
  /** Called with individual transcript/tool entries as they appear. */
  onHistory?: (entry: object) => void;
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
              if (type === "tool_execution_start" || type === "tool_execution_end") {
                const e = event as {
                  type: string;
                  toolName?: string;
                  toolCallId?: string;
                  input?: Record<string, unknown>;
                  isError?: boolean;
                };
                const path =
                  e.input && typeof e.input.path === "string"
                    ? e.input.path
                    : e.input && typeof e.input.file_path === "string"
                      ? e.input.file_path
                      : undefined;
                req.onHistory?.({
                  role: "tool",
                  kind: e.type,
                  toolName: e.toolName,
                  path,
                  isError: e.isError,
                  timestamp: Date.now(),
                });
              } else if (type === "message_end") {
                const e = event as { message?: { role?: string; content?: unknown } };
                if (e.message?.role === "assistant") {
                  const text =
                    typeof e.message.content === "string"
                      ? e.message.content
                      : Array.isArray(e.message.content)
                        ? e.message.content
                            .map((c) =>
                              c && typeof c === "object" && "text" in c
                                ? String((c as { text?: string }).text ?? "")
                                : "",
                            )
                            .join("")
                        : "";
                  if (text) {
                    req.onHistory?.({
                      role: "assistant",
                      kind: "text",
                      text: text.slice(0, 2000),
                      timestamp: Date.now(),
                    });
                  }
                }
              }
            } catch {
              // observation must not break the agent
            }
          });
        }

        const onAbort = (): void => {
          try {
            session?.abort?.();
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
