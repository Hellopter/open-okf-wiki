import type { WikiRunListItem } from "@okf-wiki/contract";

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
