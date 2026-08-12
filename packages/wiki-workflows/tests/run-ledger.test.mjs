import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("terminal state rejects mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-ledger-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const ledger = createWikiRunLedger(root);
  await ledger.create({ id: "run-1", cwd: root, operation: "regenerate", at: "2026-01-01T00:00:00.000Z" });
  await ledger.update("run-1", (state) => ({ ...state, status: "cancelled" }));
  await assert.rejects(ledger.update("run-1", (state) => state), /immutable/);
});
