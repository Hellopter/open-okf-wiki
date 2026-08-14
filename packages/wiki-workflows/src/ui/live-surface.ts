import type {
  WikiActiveTool,
  WikiActivityEntry,
  WikiAgentSnapshot,
  WikiRunProgress,
  WikiRunView,
  WikiTaskSnapshot,
} from "../producer-types.js";
import { formatLocalDateTime } from "../time-format.js";

const TASK_ICONS = { queued: "·", running: "◆", complete: "✓", incomplete: "◐", failed: "✗" } as const;

export function wikiFooterStatus(view: WikiRunView, now = Date.now()): string | undefined {
  const language = view.progress?.language ?? "en";
  if (view.status === "succeeded") return language === "zh" ? "wiki ✓ 已发布" : "wiki ✓ published";
  if (view.status === "failed") return language === "zh" ? "wiki ✗ 失败" : "wiki ✗ failed";
  if (view.status === "cancelled") return language === "zh" ? "wiki · 已取消" : "wiki · cancelled";
  if (view.status === "paused") return pausedFooter(view);
  return runningFooter(view, now);
}

export function wikiWidgetLines(view: WikiRunView): string[] | undefined {
  if (view.status !== "running") return undefined;
  const progress = view.progress;
  const language = progress?.language ?? "en";
  if (!progress) return [`◆ ${leadLabel(language)}`];
  const lines = [leadLine(progress, language)];
  const batch = progress.currentBatch;
  if (batch) {
    lines.push(`${language === "zh" ? "批次" : "batch"} ${batch.batch}  ${batch.completed}/${batch.total}`);
    const tasks = [...batch.tasks].sort(compareTasks);
    const visibleCount = tasks.length > 4 ? 3 : 4;
    const visible = tasks.slice(0, visibleCount);
    for (const task of visible) lines.push(taskLine(task, language));
    const hidden = tasks.length - visible.length;
    if (hidden > 0) lines.push(`  +${hidden} ${language === "zh" ? "个其他任务" : "more"}`);
  } else {
    for (const entry of recentToolOutcomes(progress.recentActivity).slice(-4)) {
      lines.push(toolOutcomeLine(entry));
    }
  }
  return lines.slice(0, 6);
}

export function themeWikiLiveText(theme: unknown, text: string): string {
  const value = theme as { fg?(color: string, text: string): string } | undefined;
  if (typeof value?.fg !== "function") return text;
  try { return String(value.fg(liveTextColor(text), text)); } catch { return text; }
}

function runningFooter(view: WikiRunView, now: number): string {
  const progress = view.progress;
  if (!progress) return "wiki ◆ lead";
  const lead = progress.lead;
  if (!lead) return `wiki ◆ ${progress.stage}`;
  if (lead.health === "degraded") {
    return `wiki ! lead · ${progress.language === "zh" ? "观测降级" : "observability degraded"}`;
  }
  const activityAge = age(lead.lastActivityAt, now);
  const heartbeatAge = age(lead.lastHeartbeatAt, now);
  if (isLongWait(lead, now)) {
    return `wiki ! lead · ${progress.language === "zh" ? "无 Pi 活动" : "no Pi activity"} ${activityAge ?? "?"}${heartbeatAge ? ` · ${progress.language === "zh" ? "会话存活" : "session alive"} ${heartbeatAge}` : ""}`;
  }
  const batch = progress.currentBatch;
  const current = lead.activeTools[0]?.name ?? quietActivity(lead.activity, progress.language ?? "en");
  const batchText = batch && lead.activity === "delegating" ? `batch ${batch.batch} · ${batch.completed}/${batch.total}` : current;
  const context = lead.usage?.contextPercent === undefined ? undefined : `ctx ${Math.round(lead.usage.contextPercent)}%`;
  return ["wiki ◆ lead", batchText, activityAge ? `activity ${activityAge}` : undefined, context].filter(Boolean).join(" · ");
}

function pausedFooter(view: WikiRunView): string {
  const reason = view.pause?.reason ?? "paused";
  const retry = view.pause?.retryAt ? formatLocalDateTime(view.pause.retryAt) : undefined;
  return retry ? `wiki ⏸ ${reason} · retry ${retry}` : `wiki ⏸ ${reason}`;
}

function leadLine(progress: WikiRunProgress, language: "zh" | "en"): string {
  const lead = progress.lead;
  const label = leadLabel(language);
  if (!lead) return `◆ ${label}`;
  const degraded = lead.health === "degraded";
  const icon = degraded ? "!" : agentIcon(lead);
  const details = [liveDetail(lead.activeTools[0], lead.activity, language), degraded ? language === "zh" ? "观测降级" : "observability degraded" : undefined].filter((part): part is string => Boolean(part));
  return `${icon} ${label}${details.length ? `  ${details.join("  ")}` : ""}`;
}

function taskLine(task: WikiTaskSnapshot, language: "zh" | "en"): string {
  const degraded = task.health === "degraded";
  const detail = task.status === "running" ? liveDetail(task.activeTool, undefined, language) : task.summary;
  const health = degraded ? language === "zh" ? "观测降级" : "observability degraded" : undefined;
  return `  ${degraded ? "!" : TASK_ICONS[task.status]} ${task.role}  ${task.id}${detail ? `  ${detail}` : ""}${health ? `  ${health}` : ""}`;
}

function leadLabel(language: "zh" | "en"): string {
  return language === "zh" ? "主理" : "lead";
}

function liveTextColor(text: string): "success" | "error" | "warning" | "accent" | "dim" {
  if (text.includes("✗")) return "error";
  if (text.includes("!") || text.includes("⏸")) return "warning";
  if (text.includes("✓")) return "success";
  if (text.includes("◆")) return "accent";
  return "dim";
}

function liveDetail(tool: WikiActiveTool | undefined, activity: WikiAgentSnapshot["activity"] | undefined, language: "zh" | "en"): string | undefined {
  if (tool) return tool.summary ? `${tool.name}  ${tool.summary}` : tool.name;
  return quietActivity(activity, language);
}

function recentToolOutcomes(activity: WikiActivityEntry[] | undefined): WikiActivityEntry[] {
  return (activity ?? []).filter((entry) => entry.kind === "tool" && entry.completed);
}

function toolOutcomeLine(entry: WikiActivityEntry): string {
  const failed = entry.severity === "error";
  const detail = failed ? entry.message : entry.summary;
  return `  ${failed ? "✗" : "✓"} ${entry.toolName ?? "tool"}${detail ? `  ${detail}` : ""}`;
}

function compareTasks(a: WikiTaskSnapshot, b: WikiTaskSnapshot): number {
  const priority = { failed: 0, incomplete: 0, running: 1, queued: 2, complete: 3 } as const;
  return priority[a.status] - priority[b.status];
}

function agentIcon(agent: WikiAgentSnapshot): string {
  if (agent.status === "failed") return "✗";
  if (agent.status === "incomplete") return "◐";
  if (agent.status === "complete") return "✓";
  if (agent.status === "retrying") return "!";
  return agent.status === "queued" ? "·" : "◆";
}

function quietActivity(activity: WikiAgentSnapshot["activity"] | undefined, language: "zh" | "en"): string | undefined {
  if (!activity || activity === "starting" || activity === "settled" || activity === "waiting_model" || activity === "using_tool") {
    return undefined;
  }
  const zh: Partial<Record<WikiAgentSnapshot["activity"], string>> = {
    streaming: "生成中", delegating: "协调委派", synthesizing: "综合结果",
    compacting: "压缩上下文", retry_wait: "等待重试", finishing: "收尾中",
  };
  if (language === "zh") return zh[activity] ?? activity;
  return activity.replaceAll("_", " ");
}

function age(value: string | undefined, now: number): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

function isLongWait(agent: WikiAgentSnapshot, now: number): boolean {
  if (!agent.lastActivityAt || !agent.lastHeartbeatAt) return false;
  return now - Date.parse(agent.lastActivityAt) >= 120_000 && now - Date.parse(agent.lastHeartbeatAt) < 15_000;
}
