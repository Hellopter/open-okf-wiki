import type {
  WikiActivityEntry,
  WikiAgentInspection,
  WikiAgentStatus,
  WikiContextStats,
  WikiDelegationBatchSummary,
  WikiRunEvent,
  WikiRunStage,
  WikiRunView,
} from "./producer-types.js";
import { formatLocalDateTime } from "./time-format.js";

export type WikiTone = "muted" | "accent" | "success" | "warning" | "error";
export type WikiMarker = "·" | "◆" | "✓" | "◐" | "✗" | "○" | "!" | "⏸";
export type WikiLiveness = "quiet" | "active" | "alive_without_activity" | "degraded" | "terminal";

export interface WikiStatusSemantics {
  marker: WikiMarker;
  tone: WikiTone;
  terminal: boolean;
}

export interface WikiRunObservability {
  language: "zh" | "en";
  status: WikiStatusSemantics & { label: string };
  stage?: { key: WikiRunStage; label: string };
  health: "healthy" | "degraded";
  liveness: WikiLiveness;
  activityAge?: string;
  heartbeatAge?: string;
}

export interface WikiRunEventObservability {
  text: string;
  tone: WikiTone;
  visible: boolean;
}

/** Project a durable domain event into presentation semantics for every UI adapter. */
export function projectWikiRunEvent(event: WikiRunEvent): WikiRunEventObservability {
  const message = event.message.trim() || eventLabel(event.type);
  switch (event.type) {
    case "stage":
      return { text: `[${event.stage}] ${message}`, tone: "accent", visible: true };
    case "delegate": {
      const task = event.taskId ? ` ${event.taskId}` : "";
      return { text: `[batch ${event.batch} ${event.completed}/${event.total}] ${message}${task}`, tone: "accent", visible: true };
    }
    case "telemetry":
      return { text: message, tone: event.phase === "observability_health" && event.status === "degraded" ? "warning" : "muted", visible: false };
    case "warning":
      return { text: event.detail === message ? message : `${message}: ${event.detail}`, tone: "warning", visible: true };
    case "paused":
      return { text: message, tone: "warning", visible: true };
    case "failed":
      return { text: message, tone: "error", visible: true };
    case "completed":
      return { text: message, tone: "success", visible: true };
    case "cancelled":
      return { text: message, tone: "muted", visible: true };
    case "started":
    case "progress":
    case "resumed":
      return { text: message, tone: "accent", visible: true };
  }
}

export function projectWikiRunObservability(view: WikiRunView, now = Date.now()): WikiRunObservability {
  const language = view.progress?.language ?? "en";
  const lead = view.progress?.lead;
  const status = runStatusSemantics(view.status);
  const health = lead?.health ?? "healthy";
  const activityAge = formatAge(lead?.lastActivityAt, now);
  const heartbeatAge = formatAge(lead?.lastHeartbeatAt, now);
  const liveness: WikiLiveness = status.terminal ? "terminal"
    : health === "degraded" ? "degraded"
      : isLongWait(lead?.lastActivityAt, lead?.lastHeartbeatAt, now) ? "alive_without_activity"
        : lead?.activeTools.length || lead?.activity === "streaming" || lead?.activity === "using_tool" ? "active"
          : "quiet";
  return {
    language,
    status: { ...status, label: localizedStatus(view.status, language) },
    ...(view.progress?.stage ? { stage: stageSemantics(view.progress.stage, language) } : {}),
    health,
    liveness,
    ...(activityAge ? { activityAge } : {}),
    ...(heartbeatAge ? { heartbeatAge } : {}),
  };
}

export function runStatusSemantics(status: WikiRunView["status"]): WikiStatusSemantics {
  switch (status) {
    case "running": return { marker: "◆", tone: "accent", terminal: false };
    case "paused": return { marker: "⏸", tone: "warning", terminal: false };
    case "succeeded": return { marker: "✓", tone: "success", terminal: true };
    case "failed": return { marker: "✗", tone: "error", terminal: true };
    case "cancelled": return { marker: "○", tone: "muted", terminal: true };
  }
}

export function agentStatusSemantics(status: WikiAgentStatus): WikiStatusSemantics {
  switch (status) {
    case "running": return { marker: "◆", tone: "accent", terminal: false };
    case "complete": return { marker: "✓", tone: "success", terminal: true };
    case "incomplete":
    case "retrying": return { marker: "◐", tone: "warning", terminal: false };
    case "failed": return { marker: "✗", tone: "error", terminal: true };
    case "queued": return { marker: "·", tone: "muted", terminal: false };
    case "cancelled": return { marker: "○", tone: "muted", terminal: true };
  }
}

export function batchStatusSemantics(status: WikiDelegationBatchSummary["status"]): WikiStatusSemantics {
  switch (status) {
    case "running": return { marker: "◆", tone: "accent", terminal: false };
    case "complete": return { marker: "✓", tone: "success", terminal: true };
    case "partial": return { marker: "◐", tone: "warning", terminal: true };
    case "failed": return { marker: "✗", tone: "error", terminal: true };
  }
}

export function activitySemantics(entry: WikiActivityEntry): WikiStatusSemantics {
  if (entry.severity === "error") return { marker: "✗", tone: "error", terminal: Boolean(entry.completed) };
  if (entry.severity === "warning") return { marker: "!", tone: "warning", terminal: Boolean(entry.completed) };
  if (entry.completed) return { marker: "✓", tone: "success", terminal: true };
  return { marker: "·", tone: "muted", terminal: false };
}

export function stageSemantics(stage: WikiRunStage, language: "zh" | "en" = "en"): { key: WikiRunStage; label: string } {
  return { key: stage, label: localizedStage(stage, language) };
}

export type WikiTextRole = "primary" | "label" | WikiTone;
export interface WikiTextSpan { text: string; role: WikiTextRole; emphasis?: boolean }
export type WikiTextLine = readonly WikiTextSpan[];

export function projectWikiAgentLines(
  inspection: WikiAgentInspection,
  tab: "overview" | "process" | "output" = "overview",
): WikiTextLine[] {
  const agent = inspection.agent;
  const id = agent.target.kind === "lead" ? "lead" : `batch-${agent.target.batch}/${agent.target.taskId}`;
  const header = `Wiki ${inspection.runId}  ·  ${id}`;
  if (tab === "process") {
    const lines: WikiTextLine[] = [[span(header, "primary", true), span("  ·  process", "muted")]];
    if (inspection.process.length === 0) lines.push([span("process  ", "label"), span("unavailable for this agent", "muted")]);
    else for (const entry of inspection.process) {
      if (entry.kind === "tool" && !entry.completed) continue;
      lines.push(processLine(entry));
    }
    return lines;
  }
  if (tab === "output") {
    const output = inspection.handoff ?? agent.summary;
    return [[span(header, "primary", true)], [span("output", "label")], ...textLines(output ?? "  No output yet.", output ? "primary" : "muted")];
  }
  const status = agentStatusSemantics(agent.status);
  const lines: WikiTextLine[] = [
    [span(header, "primary", true)],
    [span(`${agent.role}  `, "primary"), span(agent.status, status.tone, true), span(`  ·  ${localizedActivity(agent.activity, "en")}  ·  attempt ${agent.attempt}`, "muted")],
  ];
  if (agent.activeTools.length) lines.push(fieldLine("tools", agent.activeTools.map((tool) => tool.name).join(", "), "accent"));
  if (agent.lastHeartbeatAt) lines.push(fieldLine("heartbeat", formatLocalDateTime(agent.lastHeartbeatAt), "muted"));
  if (agent.lastActivityAt) lines.push(fieldLine("Pi activity", formatLocalDateTime(agent.lastActivityAt), "muted"));
  if (agent.deadlineAt) lines.push(fieldLine("deadline", formatLocalDateTime(agent.deadlineAt), "muted"));
  const context = formatWikiContext(agent.usage);
  if (context) lines.push(fieldLine("context", context, "primary"));
  if (agent.summary) lines.push([span("summary", "label")], ...textLines(`  ${agent.summary}`, "primary"));
  return lines;
}

export function formatWikiContext(usage: WikiContextStats | undefined): string | undefined {
  if (!usage) return undefined;
  const parts: string[] = [];
  if (usage.turns !== undefined) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.toolCalls !== undefined) parts.push(`${usage.toolCalls} tools`);
  if (usage.input !== undefined) parts.push(`↑${tokenCount(usage.input)}`);
  if (usage.output !== undefined) parts.push(`↓${tokenCount(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${tokenCount(usage.cacheRead)}`);
  if (usage.contextTokens !== undefined || usage.contextWindow !== undefined || usage.contextPercent !== undefined) {
    const used = usage.contextTokens === undefined ? "?" : tokenCount(usage.contextTokens);
    const total = usage.contextWindow === undefined ? "" : `/${tokenCount(usage.contextWindow)}`;
    const percent = usage.contextPercent === undefined ? "" : ` ${Math.round(usage.contextPercent)}%`;
    parts.push(`ctx ${used}${total}${percent}`);
  }
  if (usage.cost !== undefined && usage.cost > 0) parts.push(usage.cost < 0.0001 ? "<$0.0001" : `$${usage.cost.toFixed(usage.cost >= 0.01 ? 2 : 4)}`);
  if (usage.model) parts.push(usage.model);
  return parts.length ? parts.join("  ") : undefined;
}

function localizedStatus(status: WikiRunView["status"], language: "zh" | "en"): string {
  const labels = language === "zh"
    ? { running: "运行中", paused: "已暂停", succeeded: "已发布", failed: "失败", cancelled: "已取消" }
    : { running: "running", paused: "paused", succeeded: "published", failed: "failed", cancelled: "cancelled" };
  return labels[status];
}

function eventLabel(type: WikiRunEvent["type"]): string {
  return type.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function localizedStage(stage: WikiRunStage, language: "zh" | "en"): string {
  const labels = language === "zh"
    ? { prepare: "准备", lead: "生成", validate: "验证", publish: "发布" }
    : { prepare: "prepare", lead: "generate", validate: "validate", publish: "publish" };
  return labels[stage];
}

function localizedActivity(activity: string, language: "zh" | "en"): string {
  const key = activity.replaceAll("_", " ");
  if (language === "en") return key;
  return ({ starting: "启动", waiting_model: "等待模型", streaming: "生成", using_tool: "使用工具", delegating: "委派", synthesizing: "整合", retry_wait: "等待重试", finishing: "收尾", settled: "完成", responding: "生成", tool: "使用工具", idle: "空闲", compacting: "压缩上下文" } as Record<string, string>)[activity] ?? key;
}

function isLongWait(activityAt: string | undefined, heartbeatAt: string | undefined, now: number): boolean {
  const activity = activityAt ? Date.parse(activityAt) : NaN;
  const heartbeat = heartbeatAt ? Date.parse(heartbeatAt) : NaN;
  return Number.isFinite(activity) && now - activity >= 120_000 && Number.isFinite(heartbeat) && now - heartbeat < 15_000;
}

function formatAge(value: string | undefined, now: number): string | undefined {
  const parsed = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) return undefined;
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

function span(text: string, role: WikiTextRole, emphasis?: boolean): WikiTextSpan { return emphasis ? { text, role, emphasis } : { text, role }; }
function textLines(text: string, role: WikiTextRole): WikiTextLine[] { return text.split("\n").map((line) => [span(line, role)]); }
function fieldLine(label: string, value: string, role: WikiTextRole): WikiTextLine { return [span(`${label}  `, "label"), span(value, role)]; }
function processLine(entry: WikiActivityEntry): WikiTextLine {
  const semantics = activitySemantics(entry);
  const duration = entry.durationMs === undefined ? "" : ` · ${durationText(entry.durationMs)}`;
  const label = entry.kind === "tool" ? entry.toolName ?? "tool" : entry.kind;
  const detail = entry.kind === "tool" && entry.severity !== "error" ? entry.summary : entry.message;
  return [span(`${semantics.marker} `, semantics.tone), span(label, "primary"), ...(duration ? [span(duration, "muted")] : []), ...(detail ? [span(`  ${detail}`, semantics.tone === "error" || semantics.tone === "warning" ? semantics.tone : "primary")] : [])];
}
function durationText(milliseconds: number): string { const seconds = Math.max(0, Math.round(milliseconds / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`; }
function tokenCount(value: number): string { if (value < 1000) return String(Math.round(value)); if (value < 10_000) return `${(value / 1000).toFixed(1)}k`; if (value < 1_000_000) return `${Math.round(value / 1000)}k`; return `${(value / 1_000_000).toFixed(1)}M`; }
