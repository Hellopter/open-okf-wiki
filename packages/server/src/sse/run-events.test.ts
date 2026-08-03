import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import type { WikiRunEvent, WikiRunSnapshot } from "@okf-wiki/contract/wiki-runs";
import { streamRunEvents, type RunEventsSource } from "./run-events.ts";

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
  status?: number;
} {
  const chunks: string[] = [];
  const req = new EventEmitter() as MutableReq;
  req.aborted = false;
  req.complete = false;
  req.headers = lastEventId === undefined ? {} : { "last-event-id": lastEventId };

  const res = new EventEmitter() as MutableRes;
  res.writableEnded = false;
  res.destroyed = false;
  const state: { status?: number } = {};
  res.writeHead = ((status: number) => {
    state.status = status;
    return res;
  }) as ServerResponse["writeHead"];
  res.write = ((chunk: string | Buffer) => {
    chunks.push(String(chunk));
    return true;
  }) as ServerResponse["write"];
  res.end = (() => {
    res.writableEnded = true;
    return res;
  }) as ServerResponse["end"];

  return {
    req,
    res,
    chunks,
    get status() {
      return state.status;
    },
  };
}

function minimalSnapshot(runId: string): WikiRunSnapshot {
  return {
    schema: "okf.wiki-runs/v5",
    definitionVersion: 5,
    runId,
    workspaceId: "ws",
    revision: 1,
    state: "running",
    intent: { mode: "generate" },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    nodes: [],
    attempts: [],
    gates: [],
    effects: [],
    artifacts: [],
  } as unknown as WikiRunSnapshot;
}

function eventAt(runId: string, eventId: number): WikiRunEvent {
  const snapshot = minimalSnapshot(runId);
  return {
    runId,
    eventId,
    revision: eventId,
    type: "run.started",
    occurredAt: "2026-08-01T00:00:00.000Z",
    snapshot,
  } as unknown as WikiRunEvent;
}

test("streamRunEvents preflight failure does not open the SSE stream", async () => {
  const pair = mockPair();
  const runs: RunEventsSource = {
    async read() {
      throw new Error("run not found");
    },
  };
  const result = await streamRunEvents(pair.req, pair.res, runs, "run-1", { pollMs: 5 });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  assert.equal(result.headersSent, false);
  assert.equal(pair.status, undefined);
  assert.equal(pair.chunks.length, 0);
});

test("streamRunEvents emits reset snapshot when Last-Event-ID is absent", async () => {
  const pair = mockPair();
  const snapshot = minimalSnapshot("run-1");
  let reads = 0;
  const runs: RunEventsSource = {
    async read(input) {
      reads += 1;
      if (input.afterEventId === 0 || input.afterEventId === undefined) {
        return { snapshot, events: [eventAt("run-1", 1)], cursor: 1 };
      }
      return { snapshot, events: [], cursor: 1 };
    },
  };

  const streaming = streamRunEvents(pair.req, pair.res, runs, "run-1", {
    pollMs: 5,
    heartbeatMs: 60_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  pair.req.aborted = true;
  pair.req.emit("close");
  const result = await streaming;

  assert.equal(result.ok, true);
  assert.equal(pair.status, 200);
  assert.ok(pair.chunks[0]?.includes("event: snapshot"));
  assert.ok(pair.chunks[0]?.includes('"cursor":1'));
  assert.ok(reads >= 1);
});

test("streamRunEvents replays from Last-Event-ID without a reset snapshot", async () => {
  const pair = mockPair("0");
  const snapshot = minimalSnapshot("run-2");
  const runs: RunEventsSource = {
    async read(input) {
      if ((input.afterEventId ?? 0) === 0) {
        return { snapshot, events: [eventAt("run-2", 1)], cursor: 1 };
      }
      return { snapshot, events: [eventAt("run-2", 1)], cursor: 1 };
    },
  };

  const streaming = streamRunEvents(pair.req, pair.res, runs, "run-2", {
    pollMs: 5,
    heartbeatMs: 60_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  pair.req.aborted = true;
  pair.req.emit("close");
  await streaming;

  assert.equal(pair.status, 200);
  const joined = pair.chunks.join("");
  assert.equal(joined.includes("event: snapshot"), false);
  assert.ok(joined.includes("event: run.event"));
  assert.ok(joined.includes("id: 1"));
});
