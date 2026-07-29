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

// ---------------------------------------------------------------------------
// Stream view types
// ---------------------------------------------------------------------------

export const PiAgentStatusSchema = z.enum(["idle", "streaming", "error"]);
export type PiAgentStatus = z.infer<typeof PiAgentStatusSchema>;

/**
 * Live wiki_produce HITL waiter identity (one per Operator Session).
 * Bound to toolCallId + runId so stale awaiting_* cards stay read-only.
 */
export const AgentPendingGateSchema = z
  .object({
    toolCallId: z.string().min(1),
    runId: z.string().min(1),
    gate: z.enum(["plan", "publication"]),
  })
  .strict();

export type AgentPendingGate = z.infer<typeof AgentPendingGateSchema>;

/** True only for the live pending gate card (interactive Approve/Deny). */
export function isLiveWikiProduceGate(
  pendingGate: AgentPendingGate | null | undefined,
  toolCallId: string,
  details: { status?: string; runId?: string } | null | undefined,
): boolean {
  if (!pendingGate || !details?.runId) return false;
  if (toolCallId !== pendingGate.toolCallId) return false;
  if (details.runId !== pendingGate.runId) return false;
  if (pendingGate.gate === "plan") return details.status === "awaiting_plan";
  return details.status === "awaiting_publication";
}

/** Derive pendingGate from wiki_produce tool details (live onUpdate path). */
export function pendingGateFromToolDetails(
  toolCallId: string,
  details: { status?: string; runId?: string } | null | undefined,
): AgentPendingGate | null {
  if (!details?.runId) return null;
  if (details.status === "awaiting_plan") {
    return { toolCallId, runId: details.runId, gate: "plan" };
  }
  if (details.status === "awaiting_publication") {
    return { toolCallId, runId: details.runId, gate: "publication" };
  }
  return null;
}

/** Finalized durable rows plus at most one live assistant snapshot. */
export type PiStreamState = {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | null;
  lastAssistantId: string | null;
  turnActive: boolean;
  agentStatus: PiAgentStatus;
  errorText: string | null;
  /** Live HITL waiter; null when no operator gate is open. */
  pendingGate: AgentPendingGate | null;
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
    /** Live HITL waiter identity; null clears; omit preserves client value. */
    pendingGate: AgentPendingGateSchema.nullable().optional(),
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
    pendingGate: null,
  };
}

/**
 * Build stream state from a durable snapshot, optionally merging an in-flight
 * active tool (SSE snapshot arm). Shared by server fixtures and web projection.
 *
 * Snapshot messages are cold history: incomplete tools become error first, then
 * the single live activeTool (if any) is re-applied as running.
 * `pendingGate` is the live waiter from getPendingGate (absent/null clears).
 */
export function applySnapshotWithActiveTool(
  messages: AgentMessage[],
  activeTool?: {
    toolCallId: string;
    toolName: string;
    details?: AgentToolCall["details"];
  } | null,
  pendingGate?: AgentPendingGate | null,
): PiStreamState {
  const snapshot = {
    ...createPiStreamState(finalizeIncompleteTools(messages)),
    pendingGate: pendingGate ?? null,
  };
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
    pendingGate: pendingGate ?? null,
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
  // Drop live HITL if it pointed at a tool we just superseded.
  const pendingGate =
    state.pendingGate && state.pendingGate.toolCallId !== keepToolCallId ? null : state.pendingGate;
  if (pendingGate !== state.pendingGate) changed = true;
  return changed ? { ...state, messages, streamingMessage, pendingGate } : state;
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
        const next = updateToolInState(state, toolCallId, {
          output,
          ...(details ? { details } : {}),
          status: isError ? "error" : "done",
          name: typeof message.toolName === "string" ? message.toolName : undefined,
        });
        if (state.pendingGate?.toolCallId === toolCallId) {
          return { ...next, pendingGate: null };
        }
        return next;
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
          pendingGate: null,
          ...(hasBody ? { lastAssistantId: finalized.id } : {}),
        };
      }
      return {
        ...state,
        messages: [...state.messages, marker],
        streamingMessage: null,
        pendingGate: null,
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
    const next = updateToolInState(state, toolCallId, {
      output: partial,
      ...(details ? { details } : {}),
      status: "running",
    });
    // Live HITL: only touch pendingGate when details parse successfully.
    // Detail-less / unparseable partials must not drop an open gate.
    if (details) {
      const fromDetails = pendingGateFromToolDetails(toolCallId, details);
      if (fromDetails) return { ...next, pendingGate: fromDetails };
      if (state.pendingGate?.toolCallId === toolCallId) {
        return { ...next, pendingGate: null };
      }
    }
    return next;
  }

  if (kind === "tool_execution_end") {
    const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId : null;
    if (!toolCallId) return state;
    const details = wikiProduceDetails(body.result);
    const output = toolOutputFromResult(body.result, details);
    const isError = body.isError === true;
    const next = updateToolInState(state, toolCallId, {
      output,
      ...(details ? { details } : {}),
      status: isError ? "error" : "done",
    });
    if (state.pendingGate?.toolCallId === toolCallId) {
      return { ...next, pendingGate: null };
    }
    return next;
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
    // Turn is over: no tool may remain pending/running (UI would spin forever).
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
      pendingGate: null,
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
      pendingGate: null,
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
    pendingGate: next.pendingGate,
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
    // Omitted pendingGate preserves client value (partial fixtures); null clears.
    pendingGate: patch.pendingGate !== undefined ? patch.pendingGate : state.pendingGate,
  };
}
