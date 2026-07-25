/**
 * Unit tests for dev-stack wait helper + port free logic (no full stack boot).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { ensurePortFree, isPortOpen, waitForUrl } from "./dev-stack.mjs";

describe("dev-stack waitForUrl", () => {
  it("resolves when the URL becomes healthy", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
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

describe("dev-stack ensurePortFree", () => {
  it("no-ops when the port is free", async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    await ensurePortFree(port, "test", { kill: false });
    assert.equal(await isPortOpen(port), false);
  });

  it("refuses a busy port when kill is disabled", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      assert.equal(await isPortOpen(port), true);
      await assert.rejects(() => ensurePortFree(port, "test", { kill: false }), /already in use/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("frees a busy port when kill is enabled (separate process)", async () => {
    // Hold the port in a child process so killTree does not kill this test runner.
    const holder = spawn(
      process.execPath,
      [
        "-e",
        "require('node:http').createServer((q,s)=>{s.end('ok')}).listen(0,'127.0.0.1',function(){process.stdout.write(String(this.address().port))})",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const port = await new Promise((resolve, reject) => {
      let buf = "";
      holder.stdout.on("data", (chunk) => {
        buf += chunk;
        const n = Number(buf.trim());
        if (Number.isInteger(n) && n > 0) resolve(n);
      });
      holder.on("error", reject);
      holder.on("exit", (code) => {
        if (code !== null && code !== 0) reject(new Error(`holder exited ${code}`));
      });
      setTimeout(() => reject(new Error("holder port timeout")), 5_000);
    });

    try {
      assert.equal(await isPortOpen(port), true);
      await ensurePortFree(port, "test", { kill: true });
      assert.equal(await isPortOpen(port), false);
    } finally {
      try {
        holder.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});
