import assert from "node:assert/strict";
import test from "node:test";
import {
  frameWikiOverlay,
  initialWikiOverlayState,
  openWikiStatusOverlay,
  reduceWikiOverlay,
  selectedContextStats,
  selectedTaskId,
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

test("run-card cursor selects a task id for context stats", () => {
  let state = initialWikiOverlayState({ runId: "run-1", taskCount: 3 });
  assert.equal(selectedTaskId(state, ctx.taskIds), "t1");
  state = reduceWikiOverlay(state, { type: "down" }, ctx);
  assert.equal(selectedTaskId(state, ctx.taskIds), "t2");
});

test("selected context stats come from the highlighted task", () => {
  const view = {
    id: "run-1",
    cwd: "/repo",
    operation: "update",
    status: "running",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    lastEventSequence: 1,
    progress: {
      stage: "delegate",
      tasks: [
        { id: "t1", role: "research", status: "complete", usage: { turns: 2, input: 100, output: 20 } },
        { id: "t2", role: "write", status: "running" },
      ],
    },
  };
  const state = initialWikiOverlayState({ runId: "run-1", taskCount: 2 });
  assert.match(selectedContextStats(state, view, undefined) ?? "", /2 turns  ↑100  ↓20/);
});

test("overlay frame draws a box and a context strip", () => {
  const framed = frameWikiOverlay({
    width: 40,
    title: "wiki run-1  running",
    body: ["  ◆ write  pages/auth.md"],
    stats: "3 turns  ↑1.2k  ↓620  ctx 8.1k/200k 4%",
    footer: "esc close",
    viewport: 8,
  });
  assert.match(framed.lines[0], /^┌.*┐$/);
  assert.match(framed.lines.at(-1) ?? "", /^└.*┘$/);
  assert.ok(framed.lines.some((line) => line.includes("context")));
  assert.ok(framed.lines.some((line) => line.includes("3 turns")));
  assert.ok(framed.lines.every((line) => line.startsWith("┌") || line.startsWith("│") || line.startsWith("├") || line.startsWith("└")));
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
