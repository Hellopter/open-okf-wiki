/**
 * Workspace-scoped compact Run index SSE subscribe/poll helpers.
 *
 * Separate from per-Run control SSE and Session Pi SSE.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactErrorMessage } from "@okf-wiki/agent";
import { WikiRunIndexEventSchema, type WikiRunListItem } from "@okf-wiki/contract/wiki-runs";
import {
  attachSseLifecycle,
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_SSE_POLL_MS,
  delay,
  endSseResponse,
  openSseResponse,
  writeSse,
} from "./framing.ts";

/** Minimal WikiRuns surface needed to stream the workspace Run index. */
export type RunIndexSource = {
  readIndex(input?: { afterEventId?: number; limit?: number }): Promise<{
    runs: WikiRunListItem[];
    cursor: number;
  }>;
};

export type RunIndexSseOptions = {
  heartbeatMs?: number;
  pollMs?: number;
};

export type RunIndexSseResult =
  | { ok: true }
  | { ok: false; error: unknown; headersSent: false };

/**
 * Open workspace index SSE: preflight readIndex, emit initial frame, then poll
 * for cursor advances until the client closes.
 */
export async function streamRunIndex(
  req: IncomingMessage,
  res: ServerResponse,
  runs: RunIndexSource,
  workspaceId: string,
  options: RunIndexSseOptions = {},
): Promise<RunIndexSseResult> {
  let initial: { runs: WikiRunListItem[]; cursor: number };
  try {
    initial = await runs.readIndex();
  } catch (error) {
    return { ok: false, error, headersSent: false };
  }

  let cursor = initial.cursor;
  openSseResponse(res);
  const lifecycle = attachSseLifecycle(req, res, {
    heartbeatMs: options.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS,
  });

  writeSse(
    res,
    "index",
    WikiRunIndexEventSchema.parse({
      workspaceId,
      eventId: initial.cursor,
      occurredAt: new Date().toISOString(),
      runs: initial.runs,
    }),
    initial.cursor,
  );

  try {
    while (!lifecycle.isClosed()) {
      const update = await runs.readIndex({ afterEventId: cursor });
      if (update.runs.length > 0) {
        cursor = update.cursor;
        writeSse(
          res,
          "index",
          WikiRunIndexEventSchema.parse({
            workspaceId,
            eventId: cursor,
            occurredAt: new Date().toISOString(),
            runs: update.runs,
          }),
          cursor,
        );
      }
      await delay(options.pollMs ?? DEFAULT_SSE_POLL_MS);
    }
  } catch (error) {
    if (!lifecycle.isClosed()) {
      writeSse(res, "index", { error: redactErrorMessage(error) });
    }
  } finally {
    lifecycle.cleanup();
    endSseResponse(res);
  }

  return { ok: true };
}
