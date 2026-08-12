import assert from "node:assert/strict";
import test from "node:test";
import {
  initialWikiOverlayState,
  openWikiStatusOverlay,
  reduceWikiOverlay,
} from "../dist/ui/status-overlay.js";

const ctx = { taskCount: 3, taskIds: ["t1", "t2", "t3"] };

test("initial without task starts on the run card", () => {
  const state = initialWikiOverlayState({ runId: "run-1", taskCount: 3 });
  assert.equal(state.kind, "run");
  assert.equal(state.runId, "run-1");
  assert.equal(state.cursor, 0);
  assert.equal(state.scroll, 0);
  assert.equal(state.tailing, false);
  assert.equal(state.taskId, undefined);
});

test("initialTaskId starts on the task result", () => {
  const state = initialWikiOverlayState({ runId: "run-1", taskCount: 3, initialTaskId: "t2" });
  assert.equal(state.kind, "task");
  assert.equal(state.taskId, "t2");
});

test("process true starts on the process pager", () => {
  const state = initialWikiOverlayState({
    runId: "run-1",
    taskCount: 3,
    initialTaskId: "t2",
    process: true,
  });
  assert.equal(state.kind, "process");
  assert.equal(state.taskId, "t2");
});

test("enter from run selects taskIds[cursor]", () => {
  let state = initialWikiOverlayState({ runId: "run-1", taskCount: 3 });
  state = reduceWikiOverlay(state, { type: "enter" }, ctx);
  assert.equal(state.kind, "task");
  assert.equal(state.taskId, "t1");

  state = initialWikiOverlayState({ runId: "run-1", taskCount: 3 });
  state = reduceWikiOverlay(state, { type: "down" }, ctx);
  state = reduceWikiOverlay(state, { type: "enter" }, ctx);
  assert.equal(state.kind, "task");
  assert.equal(state.taskId, "t2");
});

test("back from process returns to task then run", () => {
  let state = initialWikiOverlayState({
    runId: "run-1",
    taskCount: 3,
    initialTaskId: "t2",
    process: true,
  });
  state = reduceWikiOverlay(state, { type: "back" }, ctx);
  assert.equal(state.kind, "task");
  assert.equal(state.taskId, "t2");
  state = reduceWikiOverlay(state, { type: "back" }, ctx);
  assert.equal(state.kind, "run");
});

test("up/down cursor clamps within tasks", () => {
  let state = initialWikiOverlayState({ runId: "run-1", taskCount: 3 });
  state = reduceWikiOverlay(state, { type: "up" }, ctx);
  assert.equal(state.cursor, 0);
  state = reduceWikiOverlay(state, { type: "down" }, ctx);
  assert.equal(state.cursor, 1);
  state = reduceWikiOverlay(state, { type: "down" }, ctx);
  state = reduceWikiOverlay(state, { type: "down" }, ctx);
  state = reduceWikiOverlay(state, { type: "down" }, ctx);
  assert.equal(state.cursor, 2);
});

test("toggleTail sets tailing on the process pager", () => {
  let state = initialWikiOverlayState({
    runId: "run-1",
    taskCount: 3,
    initialTaskId: "t1",
    process: true,
  });
  state = reduceWikiOverlay(state, { type: "toggleTail" }, ctx);
  assert.equal(state.tailing, true);
});

test("openWikiStatusOverlay resolves when ui.custom is missing", async () => {
  await openWikiStatusOverlay({
    ui: {},
    handle: {
      view: async () => {
        throw new Error("view should not run without custom UI");
      },
      inspect: async () => undefined,
    },
  });
});
