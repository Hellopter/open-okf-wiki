import assert from "node:assert/strict";
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { openWikiRuns } from "../../wiki-runs.js";
import {
  blockingFreeze,
  context,
  freezeAndPlanExecutor,
  makeWorkspace,
  removeWorkspace,
  seedOpenPlanGate,
  succeededProbe,
  waitForTerminal,
} from "./harness.js";

test("cancel before the executor starts prevents its invocation", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let invocations = 0;
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: freezeAndPlanExecutor(async ({ workDir }) => {
      invocations += 1;
      return succeededProbe(workDir);
    }),
  });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-cancel-before-pi" },
    context(workspaceId),
  );
  await runs.dispatch(
    { type: "cancel_run", commandId: "cancel-before-pi", runId: receipt.runId },
    context(workspaceId),
  );
  assert.equal(invocations, 0);
  assert.equal((await runs.read({ runId: receipt.runId })).snapshot.state, "cancelled");
});

test("cancel aborts an executing Pi attempt and its late result cannot commit", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let started!: () => void;
  const startedAttempt = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: freezeAndPlanExecutor(async ({ workDir }, signal) => {
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await writeFile(path.join(workDir, "late-result.txt"), "too late\n", "utf8");
      return succeededProbe(workDir);
    }),
  });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-cancel" },
    context(workspaceId),
  );
  await startedAttempt;
  const cancelled = await runs.dispatch(
    { type: "cancel_run", commandId: "cancel-1", runId: receipt.runId },
    context(workspaceId),
  );
  assert.deepEqual(
    await runs.dispatch(
      { type: "cancel_run", commandId: "cancel-1", runId: receipt.runId },
      context(workspaceId),
    ),
    cancelled,
  );
  const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.attempts[0]?.state, "cancelled");
  assert.equal(snapshot.state, "cancelled");
  assert.equal(snapshot.nodes[0]?.state, "cancelled");
  assert.deepEqual(snapshot.nodes[0]?.outputs, []);
});

test("cancel aborts an active freeze and removes its unpinned run tree", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let started!: () => void;
  const startedFreeze = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runs = await openWikiRuns({
    rootPath: root,
    freezeRunBoundary: blockingFreeze(root, started),
  });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-cancel-freeze" },
    context(workspaceId),
  );
  await startedFreeze;
  await runs.dispatch(
    { type: "cancel_run", commandId: "cancel-freeze", runId: receipt.runId },
    context(workspaceId),
  );
  assert.equal((await runs.read({ runId: receipt.runId })).snapshot.state, "cancelled");
  await assert.rejects(() => lstat(path.join(root, ".okf-wiki", "runs", receipt.runId)), /ENOENT/);
});

test("terminal runs reject a new cancellation command", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-terminal-cancel" },
    context(workspaceId),
  );
  // Freeze advances to plan-ready (still active); cancel is allowed, then terminal.
  await waitForTerminal(runs, receipt.runId);
  await runs.dispatch(
    { type: "cancel_run", commandId: "cancel-after-freeze", runId: receipt.runId },
    context(workspaceId),
  );
  assert.equal((await runs.read({ runId: receipt.runId })).snapshot.state, "cancelled");
  await assert.rejects(
    () =>
      runs.dispatch(
        { type: "cancel_run", commandId: "cancel-terminal", runId: receipt.runId },
        context(workspaceId),
      ),
    /terminal state: cancelled/,
  );
});

test("CancelRun withdraws open gates", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-cancel-gate" },
    context(workspaceId),
  );
  await waitForTerminal(runs, receipt.runId);
  await runs.close();
  const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-cancel" });
  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  assert.equal((await reopened.read({ runId: receipt.runId })).snapshot.gates[0]?.state, "open");
  await reopened.dispatch(
    { type: "cancel_run", commandId: "cancel-with-gate", runId: receipt.runId },
    context(workspaceId),
  );
  const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.state, "cancelled");
  assert.equal(snapshot.gates.find((gate) => gate.gateId === gateId)?.state, "withdrawn");
  assert.equal(snapshot.gates[0]?.decision, null);
});
