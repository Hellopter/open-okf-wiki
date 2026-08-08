import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  parseKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type {
  WikiAgentView,
  WikiPhaseStatus,
  WikiPhaseView,
  WikiProgressSnapshot,
  WikiObservationEntry,
} from "../orch/types.js";
import {
  agentStatusGlyph,
  formatAgentActivity,
  formatAgentLine,
  formatAgentContext,
  formatDuration,
  formatLatestUsage,
  formatRunUsage,
  isAgentStale,
  phaseStatusGlyph,
  type FormatTimeOpts,
} from "./format.js";
import { formatWikiObservationEntries } from "./transcript.js";

export type WikiNavigatorView = "idle" | "overview" | "detail" | "proposal";
export type WikiNavigatorPane = "phases" | "agents";

export interface WikiNavigatorState {
  snapshot?: WikiProgressSnapshot;
  view: WikiNavigatorView;
  pane: WikiNavigatorPane;
  phaseIndex: number;
  agentIndex: number;
  transcriptLines: string[];
  transcriptOffset: number;
  transcriptLoading: boolean;
  followTranscript: boolean;
  /** Effective transcript rows from the most recent interactive render. */
  transcriptPageRows?: number;
  /** Visible rows allocated to the scrollable proposal preview. */
  proposalOffset: number;
  proposalPageRows?: number;
  proposalPreviewRows?: number;
}

type NavigatorAction = "close" | "load-transcript" | "pause" | "resume" | "stop" | "approve" | "reject";

export interface WikiNavigatorKeyResult {
  state: WikiNavigatorState;
  action?: NavigatorAction;
  agentId?: string;
}

export interface WikiNavigatorIdleInfo {
  initialized: boolean;
  root: string;
  name?: string;
  sourceCount: number;
}

export interface WikiNavigatorRenderOptions extends FormatTimeOpts {
  width?: number;
  maxRows?: number;
  transcriptRows?: number;
  interactive?: boolean;
}

export interface OpenWikiNavigatorContext {
  hasUI: boolean;
  ui: ExtensionUIContext;
}

export interface OpenWikiNavigatorOptions {
  getSnapshot: () => WikiProgressSnapshot | undefined;
  idle: WikiNavigatorIdleInfo;
  subscribe?: (cb: (snapshot: WikiProgressSnapshot) => void) => () => void;
  getTranscript?: (agentId: string) => Promise<WikiObservationEntry[]> | WikiObservationEntry[];
  onPause?: () => Promise<boolean> | boolean;
  onResume?: () => Promise<boolean> | boolean;
  onStop?: () => Promise<boolean> | boolean;
  /** Approves the active proposed run; the run id remains internal to the extension. */
  onApprove?: () => Promise<boolean> | boolean;
  /** Rejects the active proposal. The extension may implement this as stopping the run. */
  onReject?: () => Promise<boolean> | boolean;
  formatOpts?: FormatTimeOpts;
}

type NavigatorTheme = Pick<Theme, "fg" | "bold">;

const PLAIN_THEME: NavigatorTheme = { fg: (_color, text) => text, bold: (text) => text };
const LIVE: ReadonlySet<WikiAgentView["status"]> = new Set(["starting", "running", "waiting_tool"]);
const DIALOG_MARGIN = 1;
const TRANSCRIPT_PAGE_ROWS = 12;
const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

interface NavigatorPlanQuality {
  verdict?: string;
  passed?: number;
  failed?: number;
  blocked?: number;
  findings?: number;
}

interface NavigatorSnapshotExtras {
  planPreview?: string;
  planSummary?: string;
  qualitySummary?: NavigatorPlanQuality;
}

function isProposedSnapshot(snapshot: WikiProgressSnapshot | undefined): boolean {
  return String(snapshot?.overall ?? "") === "proposed";
}

function snapshotExtras(snapshot: WikiProgressSnapshot): NavigatorSnapshotExtras {
  return snapshot as WikiProgressSnapshot & NavigatorSnapshotExtras;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

function inferPhaseStatus(agents: WikiAgentView[]): WikiPhaseStatus {
  if (agents.some((agent) => agent.status === "failed" || agent.status === "timed_out")) return "failed";
  if (agents.some((agent) => LIVE.has(agent.status))) return "active";
  if (agents.length > 0 && agents.every((agent) => agent.status === "succeeded" || agent.status === "skipped")) {
    return "done";
  }
  return "pending";
}

function navigatorPhases(snapshot: WikiProgressSnapshot): WikiPhaseView[] {
  const phases = snapshot.phases.map((phase) => ({ ...phase }));
  const known = new Set(phases.map((phase) => phase.name));
  for (const agent of snapshot.agents) {
    if (known.has(agent.phase)) continue;
    const agents = snapshot.agents.filter((candidate) => candidate.phase === agent.phase);
    phases.push({ name: agent.phase, status: inferPhaseStatus(agents) });
    known.add(agent.phase);
  }
  return phases;
}

function phaseAgents(snapshot: WikiProgressSnapshot, phaseIndex: number): WikiAgentView[] {
  const phases = navigatorPhases(snapshot);
  const phase = phases[clampIndex(phaseIndex, phases.length)];
  return phase ? snapshot.agents.filter((agent) => agent.phase === phase.name) : [];
}

function selectedPhase(state: WikiNavigatorState): WikiPhaseView | undefined {
  if (!state.snapshot) return undefined;
  const phases = navigatorPhases(state.snapshot);
  return phases[clampIndex(state.phaseIndex, phases.length)];
}

function selectedAgent(state: WikiNavigatorState): WikiAgentView | undefined {
  if (!state.snapshot) return undefined;
  const agents = phaseAgents(state.snapshot, state.phaseIndex);
  return agents[clampIndex(state.agentIndex, agents.length)];
}

function defaultPhaseIndex(snapshot: WikiProgressSnapshot): number {
  const phases = navigatorPhases(snapshot);
  const current = phases.findIndex((phase) => phase.name === snapshot.currentPhase);
  if (current >= 0) return current;
  const live = phases.findIndex((phase) => snapshot.agents.some((agent) => agent.phase === phase.name && LIVE.has(agent.status)));
  return live >= 0 ? live : 0;
}

function defaultAgentIndex(snapshot: WikiProgressSnapshot, phaseIndex: number): number {
  const agents = phaseAgents(snapshot, phaseIndex);
  const live = agents.findIndex((agent) => LIVE.has(agent.status));
  return live >= 0 ? live : 0;
}

export function createWikiNavigatorState(snapshot?: WikiProgressSnapshot): WikiNavigatorState {
  const phaseIndex = snapshot ? defaultPhaseIndex(snapshot) : 0;
  return {
    snapshot,
    view: snapshot ? (isProposedSnapshot(snapshot) ? "proposal" : "overview") : "idle",
    pane: "phases",
    phaseIndex,
    agentIndex: snapshot ? defaultAgentIndex(snapshot, phaseIndex) : 0,
    transcriptLines: [],
    transcriptOffset: 0,
    transcriptLoading: false,
    followTranscript: true,
    transcriptPageRows: TRANSCRIPT_PAGE_ROWS,
    proposalOffset: 0,
    proposalPageRows: TRANSCRIPT_PAGE_ROWS,
    proposalPreviewRows: 0,
  };
}

function updateNavigatorSnapshot(state: WikiNavigatorState, snapshot: WikiProgressSnapshot): WikiNavigatorState {
  const wasIdle = !state.snapshot || state.view === "idle";
  const proposed = isProposedSnapshot(snapshot);
  const previousPhase = selectedPhase(state)?.name;
  const previousAgent = selectedAgent(state)?.agentId;
  const phases = navigatorPhases(snapshot);
  const phaseIndex = previousPhase ? phases.findIndex((phase) => phase.name === previousPhase) : -1;
  const nextPhaseIndex = phaseIndex >= 0 ? phaseIndex : defaultPhaseIndex(snapshot);
  const agents = phaseAgents(snapshot, nextPhaseIndex);
  const agentIndex = previousAgent ? agents.findIndex((agent) => agent.agentId === previousAgent) : -1;
  const nextAgentIndex = agentIndex >= 0 ? agentIndex : defaultAgentIndex(snapshot, nextPhaseIndex);
  const agentChanged = Boolean(previousAgent) && previousAgent !== agents[nextAgentIndex]?.agentId;
  return {
    ...state,
    snapshot,
    view: proposed ? "proposal" : wasIdle || state.view === "proposal" || (agentChanged && state.view === "detail") ? "overview" : state.view,
    pane: wasIdle ? "phases" : agentChanged ? "agents" : state.pane,
    phaseIndex: nextPhaseIndex,
    agentIndex: nextAgentIndex,
    transcriptLines: agentChanged ? [] : state.transcriptLines,
    transcriptOffset: agentChanged ? 0 : state.transcriptOffset,
    transcriptLoading: agentChanged ? false : state.transcriptLoading,
    proposalOffset: proposed ? state.proposalOffset : 0,
  };
}

function withPhaseSelection(state: WikiNavigatorState, phaseIndex: number): WikiNavigatorState {
  if (!state.snapshot) return state;
  const nextPhaseIndex = clampIndex(phaseIndex, navigatorPhases(state.snapshot).length);
  return {
    ...state,
    phaseIndex: nextPhaseIndex,
    agentIndex: defaultAgentIndex(state.snapshot, nextPhaseIndex),
  };
}

function withAgentSelection(state: WikiNavigatorState, agentIndex: number): WikiNavigatorState {
  if (!state.snapshot) return state;
  return { ...state, agentIndex: clampIndex(agentIndex, phaseAgents(state.snapshot, state.phaseIndex).length) };
}

function withTranscript(state: WikiNavigatorState, entries: readonly WikiObservationEntry[]): WikiNavigatorState {
  const lines = formatWikiObservationEntries(entries);
  const maxOffset = Math.max(0, lines.length - transcriptPageRows(state));
  return {
    ...state,
    transcriptLines: lines,
    transcriptOffset: state.followTranscript ? maxOffset : Math.min(state.transcriptOffset, maxOffset),
    transcriptLoading: false,
  };
}

function transcriptPageRows(state: WikiNavigatorState): number {
  return Math.max(1, state.transcriptPageRows ?? TRANSCRIPT_PAGE_ROWS);
}

function withTranscriptPageRows(state: WikiNavigatorState, rows: number): WikiNavigatorState {
  const transcriptRows = Math.max(1, Math.floor(rows));
  if (state.transcriptPageRows === transcriptRows) return state;
  const maxOffset = Math.max(0, state.transcriptLines.length - transcriptRows);
  return {
    ...state,
    transcriptPageRows: transcriptRows,
    transcriptOffset: state.followTranscript ? maxOffset : Math.min(state.transcriptOffset, maxOffset),
  };
}

function withProposalPageRows(state: WikiNavigatorState, rows: number, previewRows: number): WikiNavigatorState {
  const proposalPageRows = Math.max(1, Math.floor(rows));
  const maxOffset = Math.max(0, previewRows - proposalPageRows);
  if (state.proposalPageRows === proposalPageRows && state.proposalPreviewRows === previewRows && state.proposalOffset <= maxOffset) return state;
  return {
    ...state,
    proposalPageRows,
    proposalPreviewRows: previewRows,
    proposalOffset: Math.min(state.proposalOffset, maxOffset),
  };
}

function result(state: WikiNavigatorState, action?: NavigatorAction, agentId?: string): WikiNavigatorKeyResult {
  return action ? { state, action, agentId } : { state };
}

function openDetail(state: WikiNavigatorState): WikiNavigatorKeyResult {
  const agent = selectedAgent(state);
  if (!agent) return result(state);
  return result(
    {
      ...state,
      view: "detail",
      transcriptLines: [],
      transcriptOffset: 0,
      transcriptLoading: true,
      followTranscript: true,
    },
    "load-transcript",
    agent.agentId,
  );
}

function proposalPreview(snapshot: WikiProgressSnapshot, width: number): string[] {
  const preview = snapshotExtras(snapshot).planPreview;
  if (!preview?.trim()) return ["Plan preview is unavailable."];
  return wrapTextWithAnsi(preview, Math.max(1, width));
}

function proposalPageRows(state: WikiNavigatorState): number {
  return Math.max(1, state.proposalPageRows ?? TRANSCRIPT_PAGE_ROWS);
}

function proposalMaxOffset(state: WikiNavigatorState): number {
  return Math.max(0, (state.proposalPreviewRows ?? 0) - proposalPageRows(state));
}

/** Apply a parsed key to the single-window phase -> agent -> execution navigator. */
export function applyWikiNavigatorKey(state: WikiNavigatorState, key: string): WikiNavigatorKeyResult {
  const normalized = key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : key === "Enter" ? "enter" : key;

  if (normalized === "q") return result(state, "close");
  if (normalized === "a" && isProposedSnapshot(state.snapshot)) return result(state, "approve");
  if (normalized === "r" && isProposedSnapshot(state.snapshot)) return result(state, "reject");
  if (normalized === "p" && state.snapshot && !isProposedSnapshot(state.snapshot)) {
    return result(state, state.snapshot.overall === "paused" ? "resume" : "pause");
  }
  if (normalized === "x" && state.snapshot) return result(state, "stop");

  if (state.view === "idle") {
    return normalized === "escape" || normalized === "esc" || normalized === "left" ? result(state, "close") : result(state);
  }

  if (state.view === "proposal") {
    if (normalized === "escape" || normalized === "esc" || normalized === "left") {
      return result({ ...state, view: "overview", pane: "phases" });
    }
    if (normalized === "g" || normalized === "home") return result({ ...state, proposalOffset: 0 });
    if (normalized === "G" || normalized === "shift+g" || normalized === "end") {
      return result({ ...state, proposalOffset: proposalMaxOffset(state) });
    }
    if (normalized === "up" || normalized === "k") {
      return result({ ...state, proposalOffset: Math.max(0, state.proposalOffset - 1) });
    }
    if (normalized === "down" || normalized === "j") {
      return result({ ...state, proposalOffset: Math.min(proposalMaxOffset(state), state.proposalOffset + 1) });
    }
    return result(state);
  }

  if (state.view === "detail") {
    if (normalized === "escape" || normalized === "esc" || normalized === "left") {
      return result({ ...state, view: "overview", pane: "agents", transcriptLoading: false });
    }
    if (normalized === "g" || normalized === "home") {
      return result({ ...state, transcriptOffset: 0, followTranscript: false });
    }
    if (normalized === "G" || normalized === "shift+g" || normalized === "end") {
      return result({ ...state, transcriptOffset: Math.max(0, state.transcriptLines.length - transcriptPageRows(state)), followTranscript: true });
    }
    if (normalized === "up" || normalized === "k") {
      return result({ ...state, transcriptOffset: Math.max(0, state.transcriptOffset - 1), followTranscript: false });
    }
    if (normalized === "down" || normalized === "j") {
      const maxOffset = Math.max(0, state.transcriptLines.length - transcriptPageRows(state));
      const transcriptOffset = Math.min(maxOffset, state.transcriptOffset + 1);
      return result({ ...state, transcriptOffset, followTranscript: transcriptOffset === maxOffset });
    }
    if (normalized === "t") {
      const agent = selectedAgent(state);
      return agent
        ? result({ ...state, transcriptLoading: true, followTranscript: true }, "load-transcript", agent.agentId)
        : result(state);
    }
    return result(state);
  }

  if (normalized === "escape" || normalized === "esc") {
    return state.pane === "agents" ? result({ ...state, pane: "phases" }) : result(state, "close");
  }
  if (normalized === "left") {
    return state.pane === "agents" ? result({ ...state, pane: "phases" }) : result(state, "close");
  }
  if (normalized === "v" && isProposedSnapshot(state.snapshot)) {
    return result({ ...state, view: "proposal", proposalOffset: 0 });
  }
  if (normalized === "right" || normalized === "enter") {
    return state.pane === "phases" ? result({ ...state, pane: "agents" }) : openDetail(state);
  }
  if (normalized === "up" || normalized === "k") {
    return state.pane === "phases"
      ? result(withPhaseSelection(state, state.phaseIndex - 1))
      : result(withAgentSelection(state, state.agentIndex - 1));
  }
  if (normalized === "down" || normalized === "j") {
    return state.pane === "phases"
      ? result(withPhaseSelection(state, state.phaseIndex + 1))
      : result(withAgentSelection(state, state.agentIndex + 1));
  }
  return result(state);
}

function listWindow<T>(items: readonly T[], selectedIndex: number, maxRows: number): { start: number; items: readonly T[]; more: boolean } {
  if (items.length <= maxRows) return { start: 0, items, more: false };
  const selected = clampIndex(selectedIndex, items.length);
  const start = Math.min(Math.max(0, selected - Math.floor(maxRows / 2)), items.length - maxRows);
  return { start, items: items.slice(start, start + maxRows), more: start + maxRows < items.length };
}

function phaseLine(phase: WikiPhaseView, snapshot: WikiProgressSnapshot, selected: boolean, width: number, theme: NavigatorTheme): string {
  const agents = snapshot.agents.filter((agent) => agent.phase === phase.name);
  const done = agents.filter((agent) => agent.status === "succeeded" || agent.status === "skipped").length;
  const marker = selected ? theme.fg("accent", theme.bold("› ")) : "  ";
  const label = `${phase.name} ${phaseStatusGlyph(phase.status)} ${done}/${agents.length}`;
  return truncateToWidth(selected ? `${marker}${theme.fg("accent", theme.bold(label))}` : `${marker}${label}`, width, "", true);
}

function agentLine(agent: WikiAgentView, selected: boolean, opts: WikiNavigatorRenderOptions, width: number, theme: NavigatorTheme): string {
  const marker = selected ? theme.fg("accent", theme.bold("› ")) : "  ";
  const line = formatAgentLine(agent, opts);
  return truncateToWidth(selected ? `${marker}${theme.fg("accent", theme.bold(line))}` : `${marker}${line}`, width, "", true);
}

function fillCell(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "", true);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function frameTitle(title: string, width: number, theme: NavigatorTheme): string {
  const label = truncateToWidth(` ${title} `, Math.max(0, width - 1), "", true);
  return theme.fg("dim", label) + theme.fg("border", "─".repeat(Math.max(1, width - visibleWidth(label))));
}

interface TwoPaneFrameOptions {
  width: number;
  bodyRows: number;
  leftWidth: number;
  leftTitle: string;
  rightTitle: string;
  left: readonly string[];
  right: readonly string[];
  theme: NavigatorTheme;
}

/** Full-height two-pane frame. Every allocated body row retains the divider. */
function renderTwoPaneFrame(options: TwoPaneFrameOptions): string[] {
  const rightWidth = options.width - options.leftWidth - 3;
  const border = (value: string) => options.theme.fg("border", value);
  const lines = [
    `${border("┌")}${frameTitle(options.leftTitle, options.leftWidth, options.theme)}${border("┬")}${frameTitle(options.rightTitle, rightWidth, options.theme)}${border("┐")}`,
  ];
  for (let index = 0; index < options.bodyRows; index++) {
    lines.push(
      `${border("│")}${fillCell(options.left[index] ?? "", options.leftWidth)}${border("│")}${fillCell(options.right[index] ?? "", rightWidth)}${border("│")}`,
    );
  }
  lines.push(`${border("└")}${border("─".repeat(options.leftWidth))}${border("┴")}${border("─".repeat(rightWidth))}${border("┘")}`);
  return lines;
}

function renderOverview(state: WikiNavigatorState, opts: WikiNavigatorRenderOptions, theme: NavigatorTheme): string[] {
  const snapshot = state.snapshot!;
  const width = Math.max(1, opts.width ?? 80);
  const maxRows = Math.max(2, opts.maxRows ?? 12);
  const phases = navigatorPhases(snapshot);
  const agents = phaseAgents(snapshot, state.phaseIndex);
  const lines = [`Wiki ${snapshot.overall} · ${snapshot.currentPhase ?? "—"}`];

  if (width < 52) {
    lines.push(theme.fg("dim", "Phases"));
    const paneRows = Math.max(1, Math.floor((maxRows - lines.length - (opts.interactive ? 1 : 0) - 2) / 2));
    const phaseRows = listWindow(phases, state.phaseIndex, paneRows);
    for (let index = 0; index < phaseRows.items.length; index++) {
      lines.push(phaseLine(phaseRows.items[index]!, snapshot, state.pane === "phases" && phaseRows.start + index === state.phaseIndex, width, theme));
    }
    if (phaseRows.more) lines.push(theme.fg("dim", "  …"));
    lines.push(theme.fg("dim", `Agents · ${selectedPhase(state)?.name ?? "—"}`));
    const agentRows = listWindow(agents, state.agentIndex, paneRows);
    for (let index = 0; index < agentRows.items.length; index++) {
      lines.push(agentLine(agentRows.items[index]!, state.pane === "agents" && agentRows.start + index === state.agentIndex, opts, width, theme));
    }
    if (agents.length === 0) lines.push(theme.fg("dim", "  no agents"));
    if (agentRows.more) lines.push(theme.fg("dim", "  …"));
  } else {
    const leftWidth = Math.min(30, Math.max(20, Math.floor((width - 3) * 0.32)));
    const rightWidth = width - leftWidth - 3;
    const reservedRows = lines.length + (opts.interactive ? 1 : 0) + 2;
    const bodyRows = Math.max(1, maxRows - reservedRows);
    const phaseRows = listWindow(phases, state.phaseIndex, bodyRows);
    const agentRows = listWindow(agents, state.agentIndex, bodyRows);
    const left: string[] = [];
    const right: string[] = [];
    for (let index = 0; index < bodyRows; index++) {
      const phase = phaseRows.items[index];
      const agent = agentRows.items[index];
      let leftLine = phase
        ? phaseLine(phase, snapshot, state.pane === "phases" && phaseRows.start + index === state.phaseIndex, leftWidth, theme)
        : "";
      let rightLine = agent
        ? agentLine(agent, state.pane === "agents" && agentRows.start + index === state.agentIndex, opts, rightWidth, theme)
        : agents.length === 0 && index === 0
          ? truncateToWidth(theme.fg("dim", "  no agents"), rightWidth, "", true)
          : "";
      if (index === bodyRows - 1 && phaseRows.more) leftLine = theme.fg("dim", "  …");
      if (index === bodyRows - 1 && agentRows.more) rightLine = theme.fg("dim", "  …");
      left.push(leftLine);
      right.push(rightLine);
    }
    lines.push(
      ...renderTwoPaneFrame({
        width,
        bodyRows,
        leftWidth,
        leftTitle: "Phases",
        rightTitle: `Agents · ${selectedPhase(state)?.name ?? "—"}`,
        left,
        right,
        theme,
      }),
    );
  }

  if (opts.interactive) {
    lines.push(
      isProposedSnapshot(snapshot)
        ? "←/→ pane · ↑/↓ select · enter observe · v plan · a approve · r reject plan · q close"
        : "←/→ pane · ↑/↓ select · enter observe · p pause/resume · x stop · q close",
    );
  }
  return lines;
}

function formatQualitySummary(snapshot: WikiProgressSnapshot): string {
  const quality = snapshotExtras(snapshot).qualitySummary;
  if (!quality) return "Quality: awaiting review";
  const parts: string[] = [];
  if (quality.verdict) parts.push(quality.verdict.toUpperCase());
  if (typeof quality.passed === "number") parts.push(`${quality.passed} passed`);
  if (typeof quality.failed === "number") parts.push(`${quality.failed} failed`);
  if (typeof quality.blocked === "number") parts.push(`${quality.blocked} blocked`);
  if (typeof quality.findings === "number") parts.push(`${quality.findings} findings`);
  return parts.length > 0 ? `Quality: ${parts.join(" · ")}` : "Quality: awaiting review";
}

function proposalIntro(snapshot: WikiProgressSnapshot, width: number): string[] {
  const summary = snapshotExtras(snapshot).planSummary;
  return [
    "Plan approval",
    ...wrapTextWithAnsi(summary?.trim() ? `Summary: ${summary.trim()}` : "Summary: source-grounded plan is ready for review.", Math.max(1, width)),
    ...wrapTextWithAnsi(formatQualitySummary(snapshot), Math.max(1, width)),
    "",
    "Plan preview",
  ];
}

function renderProposal(state: WikiNavigatorState, opts: WikiNavigatorRenderOptions, theme: NavigatorTheme): string[] {
  const snapshot = state.snapshot!;
  const width = Math.max(1, opts.width ?? 80);
  const maxRows = Math.max(2, opts.maxRows ?? 12);
  const phases = navigatorPhases(snapshot);
  const lines = [theme.bold("Wiki proposed · approval required")];
  const footer = opts.interactive ? "↑/↓ scroll plan · g/G start/end · a approve · r reject plan · ← phases · q close" : undefined;

  if (width < 52) {
    const headerRows = lines.length + (footer ? 1 : 0);
    const intro = proposalIntro(snapshot, width);
    const previewRows = Math.max(1, maxRows - headerRows - intro.length - 1);
    const preview = proposalPreview(snapshot, width);
    const maxOffset = Math.max(0, preview.length - previewRows);
    const start = Math.min(state.proposalOffset, maxOffset);
    lines.push(...intro, ...preview.slice(start, start + previewRows));
    if (preview.length > previewRows) lines.push(theme.fg("dim", `${start + 1}-${Math.min(preview.length, start + previewRows)} / ${preview.length}`));
  } else {
    const leftWidth = Math.min(30, Math.max(20, Math.floor((width - 3) * 0.32)));
    const rightWidth = width - leftWidth - 3;
    const reservedRows = lines.length + (footer ? 1 : 0) + 2;
    const bodyRows = Math.max(1, maxRows - reservedRows);
    const phaseRows = listWindow(phases, state.phaseIndex, bodyRows);
    const intro = proposalIntro(snapshot, rightWidth);
    const previewRows = Math.max(1, bodyRows - intro.length - 1);
    const preview = proposalPreview(snapshot, rightWidth);
    const maxOffset = Math.max(0, preview.length - previewRows);
    const start = Math.min(state.proposalOffset, maxOffset);
    const left: string[] = [];
    const right = [...intro, ...preview.slice(start, start + previewRows)];
    if (preview.length > previewRows) right.push(theme.fg("dim", `${start + 1}-${Math.min(preview.length, start + previewRows)} / ${preview.length}`));
    for (let index = 0; index < bodyRows; index++) {
      const phase = phaseRows.items[index];
      left.push(
        phase
          ? phaseLine(phase, snapshot, phaseRows.start + index === state.phaseIndex, leftWidth, theme)
          : "",
      );
    }
    lines.push(
      ...renderTwoPaneFrame({
        width,
        bodyRows,
        leftWidth,
        leftTitle: "Phases",
        rightTitle: "Plan",
        left,
        right,
        theme,
      }),
    );
  }
  if (footer) lines.push(footer);
  return lines;
}

function detailPreamble(
  state: WikiNavigatorState,
  opts: WikiNavigatorRenderOptions,
  theme: NavigatorTheme,
): { agent?: WikiAgentView; lines: string[] } {
  const agent = selectedAgent(state);
  if (!agent) return { lines: [theme.fg("warning", "Selected agent is no longer available."), "← back · q close"] };

  const lines = [theme.bold(agent.label), `${agent.phase} · ${agentStatusGlyph(agent.status)} ${agent.status} · ${formatDuration(agent.elapsedMs)}`];
  const prompt = (agent as WikiAgentView & { prompt?: unknown }).prompt;
  if (typeof prompt === "string" && prompt.trim()) lines.push(`Input prompt: ${prompt.trim()}`);
  const context = formatAgentContext(agent);
  if (context) lines.push(context);
  const activity = formatAgentActivity(agent);
  if (activity) lines.push(theme.fg("warning", activity));
  const latestUsage = formatLatestUsage(agent);
  if (latestUsage) lines.push(latestUsage);
  const runUsage = formatRunUsage(agent);
  if (runUsage) lines.push(runUsage);
  const compactionCount = (agent as WikiAgentView & { compactionCount?: number }).compactionCount;
  if (compactionCount) lines.push(`Context compacted ${compactionCount}x`);
  if (agent.lastTool) lines.push(`Last tool: ${agent.lastTool.name}${agent.lastTool.path ? ` ${agent.lastTool.path}` : ""}`);
  if (agent.lastError) lines.push(theme.fg("error", `Error: ${agent.lastError}`));
  if (opts.staleWarnMs !== undefined && isAgentStale(agent, opts.staleWarnMs, opts.now)) {
    lines.push(theme.fg("warning", "Stale: no recent heartbeat"));
  }
  lines.push(theme.fg("dim", `Execution stream${state.followTranscript ? " · following" : ""}`));
  lines.push("─".repeat(40));
  return { agent, lines };
}

function detailTranscriptRows(preambleRows: number, opts: WikiNavigatorRenderOptions): number {
  const maxRows = Math.max(1, opts.maxRows ?? Number.POSITIVE_INFINITY);
  const footerRows = opts.interactive ? 1 : 0;
  // Reserve the optional paging hints so transcript rows never push controls off-screen.
  return Math.max(1, Math.min(opts.transcriptRows ?? TRANSCRIPT_PAGE_ROWS, maxRows - preambleRows - footerRows - 2));
}

function effectiveTranscriptPageRows(state: WikiNavigatorState, opts: WikiNavigatorRenderOptions): number {
  if (state.view !== "detail") return TRANSCRIPT_PAGE_ROWS;
  const preamble = detailPreamble(state, opts, PLAIN_THEME);
  return preamble.agent ? detailTranscriptRows(preamble.lines.length, opts) : TRANSCRIPT_PAGE_ROWS;
}

function proposalPagination(state: WikiNavigatorState, opts: WikiNavigatorRenderOptions): { pageRows: number; previewRows: number } {
  const snapshot = state.snapshot;
  if (!snapshot) return { pageRows: TRANSCRIPT_PAGE_ROWS, previewRows: 0 };
  const width = Math.max(1, opts.width ?? 80);
  const maxRows = Math.max(2, opts.maxRows ?? 12);
  const footerRows = opts.interactive ? 1 : 0;
  if (width < 52) {
    const introRows = proposalIntro(snapshot, width).length;
    const pageRows = Math.max(1, maxRows - 1 - footerRows - introRows - 1);
    return { pageRows, previewRows: proposalPreview(snapshot, width).length };
  }
  const leftWidth = Math.min(30, Math.max(20, Math.floor((width - 3) * 0.32)));
  const rightWidth = width - leftWidth - 3;
  const bodyRows = Math.max(1, maxRows - 1 - footerRows - 2);
  return {
    pageRows: Math.max(1, bodyRows - proposalIntro(snapshot, rightWidth).length - 1),
    previewRows: proposalPreview(snapshot, rightWidth).length,
  };
}

function renderDetail(state: WikiNavigatorState, opts: WikiNavigatorRenderOptions, theme: NavigatorTheme): string[] {
  const preamble = detailPreamble(state, opts, theme);
  if (!preamble.agent) return preamble.lines;
  const lines = preamble.lines;
  const transcriptRows = detailTranscriptRows(lines.length, opts);

  if (state.transcriptLoading) {
    lines.push(theme.fg("dim", "Loading execution stream…"));
  } else if (state.transcriptLines.length === 0) {
    lines.push(theme.fg("dim", "No execution output yet."));
  } else {
    const maxOffset = Math.max(0, state.transcriptLines.length - transcriptRows);
    const start = state.followTranscript ? maxOffset : Math.min(state.transcriptOffset, maxOffset);
    const window = state.transcriptLines.slice(start, start + transcriptRows);
    if (start > 0) lines.push(theme.fg("dim", `↑ ${start} earlier line${start === 1 ? "" : "s"}`));
    lines.push(...window);
    const remaining = state.transcriptLines.length - start - window.length;
    if (remaining > 0) lines.push(theme.fg("dim", `↓ ${remaining} newer line${remaining === 1 ? "" : "s"}`));
  }
  if (opts.interactive) lines.push("↑/↓ scroll · g/G start/end · t refresh · ← back · p pause/resume · x stop · q close");
  return lines;
}

function renderIdle(idle: WikiNavigatorIdleInfo, interactive: boolean, theme: NavigatorTheme): string[] {
  const title = idle.initialized ? "No active Wiki run" : "Wiki workspace is not initialized";
  const lines = [theme.bold(title), `Workspace: ${idle.name ?? idle.root}`, `Sources: ${idle.sourceCount}`];
  lines.push(idle.initialized ? "Use /wiki run to start a repository Wiki run." : "Use /wiki init to create the Wiki workspace.");
  if (interactive) lines.push("q or Esc close");
  return lines;
}

/** Render the focused Wiki Navigator without the outer dialog frame. */
export function renderWikiNavigator(
  state: WikiNavigatorState,
  idle: WikiNavigatorIdleInfo,
  opts: WikiNavigatorRenderOptions = {},
  theme: NavigatorTheme = PLAIN_THEME,
): string[] {
  if (state.view === "idle" || !state.snapshot) return renderIdle(idle, Boolean(opts.interactive), theme);
  if (state.view === "detail") return renderDetail(state, opts, theme);
  if (state.view === "proposal") return renderProposal(state, opts, theme);
  return renderOverview(state, opts, theme);
}

function fixedDialogContent(lines: string[], rows: number): string[] {
  let frame: string[];
  if (lines.length <= rows) {
    frame = lines;
  } else if (rows === 1) {
    frame = ["…"];
  } else if (rows === 2) {
    frame = [lines[0]!, lines[lines.length - 1]!];
  } else {
    frame = [...lines.slice(0, Math.max(1, rows - 2)), "…", lines[lines.length - 1]!];
  }

  if (frame.length >= rows) return frame;
  // Every interactive view ends in a shortcut footer. Keep it pinned at the
  // bottom while the viewport fills unused rows to prevent height jitter.
  const footer = frame.at(-1) ?? "";
  return [...frame.slice(0, -1), ...Array(rows - frame.length).fill(""), footer];
}

interface NavigatorDialogLayout {
  panelWidth: number;
  innerWidth: number;
  contentRows: number;
  renderOptions: WikiNavigatorRenderOptions;
}

function navigatorDialogLayout(tui: TUI, options: OpenWikiNavigatorOptions, width: number): NavigatorDialogLayout {
  const panelWidth = Math.max(1, width);
  const terminalRows = Math.max(3, tui.terminal?.rows ?? 24);
  const availableRows = Math.max(3, terminalRows - DIALOG_MARGIN * 2);
  const overlayRows = Math.max(3, Math.min(Math.floor(terminalRows * 0.92), availableRows));
  const contentRows = Math.max(1, overlayRows - 2);
  const innerWidth = Math.max(1, panelWidth - BOX_BORDER_OVERHEAD);
  return {
    panelWidth,
    innerWidth,
    contentRows,
    renderOptions: {
      ...options.formatOpts,
      width: innerWidth,
      maxRows: contentRows,
      transcriptRows: Math.max(1, contentRows - 8),
      interactive: true,
    },
  };
}

function renderNavigatorDialog(
  state: WikiNavigatorState,
  tui: TUI,
  theme: Theme,
  options: OpenWikiNavigatorOptions,
  width: number,
  layout: NavigatorDialogLayout = navigatorDialogLayout(tui, options, width),
): string[] {
  const { panelWidth, innerWidth, contentRows, renderOptions } = layout;
  const content = renderWikiNavigator(
    state,
    options.idle,
    renderOptions,
    theme,
  );

  if (panelWidth < BOX_BORDER_OVERHEAD + 6) {
    return fixedDialogContent(content.flatMap((line) => wrapTextWithAnsi(line, panelWidth)), contentRows).map((line) => truncateToWidth(line, panelWidth));
  }

  const frame = fixedDialogContent(content.flatMap((line) => wrapTextWithAnsi(line, innerWidth)), contentRows);
  const border = (line: string) => theme.fg("border", line);
  const title = theme.fg("accent", theme.bold(" wiki "));
  const titleWidth = visibleWidth(title);
  const top = border("╭─") + title + border("─".repeat(Math.max(0, innerWidth - titleWidth + 1)) + "╮");
  const bottom = border(`╰${"─".repeat(innerWidth + 2)}╯`);
  const wrap = (line: string) => {
    const body = truncateToWidth(line, innerWidth, "", true);
    const framed = border(BOX_BORDER_LEFT) + body + border(BOX_BORDER_RIGHT);
    return theme.bg("customMessageBg", framed + " ".repeat(Math.max(0, panelWidth - visibleWidth(framed))));
  };
  return [theme.bg("customMessageBg", top), ...frame.map(wrap), theme.bg("customMessageBg", bottom)];
}

/** Open the one-window Wiki Navigator in interactive Pi. */
export async function openWikiNavigator(
  ctx: OpenWikiNavigatorContext,
  options: OpenWikiNavigatorOptions,
): Promise<"closed" | "unsupported"> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Wiki Navigator requires interactive Pi. Use /wiki status --json for machine-readable state.", "info");
    return "unsupported";
  }

  try {
    await ctx.ui.custom<void>(
      (tui: TUI, theme: Theme, _keybindings, done) => {
        let state = createWikiNavigatorState(options.getSnapshot());
        let closed = false;
        let transcriptRequest = 0;
        let unsubscribe: (() => void) | undefined;
        let lastRenderOptions: WikiNavigatorRenderOptions | undefined;

        const redraw = () => tui.requestRender();
        const cleanup = () => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          unsubscribe = undefined;
        };
        const close = () => {
          cleanup();
          done(undefined);
        };
        const loadTranscript = async (agentId: string) => {
          if (!options.getTranscript) {
            state = withTranscript(state, []);
            redraw();
            return;
          }
          const request = ++transcriptRequest;
          try {
            const entries = await options.getTranscript(agentId);
            if (closed || request !== transcriptRequest || selectedAgent(state)?.agentId !== agentId) return;
            state = withTranscript(state, entries);
          } catch {
            if (closed || request !== transcriptRequest) return;
            state = withTranscript(state, [{ role: "system", kind: "text", timestamp: Date.now(), text: "(execution stream unavailable)" }]);
          }
          redraw();
        };
        const runControl = async (action: "pause" | "resume" | "stop" | "approve" | "reject") => {
          const callback =
            action === "pause"
              ? options.onPause
              : action === "resume"
                ? options.onResume
                : action === "stop"
                  ? options.onStop
                  : action === "approve"
                    ? options.onApprove
                    : options.onReject;
          if (!callback) return;
          try {
            const ok = await callback();
            if (!ok) ctx.ui.notify(`Unable to ${action === "reject" ? "reject the" : action} Wiki ${action === "reject" ? "plan" : "orchestration"}.`, "warning");
          } catch {
            ctx.ui.notify(`Unable to ${action === "reject" ? "reject the" : action} Wiki ${action === "reject" ? "plan" : "orchestration"}.`, "warning");
          }
          redraw();
        };

        unsubscribe = options.subscribe?.((snapshot) => {
          state = updateNavigatorSnapshot(state, snapshot);
          if (state.view === "detail") {
            const agentId = selectedAgent(state)?.agentId;
            if (agentId) void loadTranscript(agentId);
          }
          redraw();
        });

        let focused = false;
        const component: Component & Focusable & { dispose?: () => void } = {
          get focused(): boolean {
            return focused;
          },
          set focused(value: boolean) {
            focused = value;
          },
          render: (width: number) => {
            const layout = navigatorDialogLayout(tui, options, width);
            lastRenderOptions = layout.renderOptions;
            state = withTranscriptPageRows(state, effectiveTranscriptPageRows(state, layout.renderOptions));
            if (state.view === "proposal") {
              const pagination = proposalPagination(state, layout.renderOptions);
              state = withProposalPageRows(state, pagination.pageRows, pagination.previewRows);
            }
            return renderNavigatorDialog(state, tui, theme, options, width, layout);
          },
          handleInput: (data: string) => {
            const next = applyWikiNavigatorKey(state, parseKey(data) ?? data);
            state = lastRenderOptions
              ? withTranscriptPageRows(next.state, effectiveTranscriptPageRows(next.state, lastRenderOptions))
              : next.state;
            if (next.action === "close") {
              close();
              return;
            }
            if (next.action === "load-transcript" && next.agentId) void loadTranscript(next.agentId);
            if (next.action === "pause" || next.action === "resume" || next.action === "stop" || next.action === "approve" || next.action === "reject") {
              void runControl(next.action);
            }
            redraw();
          },
          invalidate: () => {},
          dispose: cleanup,
        };
        return component;
      },
      {
        overlay: true,
        overlayOptions: { width: "94%", maxHeight: "92%", anchor: "center", margin: DIALOG_MARGIN },
      },
    );
    return "closed";
  } catch {
    ctx.ui.notify("Wiki Navigator could not be opened.", "warning");
    return "unsupported";
  }
}
