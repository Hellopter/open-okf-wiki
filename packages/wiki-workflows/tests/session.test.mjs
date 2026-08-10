import assert from "node:assert/strict";
import test from "node:test";
import { createWikiRunSession, isWikiRunSession, parseWikiRunSession } from "../dist/session.js";

function snapshot(version = 5) {
  return {
    version,
    id: "run-1",
    cwd: "/workspace",
    requestedMode: "generate",
    language: "zh",
    status: "succeeded",
    round: 0,
    sourceRestartCount: 0,
    nodes: [],
    events: [],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

test("run-session serialization accepts only the current dynamic-workflow snapshot version", () => {
  const current = createWikiRunSession(snapshot());
  assert.equal(isWikiRunSession(current), true);
  assert.deepEqual(parseWikiRunSession(current), current);

  const historical = { ...current, snapshot: snapshot(4) };
  assert.equal(parseWikiRunSession(historical), undefined);
  assert.equal(isWikiRunSession(historical), false);

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
});
