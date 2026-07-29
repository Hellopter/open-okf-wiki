/** HTTP adapter for the durable WikiRuns control plane (ADR 0035). */
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactErrorMessage } from "@okf-wiki/agent";
import { RunCommandSchema, type WikiRunEvent, type WikiRunSnapshot } from "@okf-wiki/contract";
import { CommandIdCollision, WorkflowInUseError } from "@okf-wiki/workflow";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import { loadWorkspaceOr404 } from "../load-workspace-or-404.ts";
import { wikiRunsForWorkspace } from "../wiki-runs-registry.ts";

const HEARTBEAT_MS = 15_000;
const POLL_MS = 500;
/** Attempt transcript SSE: poll session.jsonl while the dialog is open. */
const TRANSCRIPT_SSE_POLL_MS = 400;
const TRANSCRIPT_SSE_HEARTBEAT_MS = 15_000;

function actorContext(workspaceId: string) {
  return { workspaceId, actor: { id: "local-operator", kind: "local_operator" as const } };
}

function statusFor(error: unknown): number {
  if (error instanceof CommandIdCollision || error instanceof WorkflowInUseError) return 409;
  if (error instanceof Error && error.message.startsWith("run not found:")) return 404;
  if (error instanceof Error && error.message.startsWith("attempt not found:")) return 404;
  // Missing transcript *file* is no longer an error (empty messages). Keep this
  // mapping only for any residual throw sites.
  if (error instanceof Error && error.message === "transcript not found") return 404;
  if (error instanceof Error && error.message.startsWith("transcript exceeds size limit"))
    return 413;
  if (error instanceof Error && error.message.startsWith("transcript path escaped")) return 400;
  if (error instanceof Error && error.message.startsWith("transcript is not valid")) return 400;
  return 500;
}

function parseLastEventId(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function writeSse(
  res: ServerResponse,
  event: string,
  payload: unknown,
  eventId?: number,
): void {
  if (res.writableEnded || res.destroyed) return;
  const id = eventId === undefined ? "" : `id: ${eventId}\n`;
  res.write(`${id}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function writeHeartbeat(res: ServerResponse): void {
  if (!res.writableEnded && !res.destroyed) res.write(": heartbeat\n\n");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isLiveAttemptState(state: string): boolean {
  return state === "running" || state === "suspended";
}

/** POST typed command. Actor and workspace are derived from the trusted route. */
export async function handleWikiRunCommand(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  const parsed = RunCommandSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    sendError(res, 400, "invalid WikiRuns command", parsed.error.flatten());
    return;
  }
  try {
    const receipt = await (await wikiRunsForWorkspace(workspace)).dispatch(
      parsed.data,
      actorContext(workspace.id),
    );
    sendJson(res, 202, { receipt });
  } catch (error) {
    sendError(res, statusFor(error), redactErrorMessage(error));
  }
}

/** GET one secret-free durable snapshot and its current SSE cursor. */
export async function handleGetWikiRun(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  try {
    const { snapshot, cursor } = await (await wikiRunsForWorkspace(workspace)).read({ runId });
    sendJson(res, 200, { snapshot, cursor });
  } catch (error) {
    sendError(res, statusFor(error), redactErrorMessage(error));
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
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  try {
    const transcript = await (
      await wikiRunsForWorkspace(workspace)
    ).readAttemptTranscript({ runId, attemptId });
    sendJson(res, 200, transcript);
  } catch (error) {
    sendError(res, statusFor(error), redactErrorMessage(error));
  }
}

/**
 * Attempt transcript SSE for Node details while an Attempt is live.
 *
 * - First frame: `transcript` (full secret-free messages snapshot)
 * - While running/suspended: re-read session.jsonl and emit `transcript` on change
 * - On terminal state: final `transcript` + `done`, then close
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
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  let runs;
  try {
    runs = await wikiRunsForWorkspace(workspace);
  } catch (error) {
    sendError(res, statusFor(error), redactErrorMessage(error));
    return;
  }

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
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

  const pollMs = dependencies.pollMs ?? TRANSCRIPT_SSE_POLL_MS;
  heartbeat = setInterval(
    () => writeHeartbeat(res),
    dependencies.heartbeatMs ?? TRANSCRIPT_SSE_HEARTBEAT_MS,
  );

  let lastFingerprint = "";
  let seq = 0;
  try {
    while (!closed) {
      let transcript;
      try {
        transcript = await runs.readAttemptTranscript({ runId, attemptId });
      } catch (error) {
        if (!closed) {
          // Named `transcript_error` so it does not collide with EventSource's
          // native connection `error` event on the client.
          writeSse(res, "transcript_error", { message: redactErrorMessage(error) });
        }
        break;
      }

      const live = isLiveAttemptState(transcript.state);
      const fingerprint = `${transcript.state}:${transcript.messages.length}:${JSON.stringify(transcript.messages)}`;
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        seq += 1;
        writeSse(
          res,
          "transcript",
          {
            attemptId: transcript.attemptId,
            nodeKey: transcript.nodeKey,
            state: transcript.state,
            messages: transcript.messages,
            live,
          },
          seq,
        );
      }

      if (!live) {
        seq += 1;
        writeSse(
          res,
          "done",
          {
            attemptId: transcript.attemptId,
            state: transcript.state,
          },
          seq,
        );
        break;
      }

      await delay(pollMs);
    }
  } catch (error) {
    if (!closed) writeSse(res, "transcript_error", { message: redactErrorMessage(error) });
  } finally {
    cleanup();
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

/** Durable Run SSE. Pi conversation SSE remains on the Agent Session route. */
export async function handleWikiRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
  dependencies: { heartbeatMs?: number; pollMs?: number } = {},
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  let runs;
  let initial: { snapshot: WikiRunSnapshot; events: WikiRunEvent[]; cursor: number };
  try {
    runs = await wikiRunsForWorkspace(workspace);
    initial = await runs.read({ runId, afterEventId: 0, limit: 1_000 });
  } catch (error) {
    sendError(res, statusFor(error), redactErrorMessage(error));
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
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}
