/**
 * Pure projection: Pi event → operator SSE envelope (after redaction).
 * No AgentSession access — product bus only.
 */
import { redactSensitiveValue } from "@okf-wiki/agent";
import type {
  AgentSseActiveTool,
  PiAgentSseEvent,
  WikiProduceToolDetails,
} from "@okf-wiki/contract";
import { WikiProduceToolDetailsSchema } from "@okf-wiki/contract";

export function projectPiEventForSse(
  _workspaceId: string,
  sessionId: string,
  event: unknown,
  timestamp = new Date().toISOString(),
): PiAgentSseEvent {
  const kind =
    event && typeof event === "object" && "type" in event
      ? String((event as { type: unknown }).type)
      : "event";
  return {
    source: "pi",
    kind,
    sessionId,
    payload: redactSensitiveValue(event),
    timestamp,
  };
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
