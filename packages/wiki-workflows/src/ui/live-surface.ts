import type { WikiRunProgress, WikiRunView, WikiTaskSnapshot } from "../producer-types.js";

const TASK_ICONS = {
  queued: "·",
  running: "◆",
  complete: "✓",
  incomplete: "◐",
  failed: "✗",
} as const;

export function wikiFooterStatus(view: WikiRunView): string | undefined {
  if (view.status === "succeeded") return "wiki ✓ published";
  if (view.status === "failed") return "wiki ✗ failed";
  if (view.status === "cancelled") return "wiki · cancelled";
  if (view.status === "paused") return pausedFooter(view);
  return runningFooter(view);
}

export function wikiWidgetLines(view: WikiRunView): string[] | undefined {
  const tasks = view.progress?.tasks;
  if (!tasks || tasks.length === 0) return undefined;
  return [widgetHeader(view.progress!), ...tasks.map(widgetTaskLine)];
}

export function wikiSurfaceCleared(view: WikiRunView): { footer?: string; widget?: undefined } {
  if (view.status === "succeeded" || view.status === "failed" || view.status === "paused") {
    return { footer: wikiFooterStatus(view), widget: undefined };
  }
  if (view.status === "cancelled") return { footer: wikiFooterStatus(view), widget: undefined };
  return { widget: undefined };
}

function runningFooter(view: WikiRunView): string {
  const progress = view.progress;
  if (!progress) return "wiki ◆ running";
  const parts = ["wiki ◆", progress.stage];
  if (progress.completed !== undefined && progress.total !== undefined) {
    parts.push(`${progress.completed}/${progress.total}`);
  }
  const running = progress.tasks?.find((task) => task.status === "running");
  if (running) parts.push(running.role);
  return parts.join(" ");
}

function pausedFooter(view: WikiRunView): string {
  const reason = view.pause?.reason ?? "paused";
  const retry = formatRetry(view.pause?.retryAt);
  return retry ? `wiki ⏸ ${reason} · retry ${retry}` : `wiki ⏸ ${reason}`;
}

function formatRetry(retryAt: string | undefined): string | undefined {
  if (!retryAt) return undefined;
  const match = /T(\d{2}:\d{2})/.exec(retryAt);
  if (match) return match[1];
  const clock = /(\d{1,2}:\d{2})/.exec(retryAt);
  return clock?.[1] ?? retryAt;
}

function widgetHeader(progress: WikiRunProgress): string {
  const parts: string[] = [];
  if (progress.batch !== undefined) parts.push(`batch ${progress.batch}`);
  else parts.push(progress.stage);
  if (progress.completed !== undefined && progress.total !== undefined) {
    parts.push(`${progress.completed}/${progress.total}`);
  }
  return parts.join("  ");
}

function widgetTaskLine(task: WikiTaskSnapshot): string {
  return `  ${taskIcon(task.status)} ${task.role}  ${task.id}`;
}

function taskIcon(status: WikiTaskSnapshot["status"]): string {
  return TASK_ICONS[status];
}
