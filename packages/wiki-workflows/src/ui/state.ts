import type { WikiUiModel } from "./model.js";
import { phaseRows } from "./stages.js";

export type NavigatorView = "runs" | "dashboard" | "agent";
export type DashboardPane = "stages" | "agents";
export type NavigatorConfirmationKind = "cancel" | "delete" | "retry" | "retryPhase";

export interface NavigatorConfirmation {
  kind: NavigatorConfirmationKind;
  runId: string;
  title: string;
  message: string;
  nodeId?: string;
  phaseId?: string;
}

interface StackFrame {
  view: NavigatorView;
  runId?: string;
  stageId?: string;
  nodeId?: string;
  stageCursor: number;
  agentCursor: number;
  runCursor: number;
}

/**
 * Three-level navigator stack: runs → dashboard → agent.
 * Dashboard owns a two-pane focus (stages | agents).
 */
export class NavigatorState {
  private stack: StackFrame[] = [{ view: "runs", stageCursor: 0, agentCursor: 0, runCursor: 0 }];
  pane: DashboardPane = "stages";
  showHelp = false;
  pagerOpen = false;
  followOutput = true;
  detailScroll = 0;
  /** Last computed max scroll from agent pager render (for unfollow / scroll-up conversion). */
  lastMaxScroll = 0;
  selectedAttempt?: number;
  confirmation?: NavigatorConfirmation;
  private pageSize = 1;

  private top(): StackFrame {
    return this.stack[this.stack.length - 1]!;
  }

  get view(): NavigatorView {
    return this.top().view;
  }

  get runId(): string | undefined {
    return this.top().runId;
  }

  get stageId(): string | undefined {
    return this.top().stageId;
  }

  get nodeId(): string | undefined {
    return this.top().nodeId;
  }

  get runCursor(): number {
    return this.top().runCursor;
  }

  set runCursor(value: number) {
    this.top().runCursor = value;
  }

  get stageCursor(): number {
    return this.top().stageCursor;
  }

  set stageCursor(value: number) {
    this.top().stageCursor = value;
  }

  get agentCursor(): number {
    return this.top().agentCursor;
  }

  set agentCursor(value: number) {
    this.top().agentCursor = value;
  }

  get depth(): number {
    return this.stack.length;
  }

  setPageSize(rows: number): void {
    this.pageSize = Math.max(1, rows);
  }

  clampRuns(count: number): void {
    this.runCursor = count <= 0 ? 0 : Math.max(0, Math.min(this.runCursor, count - 1));
  }

  clampDashboard(stageCount: number, agentCount: number): void {
    this.stageCursor = stageCount <= 0 ? 0 : Math.max(0, Math.min(this.stageCursor, stageCount - 1));
    this.agentCursor = agentCount <= 0 ? 0 : Math.max(0, Math.min(this.agentCursor, agentCount - 1));
  }

  move(delta: number, count: number): void {
    if (this.view === "agent") {
      if (!this.pagerOpen) return;
      this.scrollDetail(delta);
      return;
    }
    if (count <= 0) return;
    if (this.view === "runs") {
      this.runCursor = (this.runCursor + delta + count) % count;
      return;
    }
    if (this.pane === "stages") {
      this.stageCursor = (this.stageCursor + delta + count) % count;
      this.agentCursor = 0;
      return;
    }
    this.agentCursor = (this.agentCursor + delta + count) % count;
  }

  movePage(direction: -1 | 1, count: number): void {
    const delta = direction * Math.max(1, this.pageSize - 1);
    if (this.view === "agent") {
      this.pagerOpen = true;
      this.scrollDetail(delta);
      return;
    }
    if (count <= 0) return;
    if (this.view === "runs") {
      this.runCursor = Math.max(0, Math.min(count - 1, this.runCursor + delta));
      return;
    }
    if (this.pane === "stages") {
      this.stageCursor = Math.max(0, Math.min(count - 1, this.stageCursor + delta));
      this.agentCursor = 0;
      return;
    }
    this.agentCursor = Math.max(0, Math.min(count - 1, this.agentCursor + delta));
  }

  jump(edge: "start" | "end", count: number): void {
    if (this.view === "agent") {
      this.pagerOpen = true;
      if (edge === "start") {
        this.followOutput = false;
        this.detailScroll = 0;
      } else {
        // Pin to end via follow; keep a real scroll position for unfollow/scroll-up.
        this.followOutput = true;
        this.detailScroll = this.lastMaxScroll;
      }
      return;
    }
    const value = edge === "start" || count <= 0 ? 0 : count - 1;
    if (this.view === "runs") {
      this.runCursor = value;
      return;
    }
    if (this.pane === "stages") {
      this.stageCursor = value;
      this.agentCursor = 0;
      return;
    }
    this.agentCursor = value;
  }

  /**
   * Apply a real maxScroll from the agent pager renderer.
   * When following, detailScroll tracks the end; otherwise it is clamped.
   */
  applyPagerScroll(maxScroll: number): number {
    this.lastMaxScroll = Math.max(0, maxScroll);
    if (this.followOutput) {
      this.detailScroll = this.lastMaxScroll;
      return this.detailScroll;
    }
    this.detailScroll = Math.min(Math.max(0, this.detailScroll), this.lastMaxScroll);
    return this.detailScroll;
  }

  private scrollDetail(delta: number): void {
    if (delta < 0 && this.followOutput) {
      // Convert pin-to-end into a real position before moving up.
      this.followOutput = false;
      this.detailScroll = this.lastMaxScroll;
    } else if (delta < 0) {
      this.followOutput = false;
    }
    this.detailScroll = Math.max(0, this.detailScroll + delta);
    // Scrolling away from the bottom leaves follow off; reaching the bottom does not auto-follow.
    if (this.detailScroll < this.lastMaxScroll) this.followOutput = false;
  }

  switchPane(pane?: DashboardPane): void {
    if (this.view !== "dashboard") return;
    if (pane) {
      this.pane = pane;
      return;
    }
    this.pane = this.pane === "stages" ? "agents" : "stages";
  }

  openPager(): boolean {
    if (this.view !== "agent") return false;
    if (!this.pagerOpen) {
      this.pagerOpen = true;
      this.detailScroll = 0;
      this.followOutput = true;
    }
    return true;
  }

  closePager(): boolean {
    if (this.view !== "agent" || !this.pagerOpen) return false;
    this.pagerOpen = false;
    this.detailScroll = 0;
    this.followOutput = false;
    return true;
  }

  toggleFollow(): boolean {
    if (this.view !== "agent") return false;
    this.pagerOpen = true;
    this.followOutput = !this.followOutput;
    // Stay at the current bottom when toggling; follow pins on next/current render.
    this.detailScroll = this.lastMaxScroll;
    return this.followOutput;
  }

  cycleAttempt(delta: -1 | 1, attempts: number[]): void {
    if (this.view !== "agent" || attempts.length < 2) return;
    const current = this.selectedAttempt ?? attempts.at(-1)!;
    const index = Math.max(0, attempts.indexOf(current));
    const next = attempts[Math.max(0, Math.min(attempts.length - 1, index + delta))];
    this.selectedAttempt = next;
  }

  /** Open dashboard for a run (used by /wiki open with an active run). */
  openDashboard(runId: string, stageId?: string, nodeId?: string): void {
    // Keep runs under the dashboard so Esc returns to the list instead of closing.
    this.stack = [
      { view: "runs", stageCursor: 0, agentCursor: 0, runCursor: 0 },
      {
        view: "dashboard",
        runId,
        stageId,
        nodeId,
        stageCursor: 0,
        agentCursor: 0,
        runCursor: 0,
      },
    ];
    this.pane = "stages";
    this.showHelp = false;
    this.pagerOpen = false;
    this.followOutput = true;
    this.detailScroll = 0;
    this.selectedAttempt = undefined;
    this.confirmation = undefined;
  }

  openRuns(runCursor = 0): void {
    this.stack = [{ view: "runs", stageCursor: 0, agentCursor: 0, runCursor }];
    this.pane = "stages";
    this.showHelp = false;
    this.pagerOpen = false;
    this.followOutput = true;
    this.detailScroll = 0;
    this.selectedAttempt = undefined;
    this.confirmation = undefined;
  }

  drill(model: WikiUiModel): boolean {
    if (this.view === "runs") {
      const runs = model.listRuns();
      const selected = runs[this.runCursor];
      if (!selected) return false;
      const run = model.getRun(selected.id);
      const phases = run ? phaseRows(run) : [];
      const first = phases[0];
      this.stack.push({
        view: "dashboard",
        runId: selected.id,
        stageId: first?.id,
        nodeId: first?.nodeIds[0],
        stageCursor: 0,
        agentCursor: 0,
        runCursor: this.runCursor,
      });
      this.pane = "stages";
      return true;
    }

    if (this.view === "dashboard") {
      const runId = this.runId;
      if (!runId) return false;
      const phases = model.phases(runId);
      const stage = phases[this.stageCursor];
      if (!stage) return false;
      this.top().stageId = stage.id;
      const agents = model.agents(runId, stage.id);
      if (this.pane === "stages") {
        if (!agents.length) return false;
        this.pane = "agents";
        this.agentCursor = 0;
        this.top().nodeId = agents[0]?.id;
        return true;
      }
      const agent = agents[this.agentCursor];
      if (!agent) return false;
      this.stack.push({
        view: "agent",
        runId,
        stageId: stage.id,
        nodeId: agent.id,
        stageCursor: this.stageCursor,
        agentCursor: this.agentCursor,
        runCursor: this.runCursor,
      });
      this.pagerOpen = false;
      this.followOutput = true;
      this.detailScroll = 0;
      this.selectedAttempt = undefined;
      return true;
    }

    if (this.view === "agent") {
      return this.openPager();
    }

    return false;
  }

  /** Pop one level. Returns false when already at the top (caller should close). */
  back(): boolean {
    if (this.confirmation) {
      this.confirmation = undefined;
      return true;
    }
    if (this.showHelp) {
      this.showHelp = false;
      return true;
    }
    if (this.view === "agent" && this.pagerOpen) {
      this.closePager();
      return true;
    }
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    this.pagerOpen = false;
    this.detailScroll = 0;
    this.followOutput = true;
    this.selectedAttempt = undefined;
    return true;
  }

  /**
   * Keep cursors/ids coherent after live engine updates.
   * Cursor is authoritative for dashboard selection; ids are derived from it
   * except on the agent view, where the drilled-in nodeId is preserved.
   */
  sync(model: WikiUiModel): void {
    if (this.view === "runs") {
      this.clampRuns(model.listRuns().length);
      return;
    }
    const runId = this.runId;
    if (!runId) return;
    const phases = model.phases(runId);
    if (!phases.length) {
      this.clampDashboard(0, 0);
      this.top().stageId = undefined;
      this.top().nodeId = undefined;
      return;
    }

    if (this.view === "agent" && this.stageId) {
      const stageIndex = phases.findIndex((phase) => phase.id === this.stageId);
      if (stageIndex >= 0) this.stageCursor = stageIndex;
    }

    this.clampDashboard(phases.length, 0);
    const stage = phases[this.stageCursor] ?? phases[0];
    this.top().stageId = stage?.id;
    const agents = model.agents(runId, stage?.id);

    if (this.view === "agent" && this.nodeId) {
      const agentIndex = agents.findIndex((node) => node.id === this.nodeId);
      if (agentIndex >= 0) this.agentCursor = agentIndex;
    }

    this.clampDashboard(phases.length, agents.length);
    const agent = agents[this.agentCursor];
    if (this.view === "agent") {
      this.top().nodeId = this.nodeId && agents.some((node) => node.id === this.nodeId)
        ? this.nodeId
        : agent?.id;
    } else {
      this.top().nodeId = agent?.id ?? stage?.nodeIds[0];
    }
  }

  selectedRunId(model: WikiUiModel): string | undefined {
    if (this.runId) return this.runId;
    return model.listRuns()[this.runCursor]?.id;
  }

  /**
   * Return an agent retry target only when the user is actually operating in
   * agent context. The dashboard stages pane intentionally has no implicit
   * agent selection, even though it renders the first agent beside a stage.
   */
  selectedAgentId(model: WikiUiModel): string | undefined {
    if (this.view === "agent") return this.nodeId;
    if (this.view !== "dashboard" || this.pane !== "agents" || !this.runId) return undefined;
    const stage = model.phases(this.runId)[this.stageCursor];
    return model.agents(this.runId, stage?.id)[this.agentCursor]?.id;
  }

  openConfirmation(confirmation: NavigatorConfirmation): void {
    this.confirmation = confirmation;
    this.showHelp = false;
  }

  takeConfirmation(): NavigatorConfirmation | undefined {
    const confirmation = this.confirmation;
    this.confirmation = undefined;
    return confirmation;
  }
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
  | { type: "notify"; message: string; level: "info" | "warning" | "error" };

/** Map a parsed key id into a high-level navigator action (side-effect free). */
export function keyToNavigatorIntent(
  key: string | undefined,
  state: NavigatorState,
): "moveUp" | "moveDown" | "pageUp" | "pageDown" | "jumpStart" | "jumpEnd"
  | "drill" | "back" | "close" | "help" | "pause" | "cancel" | "retry" | "retryPhase"
  | "delete" | "follow" | "attemptPrev" | "attemptNext" | "paneLeft" | "paneRight" | "paneToggle" | "confirm"
  | "none" {
  if (!key) return "none";
  if (state.confirmation) {
    if (key === "enter" || key === "return") return "confirm";
    if (key === "escape" || key === "esc" || key === "q") return "back";
    return "none";
  }
  if (key === "?" || key === "shift+/") return "help";
  if (state.showHelp) {
    if (key === "escape" || key === "esc" || key === "q") return "back";
    return "none";
  }
  if (key === "q") return "close";
  if (key === "escape" || key === "esc") return "back";
  if (key === "enter" || key === "return") return "drill";
  if (key === "up" || key === "k") return "moveUp";
  if (key === "down" || key === "j") return "moveDown";
  if (key === "pageUp" || key === "ctrl+u" || key === "ctrl+b") return "pageUp";
  if (key === "pageDown" || key === "space" || key === "ctrl+d" || key === "ctrl+f") return "pageDown";
  if (key === "g" || key === "home") return "jumpStart";
  if (key === "G" || key === "shift+g" || key === "end") return "jumpEnd";
  if (key === "tab") return "paneToggle";
  if (key === "h" || key === "left") {
    if (state.view === "dashboard") return "paneLeft";
    return "back";
  }
  if (key === "l" || key === "right") {
    if (state.view === "dashboard") return "paneRight";
    return "drill";
  }
  if (key === "p") return "pause";
  if (key === "c") return "cancel";
  if (key === "r") return "retry";
  if (key === "R" || key === "shift+r") return "retryPhase";
  if (key === "x") return "delete";
  if (key === "f") return "follow";
  if (key === "[") return "attemptPrev";
  if (key === "]") return "attemptNext";
  return "none";
}
