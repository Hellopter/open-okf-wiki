import {
  type AgentSseEvent,
  applySessionStreamPatch,
  type SessionMessage,
  type SessionStreamState,
} from "@okf-wiki/contract";

function isOptimisticUserId(id: string): boolean {
  return id.startsWith("optimistic_");
}

/**
 * Drop client-only optimistic user rows once a real user message with the same
 * content is present (SSE message_end / snapshot / stream append).
 * One-to-one: each real user removes at most one unmatched optimistic with the
 * same content (so two identical prompts keep one optimistic until the second
 * real arrives).
 */
export function dedupeOptimisticUsers(state: SessionStreamState): SessionStreamState {
  const realUsers = state.messages.filter((m) => m.role === "user" && !isOptimisticUserId(m.id));
  const drop = new Set<string>();
  for (const real of realUsers) {
    const opt = state.messages.find(
      (m) =>
        m.role === "user" &&
        isOptimisticUserId(m.id) &&
        m.content === real.content &&
        !drop.has(m.id),
    );
    if (opt) drop.add(opt.id);
  }
  if (drop.size === 0) return state;
  return { ...state, messages: state.messages.filter((m) => !drop.has(m.id)) };
}

/** Append a local user bubble immediately after a successful prompt/steer send. */
export function appendOptimisticUser(state: SessionStreamState, text: string): SessionStreamState {
  const content = text.trim();
  if (!content) return state;
  const userMessage: SessionMessage = {
    id: `optimistic_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    content,
    createdAt: new Date().toISOString(),
    status: "done",
  };
  return {
    ...state,
    messages: [...state.messages, userMessage],
  };
}

/**
 * Merge attach-identity chrome from snapshot.session when state omits it
 * (Phase 0 servers put model only on payload.session).
 */
function mergeSnapshotChrome(event: Extract<AgentSseEvent, { kind: "snapshot" }>): SessionStreamState {
  const state = event.payload.state;
  const session = event.payload.session;
  return {
    ...state,
    ...(state.model ? {} : session.model ? { model: session.model } : {}),
    ...(state.contextBudget
      ? {}
      : session.contextBudget
        ? { contextBudget: session.contextBudget }
        : {}),
  };
}

/** Keep durable session history separate from the latest live stream patch. */
export function reduceSessionStreamEvent(
  state: SessionStreamState,
  event: AgentSseEvent,
): SessionStreamState {
  if (event.kind === "snapshot") {
    return dedupeOptimisticUsers(mergeSnapshotChrome(event));
  }
  if (event.kind === "stream") {
    return dedupeOptimisticUsers(applySessionStreamPatch(state, event.payload));
  }
  return state;
}
