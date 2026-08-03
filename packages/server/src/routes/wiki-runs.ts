/** HTTP adapter for the durable WikiRuns control plane (ADR 0035). */
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactErrorMessage } from "@okf-wiki/agent";
import {
  CandidateDiffReadSchema,
  CandidatePageReadSchema,
  CandidateTreeReadSchema,
  RunCommandSchema,
  WikiRunAttemptTranscriptSchema,
  WikiRunCommandResponseSchema,
  WikiRunGetResponseSchema,
  WikiRunIndexGetResponseSchema,
  WikiRunPlanReviewSchema,
  WikiRunSpecReadSchema,
} from "@okf-wiki/contract/wiki-runs";
import {
  CommandIdCollision,
  WikiRunsRequestError,
  type WikiRunsRequestErrorCode,
  WorkflowInUseError,
} from "@okf-wiki/workflow";
import {
  BodyTooLargeError,
  InvalidJsonError,
  readJsonBody,
  sendError,
  sendJson,
} from "../http-util.ts";
import { loadWorkspaceOr404 } from "../load-workspace-or-404.ts";
import { getLogger } from "../logging/index.ts";
import { streamAttemptTranscript } from "../sse/attempt-transcript.ts";
import { streamRunEvents } from "../sse/run-events.ts";
import { streamRunIndex } from "../sse/run-index.ts";
import { WikiRunsWorkspaceDeletedError, wikiRunsForWorkspace } from "../wiki-runs-registry.ts";

function actorContext(workspaceId: string) {
  return { workspaceId, actor: { id: "local-operator", kind: "local_operator" as const } };
}

const HTTP_STATUS_BY_WIKI_RUNS_ERROR = {
  not_found: 404,
  conflict: 409,
  stale_revision: 409,
  invalid_request: 400,
  payload_too_large: 413,
} as const satisfies Record<WikiRunsRequestErrorCode, number>;

function statusFor(error: unknown): number {
  if (error instanceof WikiRunsWorkspaceDeletedError) return 404;
  if (error instanceof WikiRunsRequestError) return HTTP_STATUS_BY_WIKI_RUNS_ERROR[error.code];
  if (error instanceof CommandIdCollision || error instanceof WorkflowInUseError) return 409;
  return 500;
}

function sendWikiRunsError(res: ServerResponse, error: unknown): void {
  const details = error instanceof WikiRunsRequestError ? { code: error.code } : undefined;
  sendError(res, statusFor(error), redactErrorMessage(error), details);
}

function sendWikiRunsRequestError(
  res: ServerResponse,
  code: WikiRunsRequestErrorCode,
  message: string,
): void {
  sendError(res, HTTP_STATUS_BY_WIKI_RUNS_ERROR[code], message, { code });
}

function readTranscriptCursor(url: URL, key: "before" | "after"): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return undefined;
  if (!/^\d+$/.test(raw))
    throw new WikiRunsRequestError("invalid_request", "transcript cursor is invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new WikiRunsRequestError("invalid_request", "transcript cursor is invalid");
  return value;
}

function readTranscriptLimit(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return undefined;
  if (!/^\d+$/.test(raw))
    throw new WikiRunsRequestError("invalid_request", "transcript page limit is invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    throw new WikiRunsRequestError("invalid_request", "transcript page limit is invalid");
  return value;
}

/** POST typed command. Actor and workspace are derived from the trusted route. */
export async function handleWikiRunCommand(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const code = error instanceof BodyTooLargeError ? "payload_too_large" : "invalid_request";
    const message =
      error instanceof InvalidJsonError || error instanceof BodyTooLargeError
        ? error.message
        : "invalid WikiRuns command";
    sendWikiRunsRequestError(res, code, message);
    return;
  }
  const parsed = RunCommandSchema.safeParse(body);
  if (!parsed.success) {
    sendWikiRunsRequestError(res, "invalid_request", "invalid WikiRuns command");
    return;
  }
  const commandType = parsed.data.type;
  const commandId = parsed.data.commandId;
  try {
    const receipt = await (await wikiRunsForWorkspace(workspace)).dispatch(
      parsed.data,
      actorContext(workspace.id),
    );
    getLogger().info(
      {
        event: "run.command",
        workspaceId: workspace.id,
        command: commandType,
        commandId: receipt.commandId,
        runId: receipt.runId,
      },
      "wiki run command accepted",
    );
    sendJson(res, 202, WikiRunCommandResponseSchema.parse({ receipt }));
  } catch (error) {
    const status = statusFor(error);
    const message = redactErrorMessage(error);
    getLogger()[status >= 500 ? "error" : "warn"](
      {
        event: "run.command",
        workspaceId: workspace.id,
        command: commandType,
        commandId,
        runId: "runId" in parsed.data ? parsed.data.runId : undefined,
        err: message,
        code: error instanceof WikiRunsRequestError ? error.code : undefined,
      },
      "wiki run command failed",
    );
    sendWikiRunsError(res, error);
  }
}

/** GET one secret-free durable snapshot and its current SSE cursor. */
export async function handleGetWikiRun(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  try {
    const { snapshot, cursor } = await (await wikiRunsForWorkspace(workspace)).read({ runId });
    sendJson(res, 200, WikiRunGetResponseSchema.parse({ snapshot, cursor }));
  } catch (error) {
    sendWikiRunsError(res, error);
  }
}

/**
 * GET sealed plan Spec + ExecutionPlan summary for operator document review
 * (not embedded on Run SSE). Prefer this for plan-gate UI.
 */
export async function handleGetWikiRunPlanReview(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  try {
    const body = await (await wikiRunsForWorkspace(workspace)).readPlanReview({ runId });
    sendJson(res, 200, WikiRunPlanReviewSchema.parse(body));
  } catch (error) {
    sendWikiRunsError(res, error);
  }
}

/** GET sealed plan Spec only (compat); implemented via plan-review materials. */
export async function handleGetWikiRunSpec(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  try {
    const body = await (await wikiRunsForWorkspace(workspace)).readPlanSpec({ runId });
    sendJson(res, 200, WikiRunSpecReadSchema.parse(body));
  } catch (error) {
    sendWikiRunsError(res, error);
  }
}

/** GET the compact workspace-scoped Run index projection. */
export async function handleGetWikiRunIndex(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  try {
    const index = await (await wikiRunsForWorkspace(workspace)).readIndex();
    sendJson(
      res,
      200,
      WikiRunIndexGetResponseSchema.parse({ workspaceId: workspace.id, ...index }),
    );
  } catch (error) {
    sendWikiRunsError(res, error);
  }
}

/** Candidate page read never exposes a control-store artifact path. */
export async function handleGetCandidatePage(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  const candidateDigest = url.searchParams.get("candidate")?.trim() ?? "";
  const pagePath = url.searchParams.get("page")?.trim() ?? "";
  if (!candidateDigest || !pagePath) {
    sendWikiRunsRequestError(
      res,
      "invalid_request",
      "candidate and page query parameters are required",
    );
    return;
  }
  try {
    const page = await (await wikiRunsForWorkspace(workspace)).readCandidatePage({
      runId,
      candidateDigest,
      pagePath,
    });
    sendJson(res, 200, CandidatePageReadSchema.parse(page));
  } catch (error) {
    sendWikiRunsError(res, error);
  }
}

/** GET the sealed candidate page tree without leaking artifact locations. */
export async function handleGetCandidateTree(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  const candidateDigest = url.searchParams.get("candidate")?.trim() ?? "";
  if (!candidateDigest) {
    sendWikiRunsRequestError(res, "invalid_request", "candidate query parameter is required");
    return;
  }
  try {
    const tree = await (await wikiRunsForWorkspace(workspace)).readCandidateTree({
      runId,
      candidateDigest,
    });
    sendJson(res, 200, CandidateTreeReadSchema.parse(tree));
  } catch (error) {
    sendWikiRunsError(res, error);
  }
}

export async function handleGetCandidateDiff(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  const candidateDigest = url.searchParams.get("candidate")?.trim() ?? "";
  const pagePath = url.searchParams.get("page")?.trim() ?? "";
  if (!candidateDigest || !pagePath) {
    sendWikiRunsRequestError(
      res,
      "invalid_request",
      "candidate and page query parameters are required",
    );
    return;
  }
  try {
    const diff = await (await wikiRunsForWorkspace(workspace)).readCandidateDiff({
      runId,
      candidateDigest,
      pagePath,
    });
    sendJson(res, 200, CandidateDiffReadSchema.parse(diff));
  } catch (error) {
    sendWikiRunsError(res, error);
  }
}

/**
 * GET secret-free Attempt transcript for Node details UI (completed / one-shot).
 * Does not stream tokens into run_events — pure read of session.jsonl / sealed artifact.
 */
export async function handleGetAttemptTranscript(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  attemptId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  try {
    const transcript = await (await wikiRunsForWorkspace(workspace)).readAttemptTranscript({
      runId,
      attemptId,
      beforeSequence: readTranscriptCursor(url, "before"),
      afterSequence: readTranscriptCursor(url, "after"),
      limit: readTranscriptLimit(url),
    });
    sendJson(res, 200, WikiRunAttemptTranscriptSchema.parse(transcript));
  } catch (error) {
    sendWikiRunsError(res, error);
  }
}

/**
 * Attempt transcript SSE for Node details while an Attempt is live.
 * Auth + open stream; poll/cursor logic lives in `sse/attempt-transcript`.
 */
export async function handleAttemptTranscriptEvents(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  attemptId: string,
  url: URL,
  dependencies: { heartbeatMs?: number; pollMs?: number } = {},
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;

  let runs;
  try {
    runs = await wikiRunsForWorkspace(workspace);
  } catch (error) {
    sendWikiRunsError(res, error);
    return;
  }
  let afterSequence: number;
  try {
    afterSequence = readTranscriptCursor(url, "after") ?? 0;
  } catch (error) {
    sendWikiRunsError(res, error);
    return;
  }

  await streamAttemptTranscript(req, res, runs, { runId, attemptId }, {
    ...dependencies,
    afterSequence,
    workspaceId: workspace.id,
  });
}

/** Durable Run SSE. Auth + open stream; poll/cursor logic lives in `sse/run-events`. */
export async function handleWikiRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  _url: URL,
  dependencies: { heartbeatMs?: number; pollMs?: number } = {},
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;

  let runs;
  try {
    runs = await wikiRunsForWorkspace(workspace);
  } catch (error) {
    sendWikiRunsError(res, error);
    return;
  }

  const result = await streamRunEvents(req, res, runs, runId, {
    ...dependencies,
    workspaceId: workspace.id,
  });
  if (!result.ok) sendWikiRunsError(res, result.error);
}

/** Workspace-scoped compact index SSE. Auth + open stream; poll in `sse/run-index`. */
export async function handleWikiRunIndexEvents(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
  dependencies: { heartbeatMs?: number; pollMs?: number } = {},
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;

  let runs;
  try {
    runs = await wikiRunsForWorkspace(workspace);
  } catch (error) {
    sendWikiRunsError(res, error);
    return;
  }

  const result = await streamRunIndex(req, res, runs, workspace.id, dependencies);
  if (!result.ok) sendWikiRunsError(res, result.error);
}
