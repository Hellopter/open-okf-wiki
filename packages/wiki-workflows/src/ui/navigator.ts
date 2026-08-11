import {
  getSelectListTheme,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  parseKey,
  SelectList,
  type Component,
  type Focusable,
  type SelectItem,
  type SelectListTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { latestPhaseIteration } from "../phase-iterations.js";
import {
  cancelConfirm,
  deleteConfirm,
  retryAgentConfirm,
  retryPhaseConfirm,
} from "./confirm.js";
import { errorMessage, fitRows, isActiveRunStatus, isTerminalRunStatus, PLAIN_THEME } from "./format.js";
import { WikiUiModel, type WikiNavigatorController } from "./model.js";
import { attemptNumbers } from "./render/agent.js";
import {
  borderTitle,
  NAVIGATOR_FOOTER_ROWS,
  renderHelp,
  withNavigatorFooter,
  wrapBorderedBody,
} from "./render/chrome.js";
import { renderDashboard } from "./render/dashboard.js";
import { renderAgentView } from "./render/agent.js";
import { buildRunSelectItems, renderLoadingRun, renderRunsList } from "./render/runs.js";
import { keyToNavigatorIntent, NavigatorState, type WikiNavigatorAction } from "./state.js";
import { phaseRows } from "./stages.js";
import { uiStrings, type WikiUiLanguage } from "./strings.js";

export interface OpenWikiNavigatorOptions {
  /** When set, land on the dashboard for this run (active-run open). */
  initialRunId?: string;
  language?: WikiUiLanguage;
}

/** Matches Pi's 92%-height overlay after its one-cell top/bottom margins. */
function navigatorOverlayRows(terminalRows: number): number {
  const rows = Math.max(1, Math.floor(terminalRows));
  const availableRows = Math.max(1, rows - 2);
  return Math.max(1, Math.min(Math.floor(rows * 0.92), availableRows));
}

/**
 * Pure frame renderer for the three-level navigator (testable without TUI).
 */
export function renderWikiNavigatorFrame(
  state: NavigatorState,
  model: WikiUiModel,
  width: number,
  theme: typeof PLAIN_THEME = PLAIN_THEME,
  viewportRows = 24,
  language?: WikiUiLanguage,
): string[] {
  return model.withRenderFrame(() => {
    const safeWidth = Math.max(1, width);
    const safeRows = Math.max(3, viewportRows);
    state.sync(model);
    state.setPageSize(Math.max(1, safeRows - NAVIGATOR_FOOTER_ROWS));

    if (state.confirmation) {
      return withNavigatorFooter(
        renderNavigatorConfirmation(state.confirmation.title, state.confirmation.message, theme),
        state,
        safeRows,
        safeWidth,
        theme,
        language,
      );
    }

    if (state.showHelp) {
      return withNavigatorFooter(renderHelp(safeWidth, theme, language), state, safeRows, safeWidth, theme, language);
    }

    if (state.view === "runs") {
      const runs = model.listRuns();
      const body = renderRunsList(state, runs, model.getActiveRunId(), safeWidth, theme, Math.max(1, safeRows - NAVIGATOR_FOOTER_ROWS), language);
      return withNavigatorFooter(body, state, safeRows, safeWidth, theme, language);
    }

    const run = model.getRun(state.runId);
    if (!run) {
      const workspace = model.getWorkspace();
      return withNavigatorFooter(
        renderLoadingRun(safeWidth, theme, language, workspace?.root),
        state,
        safeRows,
        safeWidth,
        theme,
        language,
      );
    }

    if (state.view === "dashboard") {
      const body = renderDashboard(state, run, safeWidth, theme, Math.max(1, safeRows - NAVIGATOR_FOOTER_ROWS), language);
      return withNavigatorFooter(body, state, safeRows, safeWidth, theme, language);
    }

    const node = model.node(state.runId, state.nodeId);
    if (!node) {
      return withNavigatorFooter(
        [theme.fg("muted", "No agent selected.")],
        state,
        safeRows,
        safeWidth,
        theme,
        language,
      );
    }
    const body = renderAgentView(state, run, node, safeWidth, theme, Math.max(1, safeRows - NAVIGATOR_FOOTER_ROWS), language);
    return withNavigatorFooter(body, state, safeRows, safeWidth, theme, language);
  });
}

/**
 * Opens the on-demand Wiki navigator overlay. Confirmations are rendered in the
 * navigator itself so focus and keyboard ownership stay with this overlay.
 */
export function openWikiNavigator(
  ui: ExtensionUIContext,
  controller: WikiNavigatorController,
  options: OpenWikiNavigatorOptions = {},
): Promise<void> {
  const model = new WikiUiModel(controller);
  const state = new NavigatorState();
  const language = options.language
    ?? controller.getWorkspace?.()?.language
    ?? controller.getRun()?.language;

  if (options.initialRunId) {
    // Caller supplies an active run id (host already filtered via getActiveRunId).
    state.openDashboard(options.initialRunId);
  } else {
    const active = controller.getActiveRunId();
    if (active) state.openDashboard(active);
    else state.openRuns();
  }

  return ui.custom<void>((tui: TUI, theme: Theme, _keybindings, done) => {
    let closed = false;
    let focused = false;
    let busy = false;
    let runsList: SelectList | undefined;
    let runsListKey = "";

    const borderColor = (text: string) => theme.fg(focused ? "accent" : "borderMuted", text);

    const rerender = () => tui.requestRender();
    const unsubscribe = model.subscribe(() => {
      state.sync(model);
      rerender();
    });

    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      done(undefined);
    };

    const selectTheme = (): SelectListTheme => {
      try {
        const selectListTheme = getSelectListTheme();
        // getSelectListTheme can return callbacks backed by an uninitialized
        // global theme in non-interactive hosts, so validate before retaining it.
        selectListTheme.selectedPrefix("");
        selectListTheme.selectedText("");
        selectListTheme.description("");
        selectListTheme.scrollInfo("");
        selectListTheme.noMatch("");
        return selectListTheme;
      } catch {
        return {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("muted", text),
          noMatch: (text) => theme.fg("muted", text),
        };
      }
    };

    const ensureRunsList = (items: SelectItem[], maxVisible: number): SelectList => {
      // Labels and descriptions carry status/progress. Recreate when either changes,
      // and when resizing changes the visible window. The cursor lives in state, so
      // rebuilding does not disrupt keyboard navigation.
      const key = JSON.stringify({ items, maxVisible: Math.max(1, maxVisible) });
      if (!runsList || runsListKey !== key) {
        runsList = new SelectList(items, Math.max(1, maxVisible), selectTheme(), {
          minPrimaryColumnWidth: 16,
          maxPrimaryColumnWidth: 48,
        });
        runsListKey = key;
        runsList.onSelectionChange = (item) => {
          const index = items.findIndex((entry) => entry.value === item.value);
          if (index >= 0) state.runCursor = index;
        };
        runsList.onSelect = (item) => {
          void handleAction({ type: "loadRun", runId: item.value }).finally(rerender);
        };
        runsList.onCancel = () => {
          void handleAction({ type: "close" });
        };
      }
      runsList.setSelectedIndex(Math.max(0, Math.min(state.runCursor, Math.max(0, items.length - 1))));
      return runsList;
    };

    const runCount = () => {
      if (state.view === "runs") return model.listRuns().length;
      if (state.view === "dashboard") {
        if (state.pane === "stages") return model.phases(state.runId).length;
        return model.agents(state.runId, model.phases(state.runId)[state.stageCursor]?.id).length;
      }
      return 0;
    };

    const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
      ui.notify(message, level);
    };

    const handleAction = async (action: WikiNavigatorAction): Promise<void> => {
      try {
        switch (action.type) {
          case "close":
            close();
            return;
          case "notify":
            notify(action.message, action.level);
            return;
          case "loadRun": {
            const loaded = await controller.loadRun(action.runId);
            if (!loaded) {
              notify("Wiki run history is unavailable", "warning");
              return;
            }
            state.openDashboard(loaded.id);
            rerender();
            return;
          }
          case "pause":
            await Promise.resolve(controller.pause());
            return;
          case "resume":
            await Promise.resolve(controller.resume(action.runId));
            return;
          case "cancel":
            await Promise.resolve(controller.cancel());
            return;
          case "retry": {
            const snapshot = await Promise.resolve(controller.retryNode(action.runId, action.nodeId));
            if (snapshot) state.openDashboard(snapshot.id);
            rerender();
            return;
          }
          case "retryPhase": {
            const snapshot = await Promise.resolve(controller.retryPhase(action.runId, action.phaseId));
            if (snapshot) state.openDashboard(snapshot.id);
            rerender();
            return;
          }
          case "deleteRun":
            await Promise.resolve(controller.deleteRun(action.runId));
            state.openRuns();
            rerender();
            return;
          default:
            return;
        }
      } catch (error) {
        notify(`Wiki run action failed: ${errorMessage(error)}`, "error");
      }
    };

    const dispatchKey = (key: string | undefined): WikiNavigatorAction => {
      const s = uiStrings(language);
      const intent = keyToNavigatorIntent(key, state);
      const activeRunId = model.getActiveRunId();
      const run = model.getRun(state.runId);

      switch (intent) {
        case "confirm": {
          const confirmation = state.takeConfirmation();
          if (!confirmation) return { type: "none" };
          const confirmedRun = model.getRun(confirmation.runId);
          if (confirmation.kind === "cancel") {
            if (!confirmedRun || model.getActiveRunId() !== confirmation.runId || !isActiveRunStatus(confirmedRun.status)) {
              return { type: "notify", message: s.noActiveCancel, level: "info" };
            }
            return { type: "cancel" };
          }
          if (confirmation.kind === "delete") {
            const selected = model.listRuns().find((item) => item.id === confirmation.runId);
            const current = model.getRun();
            if (!selected || selected.id === current?.id) {
              return { type: "notify", message: s.currentRunCannotDelete, level: "info" };
            }
            if (!isTerminalRunStatus(selected.status)) {
              return { type: "notify", message: s.onlyCompletedDelete, level: "warning" };
            }
            return { type: "deleteRun", runId: confirmation.runId };
          }
          if (!confirmedRun) {
            return { type: "notify", message: "Wiki run history is unavailable", level: "warning" };
          }
          if (confirmation.kind === "retry") {
            const node = confirmation.nodeId && confirmedRun.nodes.find((item) => item.id === confirmation.nodeId);
            if (!node) return { type: "notify", message: s.selectAgentRetry, level: "warning" };
            // Block only when this run is active and the engine still has a live executor.
            if (confirmation.runId === model.getActiveRunId() && model.isNodeLive(node.id)) {
              return { type: "notify", message: s.waitAgentSettle, level: "warning" };
            }
            return { type: "retry", runId: confirmation.runId, nodeId: node.id };
          }
          const phase = confirmation.phaseId
            ? phaseRows(confirmedRun).find((item) => item.id === confirmation.phaseId)
            : undefined;
          if (!phase?.nodeIds.length) {
            return { type: "notify", message: s.stageNotScheduled(phase?.title ?? "This stage"), level: "info" };
          }
          if (
            confirmation.runId === model.getActiveRunId()
            && latestPhaseIteration(confirmedRun.nodes, phase.id).some((node) => model.isNodeLive(node.id))
          ) {
            return { type: "notify", message: s.waitPhaseSettle, level: "warning" };
          }
          return { type: "retryPhase", runId: confirmation.runId, phaseId: phase.id };
        }
        case "help":
          state.showHelp = !state.showHelp;
          return { type: "none" };
        case "close":
          return { type: "close" };
        case "back":
          if (!state.back()) return { type: "close" };
          return { type: "none" };
        case "moveUp":
          state.move(-1, runCount());
          if (state.view === "dashboard") syncDashboardSelection(state, model);
          return { type: "none" };
        case "moveDown":
          state.move(1, runCount());
          if (state.view === "dashboard") syncDashboardSelection(state, model);
          return { type: "none" };
        case "pageUp":
          state.movePage(-1, runCount());
          if (state.view === "dashboard") syncDashboardSelection(state, model);
          return { type: "none" };
        case "pageDown":
          state.movePage(1, runCount());
          if (state.view === "dashboard") syncDashboardSelection(state, model);
          return { type: "none" };
        case "jumpStart":
          state.jump("start", runCount());
          if (state.view === "dashboard") syncDashboardSelection(state, model);
          return { type: "none" };
        case "jumpEnd":
          state.jump("end", runCount());
          if (state.view === "dashboard") syncDashboardSelection(state, model);
          return { type: "none" };
        case "paneToggle":
          state.switchPane();
          return { type: "none" };
        case "paneLeft":
          state.switchPane("stages");
          return { type: "none" };
        case "paneRight":
          state.switchPane("agents");
          return { type: "none" };
        case "drill":
          if (state.view === "runs") {
            const selected = model.listRuns()[state.runCursor];
            if (selected) return { type: "loadRun", runId: selected.id };
            return { type: "none" };
          }
          state.drill(model);
          return { type: "none" };
        case "follow":
          state.toggleFollow();
          return { type: "none" };
        case "attemptPrev":
        case "attemptNext": {
          const node = model.node(state.runId, state.nodeId);
          if (node) state.cycleAttempt(intent === "attemptPrev" ? -1 : 1, attemptNumbers(node));
          return { type: "none" };
        }
        case "pause": {
          if (!run || !state.runId) {
            return { type: "notify", message: s.selectActivePause, level: "info" };
          }
          if (state.runId === activeRunId) {
            if (run.status === "paused") return { type: "resume", runId: run.id };
            if (run.status === "running") return { type: "pause" };
          }
          if (!activeRunId && (run.status === "running" || run.status === "paused")) {
            return { type: "resume", runId: run.id };
          }
          if (activeRunId !== undefined) {
            return { type: "notify", message: s.anotherRunActive, level: "warning" };
          }
          return { type: "notify", message: s.onlyRunningPause, level: "warning" };
        }
        case "cancel": {
          if (!run || state.runId !== activeRunId || !isActiveRunStatus(run.status)) {
            return { type: "notify", message: s.noActiveCancel, level: "info" };
          }
          const prompt = cancelConfirm(language);
          state.openConfirmation({ kind: "cancel", runId: run.id, title: prompt.title, message: prompt.message });
          return { type: "none" };
        }
        case "retry": {
          const nodeId = state.selectedAgentId(model);
          const node = model.node(state.runId, nodeId);
          if (!node || !run || !state.runId) {
            return { type: "notify", message: s.selectAgentRetry, level: "warning" };
          }
          if (state.runId === activeRunId && model.isNodeLive(node.id)) {
            return { type: "notify", message: s.waitAgentSettle, level: "warning" };
          }
          const prompt = retryAgentConfirm(run, node.id, language);
          if (!prompt) return { type: "notify", message: s.selectAgentRetry, level: "warning" };
          state.openConfirmation({ kind: "retry", runId: state.runId, nodeId: node.id, title: prompt.title, message: prompt.message });
          return { type: "none" };
        }
        case "retryPhase": {
          if (state.view !== "dashboard" || !run || !state.stageId) {
            return { type: "notify", message: s.selectStageRetry, level: "warning" };
          }
          const phase = phaseRows(run).find((item) => item.id === state.stageId);
          if (!phase?.nodeIds.length) {
            return { type: "notify", message: s.stageNotScheduled(phase?.title ?? "This stage"), level: "info" };
          }
          const nodes = latestPhaseIteration(run.nodes, state.stageId);
          if (state.runId === activeRunId && nodes.some((node) => model.isNodeLive(node.id))) {
            return { type: "notify", message: s.waitPhaseSettle, level: "warning" };
          }
          const prompt = retryPhaseConfirm(run, state.stageId, language);
          if (!prompt) return { type: "notify", message: s.selectStageRetry, level: "warning" };
          state.openConfirmation({ kind: "retryPhase", runId: run.id, phaseId: state.stageId, title: prompt.title, message: prompt.message });
          return { type: "none" };
        }
        case "delete": {
          if (state.view !== "runs") {
            return { type: "notify", message: s.returnToRunsDelete, level: "info" };
          }
          const selected = model.listRuns()[state.runCursor];
          const current = model.getRun();
          if (selected?.id === current?.id) {
            return { type: "notify", message: s.currentRunCannotDelete, level: "info" };
          }
          if (!selected || selected.id === activeRunId || !isTerminalRunStatus(selected.status)) {
            return { type: "notify", message: s.onlyCompletedDelete, level: "warning" };
          }
          const prompt = deleteConfirm(language);
          state.openConfirmation({ kind: "delete", runId: selected.id, title: prompt.title, message: prompt.message });
          return { type: "none" };
        }
        default:
          return { type: "none" };
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
        const targetRows = navigatorOverlayRows(tui.terminal?.rows ?? 24);
        const contentWidth = Math.max(0, width - 4);
        const innerRows = Math.max(1, targetRows - 2);
        const s = uiStrings(language);

        // A frame needs two corners and at least one interior row. On a terminal
        // smaller than that, render the available rows without exceeding the overlay
        // maxHeight that Pi applies.
        if (width < 4 || targetRows < 3) {
          return Array.from({ length: targetRows }, () => borderColor("─".repeat(Math.max(1, width))));
        }

        let inner: string[];

        // Runs view: live SelectList; other views: pure frame body as Text.
        if (state.view === "runs" && !state.showHelp) {
          state.sync(model);
          const runs = model.listRuns();
          const items = buildRunSelectItems(runs, model.getActiveRunId(), language);
          if (!items.length) {
            inner = renderWikiNavigatorFrame(state, model, contentWidth, theme, innerRows, language);
          } else {
            // Leave space for the header and, when needed, SelectList's scroll row.
            const bodyRows = Math.max(1, innerRows - NAVIGATOR_FOOTER_ROWS);
            const listRows = Math.max(1, bodyRows - 2);
            const list = ensureRunsList(items, listRows);
            const listLines = list.render(contentWidth);
            const header = theme.fg("accent", theme.bold(s.runsTitle));
            const body = [header, ...listLines];
            inner = withNavigatorFooter(body, state, innerRows, contentWidth, theme, language);
          }
        } else {
          inner = renderWikiNavigatorFrame(state, model, contentWidth, theme, innerRows, language);
        }

        const frame = borderTitle(theme.bold("wiki workflow"), contentWidth, theme, focused);
        return [frame.top, ...wrapBorderedBody(fitRows(inner, innerRows, contentWidth), contentWidth, theme, focused), frame.bottom];
      },
      handleInput: (data) => {
        if (busy || closed) return;

        // Prefer SelectList for runs navigation when present.
        if (state.view === "runs" && !state.showHelp && !state.confirmation && runsList && model.listRuns().length) {
          const key = parseKey(data);
          // Keys SelectList owns: arrows/enter/escape via its keybindings. Also allow j/k/q/x/? via dispatch.
          if (key === "up" || key === "down" || key === "enter" || key === "return" || key === "escape" || key === "esc") {
            const before = runsList.getSelectedItem()?.value;
            runsList.handleInput(data);
            const after = runsList.getSelectedItem();
            if (after && after.value !== before) {
              const items = buildRunSelectItems(model.listRuns(), model.getActiveRunId(), language);
              const index = items.findIndex((item) => item.value === after.value);
              if (index >= 0) state.runCursor = index;
            }
            // Enter/escape are handled by SelectList callbacks (loadRun / close).
            if (key === "enter" || key === "return" || key === "escape" || key === "esc") {
              rerender();
              return;
            }
            rerender();
            return;
          }
        }

        const action = dispatchKey(parseKey(data));
        if (action.type === "none") {
          rerender();
          return;
        }
        if (
          action.type === "loadRun"
          || action.type === "retry"
          || action.type === "retryPhase"
          || action.type === "deleteRun"
          || action.type === "pause"
          || action.type === "resume"
          || action.type === "cancel"
        ) {
          busy = true;
          void handleAction(action).finally(() => {
            busy = false;
            rerender();
          });
          return;
        }
        void handleAction(action);
        rerender();
      },
      invalidate: () => {
        runsList?.invalidate();
        rerender();
      },
      dispose: () => {
        // Same close path as user quit: unsubscribe + done(undefined).
        close();
      },
    };
    return component;
  }, {
    overlay: true,
    overlayOptions: { width: "88%", minWidth: 68, maxHeight: "92%", anchor: "center", margin: 1 },
  });
}

/** Alias matching the previous public name. */
export const openWikiRunNavigator = openWikiNavigator;

function syncDashboardSelection(state: NavigatorState, model: WikiUiModel): void {
  if (state.view !== "dashboard" || !state.runId) return;
  state.sync(model);
}

function renderNavigatorConfirmation(title: string, message: string, theme: typeof PLAIN_THEME): string[] {
  return [theme.bold(title), ...message.split("\n").map((line) => theme.fg("muted", line))];
}
