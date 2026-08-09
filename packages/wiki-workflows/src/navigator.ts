import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { parseKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type {
  WikiNode,
  WikiNodeHistoryEntry,
  WikiNodeKind,
  WikiNodeMetrics,
  WikiNodeStatus,
  WikiRunSnapshot,
  WikiRunSummary,
  WikiRunStatus,
} from "./workflow-types.js";

/** The UI reads the durable session snapshot directly; no duplicate view model. */
export type WikiRunView = WikiRunSnapshot;
export type WikiRunNode = WikiNode;
export type { WikiNodeMetrics, WikiNodeStatus, WikiRunStatus } from "./workflow-types.js";

export interface WikiRetryImpact {
  targetId: string;
  targetIds: string[];
  phaseId?: string;
  preservedUpstream: string[];
  invalidatedDownstream: string[];
  writesWiki: boolean;
  rechecksGit: true;
}

/** Engine adapter. UI owns no workflow state and never edits the workspace. */
export interface WikiNavigatorController {
  listRuns(): WikiRunSummary[];
  getRun(runId?: string): WikiRunSnapshot | undefined;
  loadRun(runId: string): Promise<WikiRunSnapshot | undefined>;
  getActiveRunId(): string | undefined;
  getWorkspace?(): WikiNavigatorWorkspace | undefined;
  subscribe(listener: () => void): () => void;
  retryNode(runId: string, nodeId: string): Promise<WikiRunSnapshot | undefined> | WikiRunSnapshot | undefined;
  retryPhase(runId: string, phaseId: string): Promise<WikiRunSnapshot | undefined> | WikiRunSnapshot | undefined;
  deleteRun(runId: string): Promise<void> | void;
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
  fg(color: "accent" | "borderMuted" | "success" | "error" | "warning" | "muted" | "dim" | "text", text: string): string;
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

export type WikiNavigatorView = "runs" | "phases" | "agents" | "detail";

export interface WikiPhase {
  id: string;
  title: string;
  nodeIds: string[];
}

export interface WikiNavigatorState {
  view: WikiNavigatorView;
  selectedRunId?: string;
  selectedPhaseId?: string;
  selectedNodeId?: string;
  showHelp: boolean;
  detailExpanded: boolean;
  selectedAttempt?: number;
  confirmation?: { kind: "retry" | "retryPhase" | "cancel" | "delete"; nodeId?: string; phaseId?: string; runId?: string };
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
  | { type: "loadRun"; runId: string }
  | { type: "retry"; runId: string; nodeId: string }
  | { type: "retryPhase"; runId: string; phaseId: string }
  | { type: "deleteRun"; runId: string }
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
    if (node.phaseId) {
      const explicit = phases.find((phase) => phase.id === node.phaseId);
      if (explicit) {
        explicit.nodeIds.push(node.id);
        continue;
      }
      phases.push({ id: node.phaseId, title: node.phaseTitle ?? stageLabel(node.kind), nodeIds: [node.id] });
      continue;
    }
    if (previous && phaseKind(previous, run) === node.kind) {
      previous.nodeIds.push(node.id);
      continue;
    }
    phases.push({ id: `phase:${node.id}`, title: stageLabel(node.kind), nodeIds: [node.id] });
  }
  return phases;
}

export function createWikiNavigatorState(run?: WikiRunView, runs: WikiRunSummary[] = []): WikiNavigatorState {
  const firstPhase = run ? phaseRows(run)[0] : undefined;
  return {
    view: "runs",
    selectedRunId: run?.id ?? runs[0]?.id,
    selectedPhaseId: firstPhase?.id,
    selectedNodeId: firstPhase?.nodeIds[0],
    showHelp: false,
    detailExpanded: false,
    detailScroll: 0,
    detailFromEnd: false,
    followOutput: true,
  };
}

export function retryImpact(run: WikiRunView, targetId: string): WikiRetryImpact | undefined {
  const target = nodeById(run, targetId);
  if (!target) return undefined;
  return retryImpactFor(run, [targetId], targetId);
}

export function phaseRetryImpact(run: WikiRunView, phaseId: string): WikiRetryImpact | undefined {
  const phase = phaseRows(run).find((item) => item.id === phaseId);
  if (!phase?.nodeIds.length) return undefined;
  return retryImpactFor(run, phase.nodeIds, phase.nodeIds[0]!, phaseId);
}

function retryImpactFor(run: WikiRunView, targetIds: string[], targetId: string, phaseId?: string): WikiRetryImpact {
  const targetSet = new Set(targetIds);
  const upstream = new Set<string>();
  for (const id of targetIds) for (const upstreamId of upstreamIds(run, id)) upstream.add(upstreamId);
  const downstream = downstreamIds(run, targetIds);
  const affected = [...targetIds, ...downstream];
  return {
    targetId,
    targetIds,
    phaseId,
    preservedUpstream: [...upstream].filter((id) => !targetSet.has(id)),
    invalidatedDownstream: [...downstream],
    writesWiki: affected.some((id) => nodeById(run, id)?.kind === "write" || nodeById(run, id)?.kind === "repair"),
    rechecksGit: true,
  };
}

export function reduceWikiNavigator(
  state: WikiNavigatorState,
  key: string | undefined,
  run: WikiRunView | undefined,
  runs: WikiRunSummary[] = [],
  activeRunId?: string,
): WikiNavigatorTransition {
  const next = ensureSelection({ ...state }, run, runs);
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
      if (confirmation.kind === "retry" && confirmation.nodeId && next.selectedRunId) {
        return { state: next, action: { type: "retry", runId: next.selectedRunId, nodeId: confirmation.nodeId } };
      }
      if (confirmation.kind === "retryPhase" && confirmation.phaseId && next.selectedRunId) {
        return { state: next, action: { type: "retryPhase", runId: next.selectedRunId, phaseId: confirmation.phaseId } };
      }
      if (confirmation.kind === "delete" && confirmation.runId) {
        return { state: next, action: { type: "deleteRun", runId: confirmation.runId } };
      }
      return { state: next, action: { type: "cancel" } };
    }
    return { state: next, action };
  }

  if (key === "q") return { state: next, action: { type: "close" } };
  if (key === "escape" || key === "esc" || key === "left") return goBack(next);

  if (key === "enter" || key === "return" || key === "right") {
    if (next.view === "runs" && next.selectedRunId) {
      return { state: { ...next, view: "phases" }, action: { type: "loadRun", runId: next.selectedRunId } };
    }
    if (next.view === "detail") return { state: { ...next, detailExpanded: !next.detailExpanded }, action };
    return drill(next, run);
  }
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
  if (next.view === "detail" && (key === "[" || key === "]")) {
    const attempts = [...new Set([...(selected?.attemptHistory ?? []).map((item) => item.attempt), selected?.attempt ?? 0])]
      .filter((attempt) => attempt > 0)
      .sort((left, right) => left - right);
    if (attempts.length < 2) return { state: next, action };
    const current = attempts.indexOf(next.selectedAttempt ?? selected?.attempt ?? attempts.at(-1)!);
    const selectedAttempt = attempts[Math.max(0, Math.min(attempts.length - 1, current + (key === "[" ? -1 : 1)))];
    return { state: { ...next, selectedAttempt }, action };
  }
  if (key === "up" || key === "k") return moveSelection(next, run, runs, -1);
  if (key === "down" || key === "j") return moveSelection(next, run, runs, 1);
  if (key === "g" || key === "home") return selectEdge(next, run, runs, "start");
  if (key === "G" || key === "shift+g" || key === "end") return selectEdge(next, run, runs, "end");
  if (key === "r") {
    if (!selected) return { state: next, action: { type: "notify", message: "Open a phase and select an agent to retry", level: "warning" } };
    if (selected.status === "running" || selected.status === "queued") {
      return { state: next, action: { type: "notify", message: "Wait for the selected agent to settle before retrying", level: "warning" } };
    }
    next.confirmation = { kind: "retry", nodeId: selected.id };
    return { state: next, action };
  }
  if (key === "R" || key === "shift+r") {
    if (next.view !== "phases" || !run || !next.selectedPhaseId) {
      return { state: next, action: { type: "notify", message: "Select a phase before retrying it", level: "warning" } };
    }
    const phase = selectedPhase(next, run);
    const nodes = phase?.nodeIds.map((id) => nodeById(run, id)).filter((node): node is WikiRunNode => Boolean(node)) ?? [];
    if (nodes.some((node) => node.status === "running")) {
      return { state: next, action: { type: "notify", message: "Wait for running agents in the selected phase to settle before retrying it", level: "warning" } };
    }
    next.confirmation = { kind: "retryPhase", phaseId: next.selectedPhaseId };
    return { state: next, action };
  }
  if (key === "p") {
    if (!run || next.selectedRunId !== activeRunId) return { state: next, action: { type: "notify", message: "Select the active Wiki run to pause or resume", level: "info" } };
    if (run.status === "paused") return { state: next, action: { type: "resume" } };
    if (run.status === "running") return { state: next, action: { type: "pause" } };
    return { state: next, action: { type: "notify", message: "Only a running or paused run can be paused", level: "warning" } };
  }
  if (key === "c") {
    if (!run || next.selectedRunId !== activeRunId || !isActiveRun(run)) return { state: next, action: { type: "notify", message: "No active Wiki run to cancel", level: "info" } };
    next.confirmation = { kind: "cancel" };
    return { state: next, action };
  }
  if (key === "x") {
    if (next.view !== "runs") {
      return { state: next, action: { type: "notify", message: "Return to the Wiki run list to delete history", level: "info" } };
    }
    const selectedRun = runs.find((item) => item.id === next.selectedRunId);
    if (!selectedRun || selectedRun.id === activeRunId || !isTerminalRun(selectedRun.status)) {
      return { state: next, action: { type: "notify", message: "Only inactive completed history can be deleted", level: "warning" } };
    }
    next.confirmation = { kind: "delete", runId: selectedRun.id };
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
  runs: WikiRunSummary[] = run ? [summarizeRun(run)] : [],
  activeRunId?: string,
): string[] {
  const safeWidth = Math.max(20, width);
  const safeRows = Math.max(8, viewportRows);
  const normalized = ensureSelection(state, run, runs);
  if (normalized.view === "runs") {
    if (normalized.showHelp) return fitRows([theme.bold("Wiki Run Controls"), ...renderHelp(safeWidth, theme), footerHint(normalized)], safeRows, safeWidth);
    if (normalized.confirmation) return fitRows([...renderConfirmation(normalized.confirmation, run, safeWidth, theme), footerHint(normalized)], safeRows, safeWidth);
    return fitRows(renderRuns(normalized, runs, activeRunId, safeWidth, theme, safeRows - 1).concat(footerHint(normalized)), safeRows, safeWidth);
  }
  if (!run) return fitRows(renderLoadingWorkspace(safeWidth, theme, workspace), safeRows, safeWidth);

  const header = renderHeader(run, safeWidth, theme);
  const bodyRows = Math.max(4, safeRows - header.length - 1);
  if (normalized.showHelp) return fitRows([...header, ...renderHelp(safeWidth, theme), footerHint(normalized)], safeRows, safeWidth);
  if (normalized.confirmation) return fitRows([...header, ...renderConfirmation(normalized.confirmation, run, safeWidth, theme), footerHint(normalized)], safeRows, safeWidth);

  let body: string[];
  if (normalized.view === "phases") body = renderPhaseChooser(normalized, run, safeWidth, theme, bodyRows);
  else if (normalized.view === "agents") body = renderAgentList(normalized, run, safeWidth, theme, bodyRows);
  else body = renderAgentDetail(normalized, run, safeWidth, theme, bodyRows);
  return fitRows([...header, ...body, footerHint(normalized)], safeRows, safeWidth);
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

/** Non-interactive history stays concise; selection and full detail belong in the TUI. */
export function renderWikiRunHistoryText(runs: WikiRunSummary[]): string {
  if (!runs.length) return "Wiki History: no runs for this project.";
  return ["Wiki History", ...runs.map((run) => {
    const focus = run.focus ? ` | ${run.focus}` : "";
    const fork = run.parentRunId ? " | fork" : "";
    return `${formatTimestamp(run.updatedAt)} | ${run.effectiveMode ?? run.requestedMode} | ${run.status} | ${run.succeededNodes}/${run.totalNodes}${fork}${focus}`;
  })].join("\n");
}

/**
 * Opens a bordered, fixed-height Pi overlay. The state reducer above keeps the
 * keyboard navigation testable without a terminal runtime.
 */
export function openWikiRunNavigator(ui: ExtensionUIContext, controller: WikiNavigatorController): Promise<void> {
  return ui.custom<void>((tui: TUI, theme: Theme, _keybindings, done) => {
    let state = createWikiNavigatorState(controller.getRun(controller.getActiveRunId()), controller.listRuns());
    let closed = false;
    let focused = false;
    const rerender = () => tui.requestRender();
    const unsubscribe = controller.subscribe(() => {
      state = ensureSelection(state, controller.getRun(state.selectedRunId), controller.listRuns());
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
        if (action.type === "loadRun") {
          void controller.loadRun(action.runId).then((loaded) => {
            if (!loaded) return ui.notify("Wiki run history is unavailable", "warning");
            const firstPhase = phaseRows(loaded)[0];
            state = { ...state, view: "phases", selectedRunId: loaded.id, selectedPhaseId: firstPhase?.id, selectedNodeId: firstPhase?.nodeIds[0], detailExpanded: false, selectedAttempt: undefined };
            rerender();
          }, (error: unknown) => ui.notify(`Could not load Wiki history: ${errorMessage(error)}`, "error"));
        }
        if (action.type === "retry") {
          void Promise.resolve(controller.retryNode(action.runId, action.nodeId)).then((snapshot) => {
            if (snapshot) {
              const firstPhase = phaseRows(snapshot)[0];
              state = { ...state, view: "phases", selectedRunId: snapshot.id, selectedPhaseId: firstPhase?.id, selectedNodeId: firstPhase?.nodeIds[0], detailExpanded: false, selectedAttempt: undefined };
            }
            rerender();
          }, (error: unknown) => ui.notify(`Retry failed: ${errorMessage(error)}`, "error"));
        }
        if (action.type === "retryPhase") {
          void Promise.resolve(controller.retryPhase(action.runId, action.phaseId)).then((snapshot) => {
            if (snapshot) {
              const firstPhase = phaseRows(snapshot)[0];
              state = { ...state, view: "phases", selectedRunId: snapshot.id, selectedPhaseId: firstPhase?.id, selectedNodeId: firstPhase?.nodeIds[0], detailExpanded: false, selectedAttempt: undefined };
            }
            rerender();
          }, (error: unknown) => ui.notify(`Phase retry failed: ${errorMessage(error)}`, "error"));
        }
        if (action.type === "deleteRun") {
          void Promise.resolve(controller.deleteRun(action.runId)).then(() => {
            state = ensureSelection({ ...state, selectedRunId: undefined }, controller.getRun(), controller.listRuns());
            rerender();
          }, (error: unknown) => ui.notify(`Delete failed: ${errorMessage(error)}`, "error"));
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
        const modalRows = Math.max(8, Math.floor(terminalRows * 0.92));
        const contentRows = Math.max(6, modalRows - 2);
        const raw = renderWikiNavigator(state, controller.getRun(state.selectedRunId), innerWidth, theme, contentRows, controller.getWorkspace?.(), controller.listRuns(), controller.getActiveRunId());
        const border = (value: string) => theme.fg(focused ? "accent" : "borderMuted", value);
        const title = " wiki workflow ";
        const top = border(`╭─${title}${"─".repeat(Math.max(0, innerWidth - visibleWidth(title) + 1))}╮`);
        const bottom = border(`╰${"─".repeat(Math.max(0, innerWidth + 2))}╯`);
        const body = raw.map((line) => {
          const padded = padToWidth(line, innerWidth);
          return border("│ ") + padded + border(" │");
        });
        return [top, ...body, bottom];
      },
      handleInput: (data) => {
        const transition = reduceWikiNavigator(state, parseKey(data), controller.getRun(state.selectedRunId), controller.listRuns(), controller.getActiveRunId());
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
  }, { overlay: true, overlayOptions: { width: "88%", minWidth: 68, maxHeight: "92%", anchor: "center", margin: 1 } });
}

function renderLoadingWorkspace(width: number, theme: WikiNavigatorTheme, workspace?: WikiNavigatorWorkspace): string[] {
  if (!workspace) return [
    theme.bold("Loading Wiki run"),
    theme.fg("muted", "The selected history is being loaded."),
  ];
  const sources = workspace.sources.length ? workspace.sources.map((source) => source.path).join(", ") : "none";
  return [
    theme.bold("Loading Wiki run"),
    truncateToWidth(`Path: ${workspace.root}`, width, "", true),
    `Language: ${workspace.language === "zh" ? "Chinese" : "English"}`,
    truncateToWidth(`Sources: ${sources}`, width, "", true),
    "",
    theme.fg("muted", "The selected history is being loaded."),
  ];
}

function ensureSelection(state: WikiNavigatorState, run: WikiRunView | undefined, runs: WikiRunSummary[] = []): WikiNavigatorState {
  const selectedRunId = runs.some((item) => item.id === state.selectedRunId)
    ? state.selectedRunId
    : run?.id ?? runs[0]?.id;
  if (state.view === "runs") return { ...state, selectedRunId };
  if (!run) return { ...state, selectedRunId };
  const phases = phaseRows(run);
  if (!phases.length) return { ...state, selectedRunId: run.id, view: "phases", selectedPhaseId: undefined, selectedNodeId: undefined };
  const phase = phases.find((item) => item.id === state.selectedPhaseId) ?? phases[0];
  const node = phase && nodeById(run, state.selectedNodeId ?? "") && phase.nodeIds.includes(state.selectedNodeId ?? "")
    ? nodeById(run, state.selectedNodeId ?? "")
    : nodeById(run, phase?.nodeIds[0] ?? "");
  return { ...state, selectedRunId: run.id, selectedPhaseId: phase?.id, selectedNodeId: node?.id };
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

function downstreamIds(run: WikiRunView, targetIds: string[]): Set<string> {
  const ids = new Set<string>(targetIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of run.nodes) {
      if (ids.has(node.id) || !node.dependsOn.some((id) => ids.has(id))) continue;
      ids.add(node.id);
      changed = true;
    }
  }
  // Preserve the run's declared order, not the depth-first traversal order,
  // for predictable retry confirmation and stage rendering.
  return new Set(run.nodes.filter((node) => ids.has(node.id) && !targetIds.includes(node.id)).map((node) => node.id));
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
    return { state: phase ? { ...state, view: "agents", selectedNodeId: phase.nodeIds[0], detailExpanded: false, selectedAttempt: undefined } : state, action: { type: "none" } };
  }
  if (state.view === "agents") {
    return { state: selectedNode(state, run) ? { ...state, view: "detail", detailScroll: 0, detailFromEnd: false, followOutput: true, detailExpanded: false, selectedAttempt: undefined } : state, action: { type: "none" } };
  }
  return { state, action: { type: "none" } };
}

function goBack(state: WikiNavigatorState): WikiNavigatorTransition {
  if (state.view === "detail") return { state: { ...state, view: "agents", detailScroll: 0, detailFromEnd: false, detailExpanded: false, selectedAttempt: undefined }, action: { type: "none" } };
  if (state.view === "agents") return { state: { ...state, view: "phases" }, action: { type: "none" } };
  if (state.view === "phases") return { state: { ...state, view: "runs", selectedPhaseId: undefined, selectedNodeId: undefined }, action: { type: "none" } };
  return { state, action: { type: "close" } };
}

function moveSelection(state: WikiNavigatorState, run: WikiRunView | undefined, runs: WikiRunSummary[], delta: -1 | 1): WikiNavigatorTransition {
  if (state.view === "runs") {
    if (!runs.length) return { state, action: { type: "none" } };
    const index = Math.max(0, runs.findIndex((item) => item.id === state.selectedRunId));
    const item = runs[(index + delta + runs.length) % runs.length];
    return { state: item ? { ...state, selectedRunId: item.id } : state, action: { type: "none" } };
  }
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

function selectEdge(state: WikiNavigatorState, run: WikiRunView | undefined, runs: WikiRunSummary[], edge: "start" | "end"): WikiNavigatorTransition {
  if (state.view === "runs") {
    const item = edge === "start" ? runs[0] : runs.at(-1);
    return { state: item ? { ...state, selectedRunId: item.id } : state, action: { type: "none" } };
  }
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

function isTerminalRun(status: WikiRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "blocked" || status === "cancelled";
}

function runStatusIcon(status: WikiRunStatus): string {
  if (status === "paused") return "‖";
  return STATUS_ICON[status];
}

function runStatusColor(status: WikiRunStatus): "accent" | "success" | "error" | "warning" | "muted" {
  if (status === "paused") return "warning";
  return STATUS_COLOR[status];
}

function summarizeRun(run: WikiRunView): WikiRunSummary {
  return {
    id: run.id,
    cwd: run.cwd,
    requestedMode: run.requestedMode,
    effectiveMode: run.effectiveMode,
    focus: run.focus,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    parentRunId: run.parentRunId,
    head: run.inspection?.head,
    changedPaths: run.inspection?.changedPaths.length ?? 0,
    totalNodes: run.nodes.length,
    succeededNodes: run.nodes.filter((node) => node.status === "succeeded").length,
    failedNodes: run.nodes.filter((node) => node.status === "failed" || node.status === "blocked").length,
  };
}

function renderHeader(run: WikiRunView, width: number, theme: WikiNavigatorTheme): string[] {
  const changed = run.inspection?.changedPaths.length ?? 0;
  const progress = `${run.nodes.filter((node) => node.status === "succeeded").length}/${run.nodes.length}`;
  const head = run.inspection?.head ? ` | ${shortHash(run.inspection.head)}` : "";
  const title = truncateToWidth(`${run.effectiveMode ?? run.requestedMode} Wiki run${run.parentRunId ? " (fork)" : ""}`, width, "", true);
  const detail = `${run.status}  ${progress} agents | ${changed} changed${head}`;
  return [
    theme.fg("accent", theme.bold(title)),
    truncateToWidth(theme.fg("dim", detail), width, "", true),
  ];
}

function renderRuns(
  state: WikiNavigatorState,
  runs: WikiRunSummary[],
  activeRunId: string | undefined,
  width: number,
  theme: WikiNavigatorTheme,
  rows: number,
): string[] {
  const lines = [theme.fg("accent", theme.bold("Wiki Runs"))];
  if (!runs.length) {
    lines.push(theme.fg("muted", "No Wiki generation history yet."));
    return lines;
  }
  const selected = Math.max(0, runs.findIndex((item) => item.id === state.selectedRunId));
  const window = scrollWindow(runs.length, selected, Math.max(1, rows - 1));
  for (const run of runs.slice(window.start, window.end)) {
    const active = run.id === activeRunId ? " active" : "";
    const parent = run.parentRunId ? " fork" : "";
    const marker = run.id === state.selectedRunId ? "›" : " ";
    const icon = runStatusIcon(run.status);
    const metadata = `${run.effectiveMode ?? run.requestedMode}${parent}${active} | ${run.succeededNodes}/${run.totalNodes} | ${formatTimestamp(run.updatedAt)}`;
    const title = truncateToWidth(run.focus || "Wiki generation", Math.max(12, width - visibleWidth(metadata) - 7), "…", false);
    const primary = `${marker} ${icon} ${title}`;
    lines.push(truncateToWidth(
      run.id === state.selectedRunId
        ? theme.fg("accent", theme.bold(`${primary}  ${metadata}`))
        : `${marker} ${theme.fg(runStatusColor(run.status), icon)} ${title}  ${theme.fg("dim", metadata)}`,
      width,
      "",
      true,
    ));
  }
  if (window.total > window.end) lines.push(theme.fg("dim", `  ${window.end}/${window.total} runs`));
  return lines;
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
  const content = renderAgentTranscript(state, node, mainWidth, theme);
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
    const marker = phase.id === state.selectedPhaseId ? "›" : " ";
    const count = `${nodes.filter((node) => node.status === "succeeded").length}/${nodes.length}`;
    const text = `${marker} ${STATUS_ICON[status]} ${phase.title} ${count}`;
    lines.push(truncateToWidth(
      phase.id === state.selectedPhaseId
        ? theme.fg("accent", theme.bold(text))
        : `${theme.fg(STATUS_COLOR[status], STATUS_ICON[status])}${text.slice(2)}`,
      width,
      "",
      true,
    ));
  }
  return fitRows(lines, rows, width);
}

function phaseStatus(nodes: WikiRunNode[]): WikiNodeStatus {
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.some((node) => node.status === "blocked")) return "blocked";
  if (nodes.some((node) => node.status === "running")) return "running";
  if (nodes.some((node) => node.status === "queued")) return "queued";
  if (nodes.some((node) => node.status === "invalidated")) return "invalidated";
  if (nodes.every((node) => node.status === "cancelled")) return "cancelled";
  return "succeeded";
}

function renderNodeRow(node: WikiRunNode, selected: boolean, width: number, theme: WikiNavigatorTheme): string {
  const marker = selected ? "›" : " ";
  const attempt = node.attempt > 1 ? ` #${node.attempt}` : "";
  const activity = node.status === "running" ? ` | ${activityText(node)}` : "";
  const text = `${marker} ${STATUS_ICON[node.status]} ${node.label}${attempt}${activity}`;
  return truncateToWidth(
    selected
      ? theme.fg("accent", theme.bold(text))
      : `${text.slice(0, 2)}${theme.fg(STATUS_COLOR[node.status], STATUS_ICON[node.status])}${text.slice(3)}`,
    width,
    "",
    true,
  );
}

function renderAgentTranscript(state: WikiNavigatorState, node: WikiRunNode, width: number, theme: WikiNavigatorTheme): string[] {
  const attempt = attemptView(node, state.selectedAttempt);
  const attemptSuffix = attempt.attempt !== node.attempt ? " (archived)" : "";
  const lines = [theme.bold(`Agent: ${node.label}`)];
  lines.push(truncateToWidth(theme.fg(STATUS_COLOR[node.status], `${STATUS_ICON[node.status]} ${node.status} | attempt ${attempt.attempt}${attemptSuffix} | ${stageLabel(node.kind)}`), width, "", true));
  if (node.activity.message || node.activity.state !== "idle") lines.push(truncateToWidth(theme.fg("accent", activityText(node)), width, "", true));
  lines.push("");
  lines.push(theme.bold(`Messages & tool calls${state.detailExpanded ? " (raw)" : ""}`));
  if (attempt.history?.length) {
    for (const entry of attempt.history) lines.push(...renderHistoryEntry(entry, width, theme, state.detailExpanded));
  } else {
    lines.push(theme.fg("muted", "No completed message or tool call recorded yet."));
  }
  if (attempt.output) {
    lines.push("");
    lines.push(theme.bold("Latest assistant output"));
    lines.push(...renderObject(attempt.output, width, theme));
  }
  lines.push("");
  if (attempt.error) {
    lines.push(theme.bold("Failure"));
    lines.push(...renderObject(`Error: ${attempt.error.message}`, width, { ...theme, fg: (_color, text) => theme.fg("error", text) }));
    if (attempt.error.requiredSubmissionTool) {
      lines.push(...renderObject(`Required submission: ${attempt.error.requiredSubmissionTool}`, width, { ...theme, fg: (_color, text) => theme.fg("warning", text) }));
    }
  } else {
    lines.push(theme.bold(resultLabel(node.kind)));
    lines.push(...renderObject(attempt.result ?? "No node result recorded.", width, theme));
  }
  lines.push("");
  lines.push(theme.bold("Execution"));
  lines.push(...renderTiming(attempt, width, theme));
  lines.push(...renderMetrics(attempt, width, theme));
  return lines;
}

function resultLabel(kind: WikiNodeKind): string {
  if (kind === "research") return "Markdown handoff";
  if (kind === "plan" || kind === "replan" || kind === "review") return "Control submission";
  return "Node result";
}

function renderHistoryEntry(entry: WikiNodeHistoryEntry, width: number, theme: WikiNavigatorTheme, expanded: boolean): string[] {
  const label = historyLabel(entry);
  const color = entry.isError || entry.kind === "error" ? "error" : entry.kind === "tool_call" ? "accent" : "muted";
  const lines = [truncateToWidth(theme.fg(color, `  ${formatTimestamp(entry.at)} ${label}`), width, "", true)];
  const text = expanded || entry.kind === "message" || entry.kind === "error"
    ? entry.text || "(no text)"
    : historySummary(entry);
  lines.push(...wrapLines(text, Math.max(12, width - 4)).map((line) => truncateToWidth(theme.fg(color, `    ${line}`), width, "", true)));
  return lines;
}

function historyLabel(entry: WikiNodeHistoryEntry): string {
  const target = entry.target ? ` ${entry.target}` : "";
  if (entry.kind === "message") return "assistant";
  if (entry.kind === "tool_call") return `assistant tool ${entry.toolName ?? "call"}${target}`;
  if (entry.kind === "tool_result") return `tool ${entry.toolName ?? "result"}${target}`;
  return entry.toolName ? `tool ${entry.toolName} error${target}` : "agent error";
}

function historySummary(entry: WikiNodeHistoryEntry): string {
  if (entry.summary) return entry.summary;
  if (entry.kind === "tool_call") return "Running";
  if (entry.target) return "Completed";
  return entry.isError ? "Tool failed" : "Completed";
}

type WikiAttemptView = Pick<WikiRunNode, "attempt" | "startedAt" | "finishedAt" | "result" | "output" | "history" | "error" | "metrics">;

function attemptView(node: WikiRunNode, selectedAttempt: number | undefined): WikiAttemptView {
  if (selectedAttempt !== undefined && selectedAttempt !== node.attempt) {
    const archived = (node.attemptHistory ?? []).find((item) => item.attempt === selectedAttempt);
    if (archived) return archived;
  }
  return node;
}

function renderMetrics(node: Pick<WikiRunNode, "metrics"> & Partial<Pick<WikiRunNode, "activity">>, width: number, theme: WikiNavigatorTheme): string[] {
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
    node.activity?.retryDelayMs ? `backoff ${formatDuration(node.activity.retryDelayMs)}` : "",
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

function renderTiming(node: Pick<WikiRunNode, "startedAt" | "finishedAt">, width: number, theme: WikiNavigatorTheme): string[] {
  const lines = [
    node.startedAt ? `Started: ${formatTimestamp(node.startedAt)}` : "",
    node.finishedAt ? `Ended: ${formatTimestamp(node.finishedAt)}` : "",
    node.startedAt ? `Duration: ${formatNodeDuration(node.startedAt, node.finishedAt)}` : "",
  ].filter(Boolean);
  return lines.map((line) => truncateToWidth(theme.fg("muted", line), width, "", true));
}

function renderConfirmation(
  confirmation: NonNullable<WikiNavigatorState["confirmation"]>,
  run: WikiRunView | undefined,
  width: number,
  theme: WikiNavigatorTheme,
): string[] {
  if (confirmation.kind === "delete") {
    return [
      theme.bold("Delete Wiki History?"),
      theme.fg("warning", "The saved run record will be removed. Git files and generated Wiki pages are unchanged."),
      "",
      theme.fg("muted", "Enter delete | Esc keep history"),
    ].map((line) => truncateToWidth(line, width, "", true));
  }
  if (confirmation.kind === "cancel") {
    return [
      theme.bold("Cancel Wiki Run?"),
      theme.fg("warning", "Running agents will be aborted; completed output remains readable."),
      "",
      theme.fg("muted", "Enter confirm | Esc keep running"),
    ].map((line) => truncateToWidth(line, width, "", true));
  }
  if (!run) return [theme.fg("error", "Selected retry target is no longer loaded.")];
  const impact = confirmation.kind === "retryPhase" && confirmation.phaseId
    ? phaseRetryImpact(run, confirmation.phaseId)
    : confirmation.nodeId ? retryImpact(run, confirmation.nodeId) : undefined;
  const target = impact ? nodeById(run, impact.targetId) : undefined;
  if (!impact || !target) return [theme.fg("error", "Selected retry target no longer exists.")];
  const preserved = describeNodes(run, impact.preservedUpstream) || "none";
  const rerun = describeNodes(run, [...impact.targetIds, ...impact.invalidatedDownstream]) || target.label;
  const phase = impact.phaseId ? phaseRows(run).find((item) => item.id === impact.phaseId) : undefined;
  return [
    theme.bold(`Retry ${phase?.title ?? target.label}?`),
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
    "Runs: Up/Down or j/k select, Enter opens a run, x deletes completed history",
    "Phases: Up/Down or j/k select, Enter opens agents, R retries a settled phase",
    "Agents: Up/Down or j/k select, Enter opens transcript",
    "Detail: j/k arrows or PgUp/PgDn scroll; Enter toggles raw tool payloads; [/] changes attempts",
    "Esc or Left goes back; q closes; ? closes help",
    "p pause or resume scheduling; c cancel active run; r retries a settled agent",
  ].map((line) => truncateToWidth(line, width, "", true));
}

function footerHint(state: WikiNavigatorState): string {
  if (state.view === "runs") return "j/k runs | Enter open | x delete completed | q close | ? help";
  if (state.view === "detail") return "j/k scroll | Enter raw | [/] attempts | g/G ends | f follow | Esc back | ? help";
  if (state.view === "agents") return "j/k agents | Enter detail | g/G ends | Esc phases | ? help";
  return "j/k phases | Enter agents | R retry phase | g/G ends | Esc runs | ? help";
}

function joinColumns(
  first: string[],
  second: string[],
  firstWidth: number,
  secondWidth: number,
  rows: number,
  theme: WikiNavigatorTheme,
): string[] {
  const divider = theme.fg("borderMuted", " │ ");
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
