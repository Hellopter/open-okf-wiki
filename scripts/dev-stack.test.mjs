/**
 * Unit tests for dev-stack wait helper (no full stack boot).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { waitForUrl } from "./dev-stack.mjs";

describe("dev-stack waitForUrl", () => {
  it("resolves when the URL becomes healthy", async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      if (hits < 2) {
        res.writeHead(503);
        res.end("not yet");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      await waitForUrl(`http://127.0.0.1:${port}/api/health`, 5_000);
      assert.ok(hits >= 2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("times out when the URL never becomes healthy", async () => {
    await assert.rejects(
      () => waitForUrl("http://127.0.0.1:1/api/health", 400),
      /Timed out waiting/,
    );
  });
});
