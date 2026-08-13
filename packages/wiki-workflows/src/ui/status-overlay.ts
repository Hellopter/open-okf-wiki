import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderWikiContextStats, renderWikiRun, renderWikiTask, renderWikiTaskProcess } from "../cli.js";
import type { WikiContextStats, WikiRunEvent, WikiRunView, WikiTaskInspection, WikiTaskSnapshot } from "../producer-types.js";
import { errorMessage } from "../util.js";

export type WikiOverlayKind = "run" | "task" | "process";

export interface WikiOverlayState {
  kind: WikiOverlayKind;
  cursor: number;
  scroll: number;
  tailing: boolean;
  runId: string;
  taskId?: string;
}

export type WikiOverlayAction =
  | { type: "up" }
  | { type: "down" }
  | { type: "enter" }
  | { type: "back" }
  | { type: "openProcess" }
  | { type: "toggleTail" }
  | { type: "page"; direction: 1 | -1 };

const PAGE = 10;
const DEFAULT_VIEWPORT = 24;
const OVERLAY_MAX_HEIGHT_PERCENT = 82;
const OVERLAY_MAX_HEIGHT = `${OVERLAY_MAX_HEIGHT_PERCENT}%`;
const OVERLAY_MARGIN = 1;
const TASK_LINE = /^\s+[·◆✓◐✗] /;

export function initialWikiOverlayState(input: {
  runId: string;
  taskCount: number;
  initialTaskId?: string;
  process?: boolean;
}): WikiOverlayState {
  const kind: WikiOverlayKind = input.process ? "process" : input.initialTaskId ? "task" : "run";
  return {
    kind,
    cursor: 0,
    scroll: 0,
    tailing: false,
    runId: input.runId,
    ...(input.initialTaskId ? { taskId: input.initialTaskId } : {}),
  };
}

export function reduceWikiOverlay(
  state: WikiOverlayState,
  action: WikiOverlayAction,
  ctx: { taskCount: number; taskIds: string[] },
): WikiOverlayState {
  const current = withClampedCursor(state, ctx.taskCount);
  switch (action.type) {
    case "up":
      return current.kind === "run"
        ? { ...current, cursor: clamp(current.cursor - 1, 0, maxCursor(ctx.taskCount)) }
        : { ...current, tailing: false, scroll: Math.max(0, current.scroll - 1) };
    case "down":
      return current.kind === "run"
        ? { ...current, cursor: clamp(current.cursor + 1, 0, maxCursor(ctx.taskCount)) }
        : { ...current, scroll: current.scroll + 1 };
    case "page":
      if (current.kind === "run") {
        return { ...current, cursor: clamp(current.cursor + action.direction * PAGE, 0, maxCursor(ctx.taskCount)) };
      }
      if (action.direction < 0) {
        return { ...current, tailing: false, scroll: Math.max(0, current.scroll - PAGE) };
      }
      return { ...current, scroll: current.scroll + PAGE };
    case "enter":
      return enterOverlay(current, ctx);
    case "openProcess":
      return openProcess(current, ctx);
    case "back":
      return backOverlay(current, ctx);
    case "toggleTail":
      if (current.kind !== "process") return current;
      return { ...current, tailing: true, scroll: Number.MAX_SAFE_INTEGER };
  }
}

export async function openWikiStatusOverlay(args: {
  ui: { custom?: Function };
  handle: {
    view(): Promise<import("../producer-types.js").WikiRunView>;
    inspect(taskId: string): Promise<import("../producer-types.js").WikiTaskInspection | undefined>;
    events?(after?: number): AsyncIterable<import("../producer-types.js").WikiRunEvent>;
    control?(action: "pause" | "resume" | "cancel"): Promise<unknown>;
  };
  initialTaskId?: string;
  process?: boolean;
  onControl?: (action: "pause" | "cancel") => Promise<void>;
}): Promise<void> {
  if (typeof args.ui?.custom !== "function") return;
  await args.ui.custom(async (tui: OverlayTui, theme: unknown, keybindings: KeybindingsManager, done: () => void) => {
    const view = await args.handle.view();
    return createStatusOverlay({
      tui,
      theme,
      keybindings,
      done,
      handle: args.handle,
      view,
      initialTaskId: args.initialTaskId,
      process: args.process,
      onControl: args.onControl,
    });
  }, {
    overlay: true,
    overlayOptions: {
      width: "84%",
      minWidth: 36,
      maxHeight: OVERLAY_MAX_HEIGHT,
      anchor: "center",
      margin: OVERLAY_MARGIN,
      visible: (width: number, height: number) => width >= 36 && height >= 10,
    },
  });
}

type OverlayTui = {
  requestRender: (force?: boolean) => void;
  terminal?: { rows?: number };
};

function enterOverlay(state: WikiOverlayState, ctx: { taskIds: string[] }): WikiOverlayState {
  if (state.kind === "run") {
    const taskId = ctx.taskIds[state.cursor];
    if (!taskId) return state;
    return { ...state, kind: "task", taskId, scroll: 0, tailing: false };
  }
  if (state.kind === "task" && state.taskId) {
    return { ...state, kind: "process", scroll: 0, tailing: false };
  }
  return state;
}

function openProcess(state: WikiOverlayState, ctx: { taskIds: string[] }): WikiOverlayState {
  if (state.kind === "process") return state;
  const taskId = state.kind === "task" ? state.taskId : ctx.taskIds[state.cursor];
  if (!taskId) return state;
  return { ...state, kind: "process", taskId, scroll: 0, tailing: false };
}

function backOverlay(state: WikiOverlayState, ctx: { taskIds: string[] }): WikiOverlayState {
  if (state.kind === "process") {
    return { ...state, kind: "task", scroll: 0, tailing: false };
  }
  if (state.kind === "task") {
    const index = state.taskId ? ctx.taskIds.indexOf(state.taskId) : -1;
    return {
      ...state,
      kind: "run",
      scroll: 0,
      tailing: false,
      cursor: index >= 0 ? index : state.cursor,
    };
  }
  return state;
}

function withClampedCursor(state: WikiOverlayState, taskCount: number): WikiOverlayState {
  const cursor = clamp(state.cursor, 0, maxCursor(taskCount));
  return cursor === state.cursor ? state : { ...state, cursor };
}

function maxCursor(taskCount: number): number {
  return Math.max(0, taskCount - 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createStatusOverlay(args: {
  tui: OverlayTui;
  theme: unknown;
  keybindings: KeybindingsManager;
  done: () => void;
  handle: {
    view(): Promise<WikiRunView>;
    inspect(taskId: string): Promise<WikiTaskInspection | undefined>;
    events?(after?: number): AsyncIterable<WikiRunEvent>;
  };
  view: WikiRunView;
  initialTaskId?: string;
  process?: boolean;
  onControl?: (action: "pause" | "cancel") => Promise<void>;
}) {
  const taskIds = taskIdsOf(args.view);
  let view = args.view;
  let state = locateTask(initialWikiOverlayState({
    runId: view.id,
    taskCount: taskIds.length,
    initialTaskId: args.initialTaskId,
    process: args.process,
  }), taskIds);
  let inspection: WikiTaskInspection | undefined;
  let closed = false;
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  let maxScroll = 0;
  let loadGeneration = 0;
  let now = Date.now();
  let warning: string | undefined;
  let refreshInFlight = false;
  const eventController = new AbortController();

  const invalidate = (): void => {
    cachedWidth = undefined;
    cachedLines = undefined;
  };

  const context = () => {
    const ids = taskIdsOf(view);
    return { taskCount: ids.length, taskIds: ids };
  };

  const apply = (action: WikiOverlayAction): void => {
    const previous = state;
    state = reduceWikiOverlay(state, action, context());
    const selected = selectedTaskId(state, context().taskIds);
    const previousSelected = selectedTaskId(previous, context().taskIds);
    if (selected && (state.kind !== previous.kind || selected !== previousSelected)) {
      void loadInspection(selected);
    }
    invalidate();
    args.tui.requestRender();
  };

  const loadInspection = async (taskId: string): Promise<void> => {
    const generation = ++loadGeneration;
    try {
      const next = await args.handle.inspect(taskId);
      if (closed || generation !== loadGeneration) return;
      inspection = next;
      warning = undefined;
    } catch (error) {
      if (closed || generation !== loadGeneration) return;
      warning = errorMessage(error);
    }
    invalidate();
    args.tui.requestRender();
  };

  const finish = (): void => {
    if (closed) return;
    cleanup();
    args.done();
  };

  const handleControl = (action: "pause" | "cancel"): void => {
    void (async () => {
      try {
        await args.onControl?.(action);
      } finally {
        if (action === "cancel") finish();
      }
    })();
  };

  const initialSelected = selectedTaskId(state, taskIds);
  if (initialSelected) void loadInspection(initialSelected);
  const refreshSnapshot = async (): Promise<void> => {
    if (closed || refreshInFlight) return;
    refreshInFlight = true;
    const generation = ++loadGeneration;
    const selected = selectedTaskId(state, taskIdsOf(view));
    try {
      const [nextView, nextInspection] = await Promise.all([
        args.handle.view(),
        selected ? args.handle.inspect(selected) : Promise.resolve(undefined),
      ]);
      if (closed || generation !== loadGeneration) return;
      view = nextView;
      if (selected && selectedTaskId(state, taskIdsOf(nextView)) === selected) inspection = nextInspection;
      state = withClampedCursor(state, taskIdsOf(view).length);
      now = Date.now();
      warning = undefined;
    } catch (error) {
      if (closed || generation !== loadGeneration) return;
      warning = errorMessage(error);
    } finally {
      refreshInFlight = false;
    }
    invalidate();
    args.tui.requestRender();
  };
  subscribeEvents(args.handle, view.lastEventSequence, eventController.signal, refreshSnapshot);
  const tick = setInterval(() => {
    if (closed) return;
    if (warning) {
      void refreshSnapshot();
      return;
    }
    if (view.status !== "running") return;
    now = Date.now();
    invalidate();
    args.tui.requestRender();
  }, 1000);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    loadGeneration += 1;
    clearInterval(tick);
    eventController.abort();
  };

  return {
    invalidate,
    dispose() {
      cleanup();
    },
    handleInput(data: string) {
      if (closed) return;
      if (args.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
        prepareScroll();
        apply({ type: "up" });
        return;
      }
      if (args.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
        apply({ type: "down" });
        return;
      }
      if (args.keybindings.matches(data, "tui.select.pageUp")) {
        prepareScroll();
        apply({ type: "page", direction: -1 });
        return;
      }
      if (args.keybindings.matches(data, "tui.select.pageDown")) {
        apply({ type: "page", direction: 1 });
        return;
      }
      if (args.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.right)) {
        apply({ type: "enter" });
        return;
      }
      if (args.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.left)) {
        if (state.kind === "run") {
          finish();
          return;
        }
        apply({ type: "back" });
        return;
      }
      if (matchesKey(data, "o")) {
        apply({ type: "openProcess" });
        return;
      }
      if (matchesKey(data, "t")) {
        apply({ type: "toggleTail" });
        return;
      }
      if (matchesKey(data, "p")) {
        handleControl("pause");
        return;
      }
      if (matchesKey(data, "x")) handleControl("cancel");
    },
    render(width: number): string[] {
      if (cachedLines && cachedWidth === width) return cachedLines;
      const framed = frameWikiOverlay({
        width,
        title: overlayTitle(view),
        body: bodyLines(state, view, inspection, args.theme, now, warning),
        stats: selectedContextStats(state, view, inspection),
        footer: "↑↓/jk  enter  esc  o process  t tail  p pause  x cancel",
        theme: args.theme,
        viewport: viewportRows(args.tui),
        scroll: state.scroll,
        tailing: state.tailing,
      });
      maxScroll = framed.maxScroll;
      cachedWidth = width;
      cachedLines = framed.lines;
      return cachedLines;
    },
  };

  function prepareScroll(): void {
    if (state.kind === "run" || !state.tailing) return;
    state = { ...state, tailing: false, scroll: maxScroll };
  }
}

function subscribeEvents(
  handle: { events?(after?: number, signal?: AbortSignal): AsyncIterable<WikiRunEvent> },
  after: number,
  signal: AbortSignal,
  onEvent: () => Promise<void>,
): void {
  if (!handle.events) return;
  void (async () => {
    try {
      for await (const _event of handle.events!(after, signal)) {
        if (signal.aborted) return;
        await onEvent();
      }
    } catch {
      // The durable event stream may end when the run does.
    }
  })();
}

function locateTask(state: WikiOverlayState, taskIds: string[]): WikiOverlayState {
  if (!state.taskId) return state;
  const index = taskIds.indexOf(state.taskId);
  return index >= 0 ? { ...state, cursor: index } : state;
}

function taskIdsOf(view: WikiRunView): string[] {
  return view.progress?.tasks?.map((task) => task.id) ?? [];
}

export function selectedTaskId(state: WikiOverlayState, taskIds: string[]): string | undefined {
  if (state.taskId && state.kind !== "run") return state.taskId;
  return taskIds[state.cursor];
}

function overlayTitle(view: WikiRunView): string {
  return `wiki ${view.id}  ${view.status}`;
}

export function selectedContextStats(
  state: WikiOverlayState,
  view: WikiRunView,
  inspection: WikiTaskInspection | undefined,
): string | undefined {
  const taskId = selectedTaskId(state, taskIdsOf(view));
  const task = taskId ? view.progress?.tasks?.find((item) => item.id === taskId) : undefined;
  if (task?.contextRecalculating) return "context recalculating";
  const usage = usageForTask(taskId, view, inspection);
  const stats = renderWikiContextStats(usage);
  if (stats) return stats;
  return taskId ? "unavailable" : undefined;
}

function usageForTask(
  taskId: string | undefined,
  view: WikiRunView,
  inspection: WikiTaskInspection | undefined,
): WikiContextStats | undefined {
  if (!taskId) return undefined;
  const projected = view.progress?.tasks?.find((task) => task.id === taskId)?.usage;
  if (projected) return projected;
  if (inspection && inspection.task.id === taskId) return inspection.usage ?? inspection.task.usage;
  return undefined;
}

export function frameWikiOverlay(input: {
  width: number;
  title: string;
  body: string[];
  stats?: string;
  footer: string;
  theme?: unknown;
  viewport?: number;
  scroll?: number;
  tailing?: boolean;
}): { lines: string[]; maxScroll: number } {
  const width = Math.max(8, Math.floor(input.width));
  const inner = Math.max(1, width - 2);
  const hasStats = Boolean(input.stats);
  const chrome = 2 + (hasStats ? 2 : 0);
  const viewport = Math.max(1, (input.viewport ?? DEFAULT_VIEWPORT) - chrome);
  const maxScroll = Math.max(0, input.body.length - viewport);
  const scroll = input.tailing ? maxScroll : Math.min(Math.max(0, input.scroll ?? 0), maxScroll);
  const visible = input.body.slice(scroll, scroll + viewport);
  while (visible.length < viewport) visible.push("");

  const border = (text: string) => paint(input.theme, "border", text);
  const lines = [
    border(`┌${padRule(input.title, inner)}┐`),
    ...visible.map((line) => `${border("│")}${truncateToWidth(` ${line}`, inner, "...", true)}${border("│")}`),
  ];
  if (hasStats) {
    lines.push(border(`├${padRule("context", inner)}┤`));
    lines.push(`${border("│")}${truncateToWidth(` ${input.stats}`, inner, "...", true)}${border("│")}`);
  }
  lines.push(border(`└${padRule(input.footer, inner)}┘`));
  return { lines, maxScroll };
}

function padRule(label: string, inner: number): string {
  const text = label.trim() ? ` ${label.trim()} ` : "";
  const clipped = truncateToWidth(text, inner);
  return `${clipped}${"─".repeat(Math.max(0, inner - visibleWidth(clipped)))}`;
}

function viewportRows(tui: OverlayTui): number {
  const rows = tui.terminal?.rows;
  return wikiOverlayMaxHeight(
    typeof rows === "number" && Number.isFinite(rows) && rows > 6 ? rows : DEFAULT_VIEWPORT,
  );
}

export function wikiOverlayMaxHeight(terminalRows: number): number {
  const rows = Math.max(1, Math.floor(terminalRows));
  const percentHeight = Math.floor((rows * OVERLAY_MAX_HEIGHT_PERCENT) / 100);
  const availableHeight = Math.max(1, rows - OVERLAY_MARGIN * 2);
  return Math.max(1, Math.min(percentHeight, availableHeight));
}

function bodyLines(
  state: WikiOverlayState,
  view: WikiRunView,
  inspection: WikiTaskInspection | undefined,
  theme: unknown,
  now: number,
  warning: string | undefined,
): string[] {
  const text = bodyText(state, liveElapsedView(view, now), inspection);
  const lines = text.split("\n");
  const selected = selectedTaskId(state, taskIdsOf(view));
  const task = selected ? view.progress?.tasks?.find((item) => item.id === selected) : undefined;
  if (task?.status === "running") lines.splice(Math.min(2, lines.length), 0, liveTaskLine(task, now));
  if (warning) lines.splice(Math.min(2, lines.length), 0, paint(theme, "warning", `warning  ${warning}`));
  if (state.kind === "run") markCursor(lines, state.cursor, theme);
  if (lines[0]) lines[0] = paint(theme, "accent", lines[0]);
  return lines;
}

function liveElapsedView(view: WikiRunView, now: number): WikiRunView {
  return view.status === "running" ? { ...view, updatedAt: new Date(now).toISOString() } : view;
}

function liveTaskLine(task: WikiTaskSnapshot, now: number): string {
  const parts: string[] = [];
  if (task.activeTool?.name) parts.push(`tool ${task.activeTool.name}`);
  else if (task.activity && task.activity !== "idle") parts.push(task.activity);
  else parts.push("running");
  const sampled = task.sampledAt ? Date.parse(task.sampledAt) : Number.NaN;
  if (Number.isFinite(sampled)) parts.push(`last confirmed ${formatAge(now - sampled)}`);
  if (task.contextRecalculating) parts.push("context recalculating");
  return `live  ${parts.join("  ·  ")}`;
}

function formatAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function bodyText(
  state: WikiOverlayState,
  view: WikiRunView,
  inspection: WikiTaskInspection | undefined,
): string {
  if (state.kind === "run") return renderWikiRun(view);
  if (!inspection) return `Wiki ${state.runId}  ·  ${state.taskId ?? "task"}\nTask not available.`;
  return state.kind === "process" ? renderWikiTaskProcess(inspection) : renderWikiTask(inspection);
}

function markCursor(lines: string[], cursor: number, theme: unknown): void {
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!TASK_LINE.test(line)) continue;
    index += 1;
    if (index !== cursor) continue;
    lines[i] = paint(theme, "accent", `>${line.slice(1)}`);
    return;
  }
}

function paint(theme: unknown, color: string, text: string): string {
  if (!theme || typeof theme !== "object" || !("fg" in theme)) return text;
  const fg = (theme as { fg?: unknown }).fg;
  return typeof fg === "function" ? String((fg as (name: string, value: string) => string)(color, text)) : text;
}
