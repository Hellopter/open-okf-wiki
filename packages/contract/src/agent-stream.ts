/**
 * Live Operator Session stream reduce + view patches (ADR 0031).
 *
 * Server owns reduce(Pi event → stream state) and emits stream patches.
 * Web applies patches (and snapshots); it does not parse Pi content blocks live.
 */

import { z } from "zod";
import {
  type AgentMessage,
  AgentMessageSchema,
  type AgentToolCall,
  assistantFromSnapshot,
  extractAssistantError,
  extractMessageText,
  extractMessageThinking,
  isRecord,
  makeId,
  messageRole,
  patchToolsOnAssistant,
  piMessageId,
  toolOutputFromResult,
  wikiProduceDetails,
} from "./agent-message.js";

// ---------------------------------------------------------------------------
// Stream view types
// ---------------------------------------------------------------------------

export const PiAgentStatusSchema = z.enum(["idle", "streaming", "error"]);
export type PiAgentStatus = z.infer<typeof PiAgentStatusSchema>;

/** Finalized durable rows plus at most one live assistant snapshot. */
export type PiStreamState = {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | null;
  lastAssistantId: string | null;
  turnActive: boolean;
  agentStatus: PiAgentStatus;
  errorText: string | null;
};

export const AgentStreamViewPatchSchema = z
  .object({
    agentStatus: PiAgentStatusSchema,
    errorText: z.string().nullable(),
    turnActive: z.boolean(),
    lastAssistantId: z.string().nullable(),
    streamingMessage: AgentMessageSchema.nullable(),
    /** Messages newly finalized since the previous stream state. */
    appended: z.array(AgentMessageSchema),
    /** Existing finalized messages patched in place (same id). */
    updated: z.array(AgentMessageSchema),
  })
  .strict();

export type AgentStreamViewPatch = z.infer<typeof AgentStreamViewPatchSchema>;

function nowIso(): string {
  return new Date().toISOString();
}

export function createPiStreamState(seed: readonly AgentMessage[] = []): PiStreamState {
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
    agentStatus: "idle",
    errorText: null,
  };
}

/**
 * Build stream state from a durable snapshot, optionally merging an in-flight
 * active tool (SSE snapshot arm). Shared by server fixtures and web projection.
 */
export function applySnapshotWithActiveTool(
  messages: AgentMessage[],
  activeTool?: {
    toolCallId: string;
    toolName: string;
    details?: AgentToolCall["details"];
  } | null,
): PiStreamState {
  const snapshot = createPiStreamState(messages);
  if (!activeTool) return snapshot;
  return {
    ...updateToolInState(snapshot, activeTool.toolCallId, {
      name: activeTool.toolName,
      details: activeTool.details,
      output: toolOutputFromResult(undefined, activeTool.details),
      status: "running",
    }),
    turnActive: true,
    agentStatus: "streaming",
  };
}

function withAgentError(state: PiStreamState, errorText: string): PiStreamState {
  return {
    ...state,
    agentStatus: "error",
    errorText,
  };
}

function assistantErrorText(err: ReturnType<typeof extractAssistantError>): string | null {
  if (!err.isError) return null;
  return err.errorText ?? "Agent response failed";
}

/** Finalized rows + optional streaming tail (UI timeline). */
export function viewMessages(state: PiStreamState): AgentMessage[] {
  if (!state.streamingMessage) return state.messages;
  return [...state.messages, state.streamingMessage];
}

function findMessageIndex(messages: readonly AgentMessage[], id: string | null): number {
  if (!id) return -1;
  return messages.findIndex((m) => m.id === id);
}

export function updateToolInState(
  state: PiStreamState,
  toolCallId: string,
  patch: Partial<AgentToolCall> & { name?: string },
): PiStreamState {
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
 * Reduce one parent Pi event into stream state (snapshot authority for live tail).
 * Pure: returns a new state object.
 */
export function reducePiEvent(state: PiStreamState, kind: string, payload: unknown): PiStreamState {
  const body = isRecord(payload) ? payload : {};
  const message = "message" in body ? body.message : undefined;
  const role = messageRole(message);
  const ts = nowIso();

  if (kind === "message_update") {
    if (role && role !== "assistant") return state;
    if (!message) return state;

    const text = extractMessageText(message);
    const thinking = extractMessageThinking(message);
    const hasToolCalls =
      isRecord(message) &&
      Array.isArray(message.content) &&
      message.content.some((b) => isRecord(b) && b.type === "toolCall");

    if (!text && !thinking && !hasToolCalls && !state.streamingMessage) {
      return state;
    }

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

  if (kind === "message_start") {
    if (role === "user") return state;
    if (role === "toolResult" || role === "tool") return state;

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

  if (kind === "message_end") {
    if (role === "user") return state;
    if (role === "toolResult" || role === "tool") {
      if (isRecord(message) && typeof message.toolCallId === "string") {
        const toolCallId = message.toolCallId;
        const details = wikiProduceDetails(message);
        const output = toolOutputFromResult(message, details);
        const isError = message.isError === true;
        return updateToolInState(state, toolCallId, {
          output,
          ...(details ? { details } : {}),
          status: isError ? "error" : "done",
          name: typeof message.toolName === "string" ? message.toolName : undefined,
        });
      }
      return state;
    }

    const err = extractAssistantError(message);

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
    const streamError = assistantErrorText(err);

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

      const next: PiStreamState = {
        ...state,
        messages: [...state.messages, finalized],
        streamingMessage: null,
        lastAssistantId: finalized.id,
      };
      return streamError ? withAgentError(next, streamError) : next;
    }

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
      if (state.messages.some((m) => m.id === card.id)) {
        const next = { ...state, streamingMessage: null };
        return streamError ? withAgentError(next, streamError) : next;
      }
      const lastAssistant = [...state.messages].reverse().find((m) => m.role === "assistant");
      if (
        lastAssistant &&
        lastAssistant.content === card.content &&
        (lastAssistant.tools?.length ?? 0) === (card.tools?.length ?? 0) &&
        lastAssistant.status === card.status
      ) {
        const next = { ...state, streamingMessage: null };
        return streamError ? withAgentError(next, streamError) : next;
      }
      const next: PiStreamState = {
        ...state,
        messages: [...state.messages, card],
        streamingMessage: null,
        lastAssistantId: newId,
      };
      return streamError ? withAgentError(next, streamError) : next;
    }
    return streamError ? withAgentError(state, streamError) : state;
  }

  if (kind === "tool_execution_start") {
    const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId : makeId("tool");
    const toolName = typeof body.toolName === "string" ? body.toolName : "tool";
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
      output,
      ...(details ? { details } : {}),
      status: isError ? "error" : "done",
    });
  }

  if (kind === "error") {
    const errMessage = typeof body.message === "string" ? body.message : "Agent error";
    const view = viewMessages(state);
    for (let i = view.length - 1; i >= 0; i -= 1) {
      const m = view[i]!;
      if (m.role === "assistant") {
        if (m.status === "error" && (m.errorText === errMessage || m.content === errMessage)) {
          if (state.agentStatus === "error" && state.errorText === errMessage) return state;
          return withAgentError(state, errMessage);
        }
        break;
      }
      if (m.role === "system" && m.status === "error" && m.content === errMessage) {
        if (state.agentStatus === "error" && state.errorText === errMessage) return state;
        return withAgentError(state, errMessage);
      }
    }
    return withAgentError(
      {
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
      },
      errMessage,
    );
  }

  if (kind === "agent_end" || kind === "agent_settled") {
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
    const failed = state.agentStatus === "error";
    return {
      messages,
      streamingMessage: null,
      lastAssistantId,
      turnActive: false,
      agentStatus: failed ? "error" : "idle",
      errorText: failed ? state.errorText : null,
    };
  }

  if (kind === "agent_start") {
    return {
      ...state,
      turnActive: true,
      streamingMessage: null,
      lastAssistantId: null,
      agentStatus: "streaming",
      errorText: null,
    };
  }

  return state;
}

function messageFingerprint(message: AgentMessage): string {
  return JSON.stringify(message);
}

/** Diff two stream states into a wire patch (live SSE). */
export function diffStreamState(prev: PiStreamState, next: PiStreamState): AgentStreamViewPatch {
  const prevById = new Map(prev.messages.map((m) => [m.id, m]));
  const appended: AgentMessage[] = [];
  const updated: AgentMessage[] = [];
  for (const message of next.messages) {
    const prior = prevById.get(message.id);
    if (!prior) {
      appended.push(message);
    } else if (messageFingerprint(prior) !== messageFingerprint(message)) {
      updated.push(message);
    }
  }
  return {
    agentStatus: next.agentStatus,
    errorText: next.errorText,
    turnActive: next.turnActive,
    lastAssistantId: next.lastAssistantId,
    streamingMessage: next.streamingMessage,
    appended,
    updated,
  };
}

/** Apply a server stream patch onto client stream state (preserves extra local rows). */
export function applyStreamPatch(state: PiStreamState, patch: AgentStreamViewPatch): PiStreamState {
  const byId = new Map(state.messages.map((m) => [m.id, m]));
  for (const message of patch.updated) {
    byId.set(message.id, message);
  }
  for (const message of patch.appended) {
    byId.set(message.id, message);
  }
  // Preserve order: existing order, then newly appended ids not previously present.
  const seen = new Set<string>();
  const messages: AgentMessage[] = [];
  for (const message of state.messages) {
    const next = byId.get(message.id);
    if (next) {
      messages.push(next);
      seen.add(message.id);
    }
  }
  for (const message of patch.updated) {
    if (!seen.has(message.id)) {
      messages.push(message);
      seen.add(message.id);
    }
  }
  for (const message of patch.appended) {
    if (!seen.has(message.id)) {
      messages.push(message);
      seen.add(message.id);
    }
  }
  return {
    messages,
    streamingMessage: patch.streamingMessage,
    lastAssistantId: patch.lastAssistantId,
    turnActive: patch.turnActive,
    agentStatus: patch.agentStatus,
    errorText: patch.errorText,
  };
}
