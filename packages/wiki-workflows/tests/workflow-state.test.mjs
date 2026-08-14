import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WikiWorkflowState } from "../dist/workflow-state.js";

test("workflow state persists before swapping memory and resumes the durable revision", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-workflow-state-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  let fail = true;
  const persist = async (location, content) => {
    if (fail) throw new Error("injected persistence failure");
    await mkdir(path.dirname(location), { recursive: true });
    await writeFile(location, content);
  };
  const state = await WikiWorkflowState.open(root, "run-1", { persist });
  await assert.rejects(state.beginWrite(), /injected persistence failure/);
  assert.equal(state.writeRevision, 0);
  fail = false;
  assert.equal(await state.beginWrite(), 1);
  const resumed = await WikiWorkflowState.open(root, "run-1");
  assert.equal(resumed.writeRevision, 1);
});

test("workflow state fails closed on malformed persisted reviews and rejects stale snapshots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-workflow-state-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const state = await WikiWorkflowState.open(root, "run-1");
  const captured = state.snapshot(1);
  await state.beginWrite();
  assert.equal(await state.acceptReview("review", captured, 1, { verdict: "pass", reviewedPaths: ["wiki/overview.md"], findings: [], profileCoverage: [] }), false);
  assert.throws(() => state.assertPublishable(1, ["wiki/overview.md"], []), /lacks passing independent review/);

  const location = path.join(root, ".okf-wiki", "runs", "bad", "workflow-state.json");
  await mkdir(path.dirname(location), { recursive: true });
  await writeFile(location, JSON.stringify({ version: 1, compactionObserved: false, writeRevision: 0, reviews: [{ verdict: "pass" }] }));
  await assert.rejects(WikiWorkflowState.open(root, "bad"), /Invalid Wiki workflow review state/);
  assert.match(await readFile(location, "utf8"), /"pass"/);
});
