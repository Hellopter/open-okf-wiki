import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultGitRunner, type GitRunner, type GitRunResult } from "./git-runner.js";

test("createDefaultGitRunner returns a function", () => {
  const runner = createDefaultGitRunner();
  assert.equal(typeof runner, "function");
});

test("GitRunner type accepts fake implementations", async () => {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const fake: GitRunner = async (cwd, args, opts) => {
    calls.push({ cwd, args });
    assert.equal(opts?.timeoutMs, 1000);
    const result: GitRunResult = { code: 0, stdout: "ok", stderr: "" };
    return result;
  };
  const out = await fake("/tmp", ["status"], { timeoutMs: 1000 });
  assert.deepEqual(out, { code: 0, stdout: "ok", stderr: "" });
  assert.deepEqual(calls, [{ cwd: "/tmp", args: ["status"] }]);
});
