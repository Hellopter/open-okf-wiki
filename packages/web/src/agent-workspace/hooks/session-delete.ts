import type { PiSessionSummary } from "../../api";

export function removeSessionSelection(
  sessions: PiSessionSummary[],
  deletedSessionId: string,
  activeSessionId: string | null,
): { sessions: PiSessionSummary[]; activeSessionId: string | null } {
  const nextSessions = sessions.filter((session) => session.id !== deletedSessionId);
  const nextActiveSessionId = nextSessions.some((session) => session.id === activeSessionId)
    ? activeSessionId
    : (nextSessions[0]?.id ?? null);
  return { sessions: nextSessions, activeSessionId: nextActiveSessionId };
}
