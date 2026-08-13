import type {
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

export function wikiWidgetLines(view: WikiRunView, now = Date.now()): string[] | undefined {
  if (view.status !== "running") return undefined;
  const progress = view.progress;
  if (!progress) return ["LEAD  ◆ starting"];
  const language = progress.language ?? "en";
  const lines = [leadLine(progress, now, language)];
  const batch = progress.currentBatch;
  if (!batch) return lines;
  lines.push(`${language === "zh" ? "批次" : "BATCH"} ${batch.batch}  ${batch.completed}/${batch.total}`);
  const tasks = [...batch.tasks].sort(compareTasks);
  const visibleCount = tasks.length > 4 ? 3 : 4;
  const visible = tasks.slice(0, visibleCount);
  for (const task of visible) lines.push(taskLine(task, language));
  const hidden = tasks.length - visible.length;
  if (hidden > 0) lines.push(`  +${hidden} ${language === "zh" ? "个其他任务" : "more"}`);
  return lines.slice(0, 6);
}

function runningFooter(view: WikiRunView, now: number): string {
  const progress = view.progress;
  if (!progress) return "wiki ◆ lead · starting";
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
  const activity = lead.activeTools[0]?.name ?? humanActivity(lead.activity, progress.language);
  const batchText = batch && lead.activity === "delegating" ? `batch ${batch.batch} · ${batch.completed}/${batch.total}` : activity;
  const context = lead.usage?.contextPercent === undefined ? undefined : `ctx ${Math.round(lead.usage.contextPercent)}%`;
  return ["wiki ◆ lead", batchText, activityAge ? `activity ${activityAge}` : undefined, context].filter(Boolean).join(" · ");
}

function pausedFooter(view: WikiRunView): string {
  const reason = view.pause?.reason ?? "paused";
  const retry = view.pause?.retryAt ? formatLocalDateTime(view.pause.retryAt) : undefined;
  return retry ? `wiki ⏸ ${reason} · retry ${retry}` : `wiki ⏸ ${reason}`;
}

function leadLine(progress: WikiRunProgress, now: number, language: "zh" | "en"): string {
  const lead = progress.lead;
  if (!lead) return `LEAD  ◆ ${language === "zh" ? "启动中" : "starting"}`;
  const degraded = lead.health === "degraded";
  const icon = degraded ? "!" : agentIcon(lead);
  const tool = lead.activeTools[0]?.name;
  const details = [tool ?? humanActivity(lead.activity, language)];
  const heartbeat = age(lead.lastHeartbeatAt, now);
  const activity = age(lead.lastActivityAt, now);
  if (heartbeat) details.push(`${language === "zh" ? "存活" : "alive"} ${heartbeat}`);
  if (activity) details.push(`${language === "zh" ? "活动" : "activity"} ${activity}`);
  if (lead.usage?.turns !== undefined) details.push(`${lead.usage.turns}t`);
  if (lead.usage?.contextPercent !== undefined) details.push(`ctx ${Math.round(lead.usage.contextPercent)}%`);
  if (degraded) details.push(language === "zh" ? "观测降级" : "observability degraded");
  return `LEAD  ${icon} ${details.join(" · ")}`;
}

function taskLine(task: WikiTaskSnapshot, language: "zh" | "en"): string {
  const degraded = task.health === "degraded";
  const detail = task.status === "running"
    ? task.activeTool?.name ?? (task.activity && task.activity !== "idle" ? task.activity : undefined)
    : task.summary;
  const health = degraded ? language === "zh" ? "观测降级" : "observability degraded" : undefined;
  return `  ${degraded ? "!" : TASK_ICONS[task.status]} ${task.role}  ${task.id}${detail ? ` · ${detail}` : ""}${health ? ` · ${health}` : ""}`;
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

function humanActivity(activity: WikiAgentSnapshot["activity"], language: "zh" | "en" = "en"): string {
  const zh: Partial<Record<WikiAgentSnapshot["activity"], string>> = {
    starting: "启动中", waiting_model: "等待模型", streaming: "生成中", using_tool: "使用工具",
    delegating: "协调委派", synthesizing: "综合结果", compacting: "压缩上下文", retry_wait: "等待重试",
    finishing: "收尾中", settled: "已稳定",
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
