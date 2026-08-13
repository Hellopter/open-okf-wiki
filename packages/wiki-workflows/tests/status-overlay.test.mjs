import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { frameWikiOverlay, initialWikiOverlayState, openWikiStatusOverlay, reduceWikiOverlay, wikiOverlayMaxHeight } from "../dist/ui/status-overlay.js";

const lead = {
  target: { kind: "lead" }, role: "lead", status: "running", attempt: 1, activity: "synthesizing",
  health: "healthy",
  activeTools: [{ id: "r1", name: "read", startedAt: "2026-08-12T00:00:00Z" }],
  lastActivityAt: "2026-08-12T00:00:01Z", lastHeartbeatAt: "2026-08-12T00:00:02Z",
  usage: { turns: 8, contextPercent: 24 },
};
const view = {
  id: "run-1", cwd: "/repo", operation: "update", status: "running",
  createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:03Z", lastEventSequence: 2,
  progress: { stage: "lead", language: "en", lead, currentBatch: { batch: 2, status: "running", completed: 0, total: 1, tasks: [{ id: "write-auth", role: "write", status: "running" }] } },
};

function inspection(target = { kind: "lead" }, summary = "current") {
  return { runId: view.id, agent: target.kind === "lead" ? { ...lead, summary } : { ...lead, target, role: "write", summary }, process: [] };
}

function handle(overrides = {}) {
  return {
    async view() { return view; },
    async inspectAgent(target) { return inspection(target); },
    async activity() { return { entries: [], nextBefore: undefined }; },
    async *events(_after, signal) { if (signal) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); },
    ...overrides,
  };
}

async function componentFor(runHandle = handle(), rows = 24, initialTarget) {
  let component;
  let options;
  await openWikiStatusOverlay({
    initialTarget,
    ui: { async custom(factory, received) { options = received; component = await factory({ requestRender() {}, terminal: { rows } }, { fg: (_color, text) => text }, { matches: (data, binding) => data === "CONFIRM" && binding === "tui.select.confirm" }, () => {}); } },
    handle: runHandle,
  });
  return { component, options };
}

test("state reducer only models run, agent, and activity concerns", () => {
  let state = initialWikiOverlayState({ runId: "run-1" });
  assert.equal(state.kind, "run");
  state = reduceWikiOverlay(state, { type: "down" }, 3);
  assert.equal(state.cursor, 1);
  state = { ...state, kind: "agent", target: { kind: "lead" } };
  state = reduceWikiOverlay(state, { type: "tab", direction: 1 }, 3);
  assert.equal(state.tab, "process");
  state = reduceWikiOverlay(state, { type: "back" }, 3);
  assert.equal(state.kind, "run");
});

test("overlay frame is bounded by Pi viewport", () => {
  const framed = frameWikiOverlay({ width: 40, title: "wiki run-1", body: ["◆ Leader"], stats: "8 turns", footer: "esc", viewport: 8 });
  assert.match(framed.lines[0], /^┌.*┐$/);
  assert.match(framed.lines.at(-1), /^└.*┘$/);
  assert.ok(framed.lines.every((line) => visibleWidth(line) <= 40));
  for (const rows of [10, 20, 24]) assert.ok(wikiOverlayMaxHeight(rows) <= rows - 2);
});

test("workbench switches to two columns at 100 and never overflows", async () => {
  const { component } = await componentFor();
  for (const width of [44, 80, 99, 100, 120, 160]) {
    const rendered = component.render(width);
    assert.ok(rendered.length <= wikiOverlayMaxHeight(24));
    assert.ok(rendered.every((line) => visibleWidth(line) <= width));
    assert.match(rendered.join("\n"), /◆ Lead/);
    if (width >= 100) assert.match(rendered.join("\n"), /│.*Leader.*│.*Overview/);
  }
  component.dispose();
});

test("stale agent inspection cannot replace the selected agent", async () => {
  const pending = new Map();
  const deferred = (target) => new Promise((resolve) => pending.set(JSON.stringify(target), resolve));
  const subject = handle({ async inspectAgent(target) { return await deferred(target); } });
  const { component } = await componentFor(subject);
  component.handleInput("j");
  component.handleInput("CONFIRM");
  pending.get(JSON.stringify({ kind: "task", batch: 2, taskId: "write-auth" }))(inspection({ kind: "task", batch: 2, taskId: "write-auth" }, "new"));
  await new Promise((resolve) => setImmediate(resolve));
  pending.get(JSON.stringify({ kind: "lead" }))(inspection({ kind: "lead" }, "stale"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(component.render(80).join("\n"), /new/);
  assert.doesNotMatch(component.render(80).join("\n"), /stale/);
  component.dispose();
});

test("switching targets clears old inspection while the new request is pending", async () => {
  const pending = new Map();
  const subject = handle({
    async inspectAgent(target) { return await new Promise((resolve) => pending.set(JSON.stringify(target), resolve)); },
  });
  const { component } = await componentFor(subject);
  const oldLeader = inspection({ kind: "lead" }, "old leader summary");
  oldLeader.agent.health = "degraded";
  pending.get(JSON.stringify({ kind: "lead" }))(oldLeader);
  await new Promise((resolve) => setImmediate(resolve));
  const oldRendered = component.render(120).join("\n");
  assert.match(oldRendered, /old leader summary/);
  assert.match(oldRendered, /observability degraded/);

  component.handleInput("j");
  await new Promise((resolve) => setImmediate(resolve));
  const pendingWide = component.render(120).join("\n");
  assert.doesNotMatch(pendingWide, /old leader summary/);
  assert.doesNotMatch(pendingWide, /observability degraded/);
  assert.match(pendingWide, /Agent details are not available/);

  component.handleInput("CONFIRM");
  const pendingNarrow = component.render(80).join("\n");
  assert.doesNotMatch(pendingNarrow, /old leader summary/);
  assert.match(pendingNarrow, /Agent details are not available/);
  component.dispose();
});

test("activity loads 50, pages older entries, deduplicates cursor, and filters", async () => {
  const calls = [];
  const pages = [
    { entries: [{ sequence: 5, at: "2026-08-12T00:00:05Z", kind: "agent", severity: "info", target: { kind: "lead" }, message: "latest" }], nextBefore: 5 },
    { entries: [{ sequence: 5, at: "2026-08-12T00:00:05Z", kind: "agent", severity: "info", target: { kind: "lead" }, message: "duplicate" }, { sequence: 4, at: "2026-08-12T00:00:04Z", kind: "failure", severity: "error", target: { kind: "task", batch: 2, taskId: "write-auth" }, message: "older" }], nextBefore: undefined },
  ];
  const subject = handle({ async activity(options) { calls.push(options); return pages.shift() ?? { entries: [], nextBefore: undefined }; } });
  const { component } = await componentFor(subject);
  component.handleInput("j");
  component.handleInput("j");
  component.handleInput("CONFIRM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].limit, 50);
  assert.match(component.render(80).join("\n"), /latest/);
  component.handleInput("l");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[1].before, 5);
  const rendered = component.render(80).join("\n");
  assert.equal((rendered.match(/latest|duplicate/g) ?? []).length, 1);
  assert.match(rendered, /older/);
  component.handleInput("f");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1).actor, { kind: "lead" });
  component.dispose();
});

test("cancel uses confirmation and does not fire when rejected", async () => {
  let controlled = 0;
  let component;
  await openWikiStatusOverlay({
    ui: { async custom(factory) { component = await factory({ requestRender() {}, terminal: { rows: 20 } }, { fg: (_color, text) => text }, { matches: () => false }, () => {}); } },
    handle: handle(), confirmCancel: async () => false, onControl: async () => { controlled += 1; },
  });
  component.handleInput("x");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controlled, 0);
  component.dispose();
});

test("selected agent reads health directly and ordinary warnings do not degrade it", async () => {
  const warnings = Array.from({ length: 25 }, (_, index) => ({ sequence: index + 1, at: "2026-08-12T00:00:01Z", kind: "warning", severity: "warning", target: { kind: "lead" }, message: `ordinary warning ${index}` }));
  let currentLead = { ...lead, health: "degraded" };
  const subject = handle({
    async view() { return { ...view, progress: { ...view.progress, lead: currentLead, recentActivity: warnings } }; },
    async inspectAgent() { return { ...inspection({ kind: "lead" }, "current"), agent: currentLead }; },
  });
  const { component } = await componentFor(subject, 24, { kind: "lead" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(component.render(80).join("\n"), /warning  observability degraded/);
  component.dispose();
  currentLead = { ...lead, health: "healthy" };
  const recovered = await componentFor(subject, 24, { kind: "lead" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(recovered.component.render(80).join("\n"), /observability degraded/);
  recovered.component.dispose();
});

test("prepare stage always selects a leader navigation target before inspection exists", async () => {
  const preparing = { ...view, progress: { stage: "prepare", language: "en" } };
  const { component } = await componentFor(handle({ async view() { return preparing; }, async inspectAgent() { return undefined; } }));
  await new Promise((resolve) => setImmediate(resolve));
  const rendered = component.render(120).join("\n");
  assert.match(rendered, /> ◆ Leader  starting/);
  assert.match(rendered, /Leader starting\. Agent details are not available\./);
  component.dispose();
});

test("collapsed history tasks never create invisible cursor targets", async () => {
  const history = { batch: 1, status: "complete", completed: 1, total: 1, tasks: [{ id: "old", role: "review", status: "complete" }] };
  const current = { batch: 2, status: "running", completed: 0, total: 1, tasks: [{ id: "current", role: "write", status: "running" }] };
  const withHistory = { ...view, progress: { ...view.progress, currentBatch: current, batches: [history, current] } };
  for (const width of [80, 120]) {
    const inspected = [];
    const subject = handle({
      async view() { return withHistory; },
      async inspectAgent(target) { inspected.push(target); return inspection(target); },
    });
    const { component } = await componentFor(subject);
    await new Promise((resolve) => setImmediate(resolve));
    component.handleInput("j");
    await new Promise((resolve) => setImmediate(resolve));
    const navigation = component.render(width).join("\n");
    assert.equal((navigation.match(/> /g) ?? []).length, 1);
    assert.match(navigation, />   ◆ write  current/);
    assert.doesNotMatch(navigation, /review  old/);
    component.handleInput("CONFIRM");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(inspected.at(-1), { kind: "task", batch: 2, taskId: "current" });
    component.dispose();
  }
});

test("missing custom UI returns without reading the handle", async () => {
  await openWikiStatusOverlay({ ui: {}, handle: handle({ async view() { throw new Error("must not run"); } }) });
});
