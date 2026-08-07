import assert from "node:assert/strict";
import test from "node:test";
import { createCoreAdapter } from "../dist/core-adapter.js";

const names = [
  "initWorkspace", "ensureRuntime", "loadWorkspace", "getWorkspaceStatus", "addClonedSource", "addLinkedSource",
  "removeSource", "listSources", "prepareRun", "completeRunPlanning", "approveRun", "resumeRun", "setRunStatus",
  "validateRunBundle", "getRunPaths", "getRunState", "claimRun", "releaseRun",
];

function complete(module = {}) {
  return Object.fromEntries(names.map((name) => [name, module[name] ?? (() => ({ ok: true }))]));
}

test("requires exactly the v4 Markdown-run core API", () => {
  assert.throws(() => createCoreAdapter({}), /prepareRun/);
  const partial = complete();
  delete partial.validateRunBundle;
  assert.throws(() => createCoreAdapter(partial), /validateRunBundle/);
  const core = createCoreAdapter(complete());
  assert.equal(typeof core.completeRunPlanning, "function");
  assert.equal(typeof core.approveRun, "function");
});

test("normalizes synchronous host exports to awaitable methods", async () => {
  const core = createCoreAdapter(complete({
    getRunState: () => ({ runId: "r1", status: "proposed", approval: "propose" }),
    loadWorkspace: (root) => ({ root, initialized: true, sources: [] }),
  }));
  assert.deepEqual(await core.loadWorkspace("/ws"), { root: "/ws", initialized: true, sources: [] });
  assert.equal((await core.getRunState("/ws", { runId: "r1" })).status, "proposed");
});

test("turns synchronous host errors into rejected promises", async () => {
  const core = createCoreAdapter(complete({ getRunState: () => { throw new Error("disk offline"); } }));
  await assert.rejects(() => core.getRunState("/ws", { runId: "r1" }), /disk offline/);
});
