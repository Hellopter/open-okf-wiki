import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import {
  focusAgentWorkspaceRun,
  readAgentWorkspaceRoute,
  selectAgentWorkspaceAttempt,
  selectAgentWorkspaceRun,
  selectAgentWorkspaceSession,
} from "./workspace-route";

/** The sole React Router seam for Agent Workspace session / Run / Attempt URL state. */
export function useAgentWorkspaceRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const route = readAgentWorkspaceRoute(searchParams);

  const selectSession = useCallback(
    (sessionId: string) => {
      setSearchParams((previous) => selectAgentWorkspaceSession(previous, sessionId), {
        replace: true,
      });
    },
    [setSearchParams],
  );

  const selectRun = useCallback(
    (runId: string) => {
      setSearchParams((previous) => selectAgentWorkspaceRun(previous, runId), { replace: true });
    },
    [setSearchParams],
  );

  const focusRun = useCallback(
    (runId: string, attemptId?: string | null) => {
      setSearchParams((previous) => focusAgentWorkspaceRun(previous, runId, attemptId), {
        replace: true,
      });
    },
    [setSearchParams],
  );

  const selectAttempt = useCallback(
    (attemptId: string | null) => {
      setSearchParams((previous) => selectAgentWorkspaceAttempt(previous, attemptId), {
        replace: true,
      });
    },
    [setSearchParams],
  );

  return { ...route, selectSession, selectRun, focusRun, selectAttempt };
}
