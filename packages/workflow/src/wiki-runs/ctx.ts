/**
 * Shared WikiRuns host context layers (DIP surface for module hosts).
 *
 * Hosts are intersections of these layers + domain-specific callbacks.
 * Owner builds one base and spreads — avoids duplicated object literals.
 */

import type { DatabaseSync } from "node:sqlite";
import type { WikiRunEvent, WorkspaceConfig } from "@okf-wiki/contract";
import type { ClaimedNode } from "./types.js";

/** Workspace + SQLite + event emit — minimum control-plane surface. */
export type WikiRunsDbCtx = {
  /** Latest Workspace config, used exclusively when accepting StartRun. */
  workspace: WorkspaceConfig;
  /** Immutable configuration snapshot captured by the given Run at StartRun. */
  workspaceForRun(runId: string): WorkspaceConfig;
  db: DatabaseSync;
  emit(runId: string, type: WikiRunEvent["type"]): number;
};

/** DbCtx plus owner-bound IMMEDIATE transactions. */
export type WikiRunsTxCtx = WikiRunsDbCtx & {
  transaction<T>(work: () => T): T;
};

/**
 * TxCtx plus CAS / generation checks used by attempt commit, seal, freeze.
 * `isCurrent` is the attemptId+generation lease predicate.
 */
export type WikiRunsCasCtx = WikiRunsTxCtx & {
  isCurrent(claim: ClaimedNode): boolean;
  currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
};
