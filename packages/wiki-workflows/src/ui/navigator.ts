import {
  DynamicBorder,
  getSelectListTheme,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  parseKey,
  SelectList,
  Text,
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
import { asText, errorMessage, isActiveRunStatus, isTerminalRunStatus, PLAIN_THEME } from "./format.js";
import { WikiUiModel, type WikiNavigatorController } from "./model.js";
import { attemptNumbers } from "./render/agent.js";
import { NAVIGATOR_FOOTER_ROWS, renderHelp, withNavigatorFooter } from "./render/chrome.js";
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
    const safeWidth = Math.max(20, width);
    const safeRows = Math.max(8, viewportRows);
    state.sync(model);
    state.setPageSize(Math.max(1, safeRows - 6));

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
 * Opens the on-demand Wiki navigator overlay.
 * Confirmations use `ui.confirm` outside nested custom UI.
 *
 * Live shell uses Pi framework Container + DynamicBorder; the runs view wires
 * a live SelectList. Pure frame rendering remains available for tests.
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

    const shell = new Container();
    const borderColor = (text: string) => theme.fg(focused ? "accent" : "borderMuted", text);
    const topBorder = new DynamicBorder(borderColor);
    const bottomBorder = new DynamicBorder(borderColor);
    const titleText = new Text(theme.fg("accent", theme.bold(" wiki workflow ")), 0, 0);
    const bodyText = new Text("", 0, 0);
    const footerText = new Text("", 0, 0);

    shell.addChild(topBorder);
    shell.addChild(titleText);
    shell.addChild(bodyText);
    shell.addChild(footerText);
    shell.addChild(bottomBorder);

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
        return getSelectListTheme();
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
      const key = items.map((item) => item.value).join("\0");
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
            await Promise.resolve(controller.resume());
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
          case "confirmCancel": {
            const prompt = cancelConfirm(language);
            const ok = await ui.confirm(prompt.title, prompt.message);
            if (ok) await Promise.resolve(controller.cancel());
            return;
          }
          case "confirmDelete": {
            const prompt = deleteConfirm(language);
            const ok = await ui.confirm(prompt.title, prompt.message);
            if (ok) {
              await Promise.resolve(controller.deleteRun(action.runId));
              state.openRuns();
              rerender();
            }
            return;
          }
          case "confirmRetry": {
            const run = model.getRun(action.runId) ?? await controller.loadRun(action.runId);
            if (!run) {
              notify("Wiki run history is unavailable", "warning");
              return;
            }
            const prompt = retryAgentConfirm(run, action.nodeId, language);
            if (!prompt) {
              notify("Selected retry target no longer exists", "warning");
              return;
            }
            const ok = await ui.confirm(prompt.title, prompt.message);
            if (ok) {
              const snapshot = await Promise.resolve(controller.retryNode(action.runId, action.nodeId));
              if (snapshot) state.openDashboard(snapshot.id);
              rerender();
            }
            return;
          }
          case "confirmRetryPhase": {
            const run = model.getRun(action.runId) ?? await controller.loadRun(action.runId);
            if (!run) {
              notify("Wiki run history is unavailable", "warning");
              return;
            }
            const prompt = retryPhaseConfirm(run, action.phaseId, language);
            if (!prompt) {
              notify("Selected retry target no longer exists", "warning");
              return;
            }
            const ok = await ui.confirm(prompt.title, prompt.message);
            if (ok) {
              const snapshot = await Promise.resolve(controller.retryPhase(action.runId, action.phaseId));
              if (snapshot) state.openDashboard(snapshot.id);
              rerender();
            }
            return;
          }
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
          if (!run || state.runId !== activeRunId) {
            return { type: "notify", message: s.selectActivePause, level: "info" };
          }
          if (run.status === "paused") return { type: "resume" };
          if (run.status === "running") return { type: "pause" };
          return { type: "notify", message: s.onlyRunningPause, level: "warning" };
        }
        case "cancel": {
          if (!run || state.runId !== activeRunId || !isActiveRunStatus(run.status)) {
            return { type: "notify", message: s.noActiveCancel, level: "info" };
          }
          return { type: "confirmCancel" };
        }
        case "retry": {
          const node = model.node(state.runId, state.nodeId);
          if (!node || !state.runId) {
            return { type: "notify", message: s.selectAgentRetry, level: "warning" };
          }
          if (node.status === "running" || node.status === "queued") {
            return { type: "notify", message: s.waitAgentSettle, level: "warning" };
          }
          return { type: "confirmRetry", runId: state.runId, nodeId: node.id };
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
          if (nodes.some((node) => node.status === "running")) {
            return { type: "notify", message: s.waitPhaseSettle, level: "warning" };
          }
          return { type: "confirmRetryPhase", runId: run.id, phaseId: state.stageId };
        }
        case "delete": {
          if (state.view !== "runs") {
            return { type: "notify", message: s.returnToRunsDelete, level: "info" };
          }
          const selected = model.listRuns()[state.runCursor];
          if (!selected || selected.id === activeRunId || !isTerminalRunStatus(selected.status)) {
            return { type: "notify", message: s.onlyCompletedDelete, level: "warning" };
          }
          return { type: "confirmDelete", runId: selected.id };
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
        const terminalRows = tui.terminal?.rows ?? 24;
        const modalRows = Math.max(8, Math.floor(terminalRows * 0.92));
        // DynamicBorder top/bottom + title + footer consume rows outside the body.
        const chromeRows = 4;
        const contentRows = Math.max(6, modalRows - chromeRows);
        const s = uiStrings(language);
        const title = theme.fg(focused ? "accent" : "borderMuted", theme.bold(" wiki workflow "));
        titleText.setText(title);

        // Runs view: live SelectList; other views: pure frame body as Text.
        if (state.view === "runs" && !state.showHelp) {
          state.sync(model);
          const runs = model.listRuns();
          const items = buildRunSelectItems(runs, model.getActiveRunId(), language);
          const listRows = Math.max(3, contentRows - 2);
          if (!items.length) {
            const empty = renderWikiNavigatorFrame(state, model, Math.max(20, width - 2), theme, contentRows, language);
            bodyText.setText(empty.slice(0, Math.max(1, contentRows - 1)).join("\n"));
            footerText.setText(theme.fg("muted", `  ${s.footerRuns}`));
            return shell.render(width);
          }
          const list = ensureRunsList(items, listRows);
          const listLines = list.render(Math.max(20, width - 2));
          const header = theme.fg("accent", theme.bold(s.runsTitle));
          bodyText.setText([header, ...listLines].join("\n"));
          footerText.setText(theme.fg("muted", `  ${s.footerRuns}`));
          return shell.render(width);
        }

        const raw = renderWikiNavigatorFrame(state, model, Math.max(20, width - 2), theme, contentRows, language);
        // Split footer from body for DynamicBorder chrome (last non-empty hint line kept).
        const body = raw.slice(0, Math.max(0, raw.length - NAVIGATOR_FOOTER_ROWS));
        const footer = raw.slice(Math.max(0, raw.length - 1));
        bodyText.setText(body.join("\n"));
        footerText.setText(footer.join("\n") || theme.fg("muted", `  ${asText(s.footerHelp)}`));
        return shell.render(width);
      },
      handleInput: (data) => {
        if (busy || closed) return;

        // Prefer SelectList for runs navigation when present.
        if (state.view === "runs" && !state.showHelp && runsList && model.listRuns().length) {
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
          action.type === "confirmCancel"
          || action.type === "confirmDelete"
          || action.type === "confirmRetry"
          || action.type === "confirmRetryPhase"
          || action.type === "loadRun"
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
        shell.invalidate();
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
