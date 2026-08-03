import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import type { WikiRunAttemptTranscript } from "@okf-wiki/contract/wiki-runs";
import {
  streamAttemptTranscript,
  type AttemptTranscriptSource,
} from "./attempt-transcript.ts";

type MutableRes = ServerResponse & { writableEnded: boolean; destroyed: boolean };
type MutableReq = IncomingMessage & {
  aborted: boolean;
  complete: boolean;
  headers: IncomingMessage["headers"];
};

function mockPair(lastEventId?: string): {
  req: MutableReq;
  res: MutableRes;
  chunks: string[];
} {
  const chunks: string[] = [];
  const req = new EventEmitter() as MutableReq;
  req.aborted = false;
  req.complete = false;
  req.headers = lastEventId === undefined ? {} : { "last-event-id": lastEventId };

  const res = new EventEmitter() as MutableRes;
  res.writableEnded = false;
  res.destroyed = false;
  res.writeHead = (() => res) as ServerResponse["writeHead"];
  res.write = ((chunk: string | Buffer) => {
    chunks.push(String(chunk));
    return true;
  }) as ServerResponse["write"];
  res.end = (() => {
    res.writableEnded = true;
    return res;
  }) as ServerResponse["end"];

  return { req, res, chunks };
}

function terminalTranscript(
  overrides: Partial<WikiRunAttemptTranscript> = {},
): WikiRunAttemptTranscript {
  return {
    attemptId: "att-1",
    nodeKey: "freeze",
    state: "succeeded",
    events: [
      {
        trace: 1,
        ordinal: 1,
        at: "2026-08-01T00:00:00.000Z",
        kind: "assistant",
        content: "hello",
      },
    ],
    hasEarlier: false,
    hasMore: false,
    cursor: 1,
    ...overrides,
  } as unknown as WikiRunAttemptTranscript;
}

test("streamAttemptTranscript emits trace then done for a terminal attempt", async () => {
  const pair = mockPair();
  const runs: AttemptTranscriptSource = {
    async readAttemptTranscript() {
      return terminalTranscript();
    },
  };

  await streamAttemptTranscript(
    pair.req,
    pair.res,
    runs,
    { runId: "run-1", attemptId: "att-1" },
    { pollMs: 5, heartbeatMs: 60_000 },
  );

  const joined = pair.chunks.join("");
  assert.ok(joined.includes("event: trace"));
  assert.ok(joined.includes("event: done"));
  assert.ok(joined.includes('"cursor":1'));
  assert.equal(pair.res.writableEnded, true);
});

test("streamAttemptTranscript honors Last-Event-ID and skips replayed batches", async () => {
  const pair = mockPair("1");
  let seenAfter: number | undefined;
  const runs: AttemptTranscriptSource = {
    async readAttemptTranscript(input) {
      seenAfter = input.afterSequence;
      return terminalTranscript({
        events: [],
        cursor: 1,
      });
    },
  };

  await streamAttemptTranscript(
    pair.req,
    pair.res,
    runs,
    { runId: "run-1", attemptId: "att-1" },
    { afterSequence: 0, pollMs: 5, heartbeatMs: 60_000 },
  );

  assert.equal(seenAfter, 1);
  const joined = pair.chunks.join("");
  assert.equal(joined.includes("event: trace"), false);
  assert.ok(joined.includes("event: done"));
});

test("streamAttemptTranscript emits transcript_error on read failure", async () => {
  const pair = mockPair();
  const runs: AttemptTranscriptSource = {
    async readAttemptTranscript() {
      throw new Error("trace missing");
    },
  };

  await streamAttemptTranscript(
    pair.req,
    pair.res,
    runs,
    { runId: "run-1", attemptId: "att-1" },
    { pollMs: 5, heartbeatMs: 60_000 },
  );

  const joined = pair.chunks.join("");
  assert.ok(joined.includes("event: transcript_error"));
  assert.ok(joined.includes("trace missing") || joined.includes("message"));
});
