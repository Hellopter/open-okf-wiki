/**
 * Durable WikiRuns control-plane HTTP / EventSource API (ADR 0035).
 * Domain types come from `@okf-wiki/contract` — do not redeclare schemas here.
 */

import type {
  CandidateDiffRead,
  CandidatePageRead,
  CandidateTreeRead,
  RunCommand,
  WikiRunAttemptTranscript,
  WikiRunCommandResponse,
  WikiRunGetResponse,
  WikiRunIndexGetResponse,
  WikiRunListItem,
  WikiRunSpecRead,
  WikiRunState,
} from "@okf-wiki/contract";
import {
  CandidateDiffReadSchema,
  CandidatePageReadSchema,
  CandidateTreeReadSchema,
  WikiRunAttemptTranscriptSchema,
  WikiRunCommandResponseSchema,
  WikiRunGetResponseSchema,
  WikiRunIndexGetResponseSchema,
  WikiRunSpecReadSchema,
} from "@okf-wiki/contract";
import { getApiBase, request } from "./client";

export type { WikiRunAttemptTranscript, WikiRunListItem, WikiRunState };

export function getRunIndex(workspaceId: string): Promise<WikiRunIndexGetResponse> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs/index`).then(
    WikiRunIndexGetResponseSchema.parse,
  );
}

/** Durable WikiRuns snapshot + cursor (ADR 0035). */
export function getWikiRun(workspaceId: string, runId: string): Promise<WikiRunGetResponse> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`,
  ).then(WikiRunGetResponseSchema.parse);
}

/** Sealed plan Spec for operator review (not on Run SSE). */
export function getWikiRunSpec(workspaceId: string, runId: string): Promise<WikiRunSpecRead> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/spec`,
  ).then(WikiRunSpecReadSchema.parse);
}

export function getCandidatePage(
  workspaceId: string,
  runId: string,
  candidateDigest: string,
  pagePath: string,
): Promise<CandidatePageRead> {
  const query = new URLSearchParams({ candidate: candidateDigest, page: pagePath });
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/candidate/page?${query}`,
  ).then(CandidatePageReadSchema.parse);
}

export function getCandidateTree(
  workspaceId: string,
  runId: string,
  candidateDigest: string,
): Promise<CandidateTreeRead> {
  const query = new URLSearchParams({ candidate: candidateDigest });
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/candidate/tree?${query}`,
  ).then(CandidateTreeReadSchema.parse);
}

export function getCandidateDiff(
  workspaceId: string,
  runId: string,
  candidateDigest: string,
  pagePath: string,
): Promise<CandidateDiffRead> {
  const query = new URLSearchParams({ candidate: candidateDigest, page: pagePath });
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/candidate/diff?${query}`,
  ).then(CandidateDiffReadSchema.parse);
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
  return request(
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
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs/command`, {
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

export function wikiRunIndexEventsUrl(workspaceId: string): string {
  return `${getApiBase()}/api/workspaces/${encodeURIComponent(workspaceId)}/runs/index/events`;
}
