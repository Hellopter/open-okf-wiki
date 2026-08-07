import type { WikiProgressSnapshot } from "../orch/types.js";
import {
  agentStatusGlyph,
  formatCoverageLine,
  formatDuration,
  formatPhasesLine,
  isAgentStale,
  parseTimeMs,
  type FormatTimeOpts,
} from "./format.js";

const MAX_LINES = 8;
const MAX_AGENT_ROWS = 5;

/**
 * Compact multi-agent strip for `ui.setWidget` (max ~8 lines).
 * Status glyphs: ✓ ● ! ·
 */
export function formatFleetWidget(
  snapshot: WikiProgressSnapshot,
  opts: FormatTimeOpts = {},
): string[] {
  const now = opts.now ?? Date.now();
  const lines: string[] = [];

  const phase = snapshot.currentPhase ?? "—";
  const running = snapshot.agents.filter(
    (a) => a.status === "running" || a.status === "waiting_tool" || a.status === "starting",
  ).length;
  const done = snapshot.agents.filter((a) => a.status === "succeeded").length;
  const total = snapshot.agents.length;
  lines.push(
    `Wiki ${phase} [${snapshot.overall}] · ${running}▶ ${done}/${total} ✓`,
  );

  if (snapshot.phases.length > 0) {
    lines.push(formatPhasesLine(snapshot.phases));
  }

  if (snapshot.coverage) {
    lines.push(formatCoverageLine(snapshot.coverage));
  }

  const agents = snapshot.agents;
  const visible = agents.slice(0, MAX_AGENT_ROWS);
  for (const agent of visible) {
    const marker = agent.agentId === snapshot.focusedAgentId ? ">" : " ";
    let glyph = agentStatusGlyph(agent.status);
    if (opts.staleWarnMs !== undefined && isAgentStale(agent, opts.staleWarnMs, now)) {
      glyph = "!";
    }
    let elapsedMs = agent.elapsedMs;
    if (!(elapsedMs > 0)) {
      const started = parseTimeMs(agent.startedAt);
      if (started !== undefined) {
        elapsedMs = Math.max(0, (parseTimeMs(agent.endedAt) ?? now) - started);
      } else {
        elapsedMs = 0;
      }
    }
    const elapsed = formatDuration(elapsedMs);
    const tool = agent.lastTool?.name ? ` ${agent.lastTool.name}` : "";
    lines.push(`${marker}${glyph} ${agent.agentId} ${elapsed}${tool}`);
  }
  if (agents.length > visible.length) {
    lines.push(`  … +${agents.length - visible.length} more`);
  }

  if (snapshot.focusedAgentId) {
    lines.push(`focus:${snapshot.focusedAgentId}`);
  }

  // Keep within widget budget; prefer head + focus tail if over.
  if (lines.length <= MAX_LINES) return lines;
  const focusLine = lines.find((l) => l.startsWith("focus:"));
  const head = lines.slice(0, MAX_LINES - (focusLine ? 1 : 0));
  if (focusLine && !head.includes(focusLine)) head.push(focusLine);
  return head.slice(0, MAX_LINES);
}
