/**
 * Shell-owned single WikiRun projection (Batch 2).
 *
 * One `useWikiRun` subscription per workspace shell, keyed by activeRunId.
 * Gate panel + Run inspector consume this context when their runId matches —
 * no second/third EventSource for the same active run.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { WikiRunProjectionContextValue } from "./wiki-run-projection";
import { useWikiRun } from "./useWikiRun";
import type { ConnectionStatus } from "./useSessionAgent";

export type { WikiRunProjectionContextValue } from "./wiki-run-projection";
export { selectMatchingProjection } from "./wiki-run-projection";

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
  rootPath?: string;
  /** Active run id from resolveActiveRunId (null → no SSE). */
  runId: string | null;
  children: ReactNode;
};

/**
 * Owns the sole active-run `useWikiRun` subscription for the agent workspace shell.
 */
export function WikiRunProjectionProvider({
  workspaceId,
  rootPath,
  runId,
  children,
}: WikiRunProjectionProviderProps) {
  const wikiRun = useWikiRun({
    workspaceId,
    runId,
    rootPath,
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
export function useWikiRunProjection(): WikiRunProjectionContextValue {
  return useContext(WikiRunProjectionContext);
}
