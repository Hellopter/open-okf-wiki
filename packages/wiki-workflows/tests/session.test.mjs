import assert from "node:assert/strict";
import test from "node:test";
import { createWikiRunSession, isWikiRunSession, parseWikiRunSession, WIKI_RUN_POINTER_VERSION } from "../dist/session.js";

function snapshot(version = 8, overrides = {}) {
  return {
    version,
    id: "run-1",
    cwd: "/workspace",
    requestedMode: "generate",
    language: "zh",
    status: "succeeded",
    round: 0,
    sourceRestartCount: 0,
    maxResearchRounds: 6,
    nodes: [],
    events: [],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    revision: 3,
    ...overrides,
  };
}

function pointer(overrides = {}) {
  return {
    customType: "okf-wiki-run",
    workspace: "/workspace",
    pointerVersion: WIKI_RUN_POINTER_VERSION,
    runId: "run-1",
    revision: 3,
    status: "succeeded",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

test("createWikiRunSession builds a pointer-only session from a snapshot", () => {
  const session = createWikiRunSession(snapshot());
  assert.deepEqual(session, pointer());
  assert.equal("snapshot" in session, false);
  assert.equal(isWikiRunSession(session), true);
  assert.deepEqual(parseWikiRunSession(session), session);
});

test("createWikiRunSession defaults revision to 0 when snapshot has none", () => {
  const body = snapshot();
  delete body.revision;
  const session = createWikiRunSession(body);
  assert.equal(session.revision, 0);
});

test("parseWikiRunSession accepts only pointer-only sessions", () => {
  assert.deepEqual(parseWikiRunSession(pointer()), pointer());
  assert.equal(isWikiRunSession(pointer({ status: "running" })), true);
  assert.equal(isWikiRunSession(pointer({ status: "paused" })), true);
  assert.equal(isWikiRunSession(pointer({ status: "blocked" })), true);
  assert.equal(isWikiRunSession(pointer({ status: "failed" })), true);
  assert.equal(isWikiRunSession(pointer({ status: "cancelled" })), true);
});

test("parseWikiRunSession rejects legacy full-snapshot session entries (fail closed)", () => {
  const legacy = {
    customType: "okf-wiki-run",
    workspace: "/workspace",
    snapshot: snapshot(),
  };
  assert.equal(parseWikiRunSession(legacy), undefined);
  assert.equal(isWikiRunSession(legacy), false);

  // Pointer fields plus a snapshot body still fail closed.
  const hybrid = { ...pointer(), snapshot: snapshot() };
  assert.equal(parseWikiRunSession(hybrid), undefined);
});

test("parseWikiRunSession rejects malformed pointers", () => {
  for (const bad of [
    null,
    undefined,
    {},
    { customType: "other", workspace: "/workspace", pointerVersion: 1, runId: "r", revision: 0, status: "running", updatedAt: "t" },
    { ...pointer(), pointerVersion: 2 },
    { ...pointer(), pointerVersion: "1" },
    { ...pointer(), runId: "" },
    { ...pointer(), runId: 12 },
    { ...pointer(), revision: -1 },
    { ...pointer(), revision: 1.5 },
    { ...pointer(), status: "done" },
    { ...pointer(), updatedAt: "" },
    { ...pointer(), workspace: "" },
  ]) {
    assert.equal(parseWikiRunSession(bad), undefined, `expected reject for ${JSON.stringify(bad)}`);
  }
});

test("snapshot validation remains independent of session pointer parsing", async () => {
  const { explainWikiRunSnapshot, isWikiRunSnapshot, parseWikiRunSnapshot } = await import("../dist/snapshot-validation.js");
  assert.equal(isWikiRunSnapshot(snapshot()), true);

  const legacyV6 = snapshot(6);
  assert.equal(isWikiRunSnapshot(legacyV6), false);
  const versionReasons = explainWikiRunSnapshot(legacyV6);
  assert.ok(versionReasons.some((reason) => /version: expected 8, got 6/.test(reason)));
  assert.throws(
    () => parseWikiRunSnapshot(legacyV6),
    (error) => error?.code === "snapshot_incompatible" && /version: expected 8, got 6/.test(error.message),
  );

  const withBlockedDetails = {
    ...snapshot(),
    status: "blocked",
    blockedReason: "Validation produced the same unresolved error set twice",
    blockedDetails: {
      code: "same_validation_twice",
      issues: [{ code: "link", page: "core/architecture.md", message: "broken" }],
      defects: [{ kind: "depth", page: "core/architecture.md", detail: "shallow" }],
      page: "core/architecture.md",
      remainingBudget: { localRepairRounds: 0, maxLocalRepairRounds: 3 },
    },
  };
  assert.equal(isWikiRunSnapshot(withBlockedDetails), true);

  const badBlockedDetails = {
    ...snapshot(),
    blockedDetails: { issues: "not-an-array" },
  };
  assert.equal(isWikiRunSnapshot(badBlockedDetails), false);
});
