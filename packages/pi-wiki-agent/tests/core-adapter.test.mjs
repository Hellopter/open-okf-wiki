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

test("rejects an incomplete core surface at extension load", () => {
  assert.throws(() => createCoreAdapter({}), /missing Pi core exports/);
});

test("accepts the complete semantic core surface", () => {
  const core = Object.fromEntries(names.map((name) => [name, async () => ({ ok: true })]));
  assert.equal(typeof createCoreAdapter(core).prepareRun, "function");
});
