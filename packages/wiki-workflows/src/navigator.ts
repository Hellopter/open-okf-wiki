import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { parseKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { WikiNode, WikiNodeMetrics, WikiNodeStatus, WikiRunSnapshot, WikiRunStatus } from "./workflow-types.js";

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
  subscribe(listener: () => void): () => void;
  retryNode(nodeId: string): Promise<void> | void;
  pause(): Promise<void> | void;
  resume(): Promise<void> | void;
  cancel(): Promise<void> | void;
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

export interface WikiNavigatorState {
  selectedNodeId?: string;
  showDetail: boolean;
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

export function createWikiNavigatorState(run?: WikiRunView): WikiNavigatorState {
  return {
    selectedNodeId: run?.nodes[0]?.id,
    showDetail: false,
    showHelp: false,
    detailScroll: 0,
    detailFromEnd: false,
    followOutput: true,
  };
}

export function layoutForWidth(width: number): 1 | 2 | 3 {
  if (width >= 96) return 3;
  if (width >= 72) return 2;
  return 1;
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
    // A stored fingerprint is not proof that the workspace is unchanged.
    // The engine must inspect Git before it schedules the retry.
    rechecksGit: true,
  };
}

export function reduceWikiNavigator(
  state: WikiNavigatorState,
  key: string | undefined,
  run: WikiRunView | undefined,
): WikiNavigatorTransition {
  const next: WikiNavigatorState = { ...state };
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
  if (key === "escape" || key === "esc") {
    if (next.showDetail) {
      next.showDetail = false;
      return { state: next, action };
    }
    return { state: next, action: { type: "close" } };
  }
  if (key === "enter" || key === "return") {
    if (!selected) return { state: next, action };
    next.showDetail = !next.showDetail;
    next.detailScroll = 0;
    next.detailFromEnd = false;
    next.followOutput = true;
    return { state: next, action };
  }
  if (next.showDetail && (key === "up" || key === "k")) return scrollDetail(next, -1);
  if (next.showDetail && (key === "down" || key === "j")) return scrollDetail(next, 1);
  if (next.showDetail && (key === "pageUp" || key === "ctrl+u" || key === "ctrl+b")) return scrollDetail(next, -12);
  if (next.showDetail && (key === "pageDown" || key === "space" || key === "ctrl+d" || key === "ctrl+f")) return scrollDetail(next, 12);
  if (next.showDetail && (key === "g" || key === "home")) {
    return { state: { ...next, detailScroll: 0, detailFromEnd: false, followOutput: false }, action };
  }
  if (next.showDetail && (key === "G" || key === "shift+g" || key === "end")) {
    return { state: { ...next, detailScroll: 0, detailFromEnd: true, followOutput: true }, action };
  }
  if (next.showDetail && key === "f") {
    const followOutput = !next.followOutput;
    return { state: { ...next, followOutput, detailScroll: followOutput ? 0 : next.detailScroll, detailFromEnd: followOutput || next.detailFromEnd }, action };
  }
  if (key === "up" || key === "k") return moveSelection(next, run, -1);
  if (key === "down" || key === "j") return moveSelection(next, run, 1);
  if (key === "g" || key === "home") return selectEdge(next, run, "start");
  if (key === "G" || key === "shift+g" || key === "end") return selectEdge(next, run, "end");
  if (key === "r") {
    if (!selected) return { state: next, action: { type: "notify", message: "Select a node to retry", level: "warning" } };
    if (selected.status === "running" || selected.status === "queued") {
      return { state: next, action: { type: "notify", message: "Wait for the selected node to settle before retrying", level: "warning" } };
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
): string[] {
  const safeWidth = Math.max(20, width);
  if (!run) return [theme.bold("Wiki Run"), theme.fg("muted", "No Wiki run in this Pi session.")];

  const normalized = ensureSelection(state, run);
  const lines = [renderHeader(run, safeWidth, theme)];
  if (normalized.showHelp) return [...lines, "", ...renderHelp(safeWidth, theme)];
  if (normalized.confirmation) return [...lines, "", ...renderConfirmation(normalized.confirmation, run, safeWidth, theme)];

  const layout = layoutForWidth(safeWidth);
  if (layout === 3) {
    const leftWidth = Math.max(26, Math.floor(safeWidth * 0.30));
    const middleWidth = Math.max(34, Math.floor(safeWidth * 0.42));
    const rightWidth = safeWidth - leftWidth - middleWidth - 6;
    return [
      ...lines,
      ...joinColumns(
        renderNodeTree(normalized, run, leftWidth, theme),
        renderNodeDetail(normalized, run, middleWidth, theme, viewportRows - 2),
        renderRunSummary(run, rightWidth, theme),
        [leftWidth, middleWidth, rightWidth],
        theme,
      ),
    ];
  }
  if (layout === 2) {
    const leftWidth = Math.max(26, Math.floor((safeWidth - 3) * 0.38));
    const rightWidth = safeWidth - leftWidth - 3;
    return [
      ...lines,
      ...joinColumns(
        renderNodeTree(normalized, run, leftWidth, theme),
        [...renderNodeDetail(normalized, run, rightWidth, theme, viewportRows - 2), "", ...renderRunSummary(run, rightWidth, theme)],
        [],
        [leftWidth, rightWidth],
        theme,
      ),
    ];
  }
  if (normalized.showDetail) {
    return [...lines, "", ...renderNodeDetail(normalized, run, safeWidth, theme, viewportRows - 3)];
  }
  return [
    ...lines,
    "",
    ...renderNodeTree(normalized, run, safeWidth, theme),
    "",
    ...renderRunSummary(run, safeWidth, theme),
  ];
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
 * Opens the Pi overlay. The component is deliberately small: state, rendering,
 * and key transitions above remain pure and can be exercised without a terminal.
 */
export function openWikiRunNavigator(ui: ExtensionUIContext, controller: WikiNavigatorController): Promise<void> {
  return ui.custom<void>((tui: TUI, theme: Theme, _keybindings, done) => {
    let state = createWikiNavigatorState(controller.getRun());
    let closed = false;
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
    const component: Component & { dispose(): void } = {
      render: (width) => renderWikiNavigator(state, controller.getRun(), width, theme, tui.terminal.rows),
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
  }, { overlay: true, overlayOptions: { width: "92%", minWidth: 56, maxHeight: "88%", anchor: "center" } });
}

function ensureSelection(state: WikiNavigatorState, run: WikiRunView | undefined): WikiNavigatorState {
  if (!run || run.nodes.length === 0) return state;
  if (state.selectedNodeId && nodeById(run, state.selectedNodeId)) return state;
  return { ...state, selectedNodeId: run.nodes[0]?.id };
}

function selectedNode(state: WikiNavigatorState, run: WikiRunView | undefined): WikiRunNode | undefined {
  return state.selectedNodeId && run ? nodeById(run, state.selectedNodeId) : undefined;
}

function nodeById(run: WikiRunView, id: string): WikiRunNode | undefined {
  return run.nodes.find((node) => node.id === id);
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
  const visit = (id: string) => {
    for (const node of run.nodes) {
      if (!node.dependsOn.includes(id) || ids.has(node.id)) continue;
      ids.add(node.id);
      visit(node.id);
    }
  };
  visit(targetId);
  return ids;
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

function moveSelection(state: WikiNavigatorState, run: WikiRunView | undefined, delta: -1 | 1): WikiNavigatorTransition {
  if (!run?.nodes.length) return { state, action: { type: "none" } };
  const currentIndex = Math.max(0, run.nodes.findIndex((node) => node.id === state.selectedNodeId));
  const nextIndex = (currentIndex + delta + run.nodes.length) % run.nodes.length;
  return { state: { ...state, selectedNodeId: run.nodes[nextIndex]?.id, detailScroll: 0, detailFromEnd: false, followOutput: true }, action: { type: "none" } };
}

function selectEdge(state: WikiNavigatorState, run: WikiRunView | undefined, edge: "start" | "end"): WikiNavigatorTransition {
  const node = edge === "start" ? run?.nodes[0] : run?.nodes.at(-1);
  return { state: node ? { ...state, selectedNodeId: node.id, detailScroll: 0, detailFromEnd: false, followOutput: true } : state, action: { type: "none" } };
}

function scrollDetail(state: WikiNavigatorState, delta: number): WikiNavigatorTransition {
  const detailFromEnd = state.detailFromEnd;
  const offset = detailFromEnd ? Math.max(0, state.detailScroll - delta) : Math.max(0, state.detailScroll + delta);
  return {
    state: { ...state, detailScroll: offset, detailFromEnd, followOutput: false },
    action: { type: "none" },
  };
}

function isActiveRun(run: WikiRunView): boolean {
  return run.status === "running" || run.status === "paused" || run.status === "blocked";
}

function renderHeader(run: WikiRunView, width: number, theme: WikiNavigatorTheme): string {
  const changed = run.inspection?.changedPaths.length ?? 0;
  const head = run.inspection?.head ? ` | ${shortHash(run.inspection.head)}` : "";
  const content = `Wiki Run | ${run.effectiveMode ?? run.requestedMode} | ${run.status} | round ${run.round} | ${changed} changed${head}`;
  return truncateToWidth(theme.bold(content), width, "", true);
}

function renderNodeTree(state: WikiNavigatorState, run: WikiRunView, width: number, theme: WikiNavigatorTheme): string[] {
  const lines = [theme.bold("Nodes")];
  if (run.nodes.length === 0) return [...lines, theme.fg("muted", "  No nodes planned yet.")];
  const selectedId = state.selectedNodeId;
  const upstream = selectedId ? upstreamIds(run, selectedId) : new Set<string>();
  const downstream = selectedId ? downstreamIds(run, selectedId) : new Set<string>();
  let priorStage: string | undefined;
  for (const node of run.nodes) {
    const stage = stageLabel(node.kind);
    if (stage !== priorStage) {
      lines.push(truncateToWidth(theme.fg("muted", `  ${stage}`), width, "", true));
      priorStage = stage;
    }
    const marker = node.id === state.selectedNodeId ? ">" : " ";
    const relation = node.id === selectedId ? "selected" : upstream.has(node.id) ? "upstream" : downstream.has(node.id) ? "downstream" : "";
    const detail = node.attempt > 1 ? ` #${node.attempt}` : "";
    const activity = node.status === "running" ? ` ${activityText(node)}` : "";
    const relationText = relation ? ` <${relation}>` : "";
    const text = `${marker} ${STATUS_ICON[node.status]} [${node.status}]${relationText} ${node.label}${detail}${activity}`;
    const styled = theme.fg(STATUS_COLOR[node.status], text);
    lines.push(truncateToWidth(styled, width, "", true));
    if (node.error && node.id === state.selectedNodeId) lines.push(truncateToWidth(theme.fg("error", `    ${firstLine(node.error.message)}`), width, "", true));
  }
  return lines;
}

function renderNodeDetail(state: WikiNavigatorState, run: WikiRunView, width: number, theme: WikiNavigatorTheme, viewportRows: number): string[] {
  const node = selectedNode(state, run);
  if (!node) return [theme.bold("Node"), theme.fg("muted", "No node selected.")];
  const lines = [theme.bold(`Node: ${node.label}`)];
  lines.push(truncateToWidth(theme.fg(STATUS_COLOR[node.status], `${STATUS_ICON[node.status]} ${node.status} | attempt ${node.attempt} | ${node.kind}`), width, "", true));
  if (node.activity.message || node.activity.state !== "idle") lines.push(truncateToWidth(theme.fg("accent", activityText(node)), width, "", true));
  lines.push("");
  lines.push(theme.bold("Input"));
  lines.push(...renderObject(node.input ?? node.inputFingerprint ?? "No structured input recorded.", width, theme));
  const upstream = describeNodes(run, [...upstreamIds(run, node.id)]) || "none";
  const downstream = describeNodes(run, [...downstreamIds(run, node.id)]) || "none";
  lines.push(truncateToWidth(theme.fg("muted", `Upstream: ${upstream}`), width, "", true));
  lines.push(truncateToWidth(theme.fg("muted", `Downstream: ${downstream}`), width, "", true));
  lines.push("");
  lines.push(theme.bold("Result"));
  lines.push(...renderObject(node.error ? `Error: ${node.error.message}` : node.result ?? "No structured result recorded.", width, node.error ? { ...theme, fg: (_color, text) => theme.fg("error", text) } : theme));
  if (node.output) {
    lines.push("");
    lines.push(theme.bold("Output"));
    lines.push(...renderObject(node.output, width, theme));
  }
  lines.push("");
  lines.push(theme.bold("Execution"));
  lines.push(...renderTiming(node, width, theme));
  lines.push(...renderMetrics(node, width, theme));
  lines.push("");
  lines.push(theme.bold("Recent run events"));
  lines.push(...renderRecentEvents(run, node.id, width, theme));
  const viewport = Math.max(4, viewportRows);
  const maxScroll = Math.max(0, lines.length - viewport);
  const follow = state.followOutput && node.status === "running";
  const scroll = state.detailFromEnd || follow
    ? Math.max(0, maxScroll - Math.min(maxScroll, state.detailScroll))
    : Math.min(state.detailScroll, maxScroll);
  const visible = lines.slice(scroll, scroll + viewport);
  if (lines.length > viewport) {
    const position = `${scroll + 1}-${Math.min(scroll + viewport, lines.length)}/${lines.length}`;
    visible.push(theme.fg("dim", `Output ${position}${follow ? " follow" : ""}`));
  }
  return visible;
}

function renderRunSummary(run: WikiRunView, width: number, theme: WikiNavigatorTheme): string[] {
  const lines = [theme.bold("Run")];
  lines.push(truncateToWidth(`Scope: ${run.focus || "workspace"}`, width, "", true));
  lines.push(truncateToWidth(`Changed: ${run.inspection?.changedPaths.length ?? 0} files`, width, "", true));
  if (run.inspection?.head) lines.push(truncateToWidth(`Git: ${shortHash(run.inspection.head)}`, width, "", true));
  const validation = run.nodes.findLast((node) => node.kind === "validate");
  const review = run.nodes.findLast((node) => node.kind === "review");
  lines.push(truncateToWidth(`Validate: ${validation?.status ?? "pending"}`, width, "", true));
  lines.push(truncateToWidth(`Review: ${review?.status ?? "pending"}`, width, "", true));
  if (run.blockedReason) lines.push(truncateToWidth(theme.fg("warning", `Blocked: ${run.blockedReason}`), width, "", true));
  return lines;
}

function renderMetrics(node: WikiRunNode, width: number, theme: WikiNavigatorTheme): string[] {
  const metrics = node.metrics;
  if (!metrics) return [theme.fg("muted", "No telemetry recorded.")];
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

function renderRecentEvents(run: WikiRunView, nodeId: string, width: number, theme: WikiNavigatorTheme): string[] {
  const related = run.events.filter((event) => event.nodeId === undefined || event.nodeId === nodeId).slice(-6);
  if (related.length === 0) return [theme.fg("muted", "No events recorded.")];
  return related.map((event) => {
    const message = event.message ? `: ${event.message}` : "";
    return truncateToWidth(theme.fg("muted", `${formatTimestamp(event.at)} ${event.kind}${message}`), width, "", true);
  });
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
    "Up/Down or j/k select node",
    "Enter open or close detail; detail has scroll",
    "r retry selected settled node",
    "p pause or resume scheduling",
    "c cancel active run",
    "List: g/G first or last node",
    "Detail: j/k arrows or PgUp/PgDn scroll; g/G ends; f follow live output",
    "Esc back; q close; ? close help",
  ].map((line) => truncateToWidth(line, width, "", true));
}

function joinColumns(
  first: string[],
  second: string[],
  third: string[],
  widths: number[],
  theme: WikiNavigatorTheme,
): string[] {
  const columns = widths.length === 3 ? [first, second, third] : [first, second];
  const rows = Math.max(...columns.map((column) => column.length), 1);
  const divider = theme.fg("muted", " | ");
  return Array.from({ length: rows }, (_, index) => columns
    .map((column, columnIndex) => padToWidth(column[index] ?? "", widths[columnIndex] ?? 1))
    .join(divider));
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
  const attempt = activity.retryAttempt && activity.retryMaxAttempts
    ? ` ${activity.retryAttempt}/${activity.retryMaxAttempts}`
    : "";
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
