import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import type { WikiRunListItem } from "@okf-wiki/contract/wiki-runs";
import { streamRunIndex, type RunIndexSource } from "./run-index.ts";

type MutableRes = ServerResponse & { writableEnded: boolean; destroyed: boolean };
type MutableReq = IncomingMessage & {
  aborted: boolean;
  complete: boolean;
  headers: IncomingMessage["headers"];
};

function mockPair(): {
  req: MutableReq;
  res: MutableRes;
  chunks: string[];
  status?: number;
} {
  const chunks: string[] = [];
  const req = new EventEmitter() as MutableReq;
  req.aborted = false;
  req.complete = false;
  req.headers = {};

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

function listItem(runId: string): WikiRunListItem {
  return {
    runId,
    state: "running",
    updatedAt: "2026-08-01T00:00:00.000Z",
    revision: 1,
    attention: "none",
    completedNodes: 0,
    totalNodes: 1,
  };
}

test("streamRunIndex preflight failure does not open the SSE stream", async () => {
  const pair = mockPair();
  const runs: RunIndexSource = {
    async readIndex() {
      throw new Error("workspace gone");
    },
  };
  const result = await streamRunIndex(pair.req, pair.res, runs, "ws", { pollMs: 5 });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected failure");
  assert.equal(result.headersSent, false);
  assert.equal(pair.status, undefined);
});

test("streamRunIndex emits the initial index frame then polls", async () => {
  const pair = mockPair();
  let polls = 0;
  const runs: RunIndexSource = {
    async readIndex(input) {
      if (input?.afterEventId === undefined) {
        return { runs: [listItem("run-a")], cursor: 2 };
      }
      polls += 1;
      if (polls === 1) {
        return { runs: [listItem("run-b")], cursor: 3 };
      }
      return { runs: [], cursor: 3 };
    },
  };

  const streaming = streamRunIndex(pair.req, pair.res, runs, "ws", {
    pollMs: 5,
    heartbeatMs: 60_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  pair.req.aborted = true;
  pair.req.emit("close");
  const result = await streaming;

  assert.equal(result.ok, true);
  assert.equal(pair.status, 200);
  const joined = pair.chunks.join("");
  assert.ok(joined.includes("event: index"));
  assert.ok(joined.includes("run-a"));
  assert.ok(joined.includes("run-b") || polls >= 1);
});
