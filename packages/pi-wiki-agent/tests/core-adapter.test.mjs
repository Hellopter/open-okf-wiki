import assert from "node:assert/strict";
import test from "node:test";
import { createCoreAdapter } from "../dist/core-adapter.js";

const names = [
  "initWorkspace",
  "ensureRuntime",
  "loadWorkspace",
  "getWorkspaceStatus",
  "addClonedSource",
  "addLinkedSource",
  "removeSource",
  "listSources",
  "prepareRun",
  "mergeSurveyReceipts",
  "publishCheckpoint",
  "openPlanGate",
  "checkPlanGate",
  "validateCandidate",
  "getRunPaths",
];

function complete(module = {}) {
  return Object.fromEntries(names.map((name) => [name, module[name] ?? (async () => ({ ok: true }))]));
}

test("rejects an incomplete core surface at extension load", () => {
  assert.throws(() => createCoreAdapter({}), /missing Pi core exports/);
});

test("accepts the complete semantic core surface", () => {
  const core = createCoreAdapter(complete());
  assert.equal(typeof core.prepareRun, "function");
});

test("wraps sync host methods so await and .then work", async () => {
  const core = createCoreAdapter(
    complete({
      loadWorkspace: (root) => ({ root, initialized: true, sources: [] }),
      getWorkspaceStatus: (root) => ({ root, initialized: true, sources: [], activeRunId: "r1" }),
    }),
  );

  const loaded = await core.loadWorkspace("/ws");
  assert.deepEqual(loaded, { root: "/ws", initialized: true, sources: [] });

  const viaThen = await core.getWorkspaceStatus("/ws").then((status) => status.activeRunId);
  assert.equal(viaThen, "r1");
});

test("sync throws become rejected promises", async () => {
  const core = createCoreAdapter(
    complete({
      loadWorkspace: () => {
        throw new Error("disk offline");
      },
    }),
  );

  await assert.rejects(() => core.loadWorkspace("/ws"), /disk offline/);
  // Also .then rejection path
  let rejected;
  await core.loadWorkspace("/ws").then(
    () => {
      rejected = false;
    },
    (error) => {
      rejected = error.message;
    },
  );
  assert.equal(rejected, "disk offline");
});

test("missing individual required methods are reported", () => {
  const partial = complete();
  delete partial.getRunPaths;
  assert.throws(() => createCoreAdapter(partial), /getRunPaths/);
});
