import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { ProviderStoreError, WorkspaceIntakeError } from "@okf-wiki/core";
import { sendCaughtError } from "./http-util.ts";

type Captured = { status: number; body: { error: string; details?: unknown } };

function mockRes(): { res: ServerResponse; get: () => Captured | null } {
  let captured: Captured | null = null;
  const res = new EventEmitter() as ServerResponse;
  res.writeHead = ((status: number) => {
    captured = { status, body: { error: "" } };
    return res;
  }) as ServerResponse["writeHead"];
  res.end = ((payload?: string | Buffer) => {
    if (captured && payload !== undefined) {
      captured.body = JSON.parse(String(payload)) as Captured["body"];
    }
    return res;
  }) as ServerResponse["end"];
  return { res, get: () => captured };
}

test("sendCaughtError redacts sk- keys from unknown errors", () => {
  const { res, get } = mockRes();
  sendCaughtError(res, 500, new Error("upstream failed sk-proj-abc123SECRETKEY"));
  const captured = get();
  assert.equal(captured?.status, 500);
  assert.ok(captured?.body.error.includes("[redacted-key]"));
  assert.equal(captured?.body.error.includes("sk-proj-abc123SECRETKEY"), false);
});

test("sendCaughtError redacts bearer tokens and paths", () => {
  const { res, get } = mockRes();
  sendCaughtError(
    res,
    400,
    new Error("auth failed Bearer tok_live_xyz and path /home/user/.okf-wiki/secrets"),
  );
  const captured = get();
  assert.equal(captured?.status, 400);
  assert.match(captured!.body.error, /Bearer \[redacted\]/);
  assert.match(captured!.body.error, /\[redacted-path\]/);
  assert.equal(captured?.body.error.includes("tok_live_xyz"), false);
  assert.equal(captured?.body.error.includes("/home/user"), false);
});

test("sendCaughtError keeps WorkspaceIntakeError message as-is", () => {
  const { res, get } = mockRes();
  sendCaughtError(
    res,
    400,
    new WorkspaceIntakeError("invalid_name", "name must be a non-empty string"),
  );
  const captured = get();
  assert.equal(captured?.status, 400);
  assert.equal(captured?.body.error, "name must be a non-empty string");
});

test("sendCaughtError keeps ProviderStoreError message as-is", () => {
  const { res, get } = mockRes();
  sendCaughtError(
    res,
    404,
    new ProviderStoreError("provider_not_found", "provider not found: openai"),
  );
  const captured = get();
  assert.equal(captured?.status, 404);
  assert.equal(captured?.body.error, "provider not found: openai");
});

test("sendCaughtError redacts non-Error values", () => {
  const { res, get } = mockRes();
  sendCaughtError(res, 500, { message: "leak sk-test-abcdefghijklmnop" });
  const captured = get();
  assert.ok(captured?.body.error.includes("[redacted-key]"));
  assert.equal(captured?.body.error.includes("sk-test-abcdefghijklmnop"), false);
});
