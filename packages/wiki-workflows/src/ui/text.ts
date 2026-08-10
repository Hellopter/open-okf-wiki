import type { WikiRunSnapshot, WikiRunSummary } from "../workflow-types.js";
import { firstLine, formatTimestamp, STATUS_ICON } from "./format.js";

/** Plain text for /wiki status and non-interactive command output. */
export function renderWikiRunText(run: WikiRunSnapshot | undefined): string {
  if (!run) return "Wiki Run: no run in this Pi session.";
  const header = `Wiki Run ${run.id} | ${run.effectiveMode ?? run.requestedMode} | ${run.status} | round ${run.round}`;
  const nodes = run.nodes.map((node) => {
    const error = node.error ? ` | ${firstLine(node.error.message)}` : "";
    return `${STATUS_ICON[node.status]} ${node.label} [${node.status}] attempt ${node.attempt}${error}`;
  });
  const reason = run.blockedReason ? [`Blocked: ${run.blockedReason}`] : [];
  return [header, ...reason, ...nodes].join("\n");
}

/** Non-interactive history stays concise; selection and full detail belong in the TUI. */
export function renderWikiRunHistoryText(runs: WikiRunSummary[]): string {
  if (!runs.length) return "Wiki History: no runs for this project.";
  return ["Wiki History", ...runs.map((run) => {
    const focus = run.focus ? ` | ${run.focus}` : "";
    const fork = run.parentRunId ? " | fork" : "";
    return `${formatTimestamp(run.updatedAt)} | ${run.effectiveMode ?? run.requestedMode} | ${run.status} | ${run.succeededNodes}/${run.totalNodes}${fork}${focus}`;
  })].join("\n");
}

/** Delivered conversation summary when a background Wiki run terminates. */
export function renderWikiResultDelivery(run: WikiRunSnapshot): string {
  const mode = run.effectiveMode ?? run.requestedMode;
  const progress = `${run.nodes.filter((node) => node.status === "succeeded").length}/${run.nodes.length}`;
  const failed = run.nodes.filter((node) => node.status === "failed" || node.status === "blocked");
  const icon = run.status === "succeeded" ? "✓"
    : run.status === "cancelled" ? "–"
      : run.status === "blocked" ? "!"
        : "✗";
  const lines = [
    `${icon} Wiki ${mode} run ${run.status} (${progress} agents).`,
  ];
  if (run.focus) lines.push(`Focus: ${run.focus}`);
  if (run.blockedReason) lines.push(`Blocked: ${run.blockedReason}`);
  if (failed.length) {
    lines.push("", "Failed agents:");
    for (const node of failed.slice(0, 8)) {
      lines.push(`- ${node.label}: ${node.error?.message ?? node.status}`);
    }
    if (failed.length > 8) lines.push(`- … ${failed.length - 8} more`);
  }
  lines.push("", "Use /wiki open to inspect the full run.");
  return lines.join("\n");
}
