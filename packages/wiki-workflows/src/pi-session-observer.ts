import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import type {
  WikiActiveTool,
  WikiActivityEntry,
  WikiAgentActivity,
  WikiAgentTarget,
  WikiAgentTelemetry,
  WikiContextStats,
} from "./producer-types.js";

const HEARTBEAT_MS = 5_000;
const UPDATE_COALESCE_MS = 250;
const MAX_SUMMARY_CHARS = 240;
const MAX_PATH_CHARS = 300;
const MAX_PROCESS_ENTRIES = 200;

export interface PiSessionObserverOptions {
  target: WikiAgentTarget;
  attempt: number;
  timeoutMs: number;
  workspaceRoot: string;
  report: (telemetry: WikiAgentTelemetry) => void | Promise<void>;
  onHealth?: (input: { target: WikiAgentTarget; status: "degraded" | "healthy"; at: string; message?: string }) => void | Promise<void>;
  now?: () => number;
}

/** Wiki-specific projection of Pi lifecycle events. It never retains message or tool result bodies. */
export class PiSessionObserver {
  private readonly activeTools = new Map<string, WikiActiveTool>();
  private readonly process: WikiActivityEntry[] = [];
  private readonly startedAt: number;
  private readonly deadlineAt: string;
  private activity: WikiAgentActivity = "starting";
  private lastActivityAt: string;
  private lastHeartbeatAt: string;
  private sequence = 0;
  private dirty = false;
  private updateTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private delivery = Promise.resolve();
  private healthDelivery = Promise.resolve();
  private unsubscribe?: () => void;
  private degraded = false;

  constructor(
    private readonly session: AgentSession,
    private readonly options: PiSessionObserverOptions,
  ) {
    this.startedAt = this.now();
    this.lastActivityAt = this.iso(this.startedAt);
    this.lastHeartbeatAt = this.lastActivityAt;
    this.deadlineAt = this.iso(this.startedAt + options.timeoutMs);
  }

  start(): void {
    if (typeof this.session.subscribe === "function") {
      this.unsubscribe = this.session.subscribe((event) => this.onEvent(event));
    }
    this.emit(true);
    this.heartbeatTimer = setInterval(() => {
      this.lastHeartbeatAt = this.iso();
      this.emit(true, false);
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  async failed(error: unknown): Promise<void> {
    const at = this.markActivity();
    this.addProcess({
      at,
      kind: "failure",
      severity: "error",
      message: `Pi session failed (${failureCode(error)})`,
      completed: true,
    });
    this.emit(true, true);
    await this.flush();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    if (this.dirty) this.emit(true);
    await this.flush();
  }

  private onEvent(event: AgentSessionEvent): void {
    const at = this.markActivity();
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        this.activity = "waiting_model";
        this.emit(true);
        return;
      case "message_start":
      case "message_update":
        if (event.message.role !== "assistant") return;
        this.activity = this.activeTools.size > 0 ? "using_tool" : "streaming";
        this.emit(false);
        return;
      case "message_end":
        if (event.message.role !== "assistant") return;
        this.activity = this.activeTools.size > 0 ? "using_tool" : "waiting_model";
        this.emit(false);
        return;
      case "tool_execution_start": {
        const tool: WikiActiveTool = {
          id: event.toolCallId,
          name: event.toolName,
          startedAt: at,
          summary: safeToolSummary(event.toolName, event.args, this.options.workspaceRoot),
        };
        this.activeTools.set(event.toolCallId, tool);
        this.activity = toolActivity(event.toolName);
        this.emit(true);
        return;
      }
      case "tool_execution_update": {
        const tool = this.activeTools.get(event.toolCallId);
        if (tool) tool.summary = safeToolSummary(event.toolName, event.args, this.options.workspaceRoot);
        this.emit(false);
        return;
      }
      case "tool_execution_end": {
        const tool = this.activeTools.get(event.toolCallId);
        this.activeTools.delete(event.toolCallId);
        this.activity = this.activeTools.size > 0
          ? "using_tool"
          : isDelegateTool(event.toolName) ? "synthesizing"
          : event.toolName === "wiki_finish" ? "finishing"
          : "waiting_model";
        this.addProcess({
          at,
          kind: "tool",
          severity: event.isError ? "error" : "info",
          message: event.isError ? toolErrorReason(event.result) ?? "failed" : "",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          summary: tool?.summary,
          durationMs: tool ? Math.max(0, this.now() - Date.parse(tool.startedAt)) : undefined,
          completed: true,
        });
        this.emit(true);
        return;
      }
      case "compaction_start":
        this.activity = "compacting";
        this.addProcess({ at, kind: "compaction", severity: "info", message: `Context compaction started (${event.reason})`, completed: false });
        this.emit(true);
        return;
      case "compaction_end":
        this.activity = this.activeTools.size > 0 ? "using_tool" : "waiting_model";
        this.addProcess({
          at,
          kind: "compaction",
          severity: event.aborted || event.errorMessage ? "warning" : "info",
          message: event.aborted ? "Context compaction aborted" : event.errorMessage ? "Context compaction failed" : "Context compaction completed",
          completed: true,
        });
        this.emit(true);
        return;
      case "turn_end":
        this.activity = "waiting_model";
        this.emit(true, true);
        return;
      case "agent_end":
        // Pi may still compact, retry, or continue after agent_end.
        this.activity = event.willRetry ? "retry_wait" : this.activeTools.size > 0 ? "using_tool" : "waiting_model";
        this.emit(true, true);
        return;
      case "agent_settled":
        this.activeTools.clear();
        this.activity = "settled";
        this.addProcess({ at, kind: "agent", severity: "info", message: "Pi session settled", completed: true });
        this.emit(true, true);
        return;
      case "auto_retry_start":
        this.activity = "retry_wait";
        this.addProcess({ at, kind: "warning", severity: "warning", message: `Unexpected Pi auto retry ${event.attempt}/${event.maxAttempts}`, completed: false });
        this.emit(true);
        return;
      case "auto_retry_end":
        this.activity = event.success ? "waiting_model" : "settled";
        this.addProcess({ at, kind: "warning", severity: "warning", message: `Unexpected Pi auto retry ${event.success ? "completed" : "failed"}`, completed: true });
        this.emit(true);
        return;
      default:
        return;
    }
  }

  private emit(immediate: boolean, includeUsage = false): void {
    this.dirty = true;
    if (!immediate) {
      if (!this.updateTimer) {
        this.updateTimer = setTimeout(() => {
          this.updateTimer = undefined;
          this.emit(true);
        }, UPDATE_COALESCE_MS);
        this.updateTimer.unref?.();
      }
      return;
    }
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.dirty = false;
    const telemetry: WikiAgentTelemetry = {
      target: this.options.target,
      attempt: this.options.attempt,
      sampledAt: this.iso(),
      activity: this.activity,
      activeTools: [...this.activeTools.values()],
      lastActivityAt: this.lastActivityAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      deadlineAt: this.deadlineAt,
      process: this.process.map((entry) => ({ ...entry })),
      ...(includeUsage ? { usage: readSessionUsage(this.session) } : {}),
      ...(this.session.sessionFile ? { sessionFile: this.session.sessionFile } : {}),
    };
    this.delivery = this.delivery.then(async () => await this.deliver(telemetry));
  }

  private async flush(): Promise<void> {
    await this.delivery;
    await this.healthDelivery;
  }

  private async deliver(telemetry: WikiAgentTelemetry): Promise<void> {
    try {
      await this.options.report(telemetry);
      if (this.degraded) {
        this.degraded = false;
        this.reportHealth({ target: this.options.target, status: "healthy", at: this.iso() });
      }
    } catch (error) {
      if (this.degraded) return;
      this.degraded = true;
      this.reportHealth({
        target: this.options.target,
        status: "degraded",
        at: this.iso(),
        message: healthError(error),
      });
    }
  }

  private reportHealth(input: { target: WikiAgentTarget; status: "degraded" | "healthy"; at: string; message?: string }): void {
    this.healthDelivery = this.healthDelivery.then(async () => {
      try {
        await this.options.onHealth?.(input);
      } catch {
        // Health reporting is deliberately outside the telemetry delivery path.
      }
    });
  }

  private addProcess(entry: Omit<WikiActivityEntry, "sequence" | "target">): void {
    this.process.push({ ...entry, sequence: ++this.sequence, target: this.options.target });
    if (this.process.length > MAX_PROCESS_ENTRIES) this.process.splice(0, this.process.length - MAX_PROCESS_ENTRIES);
  }

  private markActivity(): string {
    this.lastActivityAt = this.iso();
    return this.lastActivityAt;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private iso(value = this.now()): string {
    return new Date(value).toISOString();
  }
}

function toolActivity(name: string): WikiAgentActivity {
  if (isDelegateTool(name)) return "delegating";
  if (name === "wiki_finish") return "finishing";
  return "using_tool";
}

/** First-line error snippet only. Never persist tool result bodies. */
function toolErrorReason(result: unknown): string | undefined {
  const content = record(result)?.content;
  const text = record(Array.isArray(content) ? content[0] : undefined)?.text;
  return typeof text === "string" ? shortString(text.split(/\r?\n/, 1)[0] ?? "", MAX_SUMMARY_CHARS) : undefined;
}

function safeToolSummary(name: string, rawArgs: unknown, workspaceRoot: string): string | undefined {
  const args = record(rawArgs);
  if (!args) return undefined;
  const relativePath = safePath(args.path, workspaceRoot);
  if (name === "read" || name === "ls" || name === "write" || name === "edit") return relativePath;
  if (name === "grep" || name === "find") return joinSummary(shortString(args.pattern, 80), relativePath);
  if (name === "wiki_delegate_start") return delegateSummary(args.tasks);
  if (name === "wiki_delegate_collect") return joinSummary(batchSummary(args.batchId), shortString(args.until, 16));
  if (name === "wiki_delegate_cancel") return joinSummary(batchSummary(args.batchId), taskIdsSummary(args.taskIds));
  return undefined;
}

function isDelegateTool(name: string): boolean {
  return name === "wiki_delegate_start" || name === "wiki_delegate_collect" || name === "wiki_delegate_cancel";
}

function batchSummary(value: unknown): string | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? `batch ${value}` : undefined;
}

function taskIdsSummary(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return joinSummary(...value.slice(0, 8).map((entry) => shortString(entry, 32)));
}

function delegateSummary(rawTasks: unknown): string | undefined {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) return undefined;
  const labels = rawTasks.flatMap((value) => {
    const task = record(value);
    if (!task) return [];
    const label = [shortString(task.role, 16), shortString(task.id, 128)].filter(Boolean).join(" ");
    return label ? [label] : [];
  });
  return joinSummary(...labels);
}

function joinSummary(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part));
  if (present.length === 0) return undefined;
  const text = present.join("  ");
  return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS - 15)}...[truncated]`;
}

function safePath(value: unknown, workspaceRoot: string): string | undefined {
  const raw = shortString(value, MAX_PATH_CHARS * 2);
  if (!raw) return undefined;
  const absolute = path.resolve(workspaceRoot, raw);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "[outside-workspace]";
  return shortString(relative.replaceAll(path.sep, "/") || ".", MAX_PATH_CHARS);
}

function shortString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 15))}...[truncated]`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function failureCode(error: unknown): string {
  const value = record(error);
  if (typeof value?.code === "string" && /^[a-z0-9_]{1,40}$/i.test(value.code)) return value.code;
  if (typeof value?.status === "number") return `http_${value.status}`;
  return "session_error";
}

function healthError(error: unknown): string {
  return error instanceof Error ? shortString(error.message, MAX_SUMMARY_CHARS) ?? "Telemetry delivery failed" : "Telemetry delivery failed";
}

export function readSessionUsage(session: AgentSession): WikiContextStats | undefined {
  let stats;
  try {
    stats = session.getSessionStats();
  } catch {
    return undefined;
  }
  let context = stats.contextUsage;
  if (!context) {
    try {
      context = session.getContextUsage();
    } catch {
      context = undefined;
    }
  }
  return {
    turns: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    total: stats.tokens.total,
    cost: stats.cost,
    ...(finite(context?.tokens) !== undefined ? { contextTokens: finite(context?.tokens) } : {}),
    ...(finite(context?.contextWindow) !== undefined ? { contextWindow: finite(context?.contextWindow) } : {}),
    ...(finite(context?.percent) !== undefined ? { contextPercent: finite(context?.percent) } : {}),
  };
}
