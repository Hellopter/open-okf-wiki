/**
 * Pi-native Operator Session projector (ADR 0031 / 0032).
 *
 * Snapshot authority: server snapshots fully replace local state (including
 * client-only optimistic user rows). Live Pi `user` role events are ignored —
 * durable user turns arrive via snapshot, not live stream.
 *
 * Content-block parsing lives in `pi-message.ts`; this module is reduce-only.
 */

import {
  extractAssistantError,
  extractMessageText,
  extractMessageThinking,
  isRecord,
  makeId,
  nowIso,
  toolOutputFromResult,
} from "./format.ts";
import {
  assistantFromSnapshot,
  messageRole,
  patchToolsOnAssistant,
  piMessageId,
  wikiProduceDetails,
} from "./pi-message.ts";
import type { AgentMessage, AgentSseLike, AgentToolCall, PiStreamState } from "./types.ts";

export function createPiStreamState(seed: AgentMessage[] = []): PiStreamState {
  let lastAssistantId: string | null = null;
  for (let i = seed.length - 1; i >= 0; i -= 1) {
    if (seed[i]?.role === "assistant") {
      lastAssistantId = seed[i]!.id;
      break;
    }
  }
  return {
    messages: seed.slice(),
    streamingMessage: null,
    lastAssistantId,
    turnActive: false,
  };
}

/** Finalized rows + optional streaming tail (UI timeline). */
export function viewMessages(state: PiStreamState): AgentMessage[] {
  if (!state.streamingMessage) return state.messages;
  return [...state.messages, state.streamingMessage];
}

function findMessageIndex(messages: AgentMessage[], id: string | null): number {
  if (!id) return -1;
  return messages.findIndex((m) => m.id === id);
}

function updateToolInState(
  state: PiStreamState,
  toolCallId: string,
  patch: Partial<AgentToolCall> & { name?: string },
): PiStreamState {
  // Prefer streaming assistant, then last finalized assistant.
  if (state.streamingMessage) {
    return {
      ...state,
      streamingMessage: patchToolsOnAssistant(state.streamingMessage, toolCallId, patch),
    };
  }
  const idx = findMessageIndex(state.messages, state.lastAssistantId);
  if (idx >= 0 && state.messages[idx]!.role === "assistant") {
    const next = state.messages.slice();
    next[idx] = patchToolsOnAssistant(next[idx]!, toolCallId, patch);
    return { ...state, messages: next };
  }
  // No assistant yet — open a streaming shell for the tool.
  const id = makeId("asst");
  const shell: AgentMessage = {
    id,
    role: "assistant",
    content: "",
    createdAt: nowIso(),
    status: "streaming",
    tools: [
      {
        id: toolCallId,
        name: patch.name ?? "tool",
        args: patch.args,
        output: patch.output,
        status: patch.status ?? "running",
      },
    ],
  };
  return {
    ...state,
    streamingMessage: shell,
    lastAssistantId: id,
  };
}

/**
 * Reduce one parent Pi event into stream state (snapshot authority).
 * Pure: returns a new state object (streamingMessage may share tool arrays).
 */
export function reducePiEvent(state: PiStreamState, kind: string, payload: unknown): PiStreamState {
  const body = isRecord(payload) ? payload : {};
  const message = "message" in body ? body.message : undefined;
  const role = messageRole(message);
  const ts = nowIso();

  // --- message_update: replace streaming from full message snapshot ---------
  if (kind === "message_update") {
    if (role && role !== "assistant") return state;

    if (!message) return state;

    const text = extractMessageText(message);
    const thinking = extractMessageThinking(message);
    const hasToolCalls =
      isRecord(message) &&
      Array.isArray(message.content) &&
      message.content.some((b) => isRecord(b) && b.type === "toolCall");

    // Empty snapshot with no open stream — wait (do not invent thinking chrome).
    if (!text && !thinking && !hasToolCalls && !state.streamingMessage) {
      return state;
    }

    // Prefer open stream id for continuity; else Pi wire id; else makeId.
    const id = state.streamingMessage?.id ?? piMessageId(message) ?? makeId("asst");
    const next = assistantFromSnapshot(message, {
      id,
      prev: state.streamingMessage,
      status: "streaming",
      ts,
    });
    return {
      ...state,
      streamingMessage: next,
      lastAssistantId: id,
    };
  }

  // --- message_start --------------------------------------------------------
  if (kind === "message_start") {
    // Live user events ignored — optimistic Composer rows + snapshot authority.
    if (role === "user") return state;
    if (role === "toolResult" || role === "tool") return state;

    // Reuse open streaming shell (e.g. tool opened one early).
    if (state.streamingMessage) {
      if (!message) return state;
      const next = assistantFromSnapshot(message, {
        id: state.streamingMessage.id,
        prev: state.streamingMessage,
        status: "streaming",
        ts,
      });
      return { ...state, streamingMessage: next, lastAssistantId: next.id };
    }

    const err = extractAssistantError(message);
    const id = piMessageId(message) ?? makeId("asst");
    const next = assistantFromSnapshot(message ?? { role: "assistant", content: [] }, {
      id,
      prev: null,
      status: err.isError ? "error" : "streaming",
      ts,
    });
    return {
      ...state,
      streamingMessage: next,
      lastAssistantId: id,
    };
  }

  // --- message_end ----------------------------------------------------------
  if (kind === "message_end") {
    // Live user events ignored — durable user turns come from snapshot only.
    if (role === "user") return state;
    if (role === "toolResult" || role === "tool") {
      // Attach tool result text onto last assistant tool row when present.
      if (isRecord(message) && typeof message.toolCallId === "string") {
        const toolCallId = message.toolCallId;
        const details = wikiProduceDetails(message);
        const output = toolOutputFromResult(message, details);
        const isError = message.isError === true;
        return updateToolInState(state, toolCallId, {
          output: output,
          ...(details ? { details } : {}),
          status: isError ? "error" : "done",
          name: typeof message.toolName === "string" ? message.toolName : undefined,
        });
      }
      return state;
    }

    const err = extractAssistantError(message);

    // Operator abort (no provider error): neutral outcome, not a failure.
    // Finalize any partial stream as done and add the system aborted marker
    // the Transcript renders as a separator (never a destructive bubble).
    if (err.aborted) {
      const marker: AgentMessage = {
        id: makeId("sys"),
        role: "system",
        content: "Stopped",
        createdAt: ts,
        status: "aborted",
      };
      if (state.streamingMessage) {
        const finalized = {
          ...state.streamingMessage,
          status: "done" as const,
          thinkingStatus: state.streamingMessage.thinking
            ? ("done" as const)
            : state.streamingMessage.thinkingStatus,
        };
        const hasBody =
          finalized.content.trim() !== "" ||
          Boolean(finalized.thinking) ||
          (finalized.tools?.length ?? 0) > 0;
        return {
          ...state,
          messages: hasBody ? [...state.messages, finalized, marker] : [...state.messages, marker],
          streamingMessage: null,
          ...(hasBody ? { lastAssistantId: finalized.id } : {}),
        };
      }
      return {
        ...state,
        messages: [...state.messages, marker],
        streamingMessage: null,
      };
    }

    const isError = err.isError;
    const status = isError ? ("error" as const) : ("done" as const);

    if (state.streamingMessage) {
      const finalized = message
        ? assistantFromSnapshot(message, {
            id: state.streamingMessage.id,
            prev: state.streamingMessage,
            status,
            ts,
          })
        : {
            ...state.streamingMessage,
            status,
            thinkingStatus: state.streamingMessage.thinking
              ? ("done" as const)
              : state.streamingMessage.thinkingStatus,
          };

      return {
        ...state,
        messages: [...state.messages, finalized],
        streamingMessage: null,
        lastAssistantId: finalized.id,
      };
    }

    // No streaming shell: open from final snapshot if meaningful.
    if (message || isError) {
      const newId = piMessageId(message) ?? makeId("asst");
      const card = message
        ? assistantFromSnapshot(message, { id: newId, prev: null, status, ts })
        : {
            id: newId,
            role: "assistant" as const,
            content: err.errorText ?? "",
            createdAt: ts,
            status,
            errorText: err.errorText,
          };
      // Idempotence across the snapshot/live cut: the server may replay a
      // message_end that the just-received snapshot already contains.
      // Prefer stable Pi id match; content equality is secondary fallback.
      if (state.messages.some((m) => m.id === card.id)) {
        return { ...state, streamingMessage: null };
      }
      const lastAssistant = [...state.messages].reverse().find((m) => m.role === "assistant");
      if (
        lastAssistant &&
        lastAssistant.content === card.content &&
        (lastAssistant.tools?.length ?? 0) === (card.tools?.length ?? 0) &&
        lastAssistant.status === card.status
      ) {
        return { ...state, streamingMessage: null };
      }
      return {
        ...state,
        messages: [...state.messages, card],
        streamingMessage: null,
        lastAssistantId: newId,
      };
    }
    return state;
  }

  // --- tool_execution_* -----------------------------------------------------
  if (kind === "tool_execution_start") {
    const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId : makeId("tool");
    const toolName = typeof body.toolName === "string" ? body.toolName : "tool";
    // Keep structured args (Pi pattern) — no string round-trip.
    const args = "args" in body ? body.args : undefined;
    return updateToolInState(state, toolCallId, {
      name: toolName,
      args,
      status: "running",
    });
  }

  if (kind === "tool_execution_update") {
    const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId : null;
    if (!toolCallId) return state;
    const details = wikiProduceDetails(body.partialResult);
    const partial = toolOutputFromResult(body.partialResult, details);
    return updateToolInState(state, toolCallId, {
      output: partial,
      ...(details ? { details } : {}),
      status: "running",
    });
  }

  if (kind === "tool_execution_end") {
    const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId : null;
    if (!toolCallId) return state;
    const details = wikiProduceDetails(body.result);
    const output = toolOutputFromResult(body.result, details);
    const isError = body.isError === true;
    return updateToolInState(state, toolCallId, {
      output: output,
      ...(details ? { details } : {}),
      status: isError ? "error" : "done",
    });
  }

  if (kind === "error") {
    const errMessage = typeof body.message === "string" ? body.message : "Agent error";
    // Dedupe: assistant bubble already carries the same provider error.
    const view = viewMessages(state);
    for (let i = view.length - 1; i >= 0; i -= 1) {
      const m = view[i]!;
      if (m.role === "assistant") {
        if (m.status === "error" && (m.errorText === errMessage || m.content === errMessage)) {
          return state;
        }
        break;
      }
      if (m.role === "system" && m.status === "error" && m.content === errMessage) {
        return state;
      }
    }
    return {
      ...state,
      messages: [
        ...state.messages,
        {
          id: makeId("sys"),
          role: "system",
          content: errMessage,
          createdAt: ts,
          status: "error",
          errorText: errMessage,
        },
      ],
    };
  }

  if (kind === "agent_end" || kind === "agent_settled") {
    // Finalize any open stream; leave lastAssistant for late tools.
    let messages = state.messages;
    let lastAssistantId = state.lastAssistantId;
    if (state.streamingMessage) {
      const done: AgentMessage = {
        ...state.streamingMessage,
        status: state.streamingMessage.status === "error" ? "error" : "done",
        thinkingStatus: state.streamingMessage.thinking
          ? "done"
          : state.streamingMessage.thinkingStatus,
      };
      messages = [...messages, done];
      lastAssistantId = done.id;
    } else {
      messages = messages.map((m) =>
        m.status === "streaming" ? { ...m, status: "done" as const } : m,
      );
    }
    return {
      messages,
      streamingMessage: null,
      lastAssistantId,
      turnActive: false,
    };
  }

  if (kind === "agent_start") {
    // New parent turn: do not reuse prior assistant as streaming target.
    return {
      ...state,
      turnActive: true,
      streamingMessage: null,
      lastAssistantId: null,
    };
  }

  // prompt / session_ready / turn_* — no transcript rows.
  return state;
}

function historyTimestamp(row: unknown): string {
  if (!isRecord(row) || typeof row.timestamp !== "number") return nowIso();
  const date = new Date(row.timestamp);
  return Number.isNaN(date.getTime()) ? nowIso() : date.toISOString();
}

/** Project the durable branch returned by Pi SessionManager (opaque Pi messages). */
export function projectPiHistory(rows: readonly unknown[]): AgentMessage[] {
  const messages: AgentMessage[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (!isRecord(row)) continue;
    const createdAt = historyTimestamp(row);
    const role = typeof row.role === "string" ? row.role : null;

    if (role === "user") {
      messages.push({
        id: piMessageId(row) ?? `hist_user_${index + 1}`,
        role: "user",
        content: extractMessageText(row),
        createdAt,
        status: "done",
      });
      continue;
    }

    if (role === "assistant") {
      const error = extractAssistantError(row);
      messages.push(
        assistantFromSnapshot(row, {
          id: piMessageId(row) ?? `hist_asst_${index + 1}`,
          status: error.isError ? "error" : "done",
          ts: createdAt,
        }),
      );
      continue;
    }

    if (role !== "toolResult" || typeof row.toolCallId !== "string") continue;
    const details = wikiProduceDetails(row);
    const output = toolOutputFromResult(row, details);
    const toolCallId = row.toolCallId;
    const toolName = typeof row.toolName === "string" ? row.toolName : undefined;
    const isError = row.isError === true;
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex]!;
      if (message.role !== "assistant") continue;
      if (!message.tools?.some((tool) => tool.id === toolCallId)) continue;
      messages[messageIndex] = patchToolsOnAssistant(message, toolCallId, {
        name: toolName,
        output,
        ...(details ? { details } : {}),
        status: isError ? "error" : "done",
      });
      break;
    }
  }

  return messages;
}

/**
 * Fold the only three accepted transport shapes:
 * current server snapshot, genuine Pi event, and heartbeat.
 *
 * Server snapshots fully replace local state — client-only optimistic user
 * rows never survive projection.
 */
export function projectAgentEvent(state: PiStreamState, event: AgentSseLike): PiStreamState {
  if (event.source === "server" && event.kind === "snapshot") {
    const rows = Array.isArray(event.payload.messages) ? event.payload.messages : [];
    // Full replace: optimistic and other client-only rows do not carry over.
    const snapshot = createPiStreamState(projectPiHistory(rows));
    const activeTool = event.payload.activeTool;
    if (!activeTool) return snapshot;
    // A genuine active tool in the snapshot means the agent turn is still
    // running — restore turnActive so a reconnect mid-turn keeps Stop/streaming
    // UI instead of showing "Ready".
    // Single derivation: same path as tool_execution_update for details.summary.
    return {
      ...updateToolInState(snapshot, activeTool.toolCallId, {
        name: activeTool.toolName,
        details: activeTool.details,
        output: toolOutputFromResult(undefined, activeTool.details),
        status: "running",
      }),
      turnActive: true,
    };
  }
  if (event.source === "pi" && typeof event.kind === "string") {
    return reducePiEvent(state, event.kind, event.payload);
  }
  return state;
}
