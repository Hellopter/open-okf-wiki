import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultGitRunner } from "./git-runner.js";

test("default runner terminates an aborted git child with AbortError", async () => {
  const runner = createDefaultGitRunner();
  const controller = new AbortController();
  const running = runner(process.cwd(), ["-c", "alias.wait=!sleep 2", "wait"], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running, (error: unknown) => (error as Error).name === "AbortError");
});
