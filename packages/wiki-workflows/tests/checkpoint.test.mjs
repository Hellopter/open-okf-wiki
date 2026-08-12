import assert from "node:assert/strict";
import test from "node:test";
import { WikiCheckpointCoordinator } from "../dist/checkpoint.js";

function snapshot(overrides = {}) {
  return {
    version: 2,
    id: "run-1",
    cwd: "/workspace",
    requestedMode: "generate",
    language: "zh",
    status: "running",
    round: 0,
    sourceRestartCount: 0,
    maxResearchRounds: 6,
    policy: {},
    policyHash: "policy",
    nodes: [],
    events: [],
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

test("checkpoint owns pointer construction, cloning, and monotonic revisions", async () => {
  const sessions = [];
  const history = [];
  const persistence = new WikiCheckpointCoordinator({
    appendSession: (value) => sessions.push(value),
    saveHistory: async (value) => history.push(value),
  });
  const source = snapshot();

  await persistence.checkpoint(source, { durable: true });
  source.status = "failed";
  await persistence.checkpoint(snapshot({ revision: 7 }), { durable: true });

  assert.deepEqual(sessions.map((value) => value.revision), [1, 8]);
  assert.deepEqual(history.map((value) => value.revision), [1, 8]);
  assert.equal(history[0].status, "running", "queued writes own a clone of caller state");
  assert.equal(sessions[0].runId, "run-1");
  assert.equal("snapshot" in sessions[0], false, "Pi entries remain pointer-only");
  assert.equal(source.revision, undefined, "checkpoint does not mutate its input");
  assert.equal(persistence.currentRevision, 8);
  persistence.seedRevision(3);
  assert.equal(persistence.currentRevision, 8, "restoring an older pointer cannot reuse revisions");
});

test("checkpoint serializes pointer and history writes without interleaving", async () => {
  const events = [];
  let releaseFirst;
  const firstHistoryGate = new Promise((resolve) => { releaseFirst = resolve; });
  const persistence = new WikiCheckpointCoordinator({
    appendSession: async (value) => events.push(`session:${value.revision}`),
    saveHistory: async (value) => {
      events.push(`history:start:${value.revision}`);
      if (value.revision === 1) await firstHistoryGate;
      events.push(`history:end:${value.revision}`);
    },
  });

  const first = persistence.checkpoint(snapshot(), { durable: true });
  const second = persistence.checkpoint(snapshot(), { durable: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["history:start:1"]);
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(events, [
    "history:start:1",
    "history:end:1",
    "session:1",
    "history:start:2",
    "history:end:2",
    "session:2",
  ]);
});

test("restoreCheckpoint adopts the durable revision and persists recovered state next", async () => {
  const revisions = [];
  const persistence = new WikiCheckpointCoordinator({
    appendSession: (value) => revisions.push(["session", value.revision, value.status]),
    saveHistory: async (value) => revisions.push(["history", value.revision, value.status]),
  });

  await persistence.restoreCheckpoint(snapshot({ revision: 12, status: "paused" }));

  assert.deepEqual(revisions, [
    ["history", 13, "paused"],
    ["session", 13, "paused"],
  ]);
  assert.equal(persistence.currentRevision, 13);
});

test("durable failures reject, remain observable, and do not poison later writes", async () => {
  const events = [];
  let fail = true;
  const persistence = new WikiCheckpointCoordinator({
    appendSession: (value) => events.push(`session:${value.revision}`),
    saveHistory: async (value) => {
      events.push(`history:${value.revision}`);
      if (fail) throw new Error("disk unavailable");
    },
  });

  await assert.rejects(
    persistence.checkpoint(snapshot(), { durable: true }),
    /disk unavailable/,
  );
  assert.match(String(persistence.lastError()), /disk unavailable/);

  fail = false;
  await persistence.checkpoint(snapshot(), { durable: true });
  await persistence.flush();

  assert.deepEqual(events, ["history:1", "history:2", "session:2"]);
  assert.equal(persistence.lastError(), undefined);
});

test("history failure never publishes a Pi pointer to a missing revision", async () => {
  const sessions = [];
  const persistence = new WikiCheckpointCoordinator({
    appendSession: (value) => sessions.push(value),
    saveHistory: async () => { throw new Error("history failed"); },
  });

  await assert.rejects(persistence.checkpoint(snapshot(), { durable: true }), /history failed/);

  assert.deepEqual(sessions, []);
});

test("background failures are retained without rejecting the checkpoint chain", async () => {
  const failure = { code: "ENOSPC" };
  const persistence = new WikiCheckpointCoordinator({
    appendSession: () => {},
    saveHistory: async () => { throw failure; },
  });

  await persistence.checkpoint(snapshot());
  await persistence.flush();

  assert.equal(persistence.lastError(), failure);
});
