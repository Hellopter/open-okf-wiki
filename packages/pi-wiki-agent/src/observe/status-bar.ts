import type { WikiProgressSnapshot } from "../orch/types.js";
import { formatDuration, isAgentStale, parseTimeMs, type FormatTimeOpts } from "./format.js";

/**
 * Compact one-liner for `ui.setStatus`.
 * Example: `Wiki Survey 4/12 · 2 running · focus:survey:1:2 · 3m`
 */
export function formatStatusBar(
  snapshot: WikiProgressSnapshot,
  opts: FormatTimeOpts = {},
): string {
  const now = opts.now ?? Date.now();
  const parts: string[] = ["Wiki"];

  const phase = snapshot.currentPhase ?? snapshot.phases.find((p) => p.status === "active")?.name;
  if (phase) parts.push(phase);

  if (snapshot.coverage) {
    parts.push(`${snapshot.coverage.unitsWithReceipt}/${snapshot.coverage.unitsTotal}`);
  }

  const running = snapshot.agents.filter(
    (a) => a.status === "running" || a.status === "waiting_tool" || a.status === "starting",
  ).length;
  const failed = snapshot.agents.filter(
    (a) => a.status === "failed" || a.status === "timed_out",
  ).length;
  const stale =
    opts.staleWarnMs !== undefined
      ? snapshot.agents.filter((a) => isAgentStale(a, opts.staleWarnMs!, now)).length
      : 0;

  const mid: string[] = [];
  if (snapshot.overall === "paused") mid.push("paused");
  else if (snapshot.overall === "failed") mid.push("failed");
  else if (snapshot.overall === "completed") mid.push("done");
  else if (snapshot.overall === "cancelled") mid.push("cancelled");
  else if (running > 0) mid.push(`${running} running`);
  else mid.push(snapshot.overall);

  if (failed > 0) mid.push(`${failed} failed`);
  if (stale > 0) mid.push(`${stale} stale`);
  if (snapshot.focusedAgentId) mid.push(`focus:${snapshot.focusedAgentId}`);

  // Prefer run age from earliest agent start; fall back to updatedAt span.
  const started = snapshot.agents
    .map((a) => parseTimeMs(a.startedAt))
    .filter((t): t is number => t !== undefined);
  const updatedAt = parseTimeMs(snapshot.updatedAt) ?? now;
  const origin = started.length > 0 ? Math.min(...started) : updatedAt;
  mid.push(formatDuration(Math.max(0, now - origin)));

  // First segment is "Wiki [Phase] [coverage]"; rest joined with middots.
  const head = parts.join(" ");
  return `${head} · ${mid.join(" · ")}`;
}
