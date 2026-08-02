import type { AgentToolCall, WikiRunListItem } from "@okf-wiki/contract";

export type SessionRunLink = Pick<WikiRunListItem, "runId" | "state" | "attention" | "updatedAt">;

/** Keep the durable Run index as the source for the Session's complete Run history. */
export function sessionRunLinks(
  runs: WikiRunListItem[],
  sessionId: string | null,
): SessionRunLink[] {
  if (!sessionId) return [];
  return runs
    .filter((run) => run.sessionId === sessionId)
    .map(({ runId, state, attention, updatedAt }) => ({ runId, state, attention, updatedAt }));
}

/** Extract the durable Run referenced by a create or repair tool receipt. */
export function runIdFromToolReceipt(tool: AgentToolCall): string | undefined {
  if (tool.name === "wiki_produce") return tool.details?.runId;
  if (tool.name !== "wiki_repair" || !tool.args || typeof tool.args !== "object") return undefined;
  const runId = (tool.args as Record<string, unknown>).runId;
  return typeof runId === "string" && runId.trim() ? runId : undefined;
}
