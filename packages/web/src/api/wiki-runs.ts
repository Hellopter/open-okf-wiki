/**
 * Durable WikiRuns control-plane HTTP / EventSource API (ADR 0035).
 * Domain types come from `@okf-wiki/contract` — do not redeclare schemas here.
 */

import type {
  RunCommand,
  RunCommandReceipt,
  WikiRunSnapshot,
  WikiRunSpecRead,
  WikiRunState,
} from "@okf-wiki/contract";
import { getApiBase, request, withRootPathQuery } from "./client";

export type { WikiRunState };

/** Slim GET /runs row — WikiRuns control plane, not the deleted v2 file record. */
export type WikiRunListItem = {
  runId: string;
  state: WikiRunState;
  updatedAt: string;
  revision: number;
};

export function listRuns(
  workspaceId: string,
  rootPath?: string,
): Promise<{ workspaceId: string; runs: WikiRunListItem[] }> {
  return request(
    withRootPathQuery(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs`, rootPath),
  );
}

/** Durable WikiRuns snapshot + cursor (ADR 0035). */
export function getWikiRun(
  workspaceId: string,
  runId: string,
  rootPath?: string,
): Promise<{ snapshot: WikiRunSnapshot; cursor: number }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`,
      rootPath,
    ),
  );
}

/** Sealed plan Spec for operator review (not on Run SSE). */
export function getWikiRunSpec(
  workspaceId: string,
  runId: string,
  rootPath?: string,
): Promise<WikiRunSpecRead> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/spec`,
      rootPath,
    ),
  );
}

/** Secret-free Attempt transcript for Node details UI (JSONL messages). */
export type WikiRunAttemptTranscript = {
  attemptId: string;
  nodeKey: string;
  state: string;
  messages: unknown[];
};

export function getWikiRunAttemptTranscript(
  workspaceId: string,
  runId: string,
  attemptId: string,
  rootPath?: string,
): Promise<WikiRunAttemptTranscript> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(attemptId)}/transcript`,
      rootPath,
    ),
  );
}

/**
 * EventSource URL for live Attempt transcript (Node details dialog).
 * Server emits `transcript` snapshots while running, then `done`.
 * Completed attempts should use GET instead.
 */
export function wikiRunAttemptTranscriptEventsUrl(
  workspaceId: string,
  runId: string,
  attemptId: string,
  rootPath?: string,
): string {
  return `${getApiBase()}${withRootPathQuery(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(attemptId)}/transcript/events`,
    rootPath,
  )}`;
}

/** Dispatch a durable WikiRuns command (StartRun / ResolveGate / Cancel / …). */
export function dispatchWikiRunCommand(
  workspaceId: string,
  command: RunCommand,
  rootPath?: string,
): Promise<{ receipt: RunCommandReceipt }> {
  return request(
    withRootPathQuery(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs/command`, rootPath),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    },
  );
}

/**
 * Absolute EventSource URL for durable WikiRuns SSE (ADR 0035).
 * Server sends `snapshot` then `run.event` frames; heartbeat has no event id.
 * Native EventSource replays with `Last-Event-ID` after the last received id.
 */
export function wikiRunEventsUrl(workspaceId: string, runId: string, rootPath?: string): string {
  return `${getApiBase()}${withRootPathQuery(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/events`,
    rootPath,
  )}`;
}
