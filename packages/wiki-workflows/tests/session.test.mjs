import assert from "node:assert/strict";
import test from "node:test";
import { createWikiRunSession, isWikiRunSession, parseWikiRunSession } from "../dist/session.js";

function snapshot(version = 7) {
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
  };
}

test("run-session serialization accepts only the current dynamic-workflow snapshot version", async () => {
  const { explainWikiRunSnapshot, isWikiRunSnapshot, parseWikiRunSnapshot } = await import("../dist/snapshot-validation.js");
  const current = createWikiRunSession(snapshot());
  assert.equal(isWikiRunSession(current), true);
  assert.deepEqual(parseWikiRunSession(current), current);
  assert.equal(isWikiRunSnapshot(snapshot()), true);

  const historical = { ...current, snapshot: snapshot(5) };
  assert.equal(parseWikiRunSession(historical), undefined);
  assert.equal(isWikiRunSession(historical), false);

  const legacyV6 = snapshot(6);
  assert.equal(isWikiRunSnapshot(legacyV6), false);
  const versionReasons = explainWikiRunSnapshot(legacyV6);
  assert.ok(versionReasons.some((reason) => /version: expected 7, got 6/.test(reason)));
  assert.throws(
    () => parseWikiRunSnapshot(legacyV6),
    (error) => error?.code === "snapshot_incompatible" && /version: expected 7, got 6/.test(error.message),
  );

  const missingRestartCount = snapshot();
  delete missingRestartCount.sourceRestartCount;
  assert.equal(parseWikiRunSession({ ...current, snapshot: missingRestartCount }), undefined);

  for (const malformed of [
    { ...snapshot(), nodes: [null] },
    { ...snapshot(), status: "done" },
    { ...snapshot(), round: -1 },
    { ...snapshot(), events: [null] },
  ]) {
    assert.equal(parseWikiRunSession({ ...current, snapshot: malformed }), undefined);
  }

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

  const badRemainingBudget = {
    ...snapshot(),
    blockedDetails: { remainingBudget: { used: "three" } },
  };
  assert.equal(isWikiRunSnapshot(badRemainingBudget), false);
});
