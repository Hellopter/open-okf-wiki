import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WikiRunAgentView, WikiRunView } from "../../workflow-types.js";
import {
  activityText,
  asText,
  fitLine,
  fitRows,
  padToWidth,
  PHASE_STATUS_COLOR,
  PHASE_STATUS_ICON,
  scrollWindow,
  STATUS_COLOR,
  STATUS_ICON,
  type WikiUiTheme,
} from "../format.js";
import { nodesForPhase, phaseRows, type WikiPhase } from "../stages.js";
import type { NavigatorState } from "../state.js";
import { uiStrings, type WikiUiLanguage } from "../strings.js";
import { renderRunHeader } from "./chrome.js";

const MIN_TWO_PANE = 68;

export function layoutForWidth(width: number): 1 | 2 {
  return width >= MIN_TWO_PANE ? 2 : 1;
}

export function renderDashboard(
  state: NavigatorState,
  run: WikiRunView,
  width: number,
  theme: WikiUiTheme,
  rows: number,
  language?: WikiUiLanguage,
): string[] {
  const header = renderRunHeader(run, width, theme);
  const bodyRows = Math.max(1, rows - header.length);
  const body = layoutForWidth(width) === 2
    ? renderTwoPane(state, run, width, theme, bodyRows, language)
    : renderSinglePane(state, run, width, theme, bodyRows, language);
  return [...header, ...body];
}

function renderTwoPane(
  state: NavigatorState,
  run: WikiRunView,
  width: number,
  theme: WikiUiTheme,
  rows: number,
  language?: WikiUiLanguage,
): string[] {
  const stages = phaseRows(run);
  const stage = stages[state.stageCursor] ?? stages[0];
  const agents = stage ? nodesForPhase(run, stage) : [];
  const leftWidth = Math.max(22, Math.min(40, Math.floor(width * 0.40)));
  const rightWidth = Math.max(20, width - leftWidth - 3);
  const left = renderStagesColumn(state, stages, run, leftWidth, theme, rows, language);
  const right = renderAgentsColumn(state, stage, agents, rightWidth, theme, rows, language);
  return joinColumns(left, right, leftWidth, rightWidth, rows, theme);
}

function renderSinglePane(
  state: NavigatorState,
  run: WikiRunView,
  width: number,
  theme: WikiUiTheme,
  rows: number,
  language?: WikiUiLanguage,
): string[] {
  const stages = phaseRows(run);
  if (state.pane === "stages") {
    return renderStagesColumn(state, stages, run, width, theme, rows, language);
  }
  const stage = stages[state.stageCursor] ?? stages[0];
  const agents = stage ? nodesForPhase(run, stage) : [];
  return renderAgentsColumn(state, stage, agents, width, theme, rows, language);
}

function renderStagesColumn(
  state: NavigatorState,
  stages: WikiPhase[],
  run: WikiRunView,
  width: number,
  theme: WikiUiTheme,
  rows: number,
  language?: WikiUiLanguage,
): string[] {
  const s = uiStrings(language);
  const lines = [theme.bold(s.stagesTitle)];
  const selected = Math.max(0, Math.min(state.stageCursor, Math.max(0, stages.length - 1)));
  const window = scrollWindow(stages.length, selected, Math.max(1, rows - 1));
  for (let index = window.start; index < window.end; index++) {
    const phase = stages[index]!;
    const nodes = nodesForPhase(run, phase);
    const status = nodes.length ? phase.status : phase.conditional ? "conditional" : "not_started";
    const marker = index === selected && state.pane === "stages" ? "›" : " ";
    const count = nodes.length
      ? `${nodes.filter((node) => node.status === "succeeded").length}/${nodes.length}`
      : status === "conditional" ? s.conditional : s.notStarted;
    const icon = PHASE_STATUS_ICON[status];
    const focused = index === selected && state.pane === "stages";
    const title = asText(phase.title);
    const text = focused
      ? `${theme.fg("accent", theme.bold(`${marker} `))}${theme.fg(PHASE_STATUS_COLOR[status], theme.bold(icon))}${theme.fg("accent", theme.bold(` ${title} ${count}`))}`
      : `${marker} ${theme.fg(PHASE_STATUS_COLOR[status], icon)} ${title} ${theme.fg("dim", count)}`;
    lines.push(truncateToWidth(text, width, "", true));
  }
  if (window.more) lines.push(theme.fg("dim", `  ${window.end}/${window.total}`));
  return fitRows(lines, rows, width);
}

function renderAgentsColumn(
  state: NavigatorState,
  stage: WikiPhase | undefined,
  agents: readonly WikiRunAgentView[],
  width: number,
  theme: WikiUiTheme,
  rows: number,
  language?: WikiUiLanguage,
): string[] {
  const s = uiStrings(language);
  if (!stage) return fitRows([theme.fg("muted", s.noAgents)], rows, width);
  const title = theme.bold(s.agentsTitle(asText(stage.title), agents.length));
  if (!agents.length) {
    return fitRows([
      title,
      theme.fg("muted", stage.conditional ? s.conditional : s.notStarted),
      theme.fg("dim", asText(stage.waitingMessage)),
      theme.fg("muted", s.noAgents),
    ], rows, width);
  }
  const lines = [title];
  const selected = Math.max(0, Math.min(state.agentCursor, agents.length - 1));
  const window = scrollWindow(agents.length, selected, Math.max(1, rows - 1));
  for (let index = window.start; index < window.end; index++) {
    const node = agents[index]!;
    const focused = index === selected && state.pane === "agents";
    lines.push(renderNodeRow(node, focused, width, theme));
  }
  if (window.more) lines.push(theme.fg("dim", `  ${window.end}/${window.total}`));
  return fitRows(lines, rows, width);
}

export function renderNodeRow(node: WikiRunAgentView, selected: boolean, width: number, theme: WikiUiTheme): string {
  const marker = selected ? "›" : " ";
  const attempt = node.attempt > 1 ? ` #${node.attempt}` : "";
  const activity = node.status === "running" ? ` | ${asText(activityText(node))}` : "";
  const icon = STATUS_ICON[node.status];
  const label = asText(node.label);
  return truncateToWidth(
    selected
      ? `${theme.fg("accent", theme.bold(`${marker} `))}${theme.fg(STATUS_COLOR[node.status], theme.bold(icon))}${theme.fg("accent", theme.bold(` ${label}${attempt}${activity}`))}`
      : `${marker} ${theme.fg(STATUS_COLOR[node.status], icon)} ${label}${attempt}${theme.fg("dim", activity)}`,
    width,
    "",
    true,
  );
}

function joinColumns(
  first: string[],
  second: string[],
  firstWidth: number,
  secondWidth: number,
  rows: number,
  theme: WikiUiTheme,
): string[] {
  const divider = theme.fg("borderMuted", " │ ");
  return Array.from({ length: rows }, (_, index) => {
    const line = `${padToWidth(first[index] ?? "", firstWidth)}${divider}${padToWidth(second[index] ?? "", secondWidth)}`;
    // visibleWidth of ANSI-padded line may exceed; keep raw join for border alignment
    return visibleWidth(line) > firstWidth + secondWidth + 3
      ? fitLine(line, firstWidth + secondWidth + 3)
      : line;
  });
}
