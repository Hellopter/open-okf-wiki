import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  analysisDir,
  analysisReceiptsDir,
  RUNS_DIR_NAME,
  runRecordPath,
  runSkillDir,
  runsDir,
  runWorkDir,
  WORKSPACE_DIR_NAME,
} from "./run-layout.js";

test("WORKSPACE_DIR_NAME and RUNS_DIR_NAME are stable leaf names", () => {
  assert.equal(WORKSPACE_DIR_NAME, ".okf-wiki");
  assert.equal(RUNS_DIR_NAME, "runs");
});

const rootCases: Array<{ root: string; label: string }> = [
  { root: "/tmp/ws", label: "absolute posix" },
  { root: "/tmp/ws/../ws-b", label: "resolves .. segments" },
  { root: "relative-ws", label: "relative root resolves against cwd" },
];

for (const { root, label } of rootCases) {
  test(`runsDir builds meta runs path (${label})`, () => {
    const expected = path.join(path.resolve(root), WORKSPACE_DIR_NAME, RUNS_DIR_NAME);
    assert.equal(runsDir(root), expected);
  });
}

const runIdCases: Array<{ runId: string }> = [
  { runId: "run-1" },
  { runId: "abc.def_ghi-01" },
  { runId: "A1" },
];

for (const { runId } of runIdCases) {
  test(`run path builders nest under runsDir for ${runId}`, () => {
    const root = "/workspace/root";
    const work = runWorkDir(root, runId);
    assert.equal(work, path.join(runsDir(root), runId));
    assert.equal(runSkillDir(root, runId), path.join(work, "skill"));
    assert.equal(runRecordPath(root, runId), path.join(runsDir(root), `${runId}.json`));
    assert.equal(analysisDir(root, runId), path.join(work, "analysis"));
    assert.equal(analysisReceiptsDir(root, runId), path.join(work, "analysis", "receipts"));
  });
}

test("run path builders resolve root consistently", () => {
  const root = "/a/b/../c";
  const runId = "r1";
  const resolved = path.resolve(root);
  assert.equal(runWorkDir(root, runId), path.join(resolved, ".okf-wiki", "runs", runId));
  assert.equal(
    analysisReceiptsDir(root, runId),
    path.join(resolved, ".okf-wiki", "runs", runId, "analysis", "receipts"),
  );
});
