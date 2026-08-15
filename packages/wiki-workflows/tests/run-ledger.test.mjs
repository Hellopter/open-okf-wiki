import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiRunLedger } from "../dist/run-ledger.js";

test("ledger persists version 1 state and ordered JSONL events", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  await ledger.append("run-1", { at: "2026-01-01T00:00:01.000Z", type: "started", message: "Started" });
  await ledger.append("run-1", { at: "2026-01-01T00:00:02.000Z", type: "progress", message: "Working" });
  assert.deepEqual((await ledger.events("run-1", 1)).map((event) => event.sequence), [2]);
  const state = JSON.parse(await readFile(path.join(root, "runs", "run-1", "run-state.json"), "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.lastEventSequence, 2);
});

test("progress persists through update/read", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  assert.equal((await ledger.read("run-1")).progress, undefined);

  const progress = {
    stage: "lead",
    lastMessage: "writing",
  };
  await ledger.update("run-1", (state) => ({ ...state, progress }));
  assert.deepEqual((await ledger.read("run-1")).progress, progress);
});

test("old state without progress still parses; invalid progress is dropped", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  const file = path.join(root, "runs", "run-1", "run-state.json");
  const raw = JSON.parse(await readFile(file, "utf8"));
  delete raw.progress;
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
  assert.equal((await ledger.read("run-1")).progress, undefined);

  await writeFile(file, `${JSON.stringify({ ...raw, progress: { stage: "nope", tasks: "bad" } }, null, 2)}\n`);
  const dropped = await ledger.read("run-1");
  assert.ok(dropped);
  assert.equal(dropped.status, "running");
  assert.equal(dropped.progress, undefined);

  await ledger.update("run-1", (state) => ({ ...state, progress: { not: "valid" } }));
  assert.equal((await ledger.read("run-1")).progress, undefined);
});

test("agent sidecars isolate lead and repeated task IDs by batch and bound process activity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  await ledger.append("run-1", { at: "2026-01-01T00:00:01.000Z", type: "progress", message: "lead", data: { stage: "lead" } });
  const entries = Array.from({ length: 205 }, (_, index) => ({
    sequence: index + 1, at: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    kind: "agent", severity: "info", message: `step ${index}`,
  }));
  await ledger.commitAgent("run-1", { target: { kind: "lead" }, attempt: 1, sampledAt: "2026-01-01T00:00:02.000Z", activity: "streaming", activeTools: [], process: entries }, "lead update");
  assert.equal((await ledger.readAgent("run-1", { kind: "lead" })).process.length, 200);
  const task = (batch, sampledAt) => ({ target: { kind: "task", batch, taskId: "review" }, attempt: 1, sampledAt, activity: "using_tool", activeTools: [] });
  await ledger.commitAgent("run-1", task(1, "2026-01-01T00:00:03.000Z"), "batch 1", { role: "review" });
  await ledger.commitAgent("run-1", task(2, "2026-01-01T00:00:04.000Z"), "batch 2", { role: "review" });
  assert.equal((await ledger.readAgent("run-1", { kind: "task", batch: 1, taskId: "review" })).agent.target.batch, 1);
  assert.equal((await ledger.readAgent("run-1", { kind: "task", batch: 2, taskId: "review" })).agent.target.batch, 2);

  const leadFile = path.join(root, "runs", "run-1", "agents", "lead.json");
  const invalid = JSON.parse(await readFile(leadFile, "utf8"));
  delete invalid.agent.updatedAt;
  await writeFile(leadFile, `${JSON.stringify(invalid, null, 2)}\n`);
  await assert.rejects(ledger.readAgent("run-1", { kind: "lead" }), /Invalid Wiki agent record/);
});

test("activity preserves important entries, bounds tools, projects a short tail, and paginates", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  await ledger.append("run-1", { at: "2026-01-01T00:00:01.000Z", type: "progress", message: "lead", data: { stage: "lead" } });
  const process = Array.from({ length: 1005 }, (_, index) => ({ sequence: index, at: "2026-01-01T00:00:02.000Z", kind: "tool", severity: "info", target: { kind: "lead" }, message: `tool ${index}` }));
  process.splice(2, 0, { sequence: 0, at: "2026-01-01T00:00:02.000Z", kind: "warning", severity: "warning", target: { kind: "lead" }, message: "important warning" });
  await ledger.commitAgent("run-1", { target: { kind: "lead" }, attempt: 1, sampledAt: "2026-01-01T00:00:02.000Z", activity: "streaming", activeTools: [], process }, "many");
  assert.equal((await ledger.read("run-1")).progress.recentActivity.length, 20);
  const important = await ledger.activity("run-1", { limit: 10, actor: { kind: "lead" }, severity: "warning" });
  assert.deepEqual(important.entries.map((entry) => entry.message), ["important warning"]);
  const first = await ledger.activity("run-1", { limit: 10, actor: { kind: "lead" } });
  assert.equal(first.entries.length, 10);
  assert.ok(first.nextBefore);
  const second = await ledger.activity("run-1", { limit: 10, before: first.nextBefore, actor: { kind: "lead" } });
  assert.ok(second.entries[0].sequence < first.entries.at(-1).sequence);
});

test("agent health persists beyond activity projection and only explicit recovery clears it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  await ledger.append("run-1", {
    at: "2026-01-01T00:00:01.000Z", type: "progress", message: "queued", data: {
      stage: "lead", batch: 1, tasks: [{ id: "write-1", role: "write", status: "queued" }],
    },
  });

  const target = { kind: "task", batch: 1, taskId: "write-1" };
  await ledger.commitHealth("run-1", { target, status: "degraded", at: "2026-01-01T00:00:02.000Z", message: "observer unavailable" });
  assert.equal((await ledger.readAgent("run-1", target)).agent.health, "degraded");
  assert.equal((await ledger.read("run-1")).progress.currentBatch.tasks[0].health, "degraded");

  for (let index = 0; index < 25; index += 1) {
    await ledger.commitAgent("run-1", {
      target, attempt: 1, sampledAt: `2026-01-01T00:00:${String(index + 3).padStart(2, "0")}.000Z`,
      activity: "retry_wait", activeTools: [],
      process: [{ sequence: 0, at: `2026-01-01T00:00:${String(index + 3).padStart(2, "0")}.000Z`, kind: "retry", severity: "warning", target, message: `retry ${index}` }],
    }, `retry ${index}`, { role: "write" });
  }
  const degraded = await ledger.read("run-1");
  assert.equal(degraded.progress.recentActivity.length, 20);
  assert.ok(!degraded.progress.recentActivity.some((entry) => entry.message === "observer unavailable"));
  assert.equal((await ledger.readAgent("run-1", target)).agent.health, "degraded");

  await ledger.commitHealth("run-1", { target, status: "healthy", at: "2026-01-01T00:01:00.000Z", message: "observer recovered" });
  assert.equal((await ledger.readAgent("run-1", target)).agent.health, "healthy");
  assert.equal((await ledger.read("run-1")).progress.currentBatch.tasks[0].health, "healthy");
  assert.deepEqual((await ledger.activity("run-1", { actor: target, severity: "warning" })).entries.map((entry) => entry.message), ["retry 24", "retry 23", "retry 22", "retry 21", "retry 20", "retry 19", "retry 18", "retry 17", "retry 16", "retry 15", "retry 14", "retry 13", "retry 12", "retry 11", "retry 10", "retry 9", "retry 8", "retry 7", "retry 6", "retry 5", "retry 4", "retry 3", "retry 2", "retry 1", "retry 0", "observer unavailable"]);
});

test("leader health before its first checkpoint creates and recovers the leader projection", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });

  const target = { kind: "lead" };
  await ledger.commitHealth("run-1", { target, status: "degraded", at: "2026-01-01T00:00:01.000Z", message: "observer unavailable" });
  const degraded = await ledger.read("run-1");
  assert.equal(degraded.progress.stage, "lead");
  assert.deepEqual(degraded.progress.lead, {
    target, role: "lead", status: "running", attempt: 1, activity: "starting",
    activeTools: [], health: "degraded", updatedAt: "2026-01-01T00:00:01.000Z",
  });
  assert.equal((await ledger.readAgent("run-1", target)).agent.health, "degraded");

  await ledger.commitHealth("run-1", { target, status: "healthy", at: "2026-01-01T00:00:02.000Z", message: "observer recovered" });
  assert.equal((await ledger.read("run-1")).progress.lead.health, "healthy");
  assert.equal((await ledger.readAgent("run-1", target)).agent.health, "healthy");
  assert.deepEqual((await ledger.activity("run-1", { actor: target })).entries.map(({ message }) => message), ["observer recovered", "observer unavailable"]);
});

test("terminal state rejects mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "regenerate", at: "2026-01-01T00:00:00.000Z" });
  await ledger.update("run-1", (state) => ({ ...state, status: "cancelled" }));
  await assert.rejects(ledger.update("run-1", (state) => state), /immutable/);
});

test("terminal transaction closes the leader sidecar", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  await ledger.append("run-1", { at: "2026-01-01T00:00:01.000Z", type: "progress", message: "lead", data: { stage: "lead" } });
  await ledger.commitAgent("run-1", { target: { kind: "lead" }, attempt: 1, sampledAt: "2026-01-01T00:00:02.000Z", activity: "streaming", activeTools: [] }, "streaming");
  await ledger.commitTerminal("run-1", { at: "2026-01-01T00:00:03.000Z", type: "completed", message: "done" }, (state) => ({ ...state, status: "succeeded", completedAt: "2026-01-01T00:00:03.000Z" }));
  assert.equal((await ledger.read("run-1")).progress.lead.status, "complete");
  assert.equal((await ledger.readAgent("run-1", { kind: "lead" })).agent.status, "complete");
});

test("batch terminal status derives partial and failed from all task outcomes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  await ledger.append("run-1", { at: "2026-01-01T00:00:01.000Z", type: "progress", message: "batch", data: { stage: "lead", batch: 1, tasks: [{ id: "a", role: "write", status: "running" }, { id: "b", role: "review", status: "running" }] } });
  const checkpoint = (taskId, sampledAt) => ({ target: { kind: "task", batch: 1, taskId }, attempt: 1, sampledAt, activity: "settled", activeTools: [] });
  await ledger.commitAgent("run-1", checkpoint("a", "2026-01-01T00:00:02.000Z"), "a complete", { role: "write", status: "complete" });
  await ledger.commitAgent("run-1", checkpoint("b", "2026-01-01T00:00:03.000Z"), "b failed", { role: "review", status: "failed" });
  assert.equal((await ledger.read("run-1")).progress.currentBatch.status, "partial");
  await ledger.append("run-1", { at: "2026-01-01T00:00:04.000Z", type: "progress", message: "batch 2", data: { stage: "lead", batch: 2, tasks: [{ id: "c", role: "write", status: "failed" }] } });
  assert.equal((await ledger.read("run-1")).progress.currentBatch.status, "failed");
  assert.equal((await ledger.read("run-1")).progress.currentBatch.completedAt, "2026-01-01T00:00:04.000Z");
});

test("agent checkpoint transaction updates sidecar, run projection, rejects stale attempts, and derives batch terminal state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  await ledger.append("run-1", {
    at: "2026-01-01T00:00:01.000Z",
    type: "progress",
    message: "delegating",
    data: { stage: "lead", batch: 1, tasks: [{ id: "write-1", role: "write", status: "running", attempt: 2 }] },
  });

  const event = await ledger.commitAgent("run-1", {
    target: { kind: "task", batch: 1, taskId: "write-1" },
    attempt: 2,
    sampledAt: "2026-01-01T00:00:02.000Z",
    activity: "streaming",
    activeTools: [],
    usage: { turns: 2, total: 140 },
    sessionFile: path.join(root, "runs", "run-1", "sessions", "write.jsonl"),
  }, "Writing", { role: "write", execution: {
    batchId: 1,
    task: { id: "write-1", role: "write", instruction: "write", sourceScopeIds: [], contextRefs: [], writePaths: ["wiki/overview.md"] },
    phase: "running", attempt: 2, collected: false,
  } });
  assert.equal(event.type, "telemetry");
  const [state, record, events] = await Promise.all([
    ledger.read("run-1"),
    ledger.readAgent("run-1", { kind: "task", batch: 1, taskId: "write-1" }),
    ledger.events("run-1", 1),
  ]);
  assert.deepEqual(state.progress.currentBatch.tasks[0].usage, { turns: 2, total: 140 });
  assert.equal(state.progress.currentBatch.tasks[0].activity, "responding");
  assert.deepEqual(record.agent.usage, { turns: 2, total: 140 });
  assert.equal(record.sessionFile, path.join(root, "runs", "run-1", "sessions", "write.jsonl"));
  assert.equal(record.execution.batchId, 1);
  assert.equal(record.execution.task.id, "write-1");
  assert.equal(record.execution.phase, "running");
  assert.equal(record.execution.attempt, 2);
  assert.deepEqual(state.progress.usage, { turns: 2, total: 140 });
  assert.deepEqual(events.map(({ type }) => type), ["telemetry"]);

  await ledger.commitAgent("run-1", {
    target: { kind: "task", batch: 1, taskId: "write-1" },
    attempt: 2,
    sampledAt: "2026-01-01T00:00:02.500Z",
    activity: "settled",
    activeTools: [],
  }, "Idle", { role: "write", status: "complete" });
  assert.equal((await ledger.read("run-1")).progress.currentBatch.status, "complete");

  const stale = await ledger.commitAgent("run-1", {
    target: { kind: "task", batch: 1, taskId: "write-1" },
    attempt: 1,
    sampledAt: "2026-01-01T00:00:03.000Z",
    usage: { turns: 99 },
  }, "stale", { role: "write" });
  assert.equal(stale, undefined);
  assert.deepEqual((await ledger.readAgent("run-1", { kind: "task", batch: 1, taskId: "write-1" })).agent.usage, { turns: 2, total: 140 });
  assert.equal((await ledger.read("run-1")).lastEventSequence, 3);
});

test("run usage overwrites duplicate telemetry by target and attempt while retaining retry usage", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  await ledger.append("run-1", {
    at: "2026-01-01T00:00:01.000Z", type: "progress", message: "lead",
    data: { stage: "lead", budgets: { maxDelegatedTasks: 24, maxDelegateBatches: 8, maxTurnsPerSession: 60, maxToolCallsPerSession: 120 } },
  });
  const checkpoint = async (attempt, turns, total, at) => await ledger.commitAgent("run-1", {
    target: { kind: "lead" }, attempt, sampledAt: at, activity: "streaming", activeTools: [], usage: { turns, total },
  }, "usage");
  await checkpoint(1, 2, 100, "2026-01-01T00:00:02.000Z");
  await checkpoint(1, 3, 150, "2026-01-01T00:00:03.000Z");
  await checkpoint(2, 1, 40, "2026-01-01T00:00:04.000Z");
  const state = await ledger.read("run-1");
  assert.deepEqual(state.progress.usage, { turns: 4, total: 190 });
  assert.deepEqual(state.progress.budgets, { maxDelegatedTasks: 24, maxDelegateBatches: 8, maxTurnsPerSession: 60, maxToolCallsPerSession: 120 });
  assert.equal(Object.keys(state.usageByAttempt).length, 2);

  const file = path.join(root, "runs", "run-1", "run-state.json");
  const raw = JSON.parse(await readFile(file, "utf8"));
  delete raw.usageByAttempt;
  delete raw.progress.usage;
  delete raw.progress.budgets;
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
  const old = await ledger.read("run-1");
  assert.equal(old.progress.usage, undefined);
  assert.equal(old.progress.budgets, undefined);
});

test("task runtime state survives restart with interleaved batches, duplicate task IDs, and attempts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-runtime-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  await ledger.append("run-1", { at: "2026-01-01T00:00:01.000Z", type: "progress", message: "lead", data: { stage: "lead" } });
  const task = (id, role = "research") => ({ id, role, instruction: `${role} ${id}`, sourceScopeIds: [], contextRefs: [] });
  const receipt = { id: "done", role: "research", status: "complete", summary: "done", outputs: [], coverage: ["covered"], gaps: [], attempts: 1 };
  const runtime = {
    batches: [
      { batchId: 1, tasks: [{ task: task("shared"), phase: "queued", attempt: 0, collected: false }] },
      { batchId: 2, tasks: [
        { task: task("done"), phase: "terminal", attempt: 1, collected: false, receipt },
        { task: task("shared", "write"), phase: "running", attempt: 2, collected: false, sessionFile: path.join(root, "sessions", "shared.jsonl") },
      ] },
    ],
  };
  await ledger.commitTaskRuntimeState("run-1", runtime, "2026-01-01T00:00:02.000Z");

  const restarted = createWikiRunLedger(root);
  assert.deepEqual(await restarted.readTaskRuntimeState("run-1"), runtime);
  const state = await restarted.read("run-1");
  assert.equal(state.taskRuntime, undefined);
  const rawState = JSON.parse(await readFile(path.join(root, "runs", "run-1", "run-state.json"), "utf8"));
  assert.equal("taskRuntime" in rawState, false);
  assert.deepEqual(state.progress.batches.map((batch) => [batch.batch, batch.tasks.map((entry) => entry.id)]), [
    [1, ["shared"]], [2, ["done", "shared"]],
  ]);
  assert.equal((await restarted.readAgent("run-1", { kind: "task", batch: 1, taskId: "shared" })).execution.phase, "queued");
  assert.equal((await restarted.readAgent("run-1", { kind: "task", batch: 2, taskId: "shared" })).execution.attempt, 2);

  const accepted = await restarted.commitAgent("run-1", {
    target: { kind: "task", batch: 2, taskId: "shared" }, attempt: 2,
    sampledAt: "2026-01-01T00:00:03.000Z", activity: "streaming", activeTools: [], usage: { turns: 3 },
  }, "resumed telemetry", { role: "write" });
  assert.equal(accepted.type, "telemetry");
  const stale = await restarted.commitAgent("run-1", {
    target: { kind: "task", batch: 2, taskId: "shared" }, attempt: 1,
    sampledAt: "2026-01-01T00:00:04.000Z", usage: { turns: 99 },
  }, "stale telemetry", { role: "write" });
  assert.equal(stale, undefined);
  assert.deepEqual((await restarted.readAgent("run-1", { kind: "task", batch: 2, taskId: "shared" })).agent.usage, { turns: 3 });

  runtime.batches[1].tasks[0].collected = true;
  await restarted.commitTaskRuntimeState("run-1", runtime, "2026-01-01T00:00:05.000Z");
  assert.equal((await createWikiRunLedger(root).readTaskRuntimeState("run-1")).batches[1].tasks[0].collected, true);
});

test("paused task runtime state round-trips pause reason, attempt, and exact session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-paused-runtime-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  const sessionFile = path.join(root, "sessions", "research.jsonl");
  const runtime = {
    batches: [{ batchId: 1, tasks: [
      {
        task: { id: "manual-paused", role: "write", instruction: "write", sourceScopeIds: [], contextRefs: [] },
        phase: "paused", attempt: 1, collected: false, sessionFile: path.join(root, "sessions", "write.jsonl"),
      },
      {
        task: { id: "provider-paused", role: "research", instruction: "research", sourceScopeIds: [], contextRefs: [] },
        phase: "paused", attempt: 3, collected: false, sessionFile,
        pause: { code: "quota", message: "Provider quota exhausted", retryable: false, retryAfterMs: 30_000 },
      },
    ] }],
  };
  await ledger.commitTaskRuntimeState("run-1", runtime, "2026-01-01T00:00:01.000Z");

  const restarted = createWikiRunLedger(root);
  assert.deepEqual(await restarted.readTaskRuntimeState("run-1"), runtime);
  const provider = await restarted.readAgent("run-1", { kind: "task", batch: 1, taskId: "provider-paused" });
  assert.equal(provider.agent.status, "retrying");
  assert.equal(provider.agent.activity, "retry_wait");
  assert.equal(provider.execution.pause.code, "quota");
  assert.equal(provider.sessionFile, sessionFile);
  assert.equal((await restarted.read("run-1")).progress.currentBatch.tasks[0].status, "running");

  await assert.rejects(ledger.commitTaskRuntimeState("run-1", {
    batches: [{ batchId: 1, tasks: [{
      task: runtime.batches[0].tasks[1].task, phase: "paused", attempt: 0, collected: false,
    }] }],
  }, "2026-01-01T00:00:02.000Z"), /Invalid Wiki task runtime task/);
});

test("task runtime checkpoint journal recovers queued, running, and terminal-uncollected sidecars atomically", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-runtime-crash-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  let armed = false;
  const crashing = createWikiRunLedger(root, { fault(point) {
    if (armed && point === "afterAgent") throw new Error("crash:afterAgent");
  } });
  await crashing.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  const definition = (id) => ({ id, role: "research", instruction: id, sourceScopeIds: [], contextRefs: [] });
  const receipt = { id: "terminal", role: "research", status: "complete", summary: "done", outputs: [], coverage: [], gaps: [], attempts: 1 };
  const runtime = {
    batches: [{ batchId: 1, tasks: [
      { task: definition("queued"), phase: "queued", attempt: 0, collected: false },
      { task: definition("running"), phase: "running", attempt: 2, collected: false, sessionFile: path.join(root, "running.jsonl") },
      { task: definition("terminal"), phase: "terminal", attempt: 1, collected: false, receipt },
    ] }],
  };
  armed = true;
  await assert.rejects(crashing.commitTaskRuntimeState("run-1", runtime, "2026-01-01T00:00:01.000Z"), /crash:afterAgent/);
  const recovered = createWikiRunLedger(root);
  assert.deepEqual(await recovered.readTaskRuntimeState("run-1"), runtime);
  assert.equal((await recovered.read("run-1")).lastEventSequence, 1);
  await assert.rejects(readFile(path.join(root, "runs", "run-1", "pending-transaction.json")), /ENOENT/);
});

for (const faultPoint of ["afterJournal", "afterAgent", "afterState", "afterEvent", "afterActivity"]) {
  test(`fresh ledger recovers a task transaction interrupted ${faultPoint}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
    t.after(async () => await rm(root, { recursive: true, force: true }));
    let armed = false;
    const crashing = createWikiRunLedger(root, { fault(point) {
      if (armed && point === faultPoint) throw new Error(`crash:${point}`);
    } });
    await crashing.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
    await crashing.append("run-1", {
      at: "2026-01-01T00:00:01.000Z",
      type: "progress",
      message: "delegating",
      data: { stage: "lead", tasks: [{ id: "write-1", role: "write", status: "running", attempt: 1 }] },
    });
    armed = true;
    const receipt = {
      id: "write-1", role: "write", status: "complete", summary: "done",
      outputs: [], coverage: ["source"], gaps: [], attempts: 1,
    };
    await assert.rejects(crashing.commitAgent("run-1", {
      target: { kind: "task", batch: 1, taskId: "write-1" }, attempt: 1,
      sampledAt: "2026-01-01T00:00:02.000Z", activity: "settled", activeTools: [],
      process: [{ sequence: 0, at: "2026-01-01T00:00:02.000Z", kind: "agent", severity: "info", target: { kind: "task", batch: 1, taskId: "write-1" }, message: "task complete" }],
    }, "complete", { role: "write", receipt }), /crash:/);

    const recovered = createWikiRunLedger(root);
    const [state, record, events, activity] = await Promise.all([
      recovered.read("run-1"), recovered.readAgent("run-1", { kind: "task", batch: 1, taskId: "write-1" }), recovered.events("run-1"),
      recovered.activity("run-1"),
    ]);
    assert.equal(state.lastEventSequence, 2);
    assert.equal(record.receipt.status, "complete");
    assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2]);
    assert.deepEqual(activity.entries.map(({ message }) => message), ["task complete"]);
    await assert.rejects(readFile(path.join(root, "runs", "run-1", "pending-transaction.json")), /ENOENT/);
  });
}
