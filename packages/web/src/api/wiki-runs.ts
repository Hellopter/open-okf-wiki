/**
 * Durable WikiRuns control-plane HTTP / EventSource API (ADR 0035).
 * Domain types come from `@okf-wiki/contract` — do not redeclare schemas here.
 */

import type {
  AttemptTraceEvent,
  RunCommand,
  RunCommandReceipt,
  WikiRunSnapshot,
  WikiRunSpecRead,
  WikiRunState,
} from "@okf-wiki/contract";
import { getApiBase, request } from "./client";

export type { WikiRunState };

/** Slim GET /runs row — WikiRuns control plane, not the deleted v2 file record. */
export type WikiRunListItem = {
  runId: string;
  state: WikiRunState;
  updatedAt: string;
  revision: number;
  /** Operator Session that started this run, when known. */
  sessionId: string | null;
};

export function listRuns(
  workspaceId: string,
): Promise<{ workspaceId: string; runs: WikiRunListItem[] }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs`);
}

/** Durable WikiRuns snapshot + cursor (ADR 0035). */
export function getWikiRun(
  workspaceId: string,
  runId: string,
): Promise<{ snapshot: WikiRunSnapshot; cursor: number }> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`,
  );
}

/** Sealed plan Spec for operator review (not on Run SSE). */
export function getWikiRunSpec(workspaceId: string, runId: string): Promise<WikiRunSpecRead> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/spec`,
  );
}

/** Secret-free cursor-paged Attempt trace for Node details UI. */
export type WikiRunAttemptTranscript = {
  attemptId: string;
  nodeKey: string;
  state: string;
  events: AttemptTraceEvent[];
  hasEarlier: boolean;
  hasMore: boolean;
  nextBefore?: number;
  cursor: number;
};

type AttemptTranscriptPageOptions = {
  before?: number;
  after?: number;
  limit?: number;
};

function attemptTranscriptQuery(options: AttemptTranscriptPageOptions = {}): string {
  const query = new URLSearchParams();
  if (options.before !== undefined) query.set("before", String(options.before));
  if (options.after !== undefined) query.set("after", String(options.after));
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const value = query.toString();
  return value ? `?${value}` : "";
}

export function getWikiRunAttemptTranscript(
  workspaceId: string,
  runId: string,
  attemptId: string,
  options?: AttemptTranscriptPageOptions,
): Promise<WikiRunAttemptTranscript> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(attemptId)}/transcript${attemptTranscriptQuery(options)}`,
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
  options?: Pick<AttemptTranscriptPageOptions, "after">,
): string {
  return `${getApiBase()}/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(attemptId)}/transcript/events${attemptTranscriptQuery(options)}`;
}

/** Dispatch a durable WikiRuns command (StartRun / ResolveGate / Cancel / …). */
export function dispatchWikiRunCommand(
  workspaceId: string,
  command: RunCommand,
): Promise<{ receipt: RunCommandReceipt }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
}

/**
 * Absolute EventSource URL for durable WikiRuns SSE (ADR 0035).
 * Server sends `snapshot` then `run.event` frames; heartbeat has no event id.
 * Native EventSource replays with `Last-Event-ID` after the last received id.
 */
export function wikiRunEventsUrl(workspaceId: string, runId: string): string {
  return `${getApiBase()}/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/events`;
}
