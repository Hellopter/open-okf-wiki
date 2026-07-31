/**
 * Durable WikiRuns control-plane HTTP / EventSource API (ADR 0035).
 * Domain types come from `@okf-wiki/contract` — do not redeclare schemas here.
 */

import type {
  RunCommand,
  WikiRunAttemptTranscript,
  WikiRunCommandResponse,
  WikiRunGetResponse,
  WikiRunListItem,
  WikiRunListResponse,
  WikiRunSpecRead,
  WikiRunState,
} from "@okf-wiki/contract";
import {
  WikiRunAttemptTranscriptSchema,
  WikiRunCommandResponseSchema,
  WikiRunGetResponseSchema,
  WikiRunListResponseSchema,
  WikiRunSpecReadSchema,
} from "@okf-wiki/contract";
import { getApiBase, request } from "./client";

export type { WikiRunAttemptTranscript, WikiRunListItem, WikiRunState };

export function listRuns(workspaceId: string): Promise<WikiRunListResponse> {
  return request<unknown>(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs`).then(
    WikiRunListResponseSchema.parse,
  );
}

/** Durable WikiRuns snapshot + cursor (ADR 0035). */
export function getWikiRun(workspaceId: string, runId: string): Promise<WikiRunGetResponse> {
  return request<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`,
  ).then(WikiRunGetResponseSchema.parse);
}

/** Sealed plan Spec for operator review (not on Run SSE). */
export function getWikiRunSpec(workspaceId: string, runId: string): Promise<WikiRunSpecRead> {
  return request<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/spec`,
  ).then(WikiRunSpecReadSchema.parse);
}

/** Secret-free cursor-paged Attempt trace for Node details UI. */
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
  return request<unknown>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(attemptId)}/transcript${attemptTranscriptQuery(options)}`,
  ).then(WikiRunAttemptTranscriptSchema.parse);
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
): Promise<WikiRunCommandResponse> {
  return request<unknown>(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  }).then(WikiRunCommandResponseSchema.parse);
}

/**
 * Absolute EventSource URL for durable WikiRuns SSE (ADR 0035).
 * Server sends `snapshot` then `run.event` frames; heartbeat has no event id.
 * Native EventSource replays with `Last-Event-ID` after the last received id.
 */
export function wikiRunEventsUrl(workspaceId: string, runId: string): string {
  return `${getApiBase()}/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/events`;
}
