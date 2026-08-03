import type { WorkspaceConfig } from "@okf-wiki/contract/workspace";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAgentSession,
  deleteAgentSession,
  getRunIndex,
  getWorkspace,
  listAgentSessions,
  type PiSessionSummary,
  parseWikiRunIndexEvent,
  type WikiRunListItem,
  wikiRunIndexEventsUrl,
} from "../api";
import { notifyError } from "../lib/notify";

type UseWorkspaceActivityOptions = {
  workspaceId: string;
  activeSessionId: string | null;
  onSelectInitialSession: (sessionId: string) => void;
};

/** Owns workbench list data and the index stream; route selection stays with the page. */
export function useWorkspaceActivity({
  workspaceId,
  activeSessionId,
  onSelectInitialSession,
}: UseWorkspaceActivityOptions) {
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [sessions, setSessions] = useState<PiSessionSummary[]>([]);
  const [runs, setRuns] = useState<WikiRunListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const autoSessionWorkspaceId = useRef<string | null>(null);
  const sessionsRef = useRef<PiSessionSummary[]>([]);
  const resourceKeyRef = useRef("");
  const runCursorRef = useRef(0);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!workspaceId) return;
      const resourceKey = workspaceId;
      const current = () => !signal?.aborted && resourceKeyRef.current === resourceKey;
      const [workspaceResult, sessionResult, runResult] = await Promise.all([
        getWorkspace(workspaceId, { signal }),
        listAgentSessions(workspaceId, { signal }),
        getRunIndex(workspaceId, { signal }),
      ]);
      if (!current()) return;
      let nextSessions = sessionResult.sessions;
      if (
        !activeSessionId &&
        nextSessions.length === 0 &&
        autoSessionWorkspaceId.current !== workspaceId
      ) {
        autoSessionWorkspaceId.current = workspaceId;
        try {
          const created = await createAgentSession(workspaceId);
          if (!current()) return;
          nextSessions = [
            {
              id: created.session.id,
              title: created.session.title,
              updatedAt: created.session.createdAt,
            },
          ];
        } catch (nextError) {
          autoSessionWorkspaceId.current = null;
          throw nextError;
        }
      }
      setWorkspace(workspaceResult.workspace);
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
      if (runResult.cursor >= runCursorRef.current) {
        runCursorRef.current = runResult.cursor;
        setRuns(runResult.runs);
      }
      if (!activeSessionId && nextSessions[0]) onSelectInitialSession(nextSessions[0].id);
    },
    [activeSessionId, onSelectInitialSession, workspaceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    resourceKeyRef.current = workspaceId;
    runCursorRef.current = 0;
    setWorkspace(null);
    sessionsRef.current = [];
    setSessions([]);
    setRuns([]);
    setError(null);
    setLoading(true);
    void refresh(controller.signal)
      .catch((nextError: unknown) => {
        if (!controller.signal.aborted) setError(nextError);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    const resourceKey = workspaceId;
    const source = new EventSource(wikiRunIndexEventsUrl(workspaceId));
    source.addEventListener("index", (event) => {
      try {
        const frame = parseWikiRunIndexEvent((event as MessageEvent<string>).data);
        if (resourceKeyRef.current !== resourceKey || frame.eventId < runCursorRef.current) return;
        runCursorRef.current = frame.eventId;
        setRuns(frame.runs);
      } catch {
        // The next snapshot restores the run index after a malformed stream frame.
      }
    });
    return () => source.close();
  }, [workspaceId]);

  const createSession = useCallback(async (): Promise<PiSessionSummary | null> => {
    if (!workspaceId || creating) return null;
    setCreating(true);
    try {
      const created = await createAgentSession(workspaceId);
      const session = {
        id: created.session.id,
        title: created.session.title,
        updatedAt: created.session.createdAt,
      };
      const nextSessions = [session, ...sessionsRef.current];
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
      return session;
    } catch (nextError) {
      notifyError(nextError);
      return null;
    } finally {
      setCreating(false);
    }
  }, [creating, workspaceId]);

  const removeSession = useCallback(
    async (sessionId: string): Promise<PiSessionSummary[] | null> => {
      if (!workspaceId) return null;
      try {
        await deleteAgentSession(workspaceId, sessionId);
        const nextSessions = sessionsRef.current.filter((session) => session.id !== sessionId);
        sessionsRef.current = nextSessions;
        setSessions(nextSessions);
        return nextSessions;
      } catch (nextError) {
        notifyError(nextError);
        return null;
      }
    },
    [workspaceId],
  );

  const updateTitleFromPrompt = useCallback((sessionId: string, title: string | undefined) => {
    if (!title) return;
    const nextSessions = sessionsRef.current.map((session) =>
      session.id === sessionId && session.title?.startsWith("Wiki Agent:")
        ? { ...session, title }
        : session,
    );
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
  }, []);

  return {
    workspace,
    sessions,
    runs,
    loading,
    creating,
    error,
    setError,
    refresh,
    createSession,
    removeSession,
    updateTitleFromPrompt,
  };
}
