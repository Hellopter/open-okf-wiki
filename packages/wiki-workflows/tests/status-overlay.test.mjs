import assert from "node:assert/strict";
import test from "node:test";
import {
  frameWikiOverlay,
  initialWikiOverlayState,
  openWikiStatusOverlay,
  reduceWikiOverlay,
  selectedContextStats,
  selectedTaskId,
  wikiOverlayMaxHeight,
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

test("overlay render keeps the footer within Pi's maxHeight budget", async () => {
  for (const rows of [10, 20, 24]) {
    let component;
    let options;
    const view = {
      id: `run-${rows}`,
      cwd: "/repo",
      operation: "update",
      status: "running",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
      lastEventSequence: 1,
      progress: {
        stage: "delegate",
        tasks: Array.from({ length: 30 }, (_, index) => ({
          id: `t${index}`,
          role: "write",
          status: "pending",
        })),
      },
    };
    await openWikiStatusOverlay({
      ui: {
        async custom(factory, received) {
          options = received;
          component = await factory(
            { requestRender() {}, terminal: { rows } },
            { fg: (_color, text) => text },
            { matches: () => false },
            () => {},
          );
        },
      },
      handle: {
        async view() { return view; },
        async inspect() { return undefined; },
      },
    });

    const actualTuiBudget = Math.min(
      Math.floor((rows * Number.parseFloat(options.overlayOptions.maxHeight)) / 100),
      rows - options.overlayOptions.margin * 2,
    );
    const rendered = component.render(60);
    assert.equal(wikiOverlayMaxHeight(rows), actualTuiBudget);
    assert.ok(rendered.length <= actualTuiBudget, `${rows}-row terminal exceeded Pi maxHeight`);
    assert.match(rendered.at(-1) ?? "", /^└.*enter.*esc.*┘$/);
    component.dispose();
  }
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

test("overlay uses stable options, injected keybindings, and ignores stale inspection", async () => {
  let component;
  let options;
  let eventSignal;
  let renders = 0;
  const pending = new Map();
  const deferred = (id) => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    pending.set(id, { promise, resolve });
    return promise;
  };
  const view = {
    id: "run-1", cwd: "/repo", operation: "update", status: "running",
    createdAt: new Date(Date.now() - 65_000).toISOString(), updatedAt: new Date(Date.now() - 64_000).toISOString(), lastEventSequence: 1,
    progress: { stage: "delegate", tasks: [
      { id: "t1", role: "research", status: "running" },
      { id: "t2", role: "write", status: "running", activity: "responding", contextRecalculating: true },
    ] },
  };
  await openWikiStatusOverlay({
    ui: {
      async custom(factory, received) {
        options = received;
        component = await factory(
          { requestRender() { renders += 1; }, terminal: { rows: 20 } },
          { fg: (_color, text) => text },
          { matches: (data, binding) => (data === "CONFIRM" && binding === "tui.select.confirm")
            || (data === "CANCEL" && binding === "tui.select.cancel") },
          () => {},
        );
      },
    },
    handle: {
      async view() { return view; },
      async inspect(taskId) { return deferred(taskId); },
      async *events(_after, signal) {
        eventSignal = signal;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      },
    },
  });
  assert.equal(options.overlay, true);
  assert.equal(options.overlayOptions.minWidth, 36);
  assert.equal(options.overlayOptions.visible(35, 20), false);
  assert.equal(options.overlayOptions.visible(80, 20), true);

  component.handleInput("j");
  component.handleInput("CONFIRM");
  pending.get("t2").resolve({ runId: "run-1", task: { id: "t2", role: "write", status: "running", summary: "new" }, processAvailable: false });
  await new Promise((resolve) => setImmediate(resolve));
  pending.get("t1").resolve({ runId: "run-1", task: { id: "t1", role: "research", status: "running", summary: "stale" }, processAvailable: false });
  await new Promise((resolve) => setImmediate(resolve));

  const rendered = component.render(60).join("\n");
  assert.match(rendered, /new/);
  assert.doesNotMatch(rendered, /stale/);
  assert.match(rendered, /responding/);
  assert.match(rendered, /context recalculating/);
  component.handleInput("CANCEL");
  const runRendered = component.render(60).join("\n");
  assert.match(runRendered, /\[1m(?:5|6)s\]/);
  assert.ok(renders > 0);
  component.dispose();
  assert.equal(eventSignal.aborted, true);
});

test("live run projection wins over stale inspection usage", () => {
  const view = {
    id: "run-1", cwd: "/repo", operation: "update", status: "running",
    createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:01.000Z", lastEventSequence: 2,
    progress: { stage: "delegate", tasks: [
      { id: "t1", role: "write", status: "running", usage: { turns: 3, input: 300 } },
    ] },
  };
  const state = initialWikiOverlayState({ runId: "run-1", taskCount: 1 });
  const stale = { runId: "run-1", task: { id: "t1", role: "write", status: "running" }, usage: { turns: 1 }, processAvailable: true };
  assert.match(selectedContextStats(state, view, stale), /3 turns/);
});

test("overlay recovers after an inspection refresh fails", async () => {
  let component;
  let inspectCalls = 0;
  let emitEvent;
  let eventSignal;
  const eventReady = new Promise((resolve) => { emitEvent = resolve; });
  const view = {
    id: "run-1", cwd: "/repo", operation: "update", status: "running",
    createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:01.000Z", lastEventSequence: 1,
    progress: { stage: "delegate", tasks: [{ id: "t1", role: "write", status: "running" }] },
  };
  await openWikiStatusOverlay({
    initialTaskId: "t1",
    ui: {
      async custom(factory) {
        component = await factory(
          { requestRender() {}, terminal: { rows: 20 } },
          { fg: (_color, text) => text },
          { matches: () => false },
          () => {},
        );
      },
    },
    handle: {
      async view() { return view; },
      async inspect() {
        inspectCalls += 1;
        if (inspectCalls === 1) throw new Error("sidecar temporarily unavailable");
        return {
          runId: "run-1",
          task: { id: "t1", role: "write", status: "running", summary: "recovered" },
          processAvailable: false,
        };
      },
      async *events(_after, signal) {
        eventSignal = signal;
        await eventReady;
        yield { version: 1, runId: "run-1", sequence: 2, at: view.updatedAt, type: "telemetry", message: "updated" };
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(component.render(60).join("\n"), /warning  sidecar temporarily unavailable/);

  emitEvent();
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = component.render(60).join("\n");
  assert.match(recovered, /recovered/);
  assert.doesNotMatch(recovered, /warning/);
  assert.equal(inspectCalls, 2);
  component.dispose();
  assert.equal(eventSignal.aborted, true);
});

test("overlay timer recovers a terminal refresh without another event", async () => {
  let component;
  let viewCalls = 0;
  const running = {
    id: "run-1", cwd: "/repo", operation: "update", status: "running",
    createdAt: new Date(Date.now() - 2_000).toISOString(), updatedAt: new Date(Date.now() - 1_000).toISOString(),
    lastEventSequence: 1, progress: { stage: "publish" },
  };
  const terminal = {
    ...running,
    status: "succeeded",
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    lastEventSequence: 2,
  };
  await openWikiStatusOverlay({
    ui: {
      async custom(factory) {
        component = await factory(
          { requestRender() {}, terminal: { rows: 20 } },
          { fg: (_color, text) => text },
          { matches: () => false },
          () => {},
        );
      },
    },
    handle: {
      async view() {
        viewCalls += 1;
        if (viewCalls === 1) return running;
        if (viewCalls === 2) throw new Error("state briefly unavailable");
        return terminal;
      },
      async inspect() { return undefined; },
      async *events() {
        yield { version: 1, runId: "run-1", sequence: 2, at: terminal.updatedAt, type: "completed", message: "done" };
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(component.render(60).join("\n"), /warning  state briefly unavailable/);

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const recovered = component.render(60).join("\n");
  assert.match(recovered, /wiki run-1  succeeded/);
  assert.doesNotMatch(recovered, /warning/);
  assert.equal(viewCalls, 3);
  component.dispose();
});
