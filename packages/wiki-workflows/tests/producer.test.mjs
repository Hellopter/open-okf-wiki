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
  const first = fixture({ createLead: () => ({ async run() { await gate.promise; return { kind: "complete", summary: "done" }; } }) });
  const original = await first.producer.start({ cwd });
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
