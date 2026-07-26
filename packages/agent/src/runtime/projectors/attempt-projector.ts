/**
 * Pure Pi AgentSession event → attempt item projector.
 *
 * Correlates tool rows by toolCallId when present (Pi tool_execution_* shape).
 * Caps item/text size for operator UI projection. No I/O, no session handles.
 */

import type { AttemptItem } from "@okf-wiki/contract";

export const MAX_ITEMS = 20;
export const MAX_TEXT_CHUNK = 2000;
export const MAX_ARGS_SUMMARY = 500;

export type AttemptProjectorState = {
  items: AttemptItem[];
  turns: number;
  contextTokens?: number;
  /** Accumulated assistant text_delta stream (for summary resolution). */
  streamedText: string;
  /**
   * toolCallId → index in items (running toolCall rows).
   * Not part of the public AttemptItem schema.
   */
  toolIndexByCallId: Map<string, number>;
};

export function createAttemptProjectorState(): AttemptProjectorState {
  return {
    items: [],
    turns: 0,
    streamedText: "",
    toolIndexByCallId: new Map(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function argsSummary(args: unknown): string | undefined {
  if (args == null) return undefined;
  try {
    const raw = typeof args === "string" ? args : JSON.stringify(args);
    return truncate(raw, MAX_ARGS_SUMMARY);
  } catch {
    return undefined;
  }
}

/** Push/coalesce a display item, enforcing MAX_ITEMS. Mutates state.items. */
export function pushAttemptItem(state: AttemptProjectorState, item: AttemptItem): void {
  if (item.type === "text" && state.items.length > 0) {
    const last = state.items[state.items.length - 1];
    if (last?.type === "text") {
      state.items[state.items.length - 1] = {
        type: "text",
        text: truncate(last.text + item.text, MAX_TEXT_CHUNK * 2),
      };
      return;
    }
  }
  state.items.push(item);
  while (state.items.length > MAX_ITEMS) {
    // Drop oldest; reindex toolCallId map when indices shift.
    state.items.shift();
    for (const [id, index] of state.toolIndexByCallId) {
      if (index === 0) state.toolIndexByCallId.delete(id);
      else state.toolIndexByCallId.set(id, index - 1);
    }
  }
}

/**
 * Apply one Pi AgentSession event to projector state (mutates and returns state).
 * Unknown / irrelevant event types are ignored.
 */
export function applyAttemptSessionEvent(
  state: AttemptProjectorState,
  event: unknown,
): AttemptProjectorState {
  if (!isRecord(event) || typeof event.type !== "string") return state;
  const kind = event.type;

  if (kind === "message_update") {
    const ame = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
    if (ame?.type === "text_delta" && typeof ame.delta === "string") {
      state.streamedText += ame.delta;
      pushAttemptItem(state, { type: "text", text: truncate(ame.delta, MAX_TEXT_CHUNK) });
    }
    return state;
  }

  if (kind === "message_end") {
    const message = isRecord(event.message) ? event.message : null;
    if (message && message.role === "assistant") {
      state.turns += 1;
      if (isRecord(message.usage)) {
        const total = message.usage.totalTokens;
        if (typeof total === "number" && total >= 0) state.contextTokens = total;
      }
    }
    return state;
  }

  if (kind === "tool_execution_start") {
    const name = typeof event.toolName === "string" ? event.toolName : "tool";
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const item: AttemptItem = {
      type: "toolCall",
      name,
      argsSummary: argsSummary(event.args ?? event.input),
      status: "running",
    };
    pushAttemptItem(state, item);
    if (toolCallId) {
      state.toolIndexByCallId.set(toolCallId, state.items.length - 1);
    }
    return state;
  }

  if (kind === "tool_execution_end") {
    const name = typeof event.toolName === "string" ? event.toolName : "tool";
    const isError = event.isError === true;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const status = isError ? "error" : "done";

    let updated = false;
    if (toolCallId && state.toolIndexByCallId.has(toolCallId)) {
      const index = state.toolIndexByCallId.get(toolCallId)!;
      const it = state.items[index];
      if (it?.type === "toolCall") {
        state.items[index] = { ...it, status };
        state.toolIndexByCallId.delete(toolCallId);
        updated = true;
      }
    }
    if (!updated) {
      // Fallback: last running toolCall with matching name (or any running tool).
      for (let i = state.items.length - 1; i >= 0; i--) {
        const it = state.items[i];
        if (it?.type === "toolCall" && it.status === "running" && (it.name === name || !name)) {
          state.items[i] = { ...it, status };
          break;
        }
      }
    }
    return state;
  }

  return state;
}

/** Snapshot items for progress emission (last MAX_ITEMS). */
export function attemptItemsSnapshot(state: AttemptProjectorState): AttemptItem[] | undefined {
  if (state.items.length === 0) return undefined;
  return state.items.slice(-MAX_ITEMS);
}
