import type { WikiRunView } from "../producer-types.js";
import { projectWikiRunObservability, type WikiProjectedTaskLine, type WikiProjectedToolOutcome, type WikiRunObservability } from "./observability.js";
import { formatLocalDateTime } from "./time-format.js";

export function wikiFooterStatus(view: WikiRunView, now = Date.now()): string | undefined {
  const semantics = projectWikiRunObservability(view, now);
  if (semantics.status.terminal) return `wiki ${semantics.status.marker} ${semantics.status.label}`;
  if (view.status === "paused") return pausedFooter(view);
  return runningFooter(semantics);
}

export function wikiWidgetLines(view: WikiRunView): string[] | undefined {
  if (view.status !== "running") return undefined;
  const semantics = projectWikiRunObservability(view);
  const lines = [leadLine(semantics)];
  if (semantics.batch) {
    lines.push(`${semantics.batch.label} ${semantics.batch.batch}  ${semantics.batch.countLabel}`);
    const tasks = [...semantics.batch.tasks].sort((left, right) => left.sortRank - right.sortRank);
    const visibleCount = tasks.length > 4 ? 3 : 4;
    for (const task of tasks.slice(0, visibleCount)) lines.push(taskLine(task));
    const hidden = tasks.length - Math.min(visibleCount, tasks.length);
    if (hidden > 0) lines.push(`  +${hidden} ${semantics.language === "zh" ? "个其他任务" : "more"}`);
  } else {
    for (const entry of semantics.recentToolOutcomes) lines.push(toolOutcomeLine(entry));
  }
  return lines.slice(0, 6);
}

export function themeWikiLiveText(theme: unknown, text: string): string {
  const value = theme as { fg?(color: string, text: string): string } | undefined;
  if (typeof value?.fg !== "function") return text;
  try { return String(value.fg(liveTextColor(text), text)); } catch { return text; }
}

function runningFooter(semantics: WikiRunObservability): string {
  if (!semantics.leadPresent) return `wiki ◆ ${semantics.stage?.label ?? semantics.leadLabel}`;
  if (semantics.health === "degraded") return `wiki ! lead · ${semantics.healthNotice}`;
  if (semantics.liveness === "alive_without_activity") return `wiki ! lead · ${semantics.silenceNotice}`;
  return [
    "wiki ◆ lead",
    semantics.activityLabel,
    semantics.activityAge ? `activity ${semantics.activityAge}` : undefined,
    semantics.contextPressure?.label,
  ].filter(Boolean).join(" · ");
}

function pausedFooter(view: WikiRunView): string {
  const reason = view.pause?.reason ?? "paused";
  const retry = view.pause?.retryAt ? formatLocalDateTime(view.pause.retryAt) : undefined;
  return retry ? `wiki ⏸ ${reason} · retry ${retry}` : `wiki ⏸ ${reason}`;
}

function leadLine(semantics: WikiRunObservability): string {
  const details = [semantics.leadDetail, semantics.healthNotice].filter((part): part is string => Boolean(part));
  return `${semantics.leadMarker} ${semantics.leadLabel}${details.length ? `  ${details.join("  ")}` : ""}`;
}

function taskLine(task: WikiProjectedTaskLine): string {
  return `  ${task.marker} ${task.role}  ${task.identity}${task.detail ? `  ${task.detail}` : ""}${task.healthNotice ? `  ${task.healthNotice}` : ""}`;
}

function toolOutcomeLine(entry: WikiProjectedToolOutcome): string {
  return `  ${entry.marker} ${entry.name}${entry.detail ? `  ${entry.detail}` : ""}`;
}

function liveTextColor(text: string): "success" | "error" | "warning" | "accent" | "dim" {
  if (text.includes("✗")) return "error";
  if (text.includes("!") || text.includes("⏸")) return "warning";
  if (text.includes("✓")) return "success";
  if (text.includes("◆")) return "accent";
  return "dim";
}
