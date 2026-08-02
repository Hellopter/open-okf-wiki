import {
  type AgentMessage,
  type AgentSseEvent,
  applyStreamPatch,
  createPiStreamState,
  type PiStreamState,
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
export function dedupeOptimisticUsers(state: PiStreamState): PiStreamState {
  const realUsers = state.messages.filter(
    (m) => m.role === "user" && !isOptimisticUserId(m.id),
  );
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
export function appendOptimisticUser(state: PiStreamState, text: string): PiStreamState {
  const content = text.trim();
  if (!content) return state;
  const userMessage: AgentMessage = {
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

/** Keep durable session history separate from the latest live stream patch. */
export function reduceSessionStreamEvent(
  state: PiStreamState,
  event: AgentSseEvent,
): PiStreamState {
  if (event.kind === "snapshot") {
    const snapshot = createPiStreamState(event.payload.messages);
    return dedupeOptimisticUsers({
      ...snapshot,
      contextPhase: event.payload.contextPhase ?? snapshot.contextPhase,
    });
  }
  if (event.kind === "stream") {
    return dedupeOptimisticUsers(applyStreamPatch(state, event.payload));
  }
  return state;
}
