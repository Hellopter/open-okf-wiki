/**
 * Durable Run control SSE subscribe/poll helpers.
 *
 * Separate from Session Pi SSE and Attempt transcript SSE (ADR 0035 / 0039).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactErrorMessage } from "@okf-wiki/agent";
import type { WikiRunEvent, WikiRunSnapshot } from "@okf-wiki/contract/wiki-runs";
import { getLogger } from "../logging/index.ts";
import {
  attachSseLifecycle,
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_SSE_POLL_MS,
  delay,
  endSseResponse,
  openSseResponse,
  parseLastEventId,
  writeSse,
} from "./framing.ts";

/** Minimal WikiRuns surface needed to stream one Run's control events. */
export type RunEventsSource = {
  read(input: {
    runId: string;
    afterEventId?: number;
    limit?: number;
  }): Promise<{
    snapshot: WikiRunSnapshot;
    events: WikiRunEvent[];
    cursor: number;
  }>;
};

export type RunEventsSseOptions = {
  heartbeatMs?: number;
  pollMs?: number;
  /** Workspace id for open/close debug logs. */
  workspaceId?: string;
};

export type RunEventsSseResult =
  | { ok: true }
  | { ok: false; error: unknown; headersSent: false };

/**
 * Open durable Run SSE: preflight read (JSON error path if fails), then
 * snapshot/reset + poll loop until the client closes.
 *
 * When preflight fails, headers are not written and the route sends a JSON error.
 */
export async function streamRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  runs: RunEventsSource,
  runId: string,
  options: RunEventsSseOptions = {},
): Promise<RunEventsSseResult> {
  let initial: {
    snapshot: WikiRunSnapshot;
    events: WikiRunEvent[];
    cursor: number;
  };
  try {
    initial = await runs.read({ runId, afterEventId: 0, limit: 1_000 });
  } catch (error) {
    return { ok: false, error, headersSent: false };
  }

  const requestedCursor = parseLastEventId(req.headers["last-event-id"]);
  let reset = requestedCursor === undefined || requestedCursor > initial.cursor;
  let cursor = reset ? initial.cursor : requestedCursor;

  openSseResponse(res);
  getLogger().debug(
    { event: "run.sse", workspaceId: options.workspaceId, runId, phase: "open" },
    "run SSE open",
  );
  const lifecycle = attachSseLifecycle(req, res, {
    heartbeatMs: options.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS,
  });

  // A first connection, invalid cursor, or future cursor receives a complete reset snapshot.
  if (reset) {
    writeSse(
      res,
      "snapshot",
      { snapshot: initial.snapshot, cursor: initial.cursor },
      initial.cursor,
    );
  }

  try {
    while (!lifecycle.isClosed()) {
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
      await delay(options.pollMs ?? DEFAULT_SSE_POLL_MS);
    }
  } catch (error) {
    if (!lifecycle.isClosed()) {
      writeSse(res, "snapshot", { error: redactErrorMessage(error) });
    }
  } finally {
    lifecycle.cleanup();
    getLogger().debug(
      { event: "run.sse", workspaceId: options.workspaceId, runId, phase: "close" },
      "run SSE closed",
    );
    endSseResponse(res);
  }

  return { ok: true };
}
