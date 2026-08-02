/** HTTP adapter for the durable WikiRuns control plane (ADR 0035). */
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactErrorMessage } from "@okf-wiki/agent";
import {
  CandidateDiffReadSchema,
  CandidatePageReadSchema,
  CandidateTreeReadSchema,
  RunCommandSchema,
  WikiRunAttemptTranscriptDoneFrameSchema,
  WikiRunAttemptTranscriptErrorFrameSchema,
  WikiRunAttemptTranscriptSchema,
  WikiRunAttemptTranscriptTraceFrameSchema,
  WikiRunCommandResponseSchema,
  type WikiRunEvent,
  WikiRunGetResponseSchema,
  WikiRunIndexEventSchema,
  WikiRunIndexGetResponseSchema,
  type WikiRunSnapshot,
  WikiRunPlanReviewSchema,
  WikiRunSpecReadSchema,
} from "@okf-wiki/contract";
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
import { WikiRunsWorkspaceDeletedError, wikiRunsForWorkspace } from "../wiki-runs-registry.ts";

const HEARTBEAT_MS = 15_000;
const POLL_MS = 500;
/** Attempt transcript SSE: poll session.jsonl while the dialog is open. */
const TRANSCRIPT_SSE_POLL_MS = 400;
const TRANSCRIPT_SSE_HEARTBEAT_MS = 15_000;

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

function parseLastEventId(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function writeSse(res: ServerResponse, event: string, payload: unknown, eventId?: number): void {
  if (res.writableEnded || res.destroyed) return;
  const id = eventId === undefined ? "" : `id: ${eventId}\n`;
  res.write(`${id}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function writeHeartbeat(res: ServerResponse): void {
  if (!res.writableEnded && !res.destroyed) res.write(": heartbeat\n\n");
}

function transcriptErrorFrame(error: unknown): { message: string } {
  const message = redactErrorMessage(error).trim() || "trace stream error";
  return WikiRunAttemptTranscriptErrorFrameSchema.parse({ message });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isLiveAttemptState(state: string): boolean {
  return state === "running" || state === "suspended";
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
 *
 * - Emits only entries after `?after=<sequence>` in ordered `trace` batches.
 * - While running/suspended: poll the bounded trace file for later entries.
 * - On terminal state: final trace batch + `done`, then close.
 *
 * Separate from Run control SSE and Session Pi SSE (ADR 0035). Dialog-scoped only.
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
    const queryAfter = readTranscriptCursor(url, "after") ?? 0;
    // EventSource sends the last frame id when reconnecting. Keep a caller's
    // explicit cursor as the lower bound, then advance from the acknowledged
    // trace batch rather than replaying it on every transport reconnect.
    afterSequence = Math.max(
      queryAfter,
      parseLastEventId(req.headers["last-event-id"] as string | undefined) ?? 0,
    );
  } catch (error) {
    sendWikiRunsError(res, error);
    return;
  }

  let closed = false;
  const lifecycle: { heartbeat?: ReturnType<typeof setInterval> } = {};
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (lifecycle.heartbeat) clearInterval(lifecycle.heartbeat);
    req.off("close", onRequestClose);
    res.off("close", cleanup);
  };
  const onRequestClose = (): void => {
    if (req.aborted || !req.complete) cleanup();
  };

  req.once("close", onRequestClose);
  res.once("close", cleanup);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  getLogger().debug(
    {
      event: "attempt.transcript.sse",
      workspaceId: workspace.id,
      runId,
      attemptId,
      phase: "open",
    },
    "attempt transcript SSE open",
  );

  const pollMs = dependencies.pollMs ?? TRANSCRIPT_SSE_POLL_MS;
  lifecycle.heartbeat = setInterval(
    () => writeHeartbeat(res),
    dependencies.heartbeatMs ?? TRANSCRIPT_SSE_HEARTBEAT_MS,
  );
  try {
    while (!closed) {
      let transcript;
      try {
        transcript = await runs.readAttemptTranscript({
          runId,
          attemptId,
          afterSequence,
          limit: 200,
        });
      } catch (error) {
        if (!closed) {
          // Named `transcript_error` so it does not collide with EventSource's
          // native connection `error` event on the client.
          writeSse(res, "transcript_error", transcriptErrorFrame(error));
        }
        break;
      }

      const live = isLiveAttemptState(transcript.state);
      if (transcript.events.length > 0) {
        afterSequence = transcript.cursor;
        writeSse(
          res,
          "trace",
          WikiRunAttemptTranscriptTraceFrameSchema.parse({
            attemptId: transcript.attemptId,
            nodeKey: transcript.nodeKey,
            state: transcript.state,
            events: transcript.events,
            cursor: transcript.cursor,
            live,
          }),
          transcript.cursor,
        );
      }

      if (!live) {
        writeSse(
          res,
          "done",
          WikiRunAttemptTranscriptDoneFrameSchema.parse({
            attemptId: transcript.attemptId,
            state: transcript.state,
            cursor: afterSequence,
          }),
        );
        break;
      }

      if (!transcript.hasMore) await delay(pollMs);
    }
  } catch (error) {
    if (!closed) writeSse(res, "transcript_error", transcriptErrorFrame(error));
  } finally {
    cleanup();
    getLogger().debug(
      {
        event: "attempt.transcript.sse",
        workspaceId: workspace.id,
        runId,
        attemptId,
        phase: "close",
      },
      "attempt transcript SSE closed",
    );
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

/** Durable Run SSE. */
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
  let initial: { snapshot: WikiRunSnapshot; events: WikiRunEvent[]; cursor: number };
  try {
    runs = await wikiRunsForWorkspace(workspace);
    initial = await runs.read({ runId, afterEventId: 0, limit: 1_000 });
  } catch (error) {
    sendWikiRunsError(res, error);
    return;
  }

  const rawLastEventId = req.headers["last-event-id"];
  const requestedCursor = parseLastEventId(
    Array.isArray(rawLastEventId) ? rawLastEventId.at(-1) : rawLastEventId,
  );
  let reset = requestedCursor === undefined || requestedCursor > initial.cursor;
  let cursor = reset ? initial.cursor : requestedCursor;
  let closed = false;
  // Assigned once after headers; held for cleanup only.
  let heartbeat: ReturnType<typeof setInterval> | undefined = undefined;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    req.off("close", onRequestClose);
    res.off("close", cleanup);
  };
  const onRequestClose = (): void => {
    if (req.aborted || !req.complete) cleanup();
  };

  req.once("close", onRequestClose);
  res.once("close", cleanup);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  getLogger().debug(
    { event: "run.sse", workspaceId: workspace.id, runId, phase: "open" },
    "run SSE open",
  );

  // A first connection, invalid cursor, or future cursor receives a complete reset snapshot.
  if (reset)
    writeSse(
      res,
      "snapshot",
      { snapshot: initial.snapshot, cursor: initial.cursor },
      initial.cursor,
    );
  heartbeat = setInterval(() => writeHeartbeat(res), dependencies.heartbeatMs ?? HEARTBEAT_MS);

  try {
    while (!closed) {
      if (!reset && cursor !== undefined) {
        const update = await runs.read({ runId, afterEventId: cursor, limit: 1_000 });
        for (const event of update.events) {
          writeSse(res, "run.event", event, event.eventId);
          cursor = event.eventId;
        }
      }
      // Snapshot cursor is already the durable cut; only events committed after it are live.
      if (reset) {
        cursor = initial.cursor;
        reset = false;
      }
      await delay(dependencies.pollMs ?? POLL_MS);
    }
  } catch (error) {
    if (!closed) writeSse(res, "snapshot", { error: redactErrorMessage(error) });
  } finally {
    cleanup();
    getLogger().debug(
      { event: "run.sse", workspaceId: workspace.id, runId, phase: "close" },
      "run SSE closed",
    );
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

/** Workspace-scoped compact index SSE for concurrently active Runs. */
export async function handleWikiRunIndexEvents(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
  dependencies: { heartbeatMs?: number; pollMs?: number } = {},
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  let runs: Awaited<ReturnType<typeof wikiRunsForWorkspace>>;
  let initial: Awaited<ReturnType<typeof runs.readIndex>>;
  try {
    runs = await wikiRunsForWorkspace(workspace);
    initial = await runs.readIndex();
  } catch (error) {
    sendWikiRunsError(res, error);
    return;
  }
  let cursor = initial.cursor;
  let closed = false;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const heartbeat = setInterval(
    () => writeHeartbeat(res),
    dependencies.heartbeatMs ?? HEARTBEAT_MS,
  );
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    req.off("close", onRequestClose);
    res.off("close", cleanup);
  };
  const onRequestClose = (): void => {
    if (req.aborted || !req.complete) cleanup();
  };
  req.once("close", onRequestClose);
  res.once("close", cleanup);
  writeSse(
    res,
    "index",
    WikiRunIndexEventSchema.parse({
      workspaceId: workspace.id,
      eventId: initial.cursor,
      occurredAt: new Date().toISOString(),
      runs: initial.runs,
    }),
    initial.cursor,
  );
  try {
    while (!closed) {
      const update = await runs.readIndex({ afterEventId: cursor });
      if (update.runs.length > 0) {
        cursor = update.cursor;
        writeSse(
          res,
          "index",
          WikiRunIndexEventSchema.parse({
            workspaceId: workspace.id,
            eventId: cursor,
            occurredAt: new Date().toISOString(),
            runs: update.runs,
          }),
          cursor,
        );
      }
      await delay(dependencies.pollMs ?? POLL_MS);
    }
  } catch (error) {
    if (!closed) writeSse(res, "index", { error: redactErrorMessage(error) });
  } finally {
    cleanup();
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}
