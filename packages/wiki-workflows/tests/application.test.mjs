import assert from "node:assert/strict";
import test from "node:test";
import { WikiWorkflowApplication } from "../dist/application.js";

function run(status = "running") {
  return { id: "run-1", cwd: "/workspace", status };
}

function fixture({ current = run(), persistError, bindError, resumeError, loadedRun, waitForIdle } = {}) {
  let snapshot = current;
  let owned = false;
  let ownerRunId;
  const calls = [];
  const engine = {
    getSnapshot: () => snapshot && structuredClone(snapshot),
    subscribe: () => () => {},
    pause() { calls.push("pause"); snapshot = { ...snapshot, status: "paused" }; },
    async resume() { calls.push("resume"); snapshot = { ...snapshot, status: "running" }; return snapshot; },
    async stop() { snapshot = { ...snapshot, status: "paused" }; },
    async cancel() { snapshot = { ...snapshot, status: "cancelled" }; },
    async waitForIdle() { calls.push("idle"); await waitForIdle?.(); return snapshot; },
  };
  const dependencies = {
    workspace: "/workspace",
    engine,
    async acquire(runId) {
      calls.push("acquire");
      const acquired = !owned;
      owned = true;
      ownerRunId = runId;
      return {
        acquired,
        async update(nextRunId) { calls.push("update"); ownerRunId = nextRunId; },
        async release() { calls.push("release"); owned = false; ownerRunId = undefined; },
      };
    },
    async persist() { calls.push("persist"); if (persistError) throw persistError; },
    async flush() {},
    async loadRun() { return loadedRun ?? snapshot; },
    async listRecoverable() { return []; },
    async bindLatestRecoverable() {
      calls.push("bind");
      if (bindError) throw bindError;
      snapshot = run("paused");
      return snapshot;
    },
    async bindRecoverable() { return snapshot; },
    async resume() {
      calls.push("resume-adapter");
      if (resumeError) throw resumeError;
      snapshot = { ...snapshot, status: "running" };
      return snapshot;
    },
    async deleteRun() {},
  };
  return { application: new WikiWorkflowApplication(dependencies), calls, isOwned: () => owned, ownerRunId: () => ownerRunId };
}

test("pause persistence failure releases ownership acquired by the action", async () => {
  const subject = fixture({ persistError: new Error("disk unavailable") });
  await assert.rejects(subject.application.dispatch({ type: "pause" }), /disk unavailable/);
  assert.equal(subject.isOwned(), false);
  assert.deepEqual(subject.calls, ["acquire", "update", "pause", "persist", "release"]);
});

test("resume restore failure releases ownership acquired by the action", async () => {
  const subject = fixture({ current: null, bindError: new Error("history unavailable") });
  await assert.rejects(subject.application.dispatch({ type: "resume" }), /history unavailable/);
  assert.equal(subject.isOwned(), false);
  assert.deepEqual(subject.calls, ["acquire", "bind", "release"]);
});

test("successful resume keeps ownership while the run is running", async () => {
  const subject = fixture({ current: run("paused") });
  await subject.application.dispatch({ type: "resume", runId: "run-1" });
  assert.equal(subject.isOwned(), true);
  assert.ok(!subject.calls.includes("release"));
});

test("deleting terminal history releases the acquired target lock even when another terminal run is observed", async () => {
  const subject = fixture({ current: run("succeeded"), loadedRun: { ...run("succeeded"), id: "run-2" } });
  await subject.application.dispatch({ type: "delete", runId: "run-2" });
  assert.equal(subject.isOwned(), false);
  assert.deepEqual(subject.calls, ["acquire", "release"]);
});

test("a stale pause settle cannot release ownership after resume", async () => {
  let releaseIdle;
  let idleStarted;
  const idleGate = new Promise((resolve) => { releaseIdle = resolve; });
  const idleSignal = new Promise((resolve) => { idleStarted = resolve; });
  const subject = fixture({ waitForIdle: async () => { idleStarted(); await idleGate; } });

  await subject.application.dispatch({ type: "pause" });
  await idleSignal;
  await subject.application.dispatch({ type: "resume", runId: "run-1" });
  releaseIdle();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subject.isOwned(), true);
  assert.equal(subject.calls.filter((call) => call === "release").length, 0);
});

test("shutdown drains a tracked pause settle before releasing ownership", async () => {
  let releaseIdle;
  let idleStarted;
  const idleGate = new Promise((resolve) => { releaseIdle = resolve; });
  const idleSignal = new Promise((resolve) => { idleStarted = resolve; });
  const subject = fixture({ waitForIdle: async () => { idleStarted(); await idleGate; } });
  await subject.application.dispatch({ type: "pause" });
  await idleSignal;

  let shutDown = false;
  const shutdown = subject.application.shutdown().then(() => { shutDown = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutDown, false);
  releaseIdle();
  await shutdown;
  assert.equal(subject.isOwned(), false);
});

test("dispatch rejects actions not allowed by authoritative run policy", async () => {
  const terminal = fixture({ current: run("succeeded") });
  await assert.rejects(terminal.application.dispatch({ type: "pause" }), /does not allow pause/);
  assert.equal(terminal.calls.includes("pause"), false);

  const running = fixture({ current: run("running"), loadedRun: run("running") });
  await assert.rejects(running.application.dispatch({ type: "retryNode", runId: "run-1", nodeId: "node-1" }), /does not allow retry/);
});
