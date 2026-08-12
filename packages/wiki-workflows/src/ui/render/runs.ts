import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WikiRunSummary } from "../../workflow-types.js";
import {
  asText,
  fitLine,
  formatTimestamp,
  runStatusColor,
  runStatusIcon,
  scrollWindow,
  type WikiUiTheme,
} from "../format.js";
import type { NavigatorState } from "../state.js";
import { uiStrings, type WikiUiLanguage } from "../strings.js";

export interface RunSelectItem {
  value: string;
  label: string;
  description?: string;
}

export function buildRunSelectItems(
  runs: WikiRunSummary[],
  activeRunId: string | undefined,
  language?: WikiUiLanguage,
): RunSelectItem[] {
  const s = uiStrings(language);
  return runs.map((run) => {
    const icon = runStatusIcon(run.status);
    const active = run.id === activeRunId ? ` · ${s.active}` : "";
    const fork = run.parentRunId ? ` · ${s.fork}` : "";
    const shortId = shortRunId(run.id);
    const title = asText(run.focus) || `${asText(run.effectiveMode ?? run.requestedMode)} Wiki`;
    return {
      value: asText(run.id),
      label: `${icon} ${title}`,
      description: `${shortId} · ${asText(run.effectiveMode ?? run.requestedMode)}${fork}${active} · ${run.succeededNodes}/${run.totalNodes} · ${formatTimestamp(run.updatedAt)}`,
    };
  });
}

/** First 8 chars of run id for compact UI (full id remains the value). */
export function shortRunId(runId: string): string {
  const id = asText(runId);
  return id.length <= 8 ? id : id.slice(0, 8);
}

export function renderRunsList(
  state: NavigatorState,
  runs: WikiRunSummary[],
  activeRunId: string | undefined,
  width: number,
  theme: WikiUiTheme,
  rows: number,
  language?: WikiUiLanguage,
): string[] {
  const s = uiStrings(language);
  const lines = [theme.fg("accent", theme.bold(s.runsTitle))];
  if (!runs.length) {
    lines.push(theme.fg("muted", s.runsEmpty));
    lines.push(theme.fg("dim", s.runsEmptyDetail));
    return lines.map((line) => fitLine(line, width));
  }

  const selected = Math.max(0, Math.min(state.runCursor, runs.length - 1));
  const window = scrollWindow(runs.length, selected, Math.max(1, rows - 1));
  for (let index = window.start; index < window.end; index++) {
    const run = runs[index]!;
    const active = run.id === activeRunId ? ` ${s.active}` : "";
    const parent = run.parentRunId ? ` ${s.fork}` : "";
    const marker = index === selected ? "›" : " ";
    const icon = runStatusIcon(run.status);
    const metadata = `${shortRunId(run.id)} | ${asText(run.effectiveMode ?? run.requestedMode)}${parent}${active} | ${run.succeededNodes}/${run.totalNodes} | ${formatTimestamp(run.updatedAt)}`;
    const title = truncateToWidth(asText(run.focus) || "Wiki generation", Math.max(12, width - visibleWidth(metadata) - 7), "…", false);
    const selectedLine = index === selected
      ? `${theme.fg("accent", theme.bold(`${marker} `))}${theme.fg(runStatusColor(run.status), theme.bold(icon))}${theme.fg("accent", theme.bold(` ${title}  ${metadata}`))}`
      : `${marker} ${theme.fg(runStatusColor(run.status), icon)} ${title}  ${theme.fg("dim", metadata)}`;
    lines.push(truncateToWidth(selectedLine, width, "", true));
  }
  if (window.more) lines.push(theme.fg("dim", `  ${window.end}/${window.total} runs`));
  return lines;
}

export function renderLoadingRun(
  width: number,
  theme: WikiUiTheme,
  language?: WikiUiLanguage,
  workspaceRoot?: string,
): string[] {
  const s = uiStrings(language);
  const lines = [
    theme.bold(s.loadingRun),
    theme.fg("muted", s.loadingRunDetail),
  ];
  if (workspaceRoot) lines.splice(1, 0, truncateToWidth(`Path: ${workspaceRoot}`, width, "", true));
  return lines.map((line) => fitLine(line, width));
}
