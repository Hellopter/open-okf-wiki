import assert from "node:assert/strict";
import test from "node:test";
import { WikiWorkCoordinator } from "../dist/lead/work-coordinator.js";

const signal = new AbortController().signal;
const emptySnapshot = (batchId) => ({ batchId, status: "running", receipts: [], pendingTaskIds: ["task-1"] });

function coordinator(overrides = {}) {
  const calls = [];
  const run = {
    taskRuntimeState: { batches: [] },
    async startNextReadyWave(plan) {
      calls.push(["queue", plan]);
      return { wave: "discovery", batchId: 1, contracts: [{ id: "task-1" }] };
    },
    async rollbackDelegateBatch(batchId) { calls.push(["rollback", batchId]); },
    async currentActiveWave() { return { wave: "write", batchId: 2 }; },
    async presentSnapshot(snapshot) { calls.push(["present", snapshot.batchId]); return snapshot; },
    ...overrides.run,
  };
  const tasks = {
    async start(contracts) { calls.push(["start", contracts]); return { batchId: 1 }; },
    async collect(batchId, options) { calls.push(["collect", batchId, options]); return emptySnapshot(batchId); },
    async cancel(batchId, taskIds, reason) { calls.push(["cancel", batchId, taskIds, reason]); return emptySnapshot(batchId); },
    ...overrides.tasks,
  };
  const work = new WikiWorkCoordinator({
    run,
    tasks,
    signal,
    writeLease: overrides.writeLease ?? { assertReviewAllowed() { calls.push(["lease"]); } },
    snapshotDiscoverySlots: overrides.snapshotDiscoverySlots ?? (async () => [{ sourceScopeId: "source", instruction: "Inspect source" }]),
  });
  return { work, calls, run };
}

test("startCurrent snapshots first-wave discovery slots before queueing and launching", async () => {
  const draft = [{ sourceScopeId: "source", instruction: "Inspect original" }];
  let queuedPlan;
  const { work, calls } = coordinator({
    snapshotDiscoverySlots: async () => draft,
    run: {
      async startNextReadyWave(plan) {
        queuedPlan = plan;
        draft[0].instruction = "Mutated after snapshot";
        calls.push(["queue", plan]);
        return { wave: "discovery", batchId: 1, contracts: [{ id: "task-1" }] };
      },
    },
  });

  assert.deepEqual(await work.startCurrent(), { wave: "discovery", batchId: 1 });
  assert.notEqual(queuedPlan, draft);
  assert.equal(queuedPlan[0].instruction, "Inspect original");
  assert.deepEqual(calls.map(([name]) => name), ["queue", "start"]);
});

test("startCurrent rolls a review queue back when write-lease preflight rejects", async () => {
  let queued = false;
  const { work, calls } = coordinator({
    run: {
      taskRuntimeState: { batches: [{ batchId: 1 }] },
      async startNextReadyWave(plan) {
        assert.deepEqual(plan, []);
        queued = true;
        return { wave: "review", batchId: 2, contracts: [{ id: "review-1" }] };
      },
      async rollbackDelegateBatch(batchId) {
        assert.equal(batchId, 2);
        queued = false;
        calls.push(["rollback", batchId]);
      },
    },
    writeLease: { assertReviewAllowed() { throw new Error("Writer lease is active"); } },
  });

  await assert.rejects(work.startCurrent(), /Writer lease is active/);
  assert.equal(queued, false, "lease rejection must not leave a queued batch");
  assert.deepEqual(calls, [["rollback", 2]]);
});

test("collectCurrent and cancelCurrent resolve the active batch and present snapshots", async () => {
  const { work, calls } = coordinator();
  assert.deepEqual(await work.collectCurrent({ until: "all", timeoutSeconds: 3 }), {
    batchId: 2, status: "running", receipts: [], pendingTaskIds: ["task-1"],
  });
  assert.deepEqual(await work.cancelCurrent("user_requested"), {
    batchId: 2, status: "running", receipts: [], pendingTaskIds: ["task-1"],
  });
  assert.deepEqual(calls, [
    ["collect", 2, { until: "all", timeoutSeconds: 3 }], ["present", 2],
    ["cancel", 2, undefined, "user_requested"], ["present", 2],
  ]);
});

test("active-wave ambiguity fails before collect or cancel reaches TaskRuntime", async () => {
  const { work, calls } = coordinator({
    run: { async currentActiveWave() { throw new Error("Wiki Run has multiple uncollected delegate waves"); } },
  });

  await assert.rejects(work.collectCurrent({ until: "any", timeoutSeconds: 0 }), /multiple uncollected/);
  await assert.rejects(work.cancelCurrent("blocked"), /multiple uncollected/);
  assert.deepEqual(calls, []);
});
