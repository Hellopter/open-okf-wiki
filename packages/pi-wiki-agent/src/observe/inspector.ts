import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	parseKey,
	truncateToWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type { WikiAgentView, WikiProgressSnapshot } from "../orch/types.js";
import {
  agentStatusGlyph,
  formatAgentDetail,
  formatAgentLine,
  formatCoverageLine,
  formatPhasesLine,
  type FormatTimeOpts,
} from "./format.js";

export type InspectorPanel = "agents" | "transcript";

export interface InspectorState {
  snapshot: WikiProgressSnapshot;
  selectedIndex: number;
  panel: InspectorPanel;
  transcriptLines: string[];
  transcriptOffset: number;
  transcriptLoading: boolean;
}

type InspectorAction = "close" | "focus" | "load-transcript" | "pause" | "resume";

export interface InspectorKeyResult {
  state: InspectorState;
  action?: InspectorAction;
  agentId?: string;
}

export interface InspectorRenderOptions extends FormatTimeOpts {
  interactive?: boolean;
  maxAgentRows?: number;
  transcriptRows?: number;
}

const LIVE: ReadonlySet<string> = new Set(["starting", "running", "waiting_tool"]);
const TRANSCRIPT_PAGE_ROWS = 12;

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

function defaultSelection(snapshot: WikiProgressSnapshot): number {
  if (snapshot.focusedAgentId) {
    const focused = snapshot.agents.findIndex((agent) => agent.agentId === snapshot.focusedAgentId);
    if (focused >= 0) return focused;
  }
  const live = snapshot.agents.findIndex((agent) => LIVE.has(agent.status));
  return live >= 0 ? live : 0;
}

function selectedInspectorAgent(state: InspectorState): WikiAgentView | undefined {
  return state.snapshot.agents[clampIndex(state.selectedIndex, state.snapshot.agents.length)];
}

export function createInspectorState(snapshot: WikiProgressSnapshot): InspectorState {
  return {
    snapshot,
    selectedIndex: defaultSelection(snapshot),
    panel: "agents",
    transcriptLines: [],
    transcriptOffset: 0,
    transcriptLoading: false,
  };
}

/** Replace a live snapshot while retaining selection whenever that agent still exists. */
function updateInspectorSnapshot(state: InspectorState, snapshot: WikiProgressSnapshot): InspectorState {
  const selectedId = selectedInspectorAgent(state)?.agentId;
  const selectedIndex = selectedId
    ? snapshot.agents.findIndex((agent) => agent.agentId === selectedId)
    : -1;
  const nextIndex = selectedIndex >= 0 ? selectedIndex : defaultSelection(snapshot);
  const changedAgent = selectedId !== snapshot.agents[nextIndex]?.agentId;
  return {
    ...state,
    snapshot,
    selectedIndex: nextIndex,
    panel: changedAgent && state.panel === "transcript" ? "agents" : state.panel,
    transcriptLines: changedAgent ? [] : state.transcriptLines,
    transcriptOffset: changedAgent ? 0 : state.transcriptOffset,
    transcriptLoading: changedAgent ? false : state.transcriptLoading,
  };
}

function setInspectorTranscript(state: InspectorState, lines: string[]): InspectorState {
  return {
    ...state,
    transcriptLines: lines,
    transcriptOffset: Math.max(0, lines.length - TRANSCRIPT_PAGE_ROWS),
    transcriptLoading: false,
  };
}

function withSelection(state: InspectorState, selectedIndex: number): InspectorState {
  return {
    ...state,
    selectedIndex: clampIndex(selectedIndex, state.snapshot.agents.length),
  };
}

function result(state: InspectorState, action?: InspectorAction, agentId?: string): InspectorKeyResult {
  return action ? { state, action, agentId } : { state };
}

/** Apply a parsed key to inspector state; effects are performed by the TUI component. */
export function applyInspectorKey(state: InspectorState, key: string): InspectorKeyResult {
  const k = key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : key === "Enter" ? "enter" : key;
  const current = selectedInspectorAgent(state);

  if (k === "q" || k === "escape" || k === "Escape" || k === "esc") return result(state, "close");

  if (k === "p") return result(state, state.snapshot.overall === "paused" ? "resume" : "pause");

  if (k === "t") {
    if (state.panel === "transcript") {
      return result({ ...state, panel: "agents", transcriptLoading: false });
    }
    if (!current) return result(state);
    return result(
      { ...state, panel: "transcript", transcriptLines: [], transcriptOffset: 0, transcriptLoading: true },
      "load-transcript",
      current.agentId,
    );
  }

  if (state.panel === "transcript") {
    if (k === "g") return result({ ...state, transcriptOffset: 0 });
    if (k === "G" || k === "shift+g") {
      return result({
        ...state,
        transcriptOffset: Math.max(0, state.transcriptLines.length - TRANSCRIPT_PAGE_ROWS),
      });
    }
    return result(state);
  }

  if (k === "j" || k === "down") return result(withSelection(state, state.selectedIndex + 1));
  if (k === "k" || k === "up") return result(withSelection(state, state.selectedIndex - 1));

  if (k === "enter" && current) {
    return result(
      {
        ...state,
        snapshot: { ...state.snapshot, focusedAgentId: current.agentId, updatedAt: Date.now() },
      },
      "focus",
      current.agentId,
    );
  }

  return result(state);
}

function visibleAgents(state: InspectorState, maxRows: number): { agents: WikiAgentView[]; start: number } {
  const agents = state.snapshot.agents;
  if (agents.length <= maxRows) return { agents, start: 0 };
  const selected = clampIndex(state.selectedIndex, agents.length);
  const start = Math.min(Math.max(0, selected - Math.floor(maxRows / 2)), agents.length - maxRows);
  return { agents: agents.slice(start, start + maxRows), start };
}

/** Render text for either the interactive overlay or the non-interactive fallback. */
export function renderInspector(state: InspectorState, opts: InspectorRenderOptions = {}): string[] {
  const lines: string[] = [];
  const snapshot = state.snapshot;
  const selected = selectedInspectorAgent(state);
  const maxAgentRows = Math.max(1, opts.maxAgentRows ?? snapshot.agents.length);
  const transcriptRows = Math.max(1, opts.transcriptRows ?? TRANSCRIPT_PAGE_ROWS);

  lines.push(`Wiki inspector · ${snapshot.overall} · ${snapshot.currentPhase ?? "—"}`);
  if (snapshot.phases.length) lines.push(formatPhasesLine(snapshot.phases));
  if (snapshot.coverage) lines.push(formatCoverageLine(snapshot.coverage));
  lines.push("─".repeat(40));

  if (state.panel === "agents") {
    if (snapshot.agents.length === 0) {
      lines.push("(no agents)");
    } else {
      const visible = visibleAgents(state, maxAgentRows);
      if (visible.start > 0) lines.push(`… ${visible.start} earlier agent${visible.start === 1 ? "" : "s"}`);
      for (let index = 0; index < visible.agents.length; index++) {
        const agent = visible.agents[index]!;
        const sourceIndex = visible.start + index;
        const cursor = sourceIndex === clampIndex(state.selectedIndex, snapshot.agents.length) ? ">" : " ";
        const focus = agent.agentId === snapshot.focusedAgentId ? "*" : " ";
        lines.push(`${cursor}${focus}${formatAgentLine(agent, opts)}`);
      }
      const remaining = snapshot.agents.length - visible.start - visible.agents.length;
      if (remaining > 0) lines.push(`… ${remaining} more agent${remaining === 1 ? "" : "s"}`);
    }
    lines.push("─".repeat(40));
    if (selected) lines.push(...formatAgentDetail(selected, snapshot, opts).split("\n"));
  } else {
    const id = selected?.agentId ?? "(none)";
    lines.push(`Transcript: ${id}  [${agentStatusGlyph(selected?.status ?? "queued")}]`);
    lines.push("─".repeat(40));
    if (state.transcriptLoading) {
      lines.push("(loading transcript)");
    } else if (state.transcriptLines.length === 0) {
      lines.push("(empty transcript)");
    } else {
      const start = Math.min(state.transcriptOffset, Math.max(0, state.transcriptLines.length - 1));
      const window = state.transcriptLines.slice(start, start + transcriptRows);
      if (start > 0) lines.push(`… ${start} earlier line${start === 1 ? "" : "s"}`);
      lines.push(...window);
      const remaining = state.transcriptLines.length - start - window.length;
      if (remaining > 0) lines.push(`… ${remaining} newer line${remaining === 1 ? "" : "s"}`);
    }
  }

  if (opts.interactive) {
    lines.push("─".repeat(40));
    lines.push(
      state.panel === "agents"
        ? "↑/↓ move · enter focus · t transcript · p pause/resume · q close"
        : "t agents · g/G top/bottom · p pause/resume · q close",
    );
  }
  return lines;
}

export interface OpenWikiInspectorContext {
  hasUI: boolean;
  ui: ExtensionUIContext;
}

export interface OpenWikiInspectorOptions {
  getSnapshot: () => WikiProgressSnapshot | undefined;
  subscribe?: (cb: (snapshot: WikiProgressSnapshot) => void) => () => void;
  getTranscript?: (agentId: string) => Promise<string[]> | string[];
  onFocus?: (agentId: string) => void;
  onPause?: () => Promise<boolean> | boolean;
  onResume?: () => Promise<boolean> | boolean;
  onFallbackText?: (lines: string[]) => void;
  formatOpts?: FormatTimeOpts;
}

function inspectorLayout(tui: TUI, state: InspectorState): Pick<InspectorRenderOptions, "maxAgentRows" | "transcriptRows"> {
  const terminalRows = tui.terminal?.rows ?? 24;
  if (state.panel === "transcript") {
    return { transcriptRows: Math.max(4, terminalRows - 8), maxAgentRows: 6 };
  }
  return { maxAgentRows: Math.max(3, Math.min(8, terminalRows - 16)), transcriptRows: TRANSCRIPT_PAGE_ROWS };
}

/** Open a focused, live-updating inspector in Pi TUI, with static fallback elsewhere. */
export async function openWikiInspector(
  ctx: OpenWikiInspectorContext,
  options: OpenWikiInspectorOptions,
): Promise<"closed" | "unsupported"> {
  const snapshot = options.getSnapshot();
  if (!snapshot) {
    ctx.ui.notify("No active Wiki run to inspect.", "warning");
    return "unsupported";
  }

  const fallback = () => {
    options.onFallbackText?.(renderInspector(createInspectorState(snapshot), { ...options.formatOpts, interactive: false }));
  };

  if (!ctx.hasUI) {
    fallback();
    ctx.ui.notify("Inspector overlay unavailable; showing text fallback.", "info");
    return "unsupported";
  }

  try {
    await ctx.ui.custom<void>(
      (tui: TUI, _theme: Theme, _keybindings, done) => {
        let state = createInspectorState(snapshot);
        let closed = false;
        let transcriptRequest = 0;
        let unsubscribe: (() => void) | undefined;

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
            state = setInspectorTranscript(state, []);
            redraw();
            return;
          }
          const request = ++transcriptRequest;
          try {
            const lines = await options.getTranscript(agentId);
            if (closed || request !== transcriptRequest || selectedInspectorAgent(state)?.agentId !== agentId) return;
            state = setInspectorTranscript(state, lines);
          } catch {
            if (closed || request !== transcriptRequest) return;
            state = setInspectorTranscript(state, ["(transcript unavailable)"]);
          }
          redraw();
        };
        const runControl = async (action: "pause" | "resume") => {
          const callback = action === "pause" ? options.onPause : options.onResume;
          if (!callback) return;
          const ok = await callback();
          if (!ok) ctx.ui.notify(`Unable to ${action} Wiki orchestration.`, "warning");
        };

        unsubscribe = options.subscribe?.((nextSnapshot) => {
          state = updateInspectorSnapshot(state, nextSnapshot);
          if (state.panel === "transcript") {
            const agentId = selectedInspectorAgent(state)?.agentId;
            if (agentId) void loadTranscript(agentId);
          }
          redraw();
        });

        const component: Component & { dispose?: () => void } = {
          render: (width: number) =>
            renderInspector(state, { ...options.formatOpts, ...inspectorLayout(tui, state), interactive: true }).map((line) =>
              truncateToWidth(line, Math.max(1, width)),
            ),
          handleInput: (data: string) => {
            const key = parseKey(data) ?? data;
            const next = applyInspectorKey(state, key);
            state = next.state;
            if (next.action === "close") {
              close();
              return;
            }
            if (next.action === "focus" && next.agentId) options.onFocus?.(next.agentId);
            if (next.action === "load-transcript" && next.agentId) void loadTranscript(next.agentId);
            if (next.action === "pause" || next.action === "resume") void runControl(next.action);
            redraw();
          },
          invalidate: () => {},
          dispose: cleanup,
        };
        return component;
      },
      { overlay: true, overlayOptions: { width: "92%", maxHeight: "92%" } },
    );
    return "closed";
  } catch {
    fallback();
    ctx.ui.notify("Inspector custom UI failed; text fallback used.", "warning");
    return "unsupported";
  }
}
