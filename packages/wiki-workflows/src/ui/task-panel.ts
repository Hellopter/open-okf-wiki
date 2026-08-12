import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { WikiRunSnapshot } from "../workflow-types.js";
import {
  activityText,
  fitLine,
  isActiveRunStatus,
  isTerminalRunStatus,
  PLAIN_THEME,
  runStatusIcon,
  runTitle,
  STATUS_ICON,
  type WikiUiTheme,
} from "./format.js";
import { WIKI_WORKFLOW_STAGES } from "../workflow-phases.js";
import { uiStrings, type WikiUiLanguage } from "./strings.js";

export const TASK_PANEL_KEY = "okf-wiki-tasks";
export const STATUS_KEY = "okf-wiki";

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
): string[] {
  const run = snapshot.run;
  if (!run) return [];
  const active = isActiveRunStatus(run.status);
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

  const activeLine = running[0]
    ? theme.fg("dim", `    ${STATUS_ICON.running} ${running[0].label}${running[0].activity.message ? ` · ${activityText(running[0])}` : ""}`)
    : undefined;
  const hint = theme.fg("dim", terminal ? s.panelTerminalHint : s.panelHint);
  return [header, fitLine(row, width), ...(activeLine ? [fitLine(activeLine, width)] : []), fitLine(hint, width)];
}

function currentPhaseTitle(run: WikiRunSnapshot): string | undefined {
  const running = run.nodes.find((node) => node.status === "running");
  if (running?.phaseTitle) return running.phaseTitle;
  if (running?.phaseId) {
    return WIKI_WORKFLOW_STAGES.find((item) => item.id === running.phaseId)?.title;
  }
  const queued = run.nodes.find((node) => node.status === "queued");
  return queued?.phaseTitle;
}

export function statusLine(run: WikiRunSnapshot | undefined, language?: WikiUiLanguage): string {
  const s = uiStrings(language);
  if (!run) return s.noRun;
  const active = run.nodes.filter((node) => node.status === "running").length;
  const failed = run.nodes.filter((node) => node.status === "failed" || node.status === "blocked").length;
  // Soft-pause keeps agents alive; surface draining until they finish.
  if (run.status === "paused" && active > 0) {
    return s.statusLinePausedDraining(active, failed);
  }
  return s.statusLine(run.status, active, failed);
}

/**
 * Install the non-blocking belowEditor task panel. The host re-invokes
 * setWidget on each engine event; this factory only paints current snapshot.
 */
export function createTaskPanelWidget(
  getSnapshot: () => TaskPanelSnapshot,
): (tui: TUI, theme: Theme) => Component {
  return (_tui, theme) => ({
    render: (width: number) => renderPanel(getSnapshot(), theme, width),
    invalidate: () => {},
  });
}

export function installTaskPanel(
  ui: ExtensionUIContext,
  getSnapshot: () => TaskPanelSnapshot,
): void {
  ui.setWidget(TASK_PANEL_KEY, createTaskPanelWidget(getSnapshot), { placement: "belowEditor" });
}

/** RPC transports can only serialize static widget lines, not component factories. */
export function installTaskPanelLines(
  ui: ExtensionUIContext,
  snapshot: TaskPanelSnapshot,
): void {
  ui.setWidget(TASK_PANEL_KEY, renderPanel(snapshot, PLAIN_THEME), { placement: "belowEditor" });
}

export function clearTaskPanel(ui: ExtensionUIContext): void {
  ui.setWidget(TASK_PANEL_KEY, undefined);
}
