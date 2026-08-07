import type {
  AgentStatus,
  WikiAgentView,
  WikiCoverageView,
  WikiPhaseStatus,
  WikiPhaseView,
  WikiProgressSnapshot,
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

/** Multi-line agent list; focused agent is marked with `>`. */
export function formatAgentsTable(
  snapshot: WikiProgressSnapshot,
  opts: FormatTimeOpts = {},
): string {
  if (snapshot.agents.length === 0) return "(no agents)";
  return snapshot.agents
    .map((agent) => {
      const marker = agent.agentId === snapshot.focusedAgentId ? ">" : " ";
      return `${marker} ${formatAgentLine(agent, opts)}`;
    })
    .join("\n");
}

/** Coverage summary: `pass1 4/12 receipts missing:8`. */
export function formatCoverageLine(coverage: WikiCoverageView): string {
  const missing = coverage.missingUnitIds.length;
  return `pass${coverage.pass} ${coverage.unitsWithReceipt}/${coverage.unitsTotal} receipts missing:${missing}`;
}

/** Phase strip: `Bootstrap✓ Survey● Plan· ...`. */
export function formatPhasesLine(phases: readonly WikiPhaseView[]): string {
  if (phases.length === 0) return "(no phases)";
  return phases.map((phase) => `${phase.name}${phaseStatusGlyph(phase.status)}`).join(" ");
}

/** Multi-line detail for a single agent (and optional snapshot context). */
export function formatAgentDetail(
  agent: WikiAgentView,
  snapshot?: WikiProgressSnapshot,
  opts: FormatTimeOpts = {},
): string {
  const now = opts.now ?? Date.now();
  const lines: string[] = [
    `Agent: ${agent.agentId}`,
    `Label: ${agent.label}`,
    `Role: ${agent.role}`,
    `Phase: ${agent.phase}`,
    `Status: ${agentStatusGlyph(agent.status)} ${agent.status}`,
    `Elapsed: ${formatDuration(agentElapsedMs(agent, now))}`,
  ];
  if (agent.model) lines.push(`Model: ${agent.model}`);
  if (agent.unitIds?.length) lines.push(`Units: ${agent.unitIds.join(", ")}`);
  if (agent.pagePaths?.length) lines.push(`Pages: ${agent.pagePaths.join(", ")}`);
  if (agent.lastTool) {
    const path = agent.lastTool.path ? ` ${agent.lastTool.path}` : "";
    lines.push(`Last tool: ${agent.lastTool.name}${path}`);
  }
  const heartbeatAt = parseTimeMs(agent.lastHeartbeatAt);
  if (heartbeatAt !== undefined) {
    lines.push(`Heartbeat: ${formatDuration(now - heartbeatAt)} ago`);
  }
  if (agent.receiptsWritten) lines.push(`Receipts written: ${agent.receiptsWritten}`);
  if (agent.tokens !== undefined) lines.push(`Tokens: ${agent.tokens}`);
  if (agent.lastError) lines.push(`Error: ${agent.lastError}`);
  if (agent.transcriptPath) lines.push(`Transcript: ${agent.transcriptPath}`);
  if (agent.sessionKey) lines.push(`Session: ${agent.sessionKey}`);
  if (opts.staleWarnMs !== undefined && isAgentStale(agent, opts.staleWarnMs, now)) {
    lines.push("Stale: yes (no recent heartbeat)");
  }
  if (snapshot) {
    lines.push(`Orch run: ${snapshot.orchRunId}`);
    if (snapshot.domainRunId) lines.push(`Domain run: ${snapshot.domainRunId}`);
    if (snapshot.focusedAgentId === agent.agentId) lines.push("Focused: yes");
  }
  return lines.join("\n");
}

/** Full multi-line status block for `/wiki status` / agents list. */
export function formatSnapshotText(
  snapshot: WikiProgressSnapshot,
  opts: FormatTimeOpts = {},
): string {
  const now = opts.now ?? Date.now();
  const lines: string[] = [];
  lines.push(`Wiki run ${snapshot.orchRunId} [${snapshot.overall}]`);
  if (snapshot.domainRunId) lines.push(`Domain: ${snapshot.domainRunId}`);
  lines.push(`Backend: ${snapshot.backend}  Mode: ${snapshot.mode}`);
  if (snapshot.focus) lines.push(`Focus text: ${snapshot.focus}`);
  if (snapshot.currentPhase) lines.push(`Current phase: ${snapshot.currentPhase}`);
  lines.push(`Phases: ${formatPhasesLine(snapshot.phases)}`);
  if (snapshot.coverage) lines.push(`Coverage: ${formatCoverageLine(snapshot.coverage)}`);
  if (snapshot.focusedAgentId) lines.push(`Focused agent: ${snapshot.focusedAgentId}`);
  if (snapshot.workdir) lines.push(`Workdir: ${snapshot.workdir}`);
  const updatedAt = parseTimeMs(snapshot.updatedAt) ?? now;
  lines.push(`Updated: ${formatDuration(Math.max(0, now - updatedAt))} ago`);
  lines.push("");
  lines.push("Agents:");
  lines.push(formatAgentsTable(snapshot, opts));
  return lines.join("\n");
}
