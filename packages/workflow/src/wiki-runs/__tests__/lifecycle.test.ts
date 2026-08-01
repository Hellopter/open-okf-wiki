import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { openWikiRuns, WorkflowInUseError } from "../../wiki-runs.js";
import {
  assertFreezeAdvancedToPlan,
  blockingFreeze,
  context,
  makeWorkspace,
  removeWorkspace,
  succeededPlan,
  waitForTerminal,
} from "./harness.js";

test("start receipt and replay are durable, and duplicate commands de-duplicate", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());

  const first = await runs.dispatch(
    {
      type: "start_run",
      commandId: "start-1",
      intent: { mode: "generate", focus: "Runtime seams" },
    },
    context(workspaceId),
  );
  const duplicate = await runs.dispatch(
    {
      type: "start_run",
      commandId: "start-1",
      intent: { mode: "generate", focus: "Runtime seams" },
    },
    context(workspaceId),
  );
  assert.deepEqual(duplicate, first);
  const finished = await waitForTerminal(runs, first.runId);
  assertFreezeAdvancedToPlan(finished.snapshot);
  assert.equal(finished.snapshot.intent?.mode, "generate");
  assert.equal(finished.snapshot.intent?.focus, "Runtime seams");
  assert.equal(finished.snapshot.schema, "okf.wiki-runs/v5");
  assert.equal(finished.snapshot.definitionVersion, 5);
  assert.ok(finished.events.some((event) => event.type === "inputs.pinned"));
  assert.ok(finished.events.some((event) => event.type === "node.ready"));
  assert.ok(finished.events.length >= 4);
  assert.equal(finished.cursor, finished.events.at(-1)?.eventId);
  for (const event of finished.events) {
    assert.equal(event.revision, event.snapshot.revision);
    assert.equal(event.runId, first.runId);
  }

  assert.deepEqual(
    await runs.dispatch(
      {
        type: "start_run",
        commandId: "start-1",
        intent: { mode: "generate", focus: "Runtime seams" },
      },
      { ...context(workspaceId), sessionId: "other" },
    ),
    first,
  );
  const mismatchedCommandRevision = (await runs.read({ runId: first.runId })).snapshot.revision;
  await assert.rejects(
    () =>
      runs.dispatch(
        {
          type: "cancel_run",
          commandId: "start-1",
          runId: first.runId,
          expectedRevision: mismatchedCommandRevision,
        },
        context(workspaceId),
      ),
    /different payload/,
  );
});

test("close waits for an aborted executor before releasing the owner lock", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let started!: () => void;
  const startedAttempt = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted!: () => void;
  const abortedAttempt = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      assert.equal(input.node.key, "plan");
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      aborted();
      await released;
      return succeededPlan(input);
    },
  });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "start-close-waits", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await startedAttempt;
  const closing = owner.close();
  await abortedAttempt;
  await assert.rejects(() => openWikiRuns({ rootPath: root }), WorkflowInUseError);
  release();
  await closing;
  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  assert.equal((await reopened.read({ runId: receipt.runId })).snapshot.state, "failed");
});

test("close aborts an active freeze and removes its unpinned run tree", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let started!: () => void;
  const startedFreeze = new Promise<void>((resolve) => {
    started = resolve;
  });
  const owner = await openWikiRuns({
    rootPath: root,
    freezeRunBoundary: blockingFreeze(root, started),
  });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "start-close-freeze", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await startedFreeze;
  await owner.close();
  await assert.rejects(() => lstat(path.join(root, ".okf-wiki", "runs", receipt.runId)), /ENOENT/);
});

test("snapshot, cursor, and incremental replay share every revision", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-read", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const terminal = await waitForTerminal(runs, receipt.runId);
  const replay = await runs.read({ runId: receipt.runId, afterEventId: 1 });
  assert.equal(replay.events[0]?.eventId, 2);
  assert.equal(replay.cursor, terminal.cursor);
  assert.equal(terminal.snapshot.revision, terminal.events.at(-1)?.revision);
});
