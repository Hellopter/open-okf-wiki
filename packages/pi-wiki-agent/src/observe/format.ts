import type {
  AgentStatus,
  WikiAgentView,
  WikiCoverageView,
  WikiPhaseStatus,
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
  return `${agent.agentId} ${glyph} ${agent.status} ${elapsed}${tool}${err}${stale}`;
}

/** Coverage summary: `pass1 4/12 receipts missing:8`. */
export function formatCoverageLine(coverage: WikiCoverageView): string {
  const missing = coverage.missingUnitIds.length;
  return `pass${coverage.pass} ${coverage.unitsWithReceipt}/${coverage.unitsTotal} receipts missing:${missing}`;
}
