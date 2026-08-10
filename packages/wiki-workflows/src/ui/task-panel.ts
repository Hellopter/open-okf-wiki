import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { WikiRunSnapshot } from "../workflow-types.js";
import {
  activityText,
  fitLine,
  isExecutingRunStatus,
  isTerminalRunStatus,
  runStatusIcon,
  runTitle,
  STATUS_ICON,
  type WikiUiTheme,
} from "./format.js";
import { phaseRows } from "./stages.js";
import { uiStrings, type WikiUiLanguage } from "./strings.js";

export const TASK_PANEL_KEY = "okf-wiki-tasks";
export const STATUS_KEY = "okf-wiki";

export type ProgressMode = "compact" | "detailed";

export interface TaskPanelSnapshot {
  run?: WikiRunSnapshot;
  language?: WikiUiLanguage;
  /** Keep a finished run visible until the next generate/refresh. */
  retainTerminal?: boolean;
}

/** Pure panel lines for tests and the setWidget factory. */
export function renderPanel(
  snapshot: TaskPanelSnapshot,
  theme: WikiUiTheme,
  width?: number,
  mode: ProgressMode = "compact",
): string[] {
  const run = snapshot.run;
  if (!run) return [];
  const active = isExecutingRunStatus(run.status);
  const terminal = isTerminalRunStatus(run.status);
  if (!active && !(terminal && snapshot.retainTerminal)) return [];

  const s = uiStrings(snapshot.language ?? run.language);
  const running = run.nodes.filter((node) => node.status === "running");
  const done = run.nodes.filter((node) => node.status === "succeeded").length;
  const icon = runStatusIcon(run.status);
  const phase = currentPhaseTitle(run);
  const phaseLabel = phase ? ` · ${phase}` : "";
  const header = theme.bold(s.panelTitle(active ? 1 : 0));
  const row = `  ${icon} ${runTitle(run)}  ${done}/${run.nodes.length} agents${phaseLabel}`;

  if (mode === "detailed") {
    const body = renderDetailedBody(run, theme);
    const hint = theme.fg("dim", terminal ? s.panelTerminalHint : s.panelHint);
    return [header, fitLine(row, width), ...body.map((line) => fitLine(line, width)), fitLine(hint, width)];
  }

  const activeLine = running[0]
    ? theme.fg("dim", `    ${STATUS_ICON.running} ${running[0].label}${running[0].activity.message ? ` · ${activityText(running[0])}` : ""}`)
    : undefined;
  const hint = theme.fg("dim", terminal ? s.panelTerminalHint : s.panelHint);
  return [header, fitLine(row, width), ...(activeLine ? [fitLine(activeLine, width)] : []), fitLine(hint, width)];
}

function renderDetailedBody(run: WikiRunSnapshot, theme: WikiUiTheme): string[] {
  const lines: string[] = [];
  for (const phase of phaseRows(run)) {
    if (!phase.nodeIds.length) continue;
    const nodes = phase.nodeIds
      .map((id) => run.nodes.find((node) => node.id === id))
      .filter((node): node is NonNullable<typeof node> => Boolean(node));
    const done = nodes.filter((node) => node.status === "succeeded").length;
    const running = nodes.some((node) => node.status === "running");
    const marker = running ? "▶" : done === nodes.length ? "✓" : " ";
    lines.push(theme.fg("accent", `  ${marker} ${phase.title}`) + theme.fg("dim", `  ${done}/${nodes.length}`));
    for (const node of nodes.slice(-6)) {
      const activity = node.status === "running" && node.activity.message ? ` · ${activityText(node)}` : "";
      lines.push(`    ${STATUS_ICON[node.status]} ${node.label}${activity}`);
    }
  }
  return lines;
}

function currentPhaseTitle(run: WikiRunSnapshot): string | undefined {
  const running = run.nodes.find((node) => node.status === "running");
  if (running?.phaseTitle) return running.phaseTitle;
  if (running?.phaseId) {
    const phase = phaseRows(run).find((item) => item.id === running.phaseId);
    return phase?.title;
  }
  const queued = run.nodes.find((node) => node.status === "queued");
  return queued?.phaseTitle;
}

export function statusLine(run: WikiRunSnapshot | undefined, language?: WikiUiLanguage): string {
  const s = uiStrings(language);
  if (!run) return s.noRun;
  const active = run.nodes.filter((node) => node.status === "running").length;
  const failed = run.nodes.filter((node) => node.status === "failed" || node.status === "blocked").length;
  return s.statusLine(run.status, active, failed);
}

/**
 * Install the non-blocking belowEditor task panel. The host re-invokes
 * setWidget on each engine event; this factory only paints current snapshot.
 */
export function createTaskPanelWidget(
  getSnapshot: () => TaskPanelSnapshot,
  mode: ProgressMode = "compact",
): (tui: TUI, theme: Theme) => Component {
  return (_tui, theme) => ({
    render: (width: number) => renderPanel(getSnapshot(), theme, width, mode),
    invalidate: () => {},
  });
}

export function installTaskPanel(
  ui: ExtensionUIContext,
  getSnapshot: () => TaskPanelSnapshot,
  mode: ProgressMode = "compact",
): void {
  ui.setWidget(TASK_PANEL_KEY, createTaskPanelWidget(getSnapshot, mode), { placement: "belowEditor" });
}

export function clearTaskPanel(ui: ExtensionUIContext): void {
  ui.setWidget(TASK_PANEL_KEY, undefined);
}
