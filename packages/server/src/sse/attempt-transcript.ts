/**
 * Attempt transcript SSE subscribe/poll helpers (Node details while live).
 *
 * - Emits only entries after `afterSequence` in ordered `trace` batches.
 * - While running/suspended: poll the bounded trace file for later entries.
 * - On terminal state: final trace batch + `done`, then close.
 *
 * Separate from Run control SSE and Session Pi SSE (ADR 0035). Dialog-scoped only.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactErrorMessage } from "@okf-wiki/agent";
import {
  WikiRunAttemptTranscriptDoneFrameSchema,
  WikiRunAttemptTranscriptErrorFrameSchema,
  WikiRunAttemptTranscriptTraceFrameSchema,
  type WikiRunAttemptTranscript,
} from "@okf-wiki/contract/wiki-runs";
import { getLogger } from "../logging/index.ts";
import {
  attachSseLifecycle,
  DEFAULT_SSE_HEARTBEAT_MS,
  delay,
  endSseResponse,
  openSseResponse,
  parseLastEventId,
  writeSse,
} from "./framing.ts";

/** Attempt transcript SSE: poll session.jsonl while the dialog is open. */
export const TRANSCRIPT_SSE_POLL_MS = 400;
export const TRANSCRIPT_SSE_HEARTBEAT_MS = DEFAULT_SSE_HEARTBEAT_MS;

/** Minimal WikiRuns surface needed to stream one Attempt transcript. */
export type AttemptTranscriptSource = {
  readAttemptTranscript(input: {
    runId: string;
    attemptId: string;
    beforeSequence?: number;
    afterSequence?: number;
    limit?: number;
  }): Promise<WikiRunAttemptTranscript>;
};

export type AttemptTranscriptSseOptions = {
  heartbeatMs?: number;
  pollMs?: number;
  /**
   * Exclusive sequence cursor from `?after=` (already validated by the route).
   * Combined with Last-Event-ID as a lower bound on reconnect.
   */
  afterSequence?: number;
  /** Workspace id for open/close debug logs. */
  workspaceId?: string;
};

function isLiveAttemptState(state: string): boolean {
  return state === "running" || state === "suspended";
}

function transcriptErrorFrame(error: unknown): { message: string } {
  const message = redactErrorMessage(error).trim() || "trace stream error";
  return WikiRunAttemptTranscriptErrorFrameSchema.parse({ message });
}

/**
 * Open attempt transcript SSE after the route has authenticated and resolved
 * `runs`. Preflight is not required — first poll may surface transcript_error.
 */
export async function streamAttemptTranscript(
  req: IncomingMessage,
  res: ServerResponse,
  runs: AttemptTranscriptSource,
  input: { runId: string; attemptId: string },
  options: AttemptTranscriptSseOptions = {},
): Promise<void> {
  const queryAfter = options.afterSequence ?? 0;
  // EventSource sends the last frame id when reconnecting. Keep a caller's
  // explicit cursor as the lower bound, then advance from the acknowledged
  // trace batch rather than replaying it on every transport reconnect.
  let afterSequence = Math.max(
    queryAfter,
    parseLastEventId(req.headers["last-event-id"]) ?? 0,
  );

  openSseResponse(res);
  getLogger().debug(
    {
      event: "attempt.transcript.sse",
      workspaceId: options.workspaceId,
      runId: input.runId,
      attemptId: input.attemptId,
      phase: "open",
    },
    "attempt transcript SSE open",
  );
  const lifecycle = attachSseLifecycle(req, res, {
    heartbeatMs: options.heartbeatMs ?? TRANSCRIPT_SSE_HEARTBEAT_MS,
  });
  const pollMs = options.pollMs ?? TRANSCRIPT_SSE_POLL_MS;

  try {
    while (!lifecycle.isClosed()) {
      let transcript: WikiRunAttemptTranscript;
      try {
        transcript = await runs.readAttemptTranscript({
          runId: input.runId,
          attemptId: input.attemptId,
          afterSequence,
          limit: 200,
        });
      } catch (error) {
        if (!lifecycle.isClosed()) {
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
    if (!lifecycle.isClosed()) {
      writeSse(res, "transcript_error", transcriptErrorFrame(error));
    }
  } finally {
    lifecycle.cleanup();
    getLogger().debug(
      {
        event: "attempt.transcript.sse",
        workspaceId: options.workspaceId,
        runId: input.runId,
        attemptId: input.attemptId,
        phase: "close",
      },
      "attempt transcript SSE closed",
    );
    endSseResponse(res);
  }
}
