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
  filter?: string;
  panel: InspectorPanel;
  transcriptLines: string[];
  transcriptOffset: number;
}

export type InspectorKeyResult =
  | InspectorState
  | { action: "close" }
  | { action: "stop"; agentId: string }
  | { action: "retry"; agentId: string }
  | { action: "pause" }
  | { action: "resume" };

export interface InspectorKeyContext {
  staleWarnMs?: number;
  onFocus?: (agentId: string) => void;
  onStop?: (agentId: string) => void;
  getTranscript?: (agentId: string) => string[];
}

const LIVE: ReadonlySet<string> = new Set(["starting", "running", "waiting_tool"]);

/** Agents matching optional substring filter (id/label/role/phase). */
export function filteredAgents(state: InspectorState): WikiAgentView[] {
  const filter = state.filter?.trim().toLowerCase();
  if (!filter) return state.snapshot.agents;
  return state.snapshot.agents.filter((agent) => {
    const hay = `${agent.agentId} ${agent.label} ${agent.role} ${agent.phase} ${agent.status}`.toLowerCase();
    return hay.includes(filter);
  });
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

function selectedAgent(state: InspectorState): WikiAgentView | undefined {
  const agents = filteredAgents(state);
  if (agents.length === 0) return undefined;
  return agents[clampIndex(state.selectedIndex, agents.length)];
}

function withSelection(state: InspectorState, selectedIndex: number): InspectorState {
  const agents = filteredAgents(state);
  return { ...state, selectedIndex: clampIndex(selectedIndex, agents.length) };
}

function loadTranscript(state: InspectorState, ctx: InspectorKeyContext): InspectorState {
  const agent = selectedAgent(state);
  if (!agent || !ctx.getTranscript) {
    return { ...state, transcriptLines: [], transcriptOffset: 0 };
  }
  const lines = ctx.getTranscript(agent.agentId) ?? [];
  return { ...state, transcriptLines: lines, transcriptOffset: 0 };
}

export function createInspectorState(snapshot: WikiProgressSnapshot): InspectorState {
  let selectedIndex = 0;
  if (snapshot.focusedAgentId) {
    const idx = snapshot.agents.findIndex((a) => a.agentId === snapshot.focusedAgentId);
    if (idx >= 0) selectedIndex = idx;
  } else {
    const live = snapshot.agents.findIndex((a) => LIVE.has(a.status));
    if (live >= 0) selectedIndex = live;
  }
  return {
    snapshot,
    selectedIndex,
    filter: undefined,
    panel: "agents",
    transcriptLines: [],
    transcriptOffset: 0,
  };
}

/**
 * Apply a single key to inspector state.
 * Keys: j/k/up/down, enter (focus), t transcript, q close, s stop, r retry,
 * p pause, P resume, / filter (clears when empty), 1-9 jump running, g/G scroll.
 */
export function applyInspectorKey(
  state: InspectorState,
  key: string,
  ctx: InspectorKeyContext = {},
): InspectorKeyResult {
  const agents = filteredAgents(state);
  const current = selectedAgent(state);

  // Normalize common key names.
  const k = key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : key === "Enter" ? "enter" : key;

  if (k === "q" || k === "Escape" || k === "esc") {
    return { action: "close" };
  }

  if (k === "p") return { action: "pause" };
  if (k === "P") return { action: "resume" };

  if (k === "j" || k === "down") {
    return withSelection(state, state.selectedIndex + 1);
  }
  if (k === "k" || k === "up") {
    return withSelection(state, state.selectedIndex - 1);
  }

  if (k === "enter") {
    if (!current) return state;
    ctx.onFocus?.(current.agentId);
    return {
      ...state,
      snapshot: {
        ...state.snapshot,
        focusedAgentId: current.agentId,
        updatedAt: Date.now(),
      },
    };
  }

  if (k === "t") {
    if (state.panel === "transcript") {
      return { ...state, panel: "agents", transcriptOffset: 0 };
    }
    const next: InspectorState = { ...state, panel: "transcript" };
    return loadTranscript(next, ctx);
  }

  if (k === "s") {
    if (!current) return state;
    ctx.onStop?.(current.agentId);
    return { action: "stop", agentId: current.agentId };
  }

  if (k === "r") {
    if (!current) return state;
    return { action: "retry", agentId: current.agentId };
  }

  if (k === "/") {
    // Filter mode is not fully interactive in v1; clear any active filter.
    return { ...state, filter: undefined, selectedIndex: 0 };
  }

  if (/^[1-9]$/.test(k)) {
    const n = Number(k);
    const running = agents.filter((a) => LIVE.has(a.status));
    const target = running[n - 1];
    if (!target) return state;
    const idx = agents.findIndex((a) => a.agentId === target.agentId);
    return withSelection(state, idx >= 0 ? idx : state.selectedIndex);
  }

  if (k === "g" || k === "G") {
    if (state.panel !== "transcript") return state;
    const page = 8;
    if (k === "g") {
      return {
        ...state,
        transcriptOffset: Math.min(
          Math.max(0, state.transcriptLines.length - 1),
          state.transcriptOffset + page,
        ),
      };
    }
    return { ...state, transcriptOffset: Math.max(0, state.transcriptOffset - page) };
  }

  return state;
}

/** Render the inspector as plain text lines (widget / message fallback). */
export function renderInspector(state: InspectorState, opts: FormatTimeOpts = {}): string[] {
  const agents = filteredAgents(state);
  const selected = selectedAgent(state);
  const lines: string[] = [];
  const snap = state.snapshot;

  lines.push(`Wiki inspector · ${snap.overall} · ${snap.currentPhase ?? "—"}`);
  if (snap.phases.length) lines.push(formatPhasesLine(snap.phases));
  if (snap.coverage) lines.push(formatCoverageLine(snap.coverage));
  if (state.filter) lines.push(`filter: ${state.filter}`);
  lines.push("─".repeat(40));

  if (state.panel === "agents") {
    if (agents.length === 0) {
      lines.push("(no agents)");
    } else {
      agents.forEach((agent, index) => {
        const cursor = index === clampIndex(state.selectedIndex, agents.length) ? ">" : " ";
        const focus = agent.agentId === snap.focusedAgentId ? "*" : " ";
        lines.push(`${cursor}${focus}${formatAgentLine(agent, opts)}`);
      });
    }
    lines.push("─".repeat(40));
    if (selected) {
      lines.push(...formatAgentDetail(selected, snap, opts).split("\n"));
    }
  } else {
    const id = selected?.agentId ?? "(none)";
    lines.push(`Transcript: ${id}  [${agentStatusGlyph(selected?.status ?? "queued")}]`);
    lines.push("─".repeat(40));
    const start = state.transcriptOffset;
    const window = state.transcriptLines.slice(start, start + 12);
    if (window.length === 0) {
      lines.push("(empty transcript)");
    } else {
      for (const line of window) lines.push(line);
      if (start + window.length < state.transcriptLines.length) {
        lines.push(`… ${state.transcriptLines.length - start - window.length} more (g/G scroll)`);
      }
    }
  }

  lines.push("─".repeat(40));
  lines.push("j/k move · enter focus · t transcript · s stop · r retry · p/P pause/resume · q close");
  return lines;
}

export interface OpenWikiInspectorContext {
  hasUI: boolean;
  ui: {
    custom?: (...args: unknown[]) => unknown;
    notify: (message: string, level?: string) => void;
  };
}

export interface OpenWikiInspectorOptions {
  getSnapshot: () => WikiProgressSnapshot | undefined;
  subscribe?: (cb: (s: WikiProgressSnapshot) => void) => () => void;
  getTranscript?: (agentId: string) => Promise<string[]> | string[];
  onFocus?: (agentId: string | undefined) => void;
  onStopAgent?: (agentId: string) => void;
  /** Optional: receive rendered text when custom TUI is unavailable. */
  onFallbackText?: (lines: string[]) => void;
  /** Format options (stale threshold, clock) applied to rendered text. */
  formatOpts?: FormatTimeOpts;
}

/**
 * Open a multi-agent inspector overlay when `ui.custom` is available.
 * Sprint 1: without custom TUI, deliver text via {@link onFallbackText} (when
 * provided) and return `"unsupported"`. Callers should not re-render on that
 * return value if they already supplied `onFallbackText`.
 */
export async function openWikiInspector(
  ctx: OpenWikiInspectorContext,
  options: OpenWikiInspectorOptions,
): Promise<"closed" | "unsupported"> {
  const snapshot = options.getSnapshot();
  if (!snapshot) {
    ctx.ui.notify("No active Wiki run to inspect.", "warning");
    return "unsupported";
  }

  const formatOpts = options.formatOpts ?? {};

  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
    const state = createInspectorState(snapshot);
    const lines = renderInspector(state, formatOpts);
    options.onFallbackText?.(lines);
    ctx.ui.notify("Inspector overlay unavailable; showing text fallback.", "info");
    return "unsupported";
  }

  // Minimal custom-handler path: render once and close. Full interactive TUI
  // is deferred; integrators can replace this when pi-tui wiring is ready.
  try {
    const state = createInspectorState(snapshot);
    const lines = renderInspector(state, formatOpts);
    await Promise.resolve(
      ctx.ui.custom({
        type: "okf-wiki-inspector",
        lines,
        snapshot,
      }),
    );
    return "closed";
  } catch {
    const state = createInspectorState(snapshot);
    options.onFallbackText?.(renderInspector(state, formatOpts));
    ctx.ui.notify("Inspector custom UI failed; text fallback used.", "warning");
    return "unsupported";
  }
}
