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
  finalizeIncompleteTools,
  finalizeIncompleteToolsOnMessage,
  isRecord,
  makeId,
  messageRole,
  patchToolsOnAssistant,
  piMessageId,
  toolOutputFromResult,
  wikiProduceDetails,
} from "./agent-message.js";
import { SessionUsageSchema } from "./session-usage.js";

// ---------------------------------------------------------------------------
// Stream view types
// ---------------------------------------------------------------------------

/**
 * Operator Session turn projection status.
 *
 * Pi lifecycle: `agent_end` is not terminal (retry / compaction / queued
 * continuation may follow). Only `agent_settled` maps to idle/error.
 */
export const PiAgentStatusSchema = z.enum([
  "idle",
  "streaming",
  "between_operations",
  "retrying",
  "compacting",
  "error",
]);
export type PiAgentStatus = z.infer<typeof PiAgentStatusSchema>;

/**
 * Session context pressure phase (UI chrome; not durable control truth).
 * Token counts remain measurements; phase is derived by the server.
 */
export const ContextPhaseSchema = z.enum([
  "normal",
  "approaching_target",
  "at_target",
  "compacting",
  "unknown",
]);
export type ContextPhase = z.infer<typeof ContextPhaseSchema>;

/** Finalized durable rows plus at most one live assistant snapshot. */
export type PiStreamState = {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | null;
  lastAssistantId: string | null;
  turnActive: boolean;
  agentStatus: PiAgentStatus;
  errorText: string | null;
  /** Context pressure phase; updated with usage / compaction events. */
  contextPhase: ContextPhase;
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
    /**
     * Optional context-fill update (e.g. after assistant message_end with usage).
     * Absent means "no change" on the client; present replaces prior sessionUsage.
     */
    sessionUsage: SessionUsageSchema.optional(),
    /** Context pressure phase when known; always set on live reduce patches. */
    contextPhase: ContextPhaseSchema.optional(),
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
    contextPhase: "unknown",
  };
}

/**
 * Derive context pressure phase from fill proxy + compaction flag.
 * Compacting wins; missing tokens/target → unknown.
 */
export function deriveContextPhase(input: {
  contextTokens?: number;
  contextTarget?: number;
  contextWindow?: number;
  compacting?: boolean;
}): ContextPhase {
  if (input.compacting) return "compacting";
  const tokens = input.contextTokens;
  const target =
    typeof input.contextTarget === "number" && input.contextTarget > 0
      ? input.contextTarget
      : typeof input.contextWindow === "number" && input.contextWindow > 0
        ? input.contextWindow
        : undefined;
  if (
    typeof tokens !== "number" ||
    !Number.isFinite(tokens) ||
    tokens < 0 ||
    typeof target !== "number"
  ) {
    return "unknown";
  }
  if (tokens >= target) return "at_target";
  // Approaching: at least 80% of target/window.
  if (tokens >= target * 0.8) return "approaching_target";
  return "normal";
}

/**
 * Build stream state from a durable snapshot, optionally merging an in-flight
 * active tool (SSE snapshot arm). Shared by server fixtures and web projection.
 *
 * Snapshot messages are cold history: incomplete tools become error first, then
 * the single live activeTool (if any) is re-applied as running.
 */
export function applySnapshotWithActiveTool(
  messages: AgentMessage[],
  activeTool?: {
    toolCallId: string;
    toolName: string;
    details?: AgentToolCall["details"];
  } | null,
): PiStreamState {
  const snapshot = createPiStreamState(finalizeIncompleteTools(messages));
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
    contextPhase: snapshot.contextPhase,
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

/** True when any assistant (finalized or streaming) already owns this toolCallId. */
function hasToolCallId(state: PiStreamState, toolCallId: string): boolean {
  if (state.streamingMessage?.tools?.some((t) => t.id === toolCallId)) return true;
  return state.messages.some(
    (m) => m.role === "assistant" && Boolean(m.tools?.some((t) => t.id === toolCallId)),
  );
}

/**
 * Patch a tool by global toolCallId lookup.
 *
 * Search order:
 * 1. streamingMessage tools by id
 * 2. all finalized messages (newest first) for an assistant owning that id
 * 3. only if not found: attach to streamingMessage / last assistant / new shell
 *
 * Never creates a second copy of an existing toolCallId.
 */
export function updateToolInState(
  state: PiStreamState,
  toolCallId: string,
  patch: Partial<AgentToolCall> & { name?: string },
): PiStreamState {
  // a. streamingMessage tools by id
  if (state.streamingMessage?.tools?.some((t) => t.id === toolCallId)) {
    return {
      ...state,
      streamingMessage: patchToolsOnAssistant(state.streamingMessage, toolCallId, patch),
    };
  }

  // b. ALL messages (newest first) for assistant containing that tool id
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i]!;
    if (message.role !== "assistant") continue;
    if (!message.tools?.some((t) => t.id === toolCallId)) continue;
    const next = state.messages.slice();
    next[i] = patchToolsOnAssistant(message, toolCallId, patch);
    return { ...state, messages: next };
  }

  // Defensive: same id exists somewhere unexpected — never fork a second card.
  if (hasToolCallId(state, toolCallId)) {
    return state;
  }

  // c. Not found: create on streamingMessage, last assistant, or a new shell
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

/** Finalize pending/running tools on messages + streamingMessage. */
export function finalizeIncompleteToolsInState(state: PiStreamState): PiStreamState {
  const messages = finalizeIncompleteTools(state.messages);
  const streamingMessage = state.streamingMessage
    ? finalizeIncompleteToolsOnMessage(state.streamingMessage)
    : null;
  if (messages === state.messages && streamingMessage === state.streamingMessage) {
    return state;
  }
  return { ...state, messages, streamingMessage };
}

/**
 * When a new wiki_produce starts, mark other non-terminal wiki_produce tools as
 * superseded so the UI does not keep multiple live produce cards.
 */
function supersedeOtherWikiProduce(state: PiStreamState, keepToolCallId: string): PiStreamState {
  const markMessage = (message: AgentMessage): AgentMessage => {
    if (!message.tools?.length) return message;
    let changed = false;
    const tools = message.tools.map((tool) => {
      if (tool.id === keepToolCallId) return tool;
      if (tool.name !== "wiki_produce") return tool;
      if (tool.status === "done" || tool.status === "error") return tool;
      changed = true;
      return {
        ...tool,
        status: "error" as const,
        output: "Superseded by a new wiki_produce",
      };
    });
    return changed ? { ...message, tools } : message;
  };

  let changed = false;
  const messages = state.messages.map((message) => {
    const next = markMessage(message);
    if (next !== message) changed = true;
    return next;
  });
  const streamingMessage = state.streamingMessage ? markMessage(state.streamingMessage) : null;
  if (streamingMessage !== state.streamingMessage) changed = true;
  return changed ? { ...state, messages, streamingMessage } : state;
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
    const base = toolName === "wiki_produce" ? supersedeOtherWikiProduce(state, toolCallId) : state;
    return updateToolInState(base, toolCallId, {
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

  if (kind === "agent_end") {
    // Agent loop ended; Pi may still retry, compact, or run queued follow-ups.
    // Keep turn active — only agent_settled is terminal.
    const failed = state.agentStatus === "error";
    let messages = state.messages;
    let lastAssistantId = state.lastAssistantId;
    let streamingMessage = state.streamingMessage;
    // Fold any leftover streaming tail into durable messages, but do not
    // finalize incomplete tools (retry/continuation may still own them).
    if (streamingMessage) {
      const done: AgentMessage = {
        ...streamingMessage,
        status: streamingMessage.status === "error" ? "error" : "done",
        thinkingStatus: streamingMessage.thinking
          ? "done"
          : streamingMessage.thinkingStatus,
      };
      messages = [...messages, done];
      lastAssistantId = done.id;
      streamingMessage = null;
    }
    return {
      ...state,
      messages,
      streamingMessage,
      lastAssistantId,
      turnActive: true,
      agentStatus: failed ? "error" : "between_operations",
      errorText: failed ? state.errorText : null,
    };
  }

  if (kind === "agent_settled") {
    // True turn terminal: no automatic retry, compaction, or queued continuation.
    const finalized = finalizeIncompleteToolsInState(state);
    let messages = finalized.messages;
    let lastAssistantId = finalized.lastAssistantId;
    if (finalized.streamingMessage) {
      const done: AgentMessage = {
        ...finalized.streamingMessage,
        status: finalized.streamingMessage.status === "error" ? "error" : "done",
        thinkingStatus: finalized.streamingMessage.thinking
          ? "done"
          : finalized.streamingMessage.thinkingStatus,
      };
      messages = [...messages, done];
      lastAssistantId = done.id;
    } else {
      messages = messages.map((m) =>
        m.status === "streaming" ? { ...m, status: "done" as const } : m,
      );
    }
    const failed = finalized.agentStatus === "error";
    return {
      messages,
      streamingMessage: null,
      lastAssistantId,
      turnActive: false,
      agentStatus: failed ? "error" : "idle",
      errorText: failed ? finalized.errorText : null,
      contextPhase:
        finalized.contextPhase === "compacting" ? "unknown" : finalized.contextPhase,
    };
  }

  if (kind === "auto_retry_start") {
    return {
      ...state,
      turnActive: true,
      agentStatus: "retrying",
    };
  }

  if (kind === "auto_retry_end") {
    const success = body.success === true;
    if (!success && typeof body.finalError === "string" && body.finalError.trim()) {
      return withAgentError(
        { ...state, turnActive: true, agentStatus: "between_operations" },
        body.finalError.trim(),
      );
    }
    // Stay between operations until agent_settled (or next agent_start).
    return {
      ...state,
      turnActive: true,
      agentStatus: state.agentStatus === "error" ? "error" : "between_operations",
    };
  }

  if (kind === "compaction_start") {
    return {
      ...state,
      turnActive: true,
      agentStatus: "compacting",
      contextPhase: "compacting",
    };
  }

  if (kind === "compaction_end") {
    const aborted = body.aborted === true;
    const willRetry = body.willRetry === true;
    const err =
      typeof body.errorMessage === "string" && body.errorMessage.trim()
        ? body.errorMessage.trim()
        : null;
    if (err && !aborted) {
      return withAgentError(
        {
          ...state,
          turnActive: true,
          agentStatus: "between_operations",
          contextPhase: "unknown",
        },
        err,
      );
    }
    return {
      ...state,
      turnActive: true,
      agentStatus: willRetry
        ? "streaming"
        : state.agentStatus === "error"
          ? "error"
          : "between_operations",
      // Compaction clears reliable fill until the next usage snapshot.
      contextPhase: "unknown",
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
    contextPhase: next.contextPhase,
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
    contextPhase: patch.contextPhase ?? state.contextPhase,
  };
}
