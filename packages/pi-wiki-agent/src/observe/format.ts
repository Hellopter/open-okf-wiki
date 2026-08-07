import type {
  AgentStatus,
  WikiAgentActivity,
  WikiAgentView,
  WikiCoverageView,
  WikiContextUsage,
  WikiPhaseStatus,
  WikiTokenUsage,
} from "../orch/types.js";

export interface FormatTimeOpts {
  staleWarnMs?: number;
  now?: number;
}

const LIVE_STATUSES = new Set<AgentStatus>(["starting", "running", "waiting_tool"]);

/** Parse ISO timestamps (or epoch ms numbers/strings) into epoch ms. */
export function parseTimeMs(value: string | number | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Format a duration for status surfaces: `12s`, `3m04s`, `1h02m`. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

/** Compact status glyph for agent/phase rows. */
export function agentStatusGlyph(status: AgentStatus): string {
  switch (status) {
    case "succeeded":
      return "✓";
    case "running":
    case "waiting_tool":
    case "starting":
      return "●";
    case "failed":
    case "timed_out":
    case "cancelled":
      return "!";
    case "queued":
    case "skipped":
    default:
      return "·";
  }
}

export function phaseStatusGlyph(status: WikiPhaseStatus): string {
  switch (status) {
    case "done":
      return "✓";
    case "active":
      return "●";
    case "failed":
      return "!";
    case "pending":
    case "skipped":
    default:
      return "·";
  }
}

/**
 * True when a live agent has not heartbeated within staleWarnMs.
 * Matches orch/progress.isAgentStale: missing timestamps on an in-flight agent
 * count as stale (never heartbeated).
 */
export function isAgentStale(
  agent: WikiAgentView,
  staleWarnMs: number,
  now: number = Date.now(),
): boolean {
  if (!LIVE_STATUSES.has(agent.status)) return false;
  const last = parseTimeMs(agent.lastHeartbeatAt ?? agent.lastTool?.at ?? agent.startedAt);
  if (last === undefined) return true;
  return now - last > staleWarnMs;
}

function agentElapsedMs(agent: WikiAgentView, now: number): number {
  if (typeof agent.elapsedMs === "number" && agent.elapsedMs > 0) return agent.elapsedMs;
  const started = parseTimeMs(agent.startedAt);
  if (started !== undefined) {
    const end = parseTimeMs(agent.endedAt) ?? now;
    return Math.max(0, end - started);
  }
  return 0;
}

function shorten(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Compact token formatter for narrow TUI rows. */
export function formatTokenCount(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) return "";
  if (tokens < 1_000) return `${Math.round(tokens)}`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m`;
}

function usageTotal(usage: WikiTokenUsage | undefined): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.total === "number" && Number.isFinite(usage.total)) return usage.total;
  const parts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return parts.length > 0 ? parts.reduce((total, value) => total + value, 0) : undefined;
}

/** Current context pressure, without inventing a model-window percentage. */
export function formatAgentContext(agent: WikiAgentView): string {
  const context: WikiContextUsage | undefined = agent.context;
  const tokens = formatTokenCount(context?.tokens);
  const window = formatTokenCount(context?.contextWindow);
  const percent = context?.percent;
  if (tokens && window) return `Context ${tokens} / ${window}${percent !== undefined ? ` (${Math.round(percent)}%)` : ""}`;
  if (tokens) return `Context ~${tokens}${percent !== undefined ? ` (${Math.round(percent)}%)` : ""}`;
  return "";
}

/** Provider-reported usage for the most recent assistant turn. */
export function formatLatestUsage(agent: WikiAgentView): string {
  const usage = agent.latestUsage;
  if (!usage) return "";
  const segments: string[] = [];
  const input = formatTokenCount(usage.input);
  const output = formatTokenCount(usage.output);
  const cache = formatTokenCount((usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
  if (input) segments.push(`in ${input}`);
  if (output) segments.push(`out ${output}`);
  if (cache && cache !== "0") segments.push(`cache ${cache}`);
  return segments.length > 0 ? `This turn ${segments.join(" · ")}` : "";
}

/** Cumulative usage for one agent session. */
export function formatRunUsage(agent: WikiAgentView): string {
  const total = usageTotal(agent.tokenUsage);
  const display = formatTokenCount(total);
  return display ? `Run total ${display}` : "";
}

/** A transient Pi retry/compaction activity line. */
export function formatAgentActivity(agent: WikiAgentView): string {
  const activity: WikiAgentActivity | undefined = agent.activity;
  if (!activity) return "";
  if (activity.kind === "compacting") return `Compacting context${activity.reason ? ` · ${shorten(activity.reason, 50)}` : ""}`;
  if (activity.kind === "retrying") {
    const attempt = activity.attempt !== undefined ? ` ${activity.attempt}/${activity.maxAttempts ?? "?"}` : "";
    const delay = activity.delayMs !== undefined ? ` · waiting ${Math.max(0, activity.delayMs) / 1_000}s` : "";
    const reason = activity.message ?? activity.reason;
    return `Retry${attempt}${delay}${reason ? ` · ${shorten(reason, 70)}` : ""}`;
  }
  return "";
}

function compactAgentStats(agent: WikiAgentView): string {
  if (agent.activity?.kind === "compacting") return "compacting";
  if (agent.activity?.kind === "retrying") {
    return agent.activity.attempt !== undefined ? `retry ${agent.activity.attempt}/${agent.activity.maxAttempts ?? "?"}` : "retrying";
  }
  const context = agent.context;
  if (context?.percent !== undefined) return `ctx ${Math.round(context.percent)}%`;
  const contextTokens = formatTokenCount(context?.tokens);
  if (contextTokens) return `ctx ${contextTokens}`;
  const total = formatTokenCount(usageTotal(agent.tokenUsage));
  return total ? `${total} tok` : "";
}

/**
 * One table row for an agent.
 * Example: `survey:1:2 ● running 1m23s read_file  !stale`
 */
export function formatAgentLine(agent: WikiAgentView, opts: FormatTimeOpts = {}): string {
  const now = opts.now ?? Date.now();
  const glyph = agentStatusGlyph(agent.status);
  const elapsed = formatDuration(agentElapsedMs(agent, now));
  const tool = agent.lastTool?.name ? ` ${shorten(agent.lastTool.name, 24)}` : "";
  const err =
    agent.status === "failed" || agent.status === "timed_out"
      ? agent.lastError
        ? ` ${shorten(agent.lastError, 40)}`
        : ""
      : "";
  const stale =
    opts.staleWarnMs !== undefined && isAgentStale(agent, opts.staleWarnMs, now)
      ? " !stale"
      : "";
  const stats = compactAgentStats(agent);
  return `${agent.agentId} ${glyph} ${agent.status} ${elapsed}${tool}${stats ? ` · ${stats}` : ""}${err}${stale}`;
}

/** Coverage summary: `pass1 4/12 receipts missing:8`. */
export function formatCoverageLine(coverage: WikiCoverageView): string {
  const missing = coverage.missingUnitIds.length;
  return `pass${coverage.pass} ${coverage.unitsWithReceipt}/${coverage.unitsTotal} receipts missing:${missing}`;
}
