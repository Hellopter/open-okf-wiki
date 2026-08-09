import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { parseKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type {
  WikiNode,
  WikiNodeHistoryEntry,
  WikiNodeKind,
  WikiNodeMetrics,
  WikiNodeStatus,
  WikiRunSnapshot,
  WikiRunStatus,
} from "./workflow-types.js";

/** The UI reads the durable session snapshot directly; no duplicate view model. */
export type WikiRunView = WikiRunSnapshot;
export type WikiRunNode = WikiNode;
export type { WikiNodeMetrics, WikiNodeStatus, WikiRunStatus } from "./workflow-types.js";

export interface WikiRetryImpact {
  targetId: string;
  preservedUpstream: string[];
  invalidatedDownstream: string[];
  writesWiki: boolean;
  rechecksGit: true;
}

/** Engine adapter. UI owns no workflow state and never edits the workspace. */
export interface WikiNavigatorController {
  getRun(): WikiRunSnapshot | undefined;
  getWorkspace?(): WikiNavigatorWorkspace | undefined;
  subscribe(listener: () => void): () => void;
  retryNode(nodeId: string): Promise<void> | void;
  pause(): Promise<void> | void;
  resume(): Promise<void> | void;
  cancel(): Promise<void> | void;
}

/** Static workspace metadata for the idle console; run state remains in the engine. */
export interface WikiNavigatorWorkspace {
  root: string;
  language: "zh" | "en";
  sources: Array<{ path: string }>;
}

export interface WikiNavigatorTheme {
  fg(color: "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text", text: string): string;
  bold(text: string): string;
}

const PLAIN_THEME: WikiNavigatorTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const STATUS_ICON: Record<WikiNodeStatus, string> = {
  queued: "o",
  running: ">",
  succeeded: "+",
  failed: "x",
  invalidated: "~",
  blocked: "!",
  cancelled: "-",
};

const STATUS_COLOR: Record<WikiNodeStatus, "accent" | "success" | "error" | "warning" | "muted"> = {
  queued: "muted",
  running: "accent",
  succeeded: "success",
  failed: "error",
  invalidated: "muted",
  blocked: "warning",
  cancelled: "muted",
};

export type WikiNavigatorView = "phases" | "agents" | "detail";

export interface WikiPhase {
  id: string;
  title: string;
  nodeIds: string[];
}

export interface WikiNavigatorState {
  view: WikiNavigatorView;
  selectedPhaseId?: string;
  selectedNodeId?: string;
  showHelp: boolean;
  confirmation?: { kind: "retry" | "cancel"; nodeId?: string };
  /** Offset from the selected anchor. `detailFromEnd` makes G/f stable without knowing terminal height. */
  detailScroll: number;
  detailFromEnd: boolean;
  followOutput: boolean;
}

export type WikiNavigatorAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel" }
  | { type: "retry"; nodeId: string }
  | { type: "notify"; message: string; level: "info" | "warning" };

export interface WikiNavigatorTransition {
  state: WikiNavigatorState;
  action: WikiNavigatorAction;
}

/** Two columns when the terminal can support a permanent phase sidebar. */
export function layoutForWidth(width: number): 1 | 2 {
  return width >= 68 ? 2 : 1;
}

export function phaseRows(run: WikiRunView): WikiPhase[] {
  const phases: WikiPhase[] = [];
  for (const node of run.nodes) {
    const previous = phases.at(-1);
    if (previous && phaseKind(previous, run) === node.kind) {
      previous.nodeIds.push(node.id);
      continue;
    }
    phases.push({ id: `phase:${node.id}`, title: stageLabel(node.kind), nodeIds: [node.id] });
  }
  return phases;
}

export function createWikiNavigatorState(run?: WikiRunView): WikiNavigatorState {
  const firstPhase = run ? phaseRows(run)[0] : undefined;
  return {
    view: "phases",
    selectedPhaseId: firstPhase?.id,
    selectedNodeId: firstPhase?.nodeIds[0],
    showHelp: false,
    detailScroll: 0,
    detailFromEnd: false,
    followOutput: true,
  };
}

export function retryImpact(run: WikiRunView, targetId: string): WikiRetryImpact | undefined {
  const target = nodeById(run, targetId);
  if (!target) return undefined;

  const upstream = upstreamIds(run, targetId);
  const downstream = downstreamIds(run, targetId);
  const affected = [targetId, ...downstream];
  return {
    targetId,
    preservedUpstream: [...upstream],
    invalidatedDownstream: [...downstream],
    writesWiki: affected.some((id) => nodeById(run, id)?.kind === "write" || nodeById(run, id)?.kind === "repair"),
    rechecksGit: true,
  };
}

export function reduceWikiNavigator(
  state: WikiNavigatorState,
  key: string | undefined,
  run: WikiRunView | undefined,
): WikiNavigatorTransition {
  const next = ensureSelection({ ...state }, run);
  const action: WikiNavigatorAction = { type: "none" };
  const selected = selectedNode(next, run);

  if (key === "?" || key === "shift+/") {
    next.showHelp = !next.showHelp;
    return { state: next, action };
  }
  if (next.showHelp) {
    if (key === "escape" || key === "esc" || key === "q") next.showHelp = false;
    return { state: next, action };
  }

  if (next.confirmation) {
    if (key === "escape" || key === "esc" || key === "q") {
      delete next.confirmation;
      return { state: next, action };
    }
    if (key === "enter" || key === "return") {
      const confirmation = next.confirmation;
      delete next.confirmation;
      if (confirmation.kind === "retry" && confirmation.nodeId) return { state: next, action: { type: "retry", nodeId: confirmation.nodeId } };
      return { state: next, action: { type: "cancel" } };
    }
    return { state: next, action };
  }

  if (key === "q") return { state: next, action: { type: "close" } };
  if (key === "escape" || key === "esc" || key === "left") return goBack(next);

  if (key === "enter" || key === "return" || key === "right") return drill(next, run);
  if (next.view === "detail" && (key === "up" || key === "k")) return scrollDetail(next, -1);
  if (next.view === "detail" && (key === "down" || key === "j")) return scrollDetail(next, 1);
  if (next.view === "detail" && (key === "pageUp" || key === "ctrl+u" || key === "ctrl+b")) return scrollDetail(next, -12);
  if (next.view === "detail" && (key === "pageDown" || key === "space" || key === "ctrl+d" || key === "ctrl+f")) return scrollDetail(next, 12);
  if (next.view === "detail" && (key === "g" || key === "home")) {
    return { state: { ...next, detailScroll: 0, detailFromEnd: false, followOutput: false }, action };
  }
  if (next.view === "detail" && (key === "G" || key === "shift+g" || key === "end")) {
    return { state: { ...next, detailScroll: 0, detailFromEnd: true, followOutput: true }, action };
  }
  if (next.view === "detail" && key === "f") {
    const followOutput = !next.followOutput;
    return { state: { ...next, followOutput, detailScroll: followOutput ? 0 : next.detailScroll, detailFromEnd: followOutput || next.detailFromEnd }, action };
  }
  if (key === "up" || key === "k") return moveSelection(next, run, -1);
  if (key === "down" || key === "j") return moveSelection(next, run, 1);
  if (key === "g" || key === "home") return selectEdge(next, run, "start");
  if (key === "G" || key === "shift+g" || key === "end") return selectEdge(next, run, "end");
  if (key === "r") {
    if (!selected) return { state: next, action: { type: "notify", message: "Open a phase and select an agent to retry", level: "warning" } };
    if (selected.status === "running" || selected.status === "queued") {
      return { state: next, action: { type: "notify", message: "Wait for the selected agent to settle before retrying", level: "warning" } };
    }
    next.confirmation = { kind: "retry", nodeId: selected.id };
    return { state: next, action };
  }
  if (key === "p") {
    if (!run) return { state: next, action: { type: "notify", message: "No Wiki run is active", level: "info" } };
    if (run.status === "paused") return { state: next, action: { type: "resume" } };
    if (run.status === "running") return { state: next, action: { type: "pause" } };
    return { state: next, action: { type: "notify", message: "Only a running or paused run can be paused", level: "warning" } };
  }
  if (key === "c") {
    if (!run || !isActiveRun(run)) return { state: next, action: { type: "notify", message: "No active Wiki run to cancel", level: "info" } };
    next.confirmation = { kind: "cancel" };
    return { state: next, action };
  }
  return { state: next, action };
}

export function renderWikiNavigator(
  state: WikiNavigatorState,
  run: WikiRunView | undefined,
  width: number,
  theme: WikiNavigatorTheme = PLAIN_THEME,
  viewportRows = 24,
  workspace?: WikiNavigatorWorkspace,
): string[] {
  const safeWidth = Math.max(20, width);
  const safeRows = Math.max(8, viewportRows);
  if (!run) return fitRows(renderIdleWorkspace(safeWidth, theme, workspace), safeRows, safeWidth);

  const normalized = ensureSelection(state, run);
  const header = renderHeader(run, safeWidth, theme);
  const bodyRows = Math.max(4, safeRows - 2);
  if (normalized.showHelp) return fitRows([header, ...renderHelp(safeWidth, theme), footerHint(normalized)], safeRows, safeWidth);
  if (normalized.confirmation) return fitRows([header, ...renderConfirmation(normalized.confirmation, run, safeWidth, theme), footerHint(normalized)], safeRows, safeWidth);

  let body: string[];
  if (normalized.view === "phases") body = renderPhaseChooser(normalized, run, safeWidth, theme, bodyRows);
  else if (normalized.view === "agents") body = renderAgentList(normalized, run, safeWidth, theme, bodyRows);
  else body = renderAgentDetail(normalized, run, safeWidth, theme, bodyRows);
  return fitRows([header, ...body, footerHint(normalized)], safeRows, safeWidth);
}

/** Plain text is also used by /wiki status and non-interactive command output. */
export function renderWikiRunText(run: WikiRunView | undefined): string {
  if (!run) return "Wiki Run: no run in this Pi session.";
  const header = `Wiki Run ${run.id} | ${run.effectiveMode ?? run.requestedMode} | ${run.status} | round ${run.round}`;
  const nodes = run.nodes.map((node) => {
    const error = node.error ? ` | ${firstLine(node.error.message)}` : "";
    return `${STATUS_ICON[node.status]} ${node.label} [${node.status}] attempt ${node.attempt}${error}`;
  });
  const reason = run.blockedReason ? [`Blocked: ${run.blockedReason}`] : [];
  return [header, ...reason, ...nodes].join("\n");
}

/**
 * Opens a bordered, fixed-height Pi overlay. The state reducer above keeps the
 * keyboard navigation testable without a terminal runtime.
 */
export function openWikiRunNavigator(ui: ExtensionUIContext, controller: WikiNavigatorController): Promise<void> {
  return ui.custom<void>((tui: TUI, theme: Theme, _keybindings, done) => {
    let state = createWikiNavigatorState(controller.getRun());
    let closed = false;
    let focused = false;
    const rerender = () => tui.requestRender();
    const unsubscribe = controller.subscribe(() => {
      state = ensureSelection(state, controller.getRun());
      rerender();
    });

    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      done(undefined);
    };
    const runAction = (action: WikiNavigatorAction) => {
      try {
        if (action.type === "close") return close();
        if (action.type === "notify") return ui.notify(action.message, action.level);
        if (action.type === "retry") {
          void Promise.resolve(controller.retryNode(action.nodeId)).then(rerender, (error: unknown) => {
            ui.notify(`Retry failed: ${errorMessage(error)}`, "error");
          });
        }
        if (action.type === "pause") {
          void Promise.resolve(controller.pause()).then(rerender, (error: unknown) => ui.notify(`Pause failed: ${errorMessage(error)}`, "error"));
        }
        if (action.type === "resume") {
          void Promise.resolve(controller.resume()).then(rerender, (error: unknown) => ui.notify(`Resume failed: ${errorMessage(error)}`, "error"));
        }
        if (action.type === "cancel") {
          void Promise.resolve(controller.cancel()).then(rerender, (error: unknown) => ui.notify(`Cancel failed: ${errorMessage(error)}`, "error"));
        }
      } catch (error) {
        ui.notify(`Wiki run action failed: ${errorMessage(error)}`, "error");
      }
    };

    const component: Component & Focusable & { dispose(): void } = {
      get focused(): boolean {
        return focused;
      },
      set focused(value: boolean) {
        focused = value;
      },
      render: (width) => {
        const sideOverhead = 4;
        const innerWidth = Math.max(20, width - sideOverhead);
        const terminalRows = tui.terminal?.rows ?? 24;
        const modalRows = Math.max(8, Math.floor(terminalRows * 0.82));
        const contentRows = Math.max(6, modalRows - 2);
        const raw = renderWikiNavigator(state, controller.getRun(), innerWidth, theme, contentRows, controller.getWorkspace?.());
        const border = (value: string) => theme.fg(focused ? "accent" : "muted", value);
        const title = " wiki workflow ";
        const top = border(`+-${title}${"-".repeat(Math.max(0, innerWidth - title.length + 1))}+`);
        const bottom = border(`+${"-".repeat(Math.max(0, innerWidth + 2))}+`);
        const body = raw.map((line) => {
          const padded = padToWidth(line, innerWidth);
          return border("| ") + padded + border(" |");
        });
        return [top, ...body, bottom];
      },
      handleInput: (data) => {
        const transition = reduceWikiNavigator(state, parseKey(data), controller.getRun());
        state = transition.state;
        runAction(transition.action);
        rerender();
      },
      invalidate: rerender,
      dispose: () => {
        if (!closed) {
          closed = true;
          unsubscribe();
        }
      },
    };
    return component;
  }, { overlay: true, overlayOptions: { width: "88%", minWidth: 68, maxHeight: "82%", anchor: "center", margin: 1 } });
}

function renderIdleWorkspace(width: number, theme: WikiNavigatorTheme, workspace?: WikiNavigatorWorkspace): string[] {
  if (!workspace) return [
    theme.bold("Wiki Workspace"),
    theme.fg("muted", "No workspace.yaml found. Run /wiki init first."),
  ];
  const sources = workspace.sources.length ? workspace.sources.map((source) => source.path).join(", ") : "none";
  return [
    theme.bold("Wiki Workspace"),
    truncateToWidth(`Path: ${workspace.root}`, width, "", true),
    `Language: ${workspace.language === "zh" ? "Chinese" : "English"}`,
    truncateToWidth(`Sources: ${sources}`, width, "", true),
    "",
    theme.fg("muted", "No Wiki run in this Pi session."),
  ];
}

function ensureSelection(state: WikiNavigatorState, run: WikiRunView | undefined): WikiNavigatorState {
  if (!run) return state;
  const phases = phaseRows(run);
  if (!phases.length) return { ...state, view: "phases", selectedPhaseId: undefined, selectedNodeId: undefined };
  const phase = phases.find((item) => item.id === state.selectedPhaseId) ?? phases[0];
  const node = phase && nodeById(run, state.selectedNodeId ?? "") && phase.nodeIds.includes(state.selectedNodeId ?? "")
    ? nodeById(run, state.selectedNodeId ?? "")
    : nodeById(run, phase?.nodeIds[0] ?? "");
  return { ...state, selectedPhaseId: phase?.id, selectedNodeId: node?.id };
}

function selectedPhase(state: WikiNavigatorState, run: WikiRunView | undefined): WikiPhase | undefined {
  return run ? phaseRows(run).find((phase) => phase.id === state.selectedPhaseId) : undefined;
}

function selectedNode(state: WikiNavigatorState, run: WikiRunView | undefined): WikiRunNode | undefined {
  return state.selectedNodeId && run ? nodeById(run, state.selectedNodeId) : undefined;
}

function nodeById(run: WikiRunView, id: string): WikiRunNode | undefined {
  return run.nodes.find((node) => node.id === id);
}

function phaseKind(phase: WikiPhase, run: WikiRunView): WikiRunNode["kind"] | undefined {
  return nodeById(run, phase.nodeIds[0] ?? "")?.kind;
}

function upstreamIds(run: WikiRunView, targetId: string): Set<string> {
  const ids = new Set<string>();
  const visit = (id: string) => {
    for (const dependency of nodeById(run, id)?.dependsOn ?? []) {
      if (ids.has(dependency)) continue;
      ids.add(dependency);
      visit(dependency);
    }
  };
  visit(targetId);
  return ids;
}

function downstreamIds(run: WikiRunView, targetId: string): Set<string> {
  const ids = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of run.nodes) {
      if (ids.has(node.id) || !node.dependsOn.includes(targetId) && !node.dependsOn.some((id) => ids.has(id))) continue;
      ids.add(node.id);
      changed = true;
    }
  }
  // Preserve the run's declared order, not the depth-first traversal order,
  // for predictable retry confirmation and stage rendering.
  return new Set(run.nodes.filter((node) => ids.has(node.id)).map((node) => node.id));
}

function stageLabel(kind: WikiRunNode["kind"]): string {
  switch (kind) {
    case "inspect": return "Inspect";
    case "plan": return "Plan";
    case "research": return "Research";
    case "write": return "Write";
    case "validate": return "Validate";
    case "review": return "Review";
    case "repair": return "Repair";
    case "replan": return "Replan";
  }
}

function drill(state: WikiNavigatorState, run: WikiRunView | undefined): WikiNavigatorTransition {
  if (!run) return { state, action: { type: "none" } };
  if (state.view === "phases") {
    const phase = selectedPhase(state, run);
    return { state: phase ? { ...state, view: "agents", selectedNodeId: phase.nodeIds[0] } : state, action: { type: "none" } };
  }
  if (state.view === "agents") {
    return { state: selectedNode(state, run) ? { ...state, view: "detail", detailScroll: 0, detailFromEnd: false, followOutput: true } : state, action: { type: "none" } };
  }
  return { state, action: { type: "none" } };
}

function goBack(state: WikiNavigatorState): WikiNavigatorTransition {
  if (state.view === "detail") return { state: { ...state, view: "agents", detailScroll: 0, detailFromEnd: false }, action: { type: "none" } };
  if (state.view === "agents") return { state: { ...state, view: "phases" }, action: { type: "none" } };
  return { state, action: { type: "close" } };
}

function moveSelection(state: WikiNavigatorState, run: WikiRunView | undefined, delta: -1 | 1): WikiNavigatorTransition {
  if (!run) return { state, action: { type: "none" } };
  if (state.view === "phases") {
    const phases = phaseRows(run);
    const index = Math.max(0, phases.findIndex((phase) => phase.id === state.selectedPhaseId));
    const phase = phases[(index + delta + phases.length) % phases.length];
    return { state: phase ? { ...state, selectedPhaseId: phase.id, selectedNodeId: phase.nodeIds[0] } : state, action: { type: "none" } };
  }
  const phase = selectedPhase(state, run);
  if (!phase?.nodeIds.length) return { state, action: { type: "none" } };
  const index = Math.max(0, phase.nodeIds.indexOf(state.selectedNodeId ?? ""));
  const id = phase.nodeIds[(index + delta + phase.nodeIds.length) % phase.nodeIds.length];
  return { state: { ...state, selectedNodeId: id, detailScroll: 0, detailFromEnd: false, followOutput: true }, action: { type: "none" } };
}

function selectEdge(state: WikiNavigatorState, run: WikiRunView | undefined, edge: "start" | "end"): WikiNavigatorTransition {
  if (!run) return { state, action: { type: "none" } };
  if (state.view === "phases") {
    const phase = edge === "start" ? phaseRows(run)[0] : phaseRows(run).at(-1);
    return { state: phase ? { ...state, selectedPhaseId: phase.id, selectedNodeId: phase.nodeIds[0] } : state, action: { type: "none" } };
  }
  const phase = selectedPhase(state, run);
  const nodeId = edge === "start" ? phase?.nodeIds[0] : phase?.nodeIds.at(-1);
  return { state: nodeId ? { ...state, selectedNodeId: nodeId, detailScroll: 0, detailFromEnd: false, followOutput: true } : state, action: { type: "none" } };
}

function scrollDetail(state: WikiNavigatorState, delta: number): WikiNavigatorTransition {
  const offset = state.detailFromEnd ? Math.max(0, state.detailScroll - delta) : Math.max(0, state.detailScroll + delta);
  return { state: { ...state, detailScroll: offset, followOutput: false }, action: { type: "none" } };
}

function isActiveRun(run: WikiRunView): boolean {
  return run.status === "running" || run.status === "paused" || run.status === "blocked";
}

function renderHeader(run: WikiRunView, width: number, theme: WikiNavigatorTheme): string {
  const changed = run.inspection?.changedPaths.length ?? 0;
  const progress = `${run.nodes.filter((node) => node.status === "succeeded").length}/${run.nodes.length}`;
  const head = run.inspection?.head ? ` | ${shortHash(run.inspection.head)}` : "";
  return truncateToWidth(theme.bold(`Wiki Run | ${run.effectiveMode ?? run.requestedMode} | ${run.status} | ${progress} agents | ${changed} changed${head}`), width, "", true);
}

function renderPhaseChooser(state: WikiNavigatorState, run: WikiRunView, width: number, theme: WikiNavigatorTheme, rows: number): string[] {
  const phase = selectedPhase(state, run);
  const preview = [theme.bold("Select a phase")];
  if (phase) {
    const agents = phase.nodeIds.map((id) => nodeById(run, id)).filter((node): node is WikiRunNode => Boolean(node));
    preview.push("");
    preview.push(theme.bold(`${phase.title} | ${agents.length} agents`));
    preview.push(...agents.slice(0, Math.max(1, rows - 5)).map((node) => renderNodeRow(node, node.id === state.selectedNodeId, width, theme)));
  } else {
    preview.push(theme.fg("muted", "No phases planned yet."));
  }
  return withSidebar(state, run, width, theme, rows, preview);
}

function renderAgentList(state: WikiNavigatorState, run: WikiRunView, width: number, theme: WikiNavigatorTheme, rows: number): string[] {
  const phase = selectedPhase(state, run);
  if (!phase) return withSidebar(state, run, width, theme, rows, [theme.fg("muted", "No phase selected.")]);
  const agents = phase.nodeIds.map((id) => nodeById(run, id)).filter((node): node is WikiRunNode => Boolean(node));
  const main = [theme.bold(`${phase.title} | ${agents.length} agents`), theme.fg("muted", "Enter opens the selected agent")];
  const window = scrollWindow(agents.length, Math.max(0, agents.findIndex((node) => node.id === state.selectedNodeId)), Math.max(1, rows - main.length));
  for (const node of agents.slice(window.start, window.end)) main.push(renderNodeRow(node, node.id === state.selectedNodeId, width, theme));
  if (window.total > window.end) main.push(theme.fg("dim", `  ${window.end}/${window.total} agents`));
  return withSidebar(state, run, width, theme, rows, main);
}

function renderAgentDetail(state: WikiNavigatorState, run: WikiRunView, width: number, theme: WikiNavigatorTheme, rows: number): string[] {
  const node = selectedNode(state, run);
  if (!node) return withSidebar(state, run, width, theme, rows, [theme.fg("muted", "No agent selected.")]);
  const sidebarWidth = layoutForWidth(width) === 2 ? Math.max(20, Math.min(28, Math.floor(width * 0.30))) : 0;
  const mainWidth = sidebarWidth ? Math.max(20, width - sidebarWidth - 3) : width;
  const content = renderAgentTranscript(node, mainWidth, theme);
  const viewport = Math.max(2, rows - 1);
  const maxScroll = Math.max(0, content.length - viewport);
  const follow = state.followOutput && node.status === "running";
  const scroll = state.detailFromEnd || follow
    ? Math.max(0, maxScroll - Math.min(maxScroll, state.detailScroll))
    : Math.min(state.detailScroll, maxScroll);
  const main = content.slice(scroll, scroll + viewport);
  const range = `${scroll + 1}-${Math.min(scroll + viewport, content.length)}/${content.length}`;
  main.push(theme.fg("dim", `  ${range}${follow ? " follow" : ""}`));
  return withSidebar(state, run, width, theme, rows, main);
}

function withSidebar(
  state: WikiNavigatorState,
  run: WikiRunView,
  width: number,
  theme: WikiNavigatorTheme,
  rows: number,
  main: string[],
): string[] {
  if (layoutForWidth(width) === 1) return fitRows(main, rows, width);
  const sidebarWidth = Math.max(20, Math.min(28, Math.floor(width * 0.30)));
  const mainWidth = Math.max(20, width - sidebarWidth - 3);
  return joinColumns(
    renderSidebar(state, run, sidebarWidth, theme, rows),
    fitRows(main, rows, mainWidth),
    sidebarWidth,
    mainWidth,
    rows,
    theme,
  );
}

function renderSidebar(state: WikiNavigatorState, run: WikiRunView, width: number, theme: WikiNavigatorTheme, rows: number): string[] {
  const phases = phaseRows(run);
  const selected = Math.max(0, phases.findIndex((phase) => phase.id === state.selectedPhaseId));
  const lines = [theme.bold("Phases")];
  const window = scrollWindow(phases.length, selected, Math.max(1, rows - 1));
  for (const phase of phases.slice(window.start, window.end)) {
    const nodes = phase.nodeIds.map((id) => nodeById(run, id)).filter((node): node is WikiRunNode => Boolean(node));
    const status = phaseStatus(nodes);
    const marker = phase.id === state.selectedPhaseId ? ">" : " ";
    const count = `${nodes.filter((node) => node.status === "succeeded").length}/${nodes.length}`;
    lines.push(truncateToWidth(theme.fg(STATUS_COLOR[status], `${marker} ${STATUS_ICON[status]} ${phase.title} ${count}`), width, "", true));
  }
  return fitRows(lines, rows, width);
}

function phaseStatus(nodes: WikiRunNode[]): WikiNodeStatus {
  if (nodes.some((node) => node.status === "running")) return "running";
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.some((node) => node.status === "blocked")) return "blocked";
  if (nodes.some((node) => node.status === "queued")) return "queued";
  if (nodes.some((node) => node.status === "invalidated")) return "invalidated";
  if (nodes.every((node) => node.status === "cancelled")) return "cancelled";
  return "succeeded";
}

function renderNodeRow(node: WikiRunNode, selected: boolean, width: number, theme: WikiNavigatorTheme): string {
  const marker = selected ? ">" : " ";
  const attempt = node.attempt > 1 ? ` #${node.attempt}` : "";
  const activity = node.status === "running" ? ` | ${activityText(node)}` : "";
  return truncateToWidth(theme.fg(STATUS_COLOR[node.status], `${marker} ${STATUS_ICON[node.status]} ${node.label}${attempt}${activity}`), width, "", true);
}

function renderAgentTranscript(node: WikiRunNode, width: number, theme: WikiNavigatorTheme): string[] {
  const lines = [theme.bold(`Agent: ${node.label}`)];
  lines.push(truncateToWidth(theme.fg(STATUS_COLOR[node.status], `${STATUS_ICON[node.status]} ${node.status} | attempt ${node.attempt} | ${stageLabel(node.kind)}`), width, "", true));
  if (node.activity.message || node.activity.state !== "idle") lines.push(truncateToWidth(theme.fg("accent", activityText(node)), width, "", true));
  lines.push("");
  lines.push(theme.bold("Messages & tool calls"));
  if (node.history?.length) {
    for (const entry of node.history) lines.push(...renderHistoryEntry(entry, width, theme));
  } else {
    lines.push(theme.fg("muted", "No completed message or tool call recorded yet."));
  }
  if (node.output) {
    lines.push("");
    lines.push(theme.bold("Latest assistant output"));
    lines.push(...renderObject(node.output, width, theme));
  }
  lines.push("");
  if (node.error) {
    lines.push(theme.bold("Failure"));
    lines.push(...renderObject(`Error: ${node.error.message}`, width, { ...theme, fg: (_color, text) => theme.fg("error", text) }));
    if (node.error.requiredSubmissionTool) {
      lines.push(...renderObject(`Required submission: ${node.error.requiredSubmissionTool}`, width, { ...theme, fg: (_color, text) => theme.fg("warning", text) }));
    }
  } else {
    lines.push(theme.bold(resultLabel(node.kind)));
    lines.push(...renderObject(node.result ?? "No node result recorded.", width, theme));
  }
  lines.push("");
  lines.push(theme.bold("Execution"));
  lines.push(...renderTiming(node, width, theme));
  lines.push(...renderMetrics(node, width, theme));
  return lines;
}

function resultLabel(kind: WikiNodeKind): string {
  if (kind === "research") return "Markdown handoff";
  if (kind === "plan" || kind === "replan" || kind === "review") return "Control submission";
  return "Node result";
}

function renderHistoryEntry(entry: WikiNodeHistoryEntry, width: number, theme: WikiNavigatorTheme): string[] {
  const label = historyLabel(entry);
  const color = entry.isError || entry.kind === "error" ? "error" : entry.kind === "tool_call" ? "accent" : "muted";
  const lines = [truncateToWidth(theme.fg(color, `  ${formatTimestamp(entry.at)} ${label}`), width, "", true)];
  lines.push(...wrapLines(entry.text || "(no text)", Math.max(12, width - 4)).map((line) => truncateToWidth(theme.fg(color, `    ${line}`), width, "", true)));
  return lines;
}

function historyLabel(entry: WikiNodeHistoryEntry): string {
  if (entry.kind === "message") return "assistant";
  if (entry.kind === "tool_call") return `assistant tool ${entry.toolName ?? "call"}`;
  if (entry.kind === "tool_result") return `tool ${entry.toolName ?? "result"}`;
  return entry.toolName ? `tool ${entry.toolName} error` : "agent error";
}

function renderMetrics(node: WikiRunNode, width: number, theme: WikiNavigatorTheme): string[] {
  const metrics = node.metrics;
  const context = formatContext(metrics.contextTokens, metrics.contextWindow, metrics.contextEstimated);
  const usage = [
    metrics.inputTokens !== undefined ? `in ${formatCount(metrics.inputTokens)}` : "",
    metrics.outputTokens !== undefined ? `out ${formatCount(metrics.outputTokens)}` : "",
    metrics.cacheReadTokens !== undefined ? `cache ${formatCount(metrics.cacheReadTokens)}` : "",
  ].filter(Boolean).join(" | ");
  const recovery = [
    metrics.compactions ? `compactions ${metrics.compactions}` : "",
    metrics.autoRetries ? `auto retries ${metrics.autoRetries}` : "",
    node.activity.retryDelayMs ? `backoff ${formatDuration(node.activity.retryDelayMs)}` : "",
  ].filter(Boolean).join(" | ");
  const lines = [
    metrics.model ? `Model: ${metrics.model}` : "",
    context ? `Context: ${context}` : "",
    usage,
    recovery,
    metrics.cost !== undefined ? `Cost: $${metrics.cost.toFixed(4)}` : "",
  ].filter(Boolean);
  return lines.map((line) => truncateToWidth(line, width, "", true));
}

function renderTiming(node: WikiRunNode, width: number, theme: WikiNavigatorTheme): string[] {
  const lines = [
    node.startedAt ? `Started: ${formatTimestamp(node.startedAt)}` : "",
    node.finishedAt ? `Ended: ${formatTimestamp(node.finishedAt)}` : "",
    node.startedAt ? `Duration: ${formatNodeDuration(node.startedAt, node.finishedAt)}` : "",
  ].filter(Boolean);
  return lines.map((line) => truncateToWidth(theme.fg("muted", line), width, "", true));
}

function renderConfirmation(
  confirmation: NonNullable<WikiNavigatorState["confirmation"]>,
  run: WikiRunView,
  width: number,
  theme: WikiNavigatorTheme,
): string[] {
  if (confirmation.kind === "cancel") {
    return [
      theme.bold("Cancel Wiki Run?"),
      theme.fg("warning", "Running agents will be aborted; completed output remains readable."),
      "",
      theme.fg("muted", "Enter confirm | Esc keep running"),
    ].map((line) => truncateToWidth(line, width, "", true));
  }
  const impact = confirmation.nodeId ? retryImpact(run, confirmation.nodeId) : undefined;
  const target = impact ? nodeById(run, impact.targetId) : undefined;
  if (!impact || !target) return [theme.fg("error", "Selected retry target no longer exists.")];
  const preserved = describeNodes(run, impact.preservedUpstream) || "none";
  const rerun = describeNodes(run, [impact.targetId, ...impact.invalidatedDownstream]) || target.label;
  return [
    theme.bold(`Retry ${target.label}?`),
    `Keep upstream: ${preserved}`,
    `Re-run: ${rerun}`,
    "Git: will be re-checked before retry.",
    impact.writesWiki ? theme.fg("warning", "This retry can write wiki/.") : "This retry does not write wiki/ directly.",
    "",
    theme.fg("muted", "Enter confirm | Esc cancel"),
  ].map((line) => truncateToWidth(line, width, "", true));
}

function renderHelp(width: number, theme: WikiNavigatorTheme): string[] {
  return [
    theme.bold("Wiki Run Controls"),
    "Phases: Up/Down or j/k select, Enter opens agents",
    "Agents: Up/Down or j/k select, Enter opens transcript",
    "Detail: j/k arrows or PgUp/PgDn scroll; g/G ends; f follows live output",
    "Esc or Left goes back; q closes; ? closes help",
    "p pause or resume scheduling; c cancel active run; r retry settled agent",
  ].map((line) => truncateToWidth(line, width, "", true));
}

function footerHint(state: WikiNavigatorState): string {
  if (state.view === "detail") return "j/k scroll | PgUp/PgDn page | g/G ends | f follow | Esc back | ? help";
  if (state.view === "agents") return "j/k agents | Enter detail | g/G ends | Esc phases | ? help";
  return "j/k phases | Enter agents | g/G ends | q close | ? help";
}

function joinColumns(
  first: string[],
  second: string[],
  firstWidth: number,
  secondWidth: number,
  rows: number,
  theme: WikiNavigatorTheme,
): string[] {
  const divider = theme.fg("muted", " | ");
  return Array.from({ length: rows }, (_, index) => `${padToWidth(first[index] ?? "", firstWidth)}${divider}${padToWidth(second[index] ?? "", secondWidth)}`);
}

function scrollWindow(total: number, active: number, cap: number): { start: number; end: number; total: number } {
  if (total <= cap) return { start: 0, end: total, total };
  const start = Math.max(0, Math.min(active - Math.floor(cap / 2), total - cap));
  return { start, end: start + cap, total };
}

function fitRows(lines: string[], rows: number, width: number): string[] {
  return [...lines.slice(0, rows).map((line) => truncateToWidth(line, width, "", true)), ...Array.from({ length: Math.max(0, rows - lines.length) }, () => "")];
}

function padToWidth(value: string, width: number): string {
  const truncated = truncateToWidth(value, Math.max(1, width), "", true);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function renderObject(value: unknown, width: number, theme: WikiNavigatorTheme): string[] {
  const text = typeof value === "string" ? value : safeJson(value);
  return wrapLines(text, width).map((line) => truncateToWidth(theme.fg("muted", line), width, "", true));
}

function wrapLines(value: string, width: number): string[] {
  const limit = Math.max(12, width);
  const lines: string[] = [];
  for (const original of value.split("\n")) {
    let rest = original || " ";
    while (visibleWidth(rest) > limit) {
      let split = rest.lastIndexOf(" ", limit);
      if (split < Math.floor(limit / 2)) split = limit;
      lines.push(rest.slice(0, split));
      rest = rest.slice(split).trimStart() || " ";
    }
    lines.push(rest);
  }
  return lines;
}

function describeNodes(run: WikiRunView, ids: string[]): string {
  return ids.map((id) => nodeById(run, id)?.label ?? id).join(", ");
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
}

function activityText(node: WikiRunNode): string {
  const activity = node.activity;
  const label = activity.message || activity.state;
  if (activity.state !== "retrying") return label;
  const attempt = activity.retryAttempt && activity.retryMaxAttempts ? ` ${activity.retryAttempt}/${activity.retryMaxAttempts}` : "";
  const delay = activity.retryDelayMs ? ` in ${formatDuration(activity.retryDelayMs)}` : "";
  return `${label}${attempt}${delay}`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatContext(
  current: number | null | undefined,
  maximum: number | null | undefined,
  estimated = false,
): string | undefined {
  if (current === undefined || current === null || maximum === undefined || maximum === null || maximum <= 0) return undefined;
  const percent = Math.round((current / maximum) * 100);
  return `${formatCount(current)} / ${formatCount(maximum)} (${percent}%)${estimated ? " estimated" : ""}`;
}

function formatDuration(milliseconds: number): string {
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)}s` : `${milliseconds}ms`;
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", "Z");
}

function formatNodeDuration(startedAt: string, finishedAt: string | undefined): string {
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "unknown";
  return formatDuration(Math.max(0, end - start));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
