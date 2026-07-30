/**
 * Shell-owned single WikiRun projection.
 *
 * One `useWikiRun` subscription per workspace shell, keyed by URL `?run=` only.
 * ActiveRunBar / RunCockpit match by runId — no second EventSource.
 * Graph expand is local UI state (not this context). Receipt only updates URL run.
 */

import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { ConnectionStatus } from "./useSessionAgent";
import { useWikiRun } from "./useWikiRun";
import type { WikiRunProjectionContextValue } from "./wiki-run-projection";

const IDLE_VALUE: WikiRunProjectionContextValue = {
  runId: null,
  subscribed: false,
  snapshot: null,
  cursor: null,
  ready: false,
  connectionStatus: "offline" satisfies ConnectionStatus,
  error: null,
  eventsUrl: null,
  refresh: async () => {},
};

const WikiRunProjectionContext = createContext<WikiRunProjectionContextValue>(IDLE_VALUE);

export type WikiRunProjectionProviderProps = {
  workspaceId: string;
  /** Active run id from URL `?run=` (null → no SSE). */
  runId: string | null;
  children: ReactNode;
};

/**
 * Owns the sole active-run `useWikiRun` subscription for the agent workspace shell.
 */
export function WikiRunProjectionProvider({
  workspaceId,
  runId,
  children,
}: WikiRunProjectionProviderProps) {
  const wikiRun = useWikiRun({
    workspaceId,
    runId,
    enabled: Boolean(runId && workspaceId),
  });

  const value = useMemo<WikiRunProjectionContextValue>(
    () => ({
      snapshot: wikiRun.snapshot,
      cursor: wikiRun.cursor,
      ready: wikiRun.ready,
      connectionStatus: wikiRun.connectionStatus,
      error: wikiRun.error,
      eventsUrl: wikiRun.eventsUrl,
      refresh: wikiRun.refresh,
      runId: runId ?? null,
      subscribed: Boolean(runId && workspaceId),
    }),
    [
      wikiRun.snapshot,
      wikiRun.cursor,
      wikiRun.ready,
      wikiRun.connectionStatus,
      wikiRun.error,
      wikiRun.eventsUrl,
      wikiRun.refresh,
      runId,
      workspaceId,
    ],
  );

  return (
    <WikiRunProjectionContext.Provider value={value}>{children}</WikiRunProjectionContext.Provider>
  );
}

/** Safe default when outside provider or with no active run. */
// The Provider and hook must share this private Context identity.
// eslint-disable-next-line react-refresh/only-export-components
export function useWikiRunProjection(): WikiRunProjectionContextValue {
  return useContext(WikiRunProjectionContext);
}
