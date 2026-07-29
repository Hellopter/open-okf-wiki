/**
 * Pure helpers for shell WikiRun projection matching (Batch 2).
 *
 * Product UI: one shell `useWikiRun` for activeRunId; consumers match by runId
 * instead of opening a second EventSource.
 */

import type { WikiRunSnapshot } from "@okf-wiki/contract";
import type { ConnectionStatus } from "./useSessionAgent";
import type { UseWikiRunResult } from "./useWikiRun";

export type WikiRunProjectionContextValue = UseWikiRunResult & {
  /** Run id the shell is subscribed to (may be null). */
  runId: string | null;
  /**
   * True when this context holds a live subscription for `runId`.
   * False for the idle default outside a provider / when runId is null.
   */
  subscribed: boolean;
};

export type MatchedWikiRunProjection = {
  matches: boolean;
  snapshot: WikiRunSnapshot | null;
  ready: boolean;
  connectionStatus: ConnectionStatus;
  error: string | null;
  refresh: () => Promise<void>;
};

/**
 * Use shell projection when it matches `runId`; otherwise return null fields
 * so callers do not open a second subscription for a non-active card.
 *
 * When the shell `runId` prop advanced but `useWikiRun` has not yet cleared the
 * previous snapshot (one render before the effect reset), drop cross-run
 * ready/error so Gate/Inspector show loading instead of stale chrome.
 */
export function selectMatchingProjection(
  projection: WikiRunProjectionContextValue,
  runId: string | null | undefined,
): MatchedWikiRunProjection {
  const matches = Boolean(runId && projection.subscribed && projection.runId === runId);
  if (!matches) {
    return {
      matches: false,
      snapshot: null,
      ready: false,
      connectionStatus: "offline",
      error: null,
      refresh: projection.refresh,
    };
  }
  const snapshot = projection.snapshot?.runId === runId ? projection.snapshot : null;
  // Snapshot present for another runId → mid-switch; treat as not ready yet.
  const crossRunStale = projection.snapshot != null && snapshot == null;
  return {
    matches: true,
    snapshot,
    ready: Boolean(snapshot) && projection.ready,
    connectionStatus: projection.connectionStatus,
    error: crossRunStale ? null : projection.error,
    refresh: projection.refresh,
  };
}
