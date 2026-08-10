import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WikiNode, WikiNodeStatus, WikiRunSnapshot, WikiRunStatus, WikiRunSummary } from "../workflow-types.js";

export type ThemeColor = "accent" | "borderMuted" | "success" | "error" | "warning" | "muted" | "dim" | "text";

export interface WikiUiTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
  bg?(color: string, text: string): string;
}

export const PLAIN_THEME: WikiUiTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

export const STATUS_ICON: Record<WikiNodeStatus, string> = {
  queued: "○",
  running: "●",
  succeeded: "✓",
  failed: "✗",
  invalidated: "↻",
  blocked: "!",
  cancelled: "–",
};

export const STATUS_COLOR: Record<WikiNodeStatus, ThemeColor> = {
  queued: "muted",
  running: "accent",
  succeeded: "success",
  failed: "error",
  invalidated: "muted",
  blocked: "warning",
  cancelled: "muted",
};

export type PhaseDisplayStatus = WikiNodeStatus | "not_started" | "conditional";

export const PHASE_STATUS_ICON: Record<PhaseDisplayStatus, string> = {
  ...STATUS_ICON,
  not_started: "○",
  conditional: "·",
};

export const PHASE_STATUS_COLOR: Record<PhaseDisplayStatus, ThemeColor> = {
  ...STATUS_COLOR,
  not_started: "muted",
  conditional: "muted",
};

/** Coerce a value to a safe display string (corrupt history must not crash render). */
export function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export function fitLine(line: string, width?: number): string {
  if (typeof width !== "number" || !Number.isFinite(width)) return line;
  const maxWidth = Math.max(0, Math.floor(width));
  if (visibleWidth(line) <= maxWidth) return line;
  return truncateToWidth(line, maxWidth);
}

export function padToWidth(value: string, width: number): string {
  const truncated = truncateToWidth(value, Math.max(1, width), "", true);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export function runStatusIcon(status: WikiRunStatus): string {
  if (status === "paused") return "‖";
  return STATUS_ICON[status];
}

export function runStatusColor(status: WikiRunStatus): ThemeColor {
  if (status === "paused") return "warning";
  return STATUS_COLOR[status];
}

export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

export function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
}

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function formatDuration(milliseconds: number): string {
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)}s` : `${milliseconds}ms`;
}

export function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

export function formatNodeDuration(startedAt: string, finishedAt: string | undefined, now = Date.now()): string {
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return "unknown";
  return formatDuration(Math.max(0, end - start));
}

export function formatContext(
  current: number | null | undefined,
  maximum: number | null | undefined,
  estimated = false,
): string | undefined {
  if (current === undefined || current === null || maximum === undefined || maximum === null || maximum <= 0) {
    return undefined;
  }
  const percent = Math.round((current / maximum) * 100);
  return `${formatCount(current)} / ${formatCount(maximum)} (${percent}%)${estimated ? " estimated" : ""}`;
}

export function runTitle(run: Pick<WikiRunSnapshot | WikiRunSummary, "effectiveMode" | "requestedMode" | "focus" | "parentRunId">): string {
  const mode = run.effectiveMode ?? run.requestedMode;
  const focus = run.focus ? `: ${run.focus}` : "";
  const fork = run.parentRunId ? " (fork)" : "";
  return `${mode} Wiki run${focus}${fork}`;
}

export function activityText(node: WikiNode): string {
  const activity = node.activity;
  const label = activity.message || activity.state;
  if (activity.state !== "retrying") return label;
  const attempt = activity.retryAttempt && activity.retryMaxAttempts
    ? ` ${activity.retryAttempt}/${activity.retryMaxAttempts}`
    : "";
  const delay = activity.retryDelayMs ? ` in ${formatDuration(activity.retryDelayMs)}` : "";
  return `${label}${attempt}${delay}`;
}

export function stageLabel(kind: WikiNode["kind"]): string {
  switch (kind) {
    case "inspect": return "Inspect";
    case "research": return "Research";
    case "synthesis": return "Synthesis";
    case "write": return "Write";
    case "validate": return "Validate";
    case "review": return "Review";
    case "repair": return "Repair";
  }
}

export function isTerminalRunStatus(status: WikiRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "blocked" || status === "cancelled";
}

export function isActiveRunStatus(status: WikiRunStatus): boolean {
  return status === "running" || status === "paused";
}

export function isExecutingRunStatus(status: WikiRunStatus): boolean {
  return status === "running" || status === "paused";
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function wrapLines(value: string, width: number): string[] {
  const limit = Math.max(12, width);
  const lines: string[] = [];
  for (const original of value.split("\n")) {
    let rest = original || " ";
    while (visibleWidth(rest) > limit) {
      let split = rest.lastIndexOf(" ", limit);
      if (split < Math.floor(limit / 2)) split = limit;
      lines.push(rest.slice(0, split));
      rest = rest.slice(split).trimStart() || " ";
    }
    lines.push(rest);
  }
  return lines;
}

export function scrollWindow(total: number, active: number, cap: number): { start: number; end: number; total: number; more: boolean } {
  if (total <= cap) return { start: 0, end: total, total, more: false };
  const start = Math.max(0, Math.min(active - Math.floor(cap / 2), total - cap));
  return { start, end: start + cap, total, more: start + cap < total };
}

export function fitRows(lines: string[], rows: number, width: number): string[] {
  return [
    ...lines.slice(0, rows).map((line) => truncateToWidth(line, width, "", true)),
    ...Array.from({ length: Math.max(0, rows - lines.length) }, () => ""),
  ];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
