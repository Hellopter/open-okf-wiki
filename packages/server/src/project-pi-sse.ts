/**
 * Pure projection: Pi event → operator SSE stream patch (after redaction).
 * Server owns reduce; web only applies stream/snapshot views (ADR 0031).
 */
import { redactSensitiveValue } from "@okf-wiki/agent";
import type {
  AgentSseActiveTool,
  AgentSseStream,
  PiStreamState,
  WikiProduceToolDetails,
} from "@okf-wiki/contract";
import {
  createPiStreamState,
  diffStreamState,
  reducePiEvent,
  WikiProduceToolDetailsSchema,
} from "@okf-wiki/contract";

export type { PiStreamState };

/**
 * Advance live stream state with one redacted Pi event and build the SSE frame.
 */
export function projectLiveStreamEvent(
  sessionId: string,
  state: PiStreamState,
  event: unknown,
  timestamp = new Date().toISOString(),
): { state: PiStreamState; frame: AgentSseStream } {
  const kind =
    event && typeof event === "object" && "type" in event
      ? String((event as { type: unknown }).type)
      : "event";
  const redacted = redactSensitiveValue(event);
  const next = reducePiEvent(state, kind, redacted);
  const patch = diffStreamState(state, next);
  return {
    state: next,
    frame: {
      source: "server",
      kind: "stream",
      sessionId,
      timestamp,
      payload: patch,
    },
  };
}

/** Empty stream state for a newly registered live session. */
export function initialLiveStreamState(): PiStreamState {
  return createPiStreamState();
}

/**
 * @deprecated Prefer {@link projectLiveStreamEvent}. Kept for tests that only
 * assert redaction of a single event envelope.
 */
export function projectPiEventForSse(
  _workspaceId: string,
  sessionId: string,
  event: unknown,
  timestamp = new Date().toISOString(),
): AgentSseStream {
  const { frame } = projectLiveStreamEvent(
    sessionId,
    createPiStreamState(),
    event,
    timestamp,
  );
  return frame;
}

/**
 * Derive activeTool chrome from a Pi tool_execution_update with wiki_produce details.
 * Returns null to clear, undefined for no change.
 */
export function activeToolUpdate(event: unknown): AgentSseActiveTool | null | undefined {
  if (!event || typeof event !== "object") return undefined;
  const body = event as Record<string, unknown>;
  if (
    body.type === "tool_execution_end" ||
    body.type === "agent_end" ||
    body.type === "agent_settled"
  ) {
    return null;
  }
  if (body.type === "tool_execution_start") return null;
  if (body.type !== "tool_execution_update") return undefined;

  const partial = body.partialResult;
  if (!partial || typeof partial !== "object") return undefined;
  const parsed = WikiProduceToolDetailsSchema.safeParse(
    (partial as Record<string, unknown>).details,
  );
  if (!parsed.success || typeof body.toolCallId !== "string" || typeof body.toolName !== "string") {
    return undefined;
  }
  return {
    toolCallId: body.toolCallId,
    toolName: body.toolName,
    details: parsed.data as WikiProduceToolDetails,
  };
}
