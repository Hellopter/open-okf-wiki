/**
 * Durable WikiRuns control-plane HTTP / EventSource API (ADR 0035).
 * Domain types come from `@okf-wiki/contract` — do not redeclare schemas here.
 */

import type { CandidateDiffRead, CandidatePageRead, CandidateTreeRead, RunCommand, WikiRunAttemptTranscript, WikiRunCommandResponse, WikiRunGetResponse, WikiRunIndexGetResponse, WikiRunListItem, WikiRunPlanReview, WikiRunSpecRead, WikiRunState } from "@okf-wiki/contract/wiki-runs";
import { CandidateDiffReadSchema, CandidatePageReadSchema, CandidateTreeReadSchema, WikiRunAttemptTranscriptSchema, WikiRunCommandResponseSchema, WikiRunGetResponseSchema, WikiRunIndexGetResponseSchema, WikiRunPlanReviewSchema, WikiRunSpecReadSchema } from "@okf-wiki/contract/wiki-runs";
import { getApiBase, request } from "./client";

export type { WikiRunAttemptTranscript, WikiRunListItem, WikiRunPlanReview, WikiRunState };

export function getRunIndex(
  workspaceId: string,
  init?: Pick<RequestInit, "signal">,
): Promise<WikiRunIndexGetResponse> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs/index`, init).then(
    WikiRunIndexGetResponseSchema.parse,
  );
}

/** Durable WikiRuns snapshot + cursor (ADR 0035). */
export function getWikiRun(workspaceId: string, runId: string): Promise<WikiRunGetResponse> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`,
  ).then(WikiRunGetResponseSchema.parse);
}

/**
 * Spec + ExecutionPlan summary for plan-gate document review (not on Run SSE).
 * Prefer this over {@link getWikiRunSpec} for operator UI.
 *
 * `discoverySummary` / `semanticSufficiency` are first-class optional fields on
 * {@link WikiRunPlanReviewSchema}. Soft-reattach keeps older host shapes
 * (`discovery` / `discoveryMap` full maps) available for UI soft-readers.
 */
export function getWikiRunPlanReview(
  workspaceId: string,
  runId: string,
  init?: Pick<RequestInit, "signal">,
): Promise<WikiRunPlanReview> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/plan-review`,
    init,
  ).then((raw) => {
    const review = WikiRunPlanReviewSchema.parse(raw);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return review;
    const row = raw as Record<string, unknown>;
    // Soft fallback: re-attach full-map aliases not on the formal schema.
    for (const key of ["discovery", "discoveryMap"] as const) {
      if (row[key] != null && typeof row[key] === "object" && !(key in review)) {
        Object.assign(review, { [key]: row[key] });
      }
    }
    // If host sent discoverySummary that failed strict parse (unlikely), re-attach.
    if (
      row.discoverySummary != null &&
      typeof row.discoverySummary === "object" &&
      review.discoverySummary === undefined
    ) {
      Object.assign(review, { discoverySummary: row.discoverySummary });
    }
    return review;
  });
}

/** Sealed plan Spec only (compat thin read). */
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
