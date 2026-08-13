import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WikiProducer } from "../dist/producer.js";

async function temporaryWorkspace(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "wiki-producer-"));
  t.after(async () => await rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(overrides = {}) {
  let next = 0;
  const calls = [];
  const adapters = {
    async prepare(input) {
      calls.push(["prepare", input.operation, input.preparation]);
      return { inspection: { fingerprint: "source-1" }, sourceFingerprint: "source-1", candidateWikiRoot: `${input.cwd}/.candidate`, sourceScopeIds: ["source"], prompt: "Produce Wiki" };
    },
    createLead() { return { async run(input) { calls.push(["lead", input.operation, input.attempt]); await input.report("Lead progress"); return { kind: "complete", summary: "done" }; } }; },
    async validate(input) { calls.push(["validate", input.operation]); return { ok: true }; },
    async publish(input) { calls.push(["publish", input.operation]); return { pages: ["a.md"], sourceFingerprint: "source-1" }; },
    ...overrides,
  };
  return { producer: new WikiProducer({ adapters, createId: () => `run-${++next}` }), calls };
}

test("start runs the deep interface and streams durable events", async (t) => {
  const cwd = await temporaryWorkspace(t);
  const subject = fixture();
  const handle = await subject.producer.start({ cwd, focus: " auth " });
  const result = await handle.result();
  assert.deepEqual(result, {
    runId: handle.id,
    status: "succeeded",
    pages: ["a.md"],
    sourceFingerprint: "source-1",
    summary: "done",
  });
  assert.equal((await handle.view()).status, "succeeded");
  assert.equal((await handle.view()).focus, "auth");
  const events = [];
  for await (const event of handle.events()) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["started", "progress", "progress", "progress", "progress", "progress", "completed"]);
  assert.deepEqual(subject.calls.map((call) => call[0]), ["prepare", "lead", "validate", "publish"]);
});

test("regenerate remains an explicit end-to-end operation", async (t) => {
  const cwd = await temporaryWorkspace(t);
  const subject = fixture();
  const handle = await subject.producer.start({ cwd, operation: "regenerate" });
  await handle.result();
  assert.equal((await handle.view()).operation, "regenerate");
  assert.ok(subject.calls.every((call) => call[1] === "regenerate" || call[0] === "lead" && call[1] === "regenerate"));
});

test("workspace allows only one running or paused run", async (t) => {
  const cwd = await temporaryWorkspace(t);
  const gate = deferred();
  const subject = fixture({ createLead: () => ({ async run({ signal }) {
    await Promise.race([gate.promise, new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
    return { kind: "complete", summary: "done" };
  } }) });
  const first = await subject.producer.start({ cwd });
  await assert.rejects(subject.producer.start({ cwd }), /already active/);
  await first.control("cancel");
  const second = await subject.producer.start({ cwd });
  assert.equal(second.id, "run-3");
  gate.resolve();
  await second.result();
});

test("resume preserves the candidate and cancel preserves terminal immutability", async (t) => {
  const cwd = await temporaryWorkspace(t);
  let invocations = 0;
  let candidateGeneration = 0;
  const gates = [deferred(), deferred()];
  const subject = fixture({
    async prepare(input) {
      if (input.preparation === "fresh") candidateGeneration += 1;
      assert.equal(candidateGeneration, 1, "resume must reuse the fresh candidate");
      subject.calls.push(["prepare", input.operation, input.preparation]);
      return { inspection: {}, sourceFingerprint: "source-1", candidateWikiRoot: `${input.cwd}/.candidate-${candidateGeneration}`, sourceScopeIds: ["source"], prompt: "Produce Wiki" };
    },
    createLead: () => ({ async run({ signal }) {
      const gate = gates[invocations++];
      await Promise.race([gate.promise, new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
      return { kind: "complete", summary: "done" };
    } }),
  });
  const handle = await subject.producer.start({ cwd });
  while (invocations === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await handle.control("pause")).status, "paused");
  assert.equal((await handle.control("resume")).status, "running");
  gates[0].resolve();
  while (invocations < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    subject.calls.filter(([name]) => name === "prepare").map(([, , preparation]) => preparation),
    ["fresh", "resume"],
  );
  assert.equal((await handle.control("cancel")).status, "cancelled");
  gates[1].resolve();
  await assert.rejects(handle.result(), /cancelled/);
  await assert.rejects(handle.control("resume"), /cannot be controlled/);
});

test("fresh producer lists and opens disk runs, recovering interruption as paused", async (t) => {
  const cwd = await temporaryWorkspace(t);
  const gate = deferred();
  let entered = false;
  const first = fixture({ createLead: () => ({ async run() {
    entered = true;
    await gate.promise;
    return { kind: "complete", summary: "done" };
  } }) });
  const original = await first.producer.start({ cwd });
  while (!entered) await new Promise((resolve) => setImmediate(resolve));
  const fresh = fixture();
  const runs = await fresh.producer.list(cwd);
  assert.equal(runs[0].id, original.id);
  const recovered = await fresh.producer.open(original.id, cwd);
  assert.ok(recovered);
  assert.equal((await recovered.view()).status, "paused");
  await recovered.control("cancel");
});

test("quota outcome durably pauses the run with retry metadata", async (t) => {
  const cwd = await temporaryWorkspace(t);
  const retryAt = "2026-08-12T12:00:00.000Z";
  const subject = fixture({
    createLead: () => ({
      async run() {
        return { kind: "pause", reason: "quota", summary: "Provider quota exhausted", retryAt };
      },
    }),
  });
  const handle = await subject.producer.start({ cwd });
  while ((await handle.view()).status === "running") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual((await handle.view()).pause, {
    reason: "quota",
    summary: "Provider quota exhausted",
    retryAt,
  });

  const fresh = fixture();
  const recovered = await fresh.producer.open(handle.id, cwd);
  assert.ok(recovered);
  assert.equal((await recovered.view()).status, "paused");
  assert.deepEqual((await recovered.view()).pause, {
    reason: "quota",
    summary: "Provider quota exhausted",
    retryAt,
  });
  await recovered.control("cancel");
});

test("stage is present on prepare/lead/validate/publish and inspect reads sidecar receipts", async (t) => {
  const cwd = await temporaryWorkspace(t);
  const receipt = {
    id: "research-1",
    role: "research",
    status: "complete",
    summary: "notes",
    outputs: [],
    coverage: ["source"],
    gaps: [],
    attempts: 1,
  };
  const tasks = [
    { id: "research-1", role: "research", status: "running" },
    { id: "write-1", role: "write", status: "queued" },
  ];
  const history = [{ role: "assistant", kind: "text", text: "found sources" }];
  const subject = fixture({
    createLead: () => ({
      async run(input) {
        await input.report("Delegating research", { tasks });
        await input.report("Research complete", { taskId: "research-1", receipt, history });
        return { kind: "complete", summary: "done" };
      },
    }),
  });
  const handle = await subject.producer.start({ cwd });
  await handle.result();
  const events = [];
  for await (const event of handle.events()) events.push(event);
  const staged = Object.fromEntries(
    events.filter((event) => event.data?.stage).map((event) => [event.message, event.data.stage]),
  );
  assert.equal(staged["Preparing candidate Wiki"], "prepare");
  assert.equal(staged["Running Wiki lead"], "lead");
  assert.equal(staged["Validating candidate Wiki"], "validate");
  assert.equal(staged["Publishing candidate Wiki"], "publish");

  const view = await handle.view();
  assert.equal(view.progress.stage, "publish");
  assert.deepEqual(view.progress.tasks, [
    { id: "research-1", role: "research", status: "running" },
    { id: "write-1", role: "write", status: "queued" },
  ]);

  const inspected = await handle.inspect("research-1");
  assert.ok(inspected);
  assert.equal(inspected.runId, handle.id);
  assert.equal(inspected.task.id, "research-1");
  assert.deepEqual(inspected.receipt, receipt);
  assert.deepEqual(inspected.history, history);
  assert.equal(inspected.processAvailable, true);

  const snapshotOnly = await handle.inspect("write-1");
  assert.ok(snapshotOnly);
  assert.equal(snapshotOnly.task.status, "queued");
  assert.equal(snapshotOnly.receipt, undefined);
  assert.equal(snapshotOnly.processAvailable, false);

  assert.equal(await handle.inspect("missing-task"), undefined);
});

test("telemetry is transactionally projected and replay/live subscribers can cancel", async (t) => {
  const cwd = await temporaryWorkspace(t);
  const ready = deferred();
  const release = deferred();
  const subject = fixture({
    createLead: () => ({ async run(input) {
      await input.report("Delegating", {
        stage: "delegate",
        tasks: [{ id: "write-1", role: "write", status: "running", attempt: 1 }],
      });
      ready.resolve();
      await release.promise;
      await input.report("Writing", {
        stage: "delegate",
        taskId: "write-1",
        phase: "update",
        telemetry: {
          taskId: "write-1",
          attempt: 1,
          sampledAt: "2026-01-01T00:00:05.000Z",
          activity: "responding",
          usage: { turns: 1, total: 42 },
          history: [{ role: "assistant", kind: "text", text: "draft" }],
        },
      });
      return { kind: "complete", summary: "done" };
    } }),
  });
  const handle = await subject.producer.start({ cwd });
  await ready.promise;

  const abort = new AbortController();
  const cancelled = handle.events(0, abort.signal)[Symbol.asyncIterator]();
  assert.equal((await cancelled.next()).value.type, "started");
  abort.abort();
  assert.equal((await cancelled.next()).done, true);

  const collect = async () => {
    const events = [];
    for await (const event of handle.events()) events.push(event);
    return events;
  };
  const first = collect();
  const second = collect();
  release.resolve();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left.map(({ sequence }) => sequence), right.map(({ sequence }) => sequence));
  assert.equal(new Set(left.map(({ sequence }) => sequence)).size, left.length);
  assert.equal(left.filter(({ type }) => type === "telemetry").length, 1);

  const view = await handle.view();
  const task = view.progress.tasks.find(({ id }) => id === "write-1");
  assert.equal(task.activity, "responding");
  assert.deepEqual(task.usage, { turns: 1, total: 42 });
  const inspected = await handle.inspect("write-1");
  assert.deepEqual(inspected.usage, { turns: 1, total: 42 });
  assert.deepEqual(inspected.history, [{ role: "assistant", kind: "text", text: "draft" }]);
  assert.equal(subject.producer.eventHubs.size, 0);
});

test("live stream observes terminal event even when terminal state is already visible", async (t) => {
  const cwd = await temporaryWorkspace(t);
  const entered = deferred();
  const release = deferred();
  const subject = fixture({
    async publish(input) {
      entered.resolve();
      await release.promise;
      return { pages: ["a.md"], sourceFingerprint: "source-1" };
    },
  });
  const handle = await subject.producer.start({ cwd });
  await entered.promise;
  const cursor = (await handle.view()).lastEventSequence;
  const iterator = handle.events(cursor)[Symbol.asyncIterator]();
  const next = iterator.next();
  release.resolve();
  const event = (await next).value;
  assert.equal(event.type, "completed");
  assert.equal((await handle.view()).status, "succeeded");
  assert.equal((await iterator.next()).done, true);
});

test("task end event is published only after inspect sees final sidecar", async (t) => {
  const cwd = await temporaryWorkspace(t);
  const ready = deferred();
  const release = deferred();
  const receipt = {
    id: "write-1", role: "write", status: "complete", summary: "done",
    outputs: [], coverage: ["source"], gaps: [], attempts: 1,
  };
  const subject = fixture({
    createLead: () => ({ async run(input) {
      await input.report("Delegating", {
        stage: "delegate", tasks: [{ id: "write-1", role: "write", status: "running", attempt: 1 }],
      });
      ready.resolve();
      await release.promise;
      await input.report("Task complete", {
        stage: "delegate", taskId: "write-1", receipt,
        history: [{ role: "assistant", kind: "text", text: "final answer" }],
        usage: { turns: 2, total: 80 },
      });
      return { kind: "complete", summary: "done" };
    } }),
  });
  const handle = await subject.producer.start({ cwd });
  await ready.promise;
  const iterator = handle.events((await handle.view()).lastEventSequence)[Symbol.asyncIterator]();
  const next = iterator.next();
  release.resolve();
  assert.equal((await next).value.message, "Task complete");
  const inspected = await handle.inspect("write-1");
  assert.equal(inspected.receipt.status, "complete");
  assert.equal(inspected.history[0].text, "final answer");
  assert.deepEqual(inspected.usage, { turns: 2, total: 80 });
  await iterator.return();
  await handle.result();
});

test("late report after cancel cannot mutate terminal state or append events", async (t) => {
  const cwd = await temporaryWorkspace(t);
  const entered = deferred();
  const release = deferred();
  const lateDone = deferred();
  const subject = fixture({
    createLead: () => ({ async run(input) {
      entered.resolve();
      await release.promise;
      try {
        await input.report("Late task end", {
          stage: "delegate",
          taskId: "late-1",
          receipt: {
            id: "late-1", role: "write", status: "complete", summary: "too late",
            outputs: [], coverage: ["source"], gaps: [], attempts: 1,
          },
        });
      } catch (error) {
        lateDone.resolve(error);
      }
      return { kind: "complete", summary: "ignored" };
    } }),
  });
  const handle = await subject.producer.start({ cwd });
  await entered.promise;
  const cancelled = await handle.control("cancel");
  assert.equal(cancelled.status, "cancelled");
  const beforeEvents = [];
  for await (const event of handle.events()) beforeEvents.push(event);
  const before = await handle.view();

  release.resolve();
  const error = await lateDone.promise;
  assert.match(error.message, /immutable/);
  await new Promise((resolve) => setImmediate(resolve));
  const after = await handle.view();
  const afterEvents = [];
  for await (const event of handle.events()) afterEvents.push(event);
  assert.equal(after.status, "cancelled");
  assert.equal(after.lastEventSequence, before.lastEventSequence);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.deepEqual(afterEvents, beforeEvents);
  assert.equal(await handle.inspect("late-1"), undefined);
});
