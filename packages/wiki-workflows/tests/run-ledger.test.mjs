import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiRunLedger } from "../dist/run-ledger.js";

test("ledger atomically persists version 1 state and ordered JSONL events", async (t) => {
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

test("progress persists through update/read and task sidecars round-trip", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "update", at: "2026-01-01T00:00:00.000Z" });
  assert.equal((await ledger.read("run-1")).progress, undefined);

  const progress = {
    stage: "delegate",
    batch: 2,
    completed: 1,
    total: 3,
    lastMessage: "writing",
    tasks: [{ id: "write-1", role: "write", status: "running", summary: "page", attempts: 1 }],
  };
  await ledger.update("run-1", (state) => ({ ...state, progress }));
  assert.deepEqual((await ledger.read("run-1")).progress, progress);

  const record = {
    receipt: {
      id: "write-1",
      role: "write",
      status: "complete",
      summary: "wrote page",
      outputs: [],
      coverage: ["source"],
      gaps: [],
      attempts: 1,
    },
    history: [{ role: "assistant", kind: "text", text: "drafted" }],
    updatedAt: "2026-01-01T00:00:03.000Z",
  };
  await ledger.writeTask("run-1", "write-1", record);
  assert.deepEqual(await ledger.readTask("run-1", "write-1"), record);
  assert.equal(await ledger.readTask("run-1", "missing"), undefined);
  const sidecar = JSON.parse(await readFile(path.join(root, "runs", "run-1", "tasks", "write-1.json"), "utf8"));
  assert.deepEqual(sidecar, record);
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

test("terminal state rejects mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "regenerate", at: "2026-01-01T00:00:00.000Z" });
  await ledger.update("run-1", (state) => ({ ...state, status: "cancelled" }));
  await assert.rejects(ledger.update("run-1", (state) => state), /immutable/);
});
