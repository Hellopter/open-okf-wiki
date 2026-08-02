import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createRootLogger, setLoggerForTest } from "./logger.ts";

afterEach(() => {
  setLoggerForTest(null);
});

test("createRootLogger writes JSON lines to file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "okf-server-log-"));
  const filePath = path.join(dir, "server.jsonl");
  const log = createRootLogger({
    level: "info",
    pretty: false,
    filePath,
    logHttp: true,
    logHttpHealth: false,
  });
  log.info({ event: "server.listen", port: 8787 }, "listening");
  // Flush async destination
  await new Promise((r) => setTimeout(r, 50));
  if (typeof (log as { flush?: () => void }).flush === "function") {
    await new Promise<void>((resolve) => {
      (log as { flush: (cb: () => void) => void }).flush(() => resolve());
    });
  }
  await new Promise((r) => setTimeout(r, 100));
  const raw = await readFile(filePath, "utf8");
  assert.ok(raw.includes("server.listen"), raw);
  assert.ok(raw.includes("okf-wiki-server"), raw);
});

test("createRootLogger redacts apiKey fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "okf-server-redact-"));
  const filePath = path.join(dir, "server.jsonl");
  const log = createRootLogger({
    level: "info",
    pretty: false,
    filePath,
    logHttp: true,
    logHttpHealth: false,
  });
  log.info({ event: "provider.test", apiKey: "sk-secret-value" }, "test");
  await new Promise((r) => setTimeout(r, 150));
  const raw = await readFile(filePath, "utf8");
  assert.ok(!raw.includes("sk-secret-value"), raw);
  assert.ok(raw.includes("[REDACTED]") || raw.includes("provider.test"), raw);
});
