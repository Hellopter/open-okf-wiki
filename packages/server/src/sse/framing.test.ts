import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import {
  attachSseLifecycle,
  openSseResponse,
  parseLastEventId,
  SSE_RESPONSE_HEADERS,
  writeSse,
  writeSseData,
  writeSseHeartbeatComment,
} from "./framing.ts";

type MutableRes = ServerResponse & { writableEnded: boolean; destroyed: boolean };

function mockRes(): {
  res: MutableRes;
  chunks: string[];
  status?: number;
  headers?: Record<string, string>;
} {
  const chunks: string[] = [];
  const state: {
    res: MutableRes;
    chunks: string[];
    status?: number;
    headers?: Record<string, string>;
  } = { res: null as unknown as MutableRes, chunks };
  const res = new EventEmitter() as MutableRes;
  res.writableEnded = false;
  res.destroyed = false;
  res.writeHead = ((status: number, headers?: Record<string, string>) => {
    state.status = status;
    state.headers = headers;
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
  state.res = res;
  return state;
}

function mockReq(): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & {
    aborted: boolean;
    complete: boolean;
  };
  req.aborted = false;
  req.complete = false;
  return req;
}

test("parseLastEventId accepts safe decimal integers", () => {
  assert.equal(parseLastEventId("0"), 0);
  assert.equal(parseLastEventId("42"), 42);
  assert.equal(parseLastEventId(" 7 "), 7);
  assert.equal(parseLastEventId(["1", "99"]), 99);
});

test("parseLastEventId rejects empty, non-decimal, and unsafe values", () => {
  assert.equal(parseLastEventId(undefined), undefined);
  assert.equal(parseLastEventId(""), undefined);
  assert.equal(parseLastEventId("  "), undefined);
  assert.equal(parseLastEventId("1.5"), undefined);
  assert.equal(parseLastEventId("-1"), undefined);
  assert.equal(parseLastEventId("abc"), undefined);
  assert.equal(parseLastEventId("1e2"), undefined);
});

test("writeSse emits named event frames with optional id", () => {
  const { res, chunks } = mockRes();
  writeSse(res, "snapshot", { cursor: 3 }, 3);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], 'id: 3\nevent: snapshot\ndata: {"cursor":3}\n\n');

  writeSse(res, "run.event", { type: "x" });
  assert.equal(chunks[1], 'event: run.event\ndata: {"type":"x"}\n\n');
});

test("writeSseData emits data-only frames for Session SSE", () => {
  const { res, chunks } = mockRes();
  writeSseData(res, { kind: "heartbeat", sessionId: "s1" });
  assert.equal(chunks[0], 'data: {"kind":"heartbeat","sessionId":"s1"}\n\n');
});

test("writeSseHeartbeatComment writes an SSE comment line", () => {
  const { res, chunks } = mockRes();
  writeSseHeartbeatComment(res);
  assert.equal(chunks[0], ": heartbeat\n\n");
});

test("writeSse is a no-op after the response ends", () => {
  const { res, chunks } = mockRes();
  res.writableEnded = true;
  writeSse(res, "snapshot", {});
  writeSseData(res, {});
  writeSseHeartbeatComment(res);
  assert.equal(chunks.length, 0);
});

test("openSseResponse writes standard SSE headers", () => {
  const state = mockRes();
  openSseResponse(state.res);
  assert.equal(state.status, 200);
  assert.deepEqual(state.headers, { ...SSE_RESPONSE_HEADERS });
});

test("attachSseLifecycle heartbeats and cleans up on abort", async () => {
  const req = mockReq();
  const { res, chunks } = mockRes();
  const lifecycle = attachSseLifecycle(req, res, {
    heartbeatMs: 20,
    onHeartbeat: writeSseHeartbeatComment,
  });
  assert.equal(lifecycle.isClosed(), false);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.ok(chunks.some((c) => c === ": heartbeat\n\n"));
  req.aborted = true;
  req.emit("close");
  assert.equal(lifecycle.isClosed(), true);
  const after = chunks.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(chunks.length, after, "heartbeat stops after cleanup");
});

test("attachSseLifecycle ignores close when the request completed normally", () => {
  const req = mockReq();
  const { res } = mockRes();
  const lifecycle = attachSseLifecycle(req, res);
  req.complete = true;
  req.aborted = false;
  req.emit("close");
  assert.equal(lifecycle.isClosed(), false);
  lifecycle.cleanup();
  assert.equal(lifecycle.isClosed(), true);
  lifecycle.cleanup(); // idempotent
  assert.equal(lifecycle.isClosed(), true);
});
