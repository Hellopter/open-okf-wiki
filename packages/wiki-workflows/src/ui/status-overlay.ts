import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderWikiAgent, renderWikiContextStats } from "../cli.js";
import type {
  WikiActivityEntry,
  WikiActivityPage,
  WikiAgentInspection,
  WikiAgentTarget,
  WikiRunEvent,
  WikiRunHandle,
  WikiRunView,
  WikiTaskSnapshot,
} from "../producer-types.js";
import { errorMessage } from "../util.js";

export type WikiOverlayKind = "run" | "agent" | "activity";
type InspectorTab = "overview" | "process" | "output";
type ActivityFilter = "all" | "leader" | "tasks" | "errors";

export interface WikiOverlayState {
  kind: WikiOverlayKind;
  cursor: number;
  scroll: number;
  tailing: boolean;
  runId: string;
  target?: WikiAgentTarget;
  tab: InspectorTab;
  filter: ActivityFilter;
}

export type WikiOverlayAction =
  | { type: "up" | "down" | "enter" | "back" | "toggleTail" | "filter" }
  | { type: "tab" | "page"; direction: 1 | -1 };

type OverlayHandle = Pick<WikiRunHandle, "view" | "events" | "inspectAgent" | "activity">;
type NavTarget = { kind: "agent"; target: WikiAgentTarget } | { kind: "activity" };
type NavRow = { label: string; target?: NavTarget };

const PAGE = 10;
const ACTIVITY_PAGE = 50;
const DEFAULT_VIEWPORT = 24;
const OVERLAY_MAX_HEIGHT_PERCENT = 88;
const OVERLAY_MAX_HEIGHT = `${OVERLAY_MAX_HEIGHT_PERCENT}%`;
const OVERLAY_MARGIN = 1;

export function initialWikiOverlayState(input: { runId: string; initialTarget?: WikiAgentTarget; process?: boolean }): WikiOverlayState {
  return {
    kind: input.initialTarget ? "agent" : "run",
    cursor: 0,
    scroll: 0,
    tailing: false,
    runId: input.runId,
    target: input.initialTarget,
    tab: input.process ? "process" : "overview",
    filter: "all",
  };
}

export function reduceWikiOverlay(state: WikiOverlayState, action: WikiOverlayAction, itemCount: number): WikiOverlayState {
  const max = Math.max(0, itemCount - 1);
  if (action.type === "up") return state.kind === "run" ? { ...state, cursor: clamp(state.cursor - 1, 0, max) } : { ...state, tailing: false, scroll: Math.max(0, state.scroll - 1) };
  if (action.type === "down") return state.kind === "run" ? { ...state, cursor: clamp(state.cursor + 1, 0, max) } : { ...state, scroll: state.scroll + 1 };
  if (action.type === "page") return state.kind === "run" ? { ...state, cursor: clamp(state.cursor + action.direction * PAGE, 0, max) } : { ...state, tailing: false, scroll: Math.max(0, state.scroll + action.direction * PAGE) };
  if (action.type === "back" && state.kind !== "run") return { ...state, kind: "run", target: undefined, scroll: 0, tailing: false };
  if (action.type === "toggleTail" && state.kind !== "run") return { ...state, tailing: !state.tailing, scroll: Number.MAX_SAFE_INTEGER };
  if (action.type === "tab" && state.kind === "agent") {
    const tabs: InspectorTab[] = ["overview", "process", "output"];
    const index = tabs.indexOf(state.tab);
    return { ...state, tab: tabs[(index + action.direction + tabs.length) % tabs.length]!, scroll: 0 };
  }
  if (action.type === "filter" && state.kind === "activity") {
    const filters: ActivityFilter[] = ["all", "leader", "tasks", "errors"];
    return { ...state, filter: filters[(filters.indexOf(state.filter) + 1) % filters.length]!, scroll: 0, tailing: false };
  }
  return state;
}

export async function openWikiStatusOverlay(args: {
  ui: { custom?: Function };
  handle: OverlayHandle;
  initialTarget?: WikiAgentTarget;
  process?: boolean;
  confirmCancel?: () => Promise<boolean>;
  onControl?: (action: "pause" | "resume" | "cancel") => Promise<void>;
}): Promise<void> {
  if (typeof args.ui.custom !== "function") return;
  await args.ui.custom(async (tui: OverlayTui, theme: unknown, keybindings: KeybindingsManager, done: () => void) => {
    const view = await args.handle.view();
    return createStatusOverlay({ ...args, tui, theme, keybindings, done, view });
  }, {
    overlay: true,
    overlayOptions: {
      width: "92%", minWidth: 36, maxHeight: OVERLAY_MAX_HEIGHT, anchor: "center", margin: OVERLAY_MARGIN,
      visible: (width: number, height: number) => width >= 36 && height >= 10,
    },
  });
}

type OverlayTui = { requestRender(force?: boolean): void; terminal?: { rows?: number } };

function createStatusOverlay(args: {
  tui: OverlayTui; theme: unknown; keybindings: KeybindingsManager; done(): void; handle: OverlayHandle; view: WikiRunView;
  initialTarget?: WikiAgentTarget; process?: boolean; confirmCancel?: () => Promise<boolean>;
  onControl?: (action: "pause" | "resume" | "cancel") => Promise<void>;
}) {
  let view = args.view;
  let state = initialWikiOverlayState({ runId: view.id, initialTarget: args.initialTarget, process: args.process });
  let inspection: WikiAgentInspection | undefined;
  let activityEntries: WikiActivityEntry[] = [];
  let activityBefore: number | undefined;
  let activityExhausted = false;
  let warning: string | undefined;
  let busy: string | undefined;
  let cached: { width: number; lines: string[] } | undefined;
  let closed = false;
  let generation = 0;
  let refreshing = false;
  let now = Date.now();
  const controller = new AbortController();
  const invalidate = () => { cached = undefined; };
  const nav = () => navigationRows(view).flatMap((row) => row.target ? [row.target] : []);
  const selected = () => state.target ? { kind: "agent" as const, target: state.target } : nav()[state.cursor];

  const loadAgent = async (): Promise<void> => {
    const item = selected();
    if (item?.kind !== "agent") { inspection = undefined; return; }
    const token = ++generation;
    try {
      const next = await args.handle.inspectAgent(item.target);
      if (closed || token !== generation) return;
      inspection = next;
      warning = undefined;
    } catch (error) {
      if (token === generation) warning = errorMessage(error);
    }
    invalidate(); args.tui.requestRender();
  };

  const loadActivity = async (append: boolean): Promise<void> => {
    if (append && activityExhausted) return;
    const token = ++generation;
    try {
      let before = append ? activityBefore : undefined;
      let page: WikiActivityPage;
      do {
        page = await args.handle.activity({
          ...(before !== undefined ? { before } : {}),
          limit: ACTIVITY_PAGE,
          ...(state.filter === "leader" ? { actor: { kind: "lead" } as const } : {}),
          ...(state.filter === "errors" ? { severity: "error" as const } : {}),
        });
        before = page.nextBefore;
      } while (state.filter === "tasks" && page.entries.every((entry) => entry.target?.kind !== "task") && before !== undefined);
      if (closed || token !== generation) return;
      applyActivityPage(page, append);
      warning = undefined;
    } catch (error) {
      if (token === generation) warning = errorMessage(error);
    }
    invalidate(); args.tui.requestRender();
  };

  const applyActivityPage = (page: WikiActivityPage, append: boolean): void => {
    const incoming = state.filter === "tasks" ? page.entries.filter((entry) => entry.target?.kind === "task") : page.entries;
    const merged = append ? [...activityEntries, ...incoming] : incoming;
    activityEntries = [...new Map(merged.map((entry) => [entry.sequence, entry])).values()];
    activityBefore = page.nextBefore;
    activityExhausted = page.nextBefore === undefined;
  };

  const loadSelected = async (): Promise<void> => {
    if (selected()?.kind === "activity") await loadActivity(false);
    else await loadAgent();
  };
  void loadSelected();

  const refresh = async (): Promise<void> => {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      view = await args.handle.view();
      state = { ...state, cursor: clamp(state.cursor, 0, Math.max(0, nav().length - 1)) };
      now = Date.now();
      await loadSelected();
    } catch (error) { warning = errorMessage(error); }
    finally { refreshing = false; invalidate(); args.tui.requestRender(); }
  };

  subscribeEvents(args.handle, view.lastEventSequence, controller.signal, refresh);
  const tick = setInterval(() => {
    if (!closed && (view.status === "running" || warning)) {
      now = Date.now(); invalidate(); args.tui.requestRender();
      if (warning) void refresh();
    }
  }, 1000);
  const cleanup = () => { if (!closed) { closed = true; generation += 1; clearInterval(tick); controller.abort(); } };
  const finish = () => { cleanup(); args.done(); };

  const apply = (action: WikiOverlayAction): void => {
    const before = selectedKey(selected());
    if (action.type === "enter" && state.kind === "run") {
      const item = selected();
      if (item?.kind === "agent") state = { ...state, kind: "agent", target: item.target, scroll: 0 };
      else if (item?.kind === "activity") state = { ...state, kind: "activity", scroll: 0 };
    } else {
      state = reduceWikiOverlay(state, action, nav().length);
    }
    if (action.type === "filter" || before !== selectedKey(selected())) {
      inspection = undefined;
      void loadSelected();
    }
    invalidate(); args.tui.requestRender();
  };

  const control = async (action: "pause" | "resume" | "cancel"): Promise<void> => {
    if (busy) return;
    if (action === "cancel" && args.confirmCancel && !await args.confirmCancel()) return;
    busy = action === "cancel" ? "Cancelling..." : action === "pause" ? "Pausing..." : "Resuming...";
    invalidate(); args.tui.requestRender();
    try { await args.onControl?.(action); await refresh(); if (action === "cancel") finish(); }
    catch (error) { warning = errorMessage(error); }
    finally { busy = undefined; invalidate(); args.tui.requestRender(); }
  };

  return {
    invalidate,
    dispose: cleanup,
    handleInput(data: string) {
      if (closed) return;
      if (args.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) return apply({ type: "up" });
      if (args.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) return apply({ type: "down" });
      if (args.keybindings.matches(data, "tui.select.pageUp")) { if (state.kind === "activity") void loadActivity(true); return apply({ type: "page", direction: -1 }); }
      if (args.keybindings.matches(data, "tui.select.pageDown")) return apply({ type: "page", direction: 1 });
      if (args.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.right)) return apply({ type: "enter" });
      if (args.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.left)) { if (state.kind === "run") finish(); else apply({ type: "back" }); return; }
      if (matchesKey(data, "t")) return apply({ type: "toggleTail" });
      if (matchesKey(data, "f")) return apply({ type: "filter" });
      if (matchesKey(data, "l") && state.kind === "activity") { void loadActivity(true); return; }
      if (matchesKey(data, Key.tab)) return apply({ type: "tab", direction: 1 });
      if (matchesKey(data, "p")) void control(view.status === "paused" ? "resume" : "pause");
      if (matchesKey(data, "r") && view.status === "paused") void control("resume");
      if (matchesKey(data, "x")) void control("cancel");
    },
    render(width: number): string[] {
      if (cached?.width === width) return cached.lines;
      const language = view.progress?.language ?? "en";
      const current = selected();
      const matched = matchingInspection(current, inspection);
      const body = renderBody(state, view, current, matched, activityEntries, activityExhausted, width, args.theme, now, warning, busy);
      const footer = language === "zh" ? "↑↓ 选择  enter 打开  tab 视图  l 更早  p 暂停  x 取消  esc" : "↑↓ select  enter open  tab view  l older  p pause  x cancel  esc";
      const framed = frameWikiOverlay({ width, title: `wiki ${view.id}  ${view.status}`, body, stats: renderWikiContextStats(matched?.agent.usage), footer, theme: args.theme, viewport: viewportRows(args.tui), scroll: state.scroll, tailing: state.tailing });
      cached = { width, lines: framed.lines };
      return framed.lines;
    },
  };
}

function navigationRows(view: WikiRunView): NavRow[] {
  const lead = view.progress?.lead;
  const rows: NavRow[] = [{
    label: `${lead?.health === "degraded" ? "!" : "◆"} Leader  ${lead?.activity.replaceAll("_", " ") ?? "starting"}`,
    target: { kind: "agent", target: { kind: "lead" } },
  }];
  for (const batch of view.progress?.batches ?? (view.progress?.currentBatch ? [view.progress.currentBatch] : [])) {
    const current = batch.batch === view.progress?.currentBatch?.batch;
    rows.push({ label: `${current ? "◆" : "✓"} Batch ${batch.batch}  ${batch.completed}/${batch.total}` });
    if (current || batch.status === "failed" || batch.status === "partial") {
      for (const task of batch.tasks) rows.push({
        label: `  ${taskIcon(task.status)} ${task.role}  ${task.id}`,
        target: { kind: "agent", target: { kind: "task", batch: batch.batch, taskId: task.id } },
      });
    }
  }
  rows.push({ label: "Activity", target: { kind: "activity" } });
  return rows;
}

function renderBody(state: WikiOverlayState, view: WikiRunView, selected: NavTarget | undefined, inspection: WikiAgentInspection | undefined, activity: WikiActivityEntry[], exhausted: boolean, width: number, theme: unknown, now: number, warning?: string, busy?: string): string[] {
  const elapsed = runElapsed(view, now);
  const header = `${stageRail(view)}${elapsed ? `  [${elapsed}]` : ""}`;
  const health = selected?.kind === "agent" && selectedAgent(view, selected.target, inspection)?.health === "degraded"
    ? view.progress?.language === "zh" ? "warning  观测降级" : "warning  observability degraded"
    : undefined;
  const notices = [busy, warning ? `warning  ${warning}` : undefined, health].filter((value): value is string => Boolean(value));
  if (state.kind === "run" && width >= 100) return [header, ...notices, "", ...columns(navigationLines(view, state.cursor, theme), inspectorLines(selected, inspection, activity, exhausted, state, now), width - 4)];
  if (state.kind === "run") return [header, ...notices, "", ...navigationLines(view, state.cursor, theme)];
  return [header, ...notices, "", ...inspectorLines(selected, inspection, activity, exhausted, state, now)];
}

function navigationLines(view: WikiRunView, cursor: number, theme: unknown): string[] {
  let index = 0;
  return navigationRows(view).map((row) => row.target ? navLine(index++ === cursor, row.label, theme) : row.label);
}

function inspectorLines(selected: NavTarget | undefined, inspection: WikiAgentInspection | undefined, activity: WikiActivityEntry[], exhausted: boolean, state: WikiOverlayState, now: number): string[] {
  if (state.kind === "activity" || selected?.kind === "activity") {
    return [`Activity  [${state.filter}]`, ...activity.map(renderActivity), exhausted ? "No earlier activity." : "l / PageUp  load earlier"];
  }
  if (!inspection) return selected?.kind === "agent" && selected.target.kind === "lead"
    ? ["Leader starting. Agent details are not available."]
    : ["Agent details are not available."];
  const tabs = `[${state.tab === "overview" ? "Overview" : "overview"}]  [${state.tab === "process" ? "Process" : "process"}]  [${state.tab === "output" ? "Output" : "output"}]`;
  return [tabs, liveAgentLine(inspection, now), ...renderWikiAgent(inspection, state.tab).split("\n")];
}

function renderActivity(entry: WikiActivityEntry): string {
  const icon = entry.severity === "error" ? "✗" : entry.severity === "warning" ? "!" : "·";
  return `${icon} ${entry.at.slice(11, 19)}  ${entry.message}`;
}

function selectedAgent(view: WikiRunView, target: WikiAgentTarget, inspection: WikiAgentInspection | undefined) {
  if (inspection && sameTarget(inspection.agent.target, target)) return inspection.agent;
  return target.kind === "lead" ? view.progress?.lead : undefined;
}

function matchingInspection(selected: NavTarget | undefined, inspection: WikiAgentInspection | undefined): WikiAgentInspection | undefined {
  return selected?.kind === "agent" && inspection && sameTarget(inspection.agent.target, selected.target) ? inspection : undefined;
}

function sameTarget(left: WikiAgentTarget, right: WikiAgentTarget): boolean {
  return left.kind === right.kind && (left.kind === "lead" || right.kind === "task" && left.batch === right.batch && left.taskId === right.taskId);
}

function stageRail(view: WikiRunView): string {
  const stages = ["prepare", "lead", "validate", "publish"] as const;
  const current = stages.indexOf(view.progress?.stage ?? "prepare");
  return stages.map((stage, index) => `${index < current ? "✓" : index === current ? "◆" : "○"} ${stage[0]!.toUpperCase()}${stage.slice(1)}`).join(" ━ ");
}

function liveAgentLine(inspection: WikiAgentInspection, now: number): string {
  const agent = inspection.agent;
  const parts = [agent.activeTools[0]?.name ? `tool ${agent.activeTools[0].name}` : agent.activity.replaceAll("_", " ")];
  const heartbeat = formatAge(agent.lastHeartbeatAt, now);
  const activity = formatAge(agent.lastActivityAt, now);
  if (heartbeat) parts.push(`session alive ${heartbeat}`);
  if (activity) parts.push(`Pi activity ${activity}`);
  return `◆ ${parts.join(" · ")}`;
}

export function frameWikiOverlay(input: { width: number; title: string; body: string[]; stats?: string; footer: string; theme?: unknown; viewport?: number; scroll?: number; tailing?: boolean }): { lines: string[]; maxScroll: number } {
  const width = Math.max(8, Math.floor(input.width));
  const inner = Math.max(1, width - 2);
  const chrome = 2 + (input.stats ? 2 : 0);
  const viewport = Math.max(1, (input.viewport ?? DEFAULT_VIEWPORT) - chrome);
  const maxScroll = Math.max(0, input.body.length - viewport);
  const scroll = input.tailing ? maxScroll : Math.min(Math.max(0, input.scroll ?? 0), maxScroll);
  const visible = input.body.slice(scroll, scroll + viewport);
  while (visible.length < viewport) visible.push("");
  const border = (text: string) => paint(input.theme, "border", text);
  const lines = [border(`┌${padRule(input.title, inner)}┐`), ...visible.map((line) => `${border("│")}${padLine(` ${line}`, inner)}${border("│")}`)];
  if (input.stats) lines.push(border(`├${padRule("context", inner)}┤`), `${border("│")}${padLine(` ${input.stats}`, inner)}${border("│")}`);
  lines.push(border(`└${padRule(input.footer, inner)}┘`));
  return { lines, maxScroll };
}

export function wikiOverlayMaxHeight(terminalRows: number): number {
  const rows = Math.max(1, Math.floor(terminalRows));
  return Math.max(1, Math.min(Math.floor(rows * OVERLAY_MAX_HEIGHT_PERCENT / 100), rows - OVERLAY_MARGIN * 2));
}

function columns(left: string[], right: string[], width: number): string[] { const leftWidth = Math.max(24, Math.min(36, Math.floor(width * 0.34))); const rightWidth = Math.max(1, width - leftWidth - 3); return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => `${padLine(left[index] ?? "", leftWidth)} │ ${padLine(right[index] ?? "", rightWidth)}`); }
function padLine(value: string, width: number): string { const clipped = truncateToWidth(value, width, "...", true); return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))); }
function padRule(label: string, inner: number): string { const clipped = truncateToWidth(label.trim() ? ` ${label.trim()} ` : "", inner); return clipped + "─".repeat(Math.max(0, inner - visibleWidth(clipped))); }
function viewportRows(tui: OverlayTui): number { const rows = tui.terminal?.rows; return wikiOverlayMaxHeight(typeof rows === "number" && rows > 6 ? rows : DEFAULT_VIEWPORT); }
function taskIcon(status: WikiTaskSnapshot["status"]): string { return ({ queued: "·", running: "◆", complete: "✓", incomplete: "◐", failed: "✗" } as const)[status]; }
function navLine(selected: boolean, text: string, theme: unknown): string { return selected ? paint(theme, "accent", `> ${text}`) : `  ${text}`; }
function selectedKey(value: NavTarget | undefined): string { return !value ? "" : value.kind === "activity" ? "activity" : JSON.stringify(value.target); }
function formatAge(value: string | undefined, now: number): string | undefined { const parsed = value ? Date.parse(value) : NaN; if (!Number.isFinite(parsed)) return undefined; const seconds = Math.max(0, Math.floor((now - parsed) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`; }
function runElapsed(view: WikiRunView, now: number): string | undefined { const start = Date.parse(view.createdAt); const end = view.completedAt ? Date.parse(view.completedAt) : now; if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined; const seconds = Math.floor((end - start) / 1000); const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds % 3600 / 60); const rest = seconds % 60; return hours ? `${hours}h${minutes}m${rest}s` : minutes ? `${minutes}m${rest}s` : `${rest}s`; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function paint(theme: unknown, color: string, text: string): string { if (!theme || typeof theme !== "object" || !("fg" in theme)) return text; const fg = (theme as { fg?: unknown }).fg; return typeof fg === "function" ? String((fg as (name: string, value: string) => string)(color, text)) : text; }
function subscribeEvents(handle: Pick<WikiRunHandle, "events">, after: number, signal: AbortSignal, onEvent: () => Promise<void>): void { void (async () => { try { for await (const _event of handle.events(after, signal)) { if (signal.aborted) return; await onEvent(); } } catch { /* durable stream may end */ } })(); }
