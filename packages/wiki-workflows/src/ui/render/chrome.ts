import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WikiRunSnapshot } from "../../workflow-types.js";
import {
  fitRows,
  formatTimestamp,
  padToWidth,
  runStatusColor,
  runStatusIcon,
  runTitle,
  shortHash,
  type WikiUiTheme,
} from "../format.js";
import type { NavigatorState } from "../state.js";
import { uiStrings, type WikiUiLanguage } from "../strings.js";

export const NAVIGATOR_FOOTER_ROWS = 2;

export function renderRunHeader(run: WikiRunSnapshot, width: number, theme: WikiUiTheme): string[] {
  const changed = run.inspection?.changedPaths.length ?? 0;
  const progress = `${run.nodes.filter((node) => node.status === "succeeded").length}/${run.nodes.length}`;
  const head = run.inspection?.head ? ` | ${shortHash(run.inspection.head)}` : "";
  const title = truncateToWidth(runTitle(run), width, "", true);
  const status = theme.fg(runStatusColor(run.status), `${runStatusIcon(run.status)} ${run.status}`);
  const detail = `${status}${theme.fg("dim", `  ${progress} agents | ${changed} changed${head}`)}`;
  return [
    theme.fg("accent", theme.bold(title)),
    truncateToWidth(detail, width, "", true),
  ];
}

export function footerHint(state: NavigatorState, language?: WikiUiLanguage): string {
  const s = uiStrings(language);
  if (state.confirmation) return s.footerConfirm;
  if (state.showHelp) return s.footerHelp;
  if (state.view === "runs") return s.footerRuns;
  if (state.view === "agent") return state.pagerOpen ? s.footerAgentPager : s.footerAgentCompact;
  return state.pane === "agents" ? s.footerDashboardAgents : s.footerDashboardStages;
}

export function withNavigatorFooter(
  content: string[],
  state: NavigatorState,
  rows: number,
  width: number,
  theme: WikiUiTheme,
  language?: WikiUiLanguage,
): string[] {
  const bodyRows = Math.max(1, rows - NAVIGATOR_FOOTER_ROWS);
  return [
    ...fitRows(content, bodyRows, width),
    "",
    truncateToWidth(theme.fg("muted", `  ${footerHint(state, language)}`), width, "", true),
  ];
}

export function renderHelp(width: number, theme: WikiUiTheme, language?: WikiUiLanguage): string[] {
  const s = uiStrings(language);
  return [
    theme.bold(s.helpTitle),
    s.helpRuns,
    s.helpDashboard,
    s.helpAgent,
    s.helpGlobal,
  ].map((line) => truncateToWidth(line, width, "", true));
}

export function borderTitle(title: string, innerWidth: number, theme: WikiUiTheme, focused: boolean): { top: string; bottom: string } {
  const border = (value: string) => theme.fg(focused ? "accent" : "borderMuted", value);
  const safeInnerWidth = Math.max(0, Math.floor(innerWidth));
  // The top has one more title column than the body because of its leading ─.
  const label = truncateToWidth(` ${title} `, safeInnerWidth + 1, "", true);
  const top = border(`╭─${label}${"─".repeat(Math.max(0, safeInnerWidth + 1 - visibleWidth(label)))}╮`);
  const bottom = border(`╰${"─".repeat(safeInnerWidth + 2)}╯`);
  return { top, bottom };
}

export function wrapBorderedBody(lines: string[], innerWidth: number, theme: WikiUiTheme, focused: boolean): string[] {
  const border = (value: string) => theme.fg(focused ? "accent" : "borderMuted", value);
  const safeInnerWidth = Math.max(0, Math.floor(innerWidth));
  return lines.map((line) => border("│ ") + (safeInnerWidth ? padToWidth(line, safeInnerWidth) : "") + border(" │"));
}

export function formatRunMeta(updatedAt: string): string {
  return formatTimestamp(updatedAt);
}
