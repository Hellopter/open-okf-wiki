import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { WikiWorkflowEngine } from "../engine.js";
import type { WikiRunEvent, WikiRunSnapshot } from "../workflow-types.js";
import { isTerminalRunStatus } from "./format.js";
import type { WikiNavigatorController, WikiNavigatorWorkspace } from "./model.js";
import { openWikiNavigator } from "./navigator.js";
import {
  clearTaskPanel,
  installTaskPanel,
  STATUS_KEY,
  statusLine,
  type ProgressMode,
  type TaskPanelSnapshot,
} from "./task-panel.js";
import { uiStrings, type WikiUiLanguage } from "./strings.js";
import { renderWikiResultDelivery } from "./text.js";

const RESULT_CUSTOM_TYPE = "okf-wiki-result";
const TERMINAL_EVENTS = new Set(["run_completed", "run_cancelled", "run_blocked"]);

export interface WikiUiHostBindOptions {
  engine: WikiWorkflowEngine;
  ui: ExtensionUIContext;
  pi: ExtensionAPI;
  language?: WikiUiLanguage;
  getController: () => WikiNavigatorController;
  progressMode?: ProgressMode;
}

export interface WikiUiHostUnbindOptions {
  /** Clear retained terminal panel state and delivery bookkeeping (session end). */
  clearRetention?: boolean;
}

/**
 * Session-scoped dual-track UI host:
 * 1. Non-blocking task panel + status (live while bound, except during navigator overlays)
 * 2. On-demand navigator overlay via openNavigator()
 */
export class WikiUiHost {
  private engine: WikiWorkflowEngine | undefined;
  private ui: ExtensionUIContext | undefined;
  private pi: ExtensionAPI | undefined;
  private language: WikiUiLanguage | undefined;
  private getController: (() => WikiNavigatorController) | undefined;
  private unsubscribe: (() => void) | undefined;
  private retainedRun: WikiRunSnapshot | undefined;
  private deliveredRunIds = new Set<string>();
  private progressMode: ProgressMode = "compact";
  /** Active navigator overlays own the viewport, so freeze lower UI updates. */
  private navigatorDepth = 0;
  private bound = false;

  bind(options: WikiUiHostBindOptions): void {
    // Soft unbind: keep retainedRun / deliveredRunIds so reopening the navigator
    // does not empty a finished-run panel mid-session.
    this.unbind({ clearRetention: false });
    this.engine = options.engine;
    this.ui = options.ui;
    this.pi = options.pi;
    this.language = options.language;
    this.getController = options.getController;
    this.progressMode = options.progressMode ?? "compact";
    this.bound = true;

    // If the engine already holds a terminal snapshot and we have no retention yet, keep it.
    const existing = options.engine.getSnapshot();
    if (existing && isTerminalRunStatus(existing.status) && !this.retainedRun) {
      this.retainedRun = structuredClone(existing);
    }

    this.unsubscribe = options.engine.subscribe((snapshot, event) => {
      this.onEngineEvent(snapshot, event);
    });

    installTaskPanel(options.ui, () => this.panelSnapshot(), this.progressMode);
    this.refresh();
  }

  unbind(options: WikiUiHostUnbindOptions = {}): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.ui) {
      clearTaskPanel(this.ui);
      this.ui.setStatus(STATUS_KEY, undefined);
    }
    this.engine = undefined;
    this.ui = undefined;
    this.pi = undefined;
    this.getController = undefined;
    this.navigatorDepth = 0;
    this.bound = false;
    if (options.clearRetention) {
      this.retainedRun = undefined;
      this.deliveredRunIds.clear();
    }
  }

  setLanguage(language: WikiUiLanguage | undefined): void {
    this.language = language;
    this.refresh();
  }

  /** Call after generate/refresh so a previous terminal run is replaced. */
  onRunStarted(snapshot: WikiRunSnapshot): void {
    this.retainedRun = undefined;
    this.deliveredRunIds.delete(snapshot.id);
    this.language = snapshot.language;
    this.refresh(snapshot);
  }

  refresh(snapshot?: WikiRunSnapshot): void {
    if (!this.bound || !this.ui || this.navigatorDepth > 0) return;
    const run = snapshot ?? this.engine?.getSnapshot() ?? this.retainedRun;
    const language = this.language ?? run?.language;
    this.ui.setStatus(STATUS_KEY, statusLine(run, language));
    installTaskPanel(this.ui, () => this.panelSnapshot(run), this.progressMode);
  }

  async openNavigator(context?: Pick<ExtensionCommandContext, "ui" | "hasUI" | "mode">): Promise<boolean> {
    const ui = context?.ui ?? this.ui;
    if (!ui) return false;
    if (context && (!context.hasUI || context.mode !== "tui")) return false;
    const controller = this.getController?.();
    if (!controller) return false;
    const activeId = controller.getActiveRunId();
    const language = this.language
      ?? controller.getWorkspace?.()?.language
      ?? controller.getRun()?.language;
    const firstNavigator = this.navigatorDepth === 0;
    this.navigatorDepth += 1;
    if (firstNavigator && this.ui) clearTaskPanel(this.ui);
    try {
      await openWikiNavigator(ui, controller, {
        initialRunId: activeId,
        language,
      });
    } finally {
      this.navigatorDepth = Math.max(0, this.navigatorDepth - 1);
      // Restore once the final navigator closes, using the newest engine state.
      if (this.navigatorDepth === 0) this.refresh();
    }
    return true;
  }

  private onEngineEvent(snapshot: WikiRunSnapshot, event: WikiRunEvent): void {
    this.language = snapshot.language;
    if (isTerminalRunStatus(snapshot.status)) {
      this.retainedRun = structuredClone(snapshot);
      if (TERMINAL_EVENTS.has(event.kind)) this.deliver(snapshot);
    } else if (snapshot.status === "running" || snapshot.status === "paused") {
      this.retainedRun = undefined;
    }
    this.refresh(snapshot);
  }

  private deliver(snapshot: WikiRunSnapshot): void {
    if (!this.pi || this.deliveredRunIds.has(snapshot.id)) return;
    this.deliveredRunIds.add(snapshot.id);
    const content = renderWikiResultDelivery(snapshot);
    try {
      this.pi.sendMessage(
        { customType: RESULT_CUSTOM_TYPE, content, display: true },
        { triggerTurn: false, deliverAs: "followUp" },
      );
    } catch {
      // Delivery is best-effort; panel/status remain the source of truth.
    }
  }

  private panelSnapshot(run?: WikiRunSnapshot): TaskPanelSnapshot {
    const current = run ?? this.engine?.getSnapshot() ?? this.retainedRun;
    return {
      run: current,
      language: this.language ?? current?.language,
      retainTerminal: Boolean(this.retainedRun && current?.id === this.retainedRun.id),
    };
  }
}

export function createWikiUiHost(): WikiUiHost {
  return new WikiUiHost();
}

export function notifyRunStarted(
  ui: ExtensionUIContext,
  snapshot: WikiRunSnapshot,
  language?: WikiUiLanguage,
): void {
  const s = uiStrings(language ?? snapshot.language);
  ui.notify(s.startedNotify(snapshot.effectiveMode ?? snapshot.requestedMode), "info");
}

export type { WikiNavigatorWorkspace };
