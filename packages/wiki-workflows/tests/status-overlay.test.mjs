import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatLocalTime } from "../dist/time-format.js";
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

async function componentFor(runHandle = handle(), rows = 24, initialTarget, theme = { fg: (_color, text) => text }, overlay = {}) {
  let component;
  let options;
  await openWikiStatusOverlay({
    initialTarget,
    ui: { async custom(factory, received) { options = received; component = await factory({ requestRender() {}, terminal: { rows } }, theme, { matches: (data, binding) => ({ "\u001b[A": "tui.select.up", "\u001b[B": "tui.select.down", CONFIRM: "tui.select.confirm", PAGE_DOWN: "tui.select.pageDown", PAGE_UP: "tui.select.pageUp" })[data] === binding }, () => {}); } },
    handle: runHandle,
    ...overlay,
  });
  return { component, options };
}

function recordingTheme(capabilities = "full") {
  const calls = [];
  const wrap = (method) => (tokenOrText, maybeText) => {
    const token = maybeText === undefined ? undefined : tokenOrText;
    const value = maybeText === undefined ? tokenOrText : maybeText;
    calls.push({ method, token, text: String(value) });
    return `\u001b[1m${String(value)}\u001b[0m`;
  };
  const theme = capabilities === "none" ? undefined : { fg: wrap("fg") };
  if (capabilities === "full") Object.assign(theme, { bg: wrap("bg"), bold: wrap("bold") });
  return { theme, calls };
}

function plain(value) {
  return value.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function dividerCoordinates(lines) {
  return lines.flatMap((line, row) => {
    const text = plain(line);
    const index = text.indexOf(" │ ");
    return index < 0 ? [] : [{ row, column: visibleWidth(text.slice(0, index)) + 1 }];
  });
}

function callFor(calls, token, pattern) {
  return calls.some((call) => call.token === token && pattern.test(call.text));
}

test("state reducer only models run, agent, and activity concerns", () => {
  let state = initialWikiOverlayState({ runId: "run-1" });
  assert.equal(state.kind, "run");
  state = reduceWikiOverlay(state, { type: "down" }, 3);
  assert.equal(state.cursor, 1);
  state = { ...state, kind: "agent", target: { kind: "lead" } };
  state = reduceWikiOverlay(state, { type: "forward" }, 3);
  assert.equal(state.tab, "process");
  state = reduceWikiOverlay(state, { type: "back" }, 3);
  assert.equal(state.kind, "agent");
  assert.equal(state.tab, "overview");
  state = reduceWikiOverlay(state, { type: "back" }, 3);
  assert.equal(state.kind, "run");
  state = { ...state, kind: "agent", target: { kind: "lead" }, fromBottom: 0 };
  state = reduceWikiOverlay(state, { type: "up" }, 3);
  assert.equal(state.fromBottom, 1);
  state = reduceWikiOverlay(state, { type: "down" }, 3);
  assert.equal(state.fromBottom, 0);
  state = reduceWikiOverlay(state, { type: "down" }, 3);
  assert.equal(state.fromBottom, 0);
  state = reduceWikiOverlay({ ...state, tab: "overview" }, { type: "forward" }, 3);
  assert.equal(state.tab, "process");
  state = reduceWikiOverlay(state, { type: "back" }, 3);
  assert.equal(state.kind, "agent");
  assert.equal(state.tab, "overview");
});

test("up arrow leaves the bottom after overscrolling or tailing", async () => {
  const process = Array.from({ length: 40 }, (_, index) => ({
    sequence: index,
    at: "2026-08-12T00:00:00.000Z",
    kind: "tool",
    severity: "info",
    message: "",
    toolName: `tool-${index}`,
    summary: `file-${index}.ts`,
    completed: true,
  }));
  const { component } = await componentFor(handle({
    async inspectAgent(target) { return { ...inspection(target), process }; },
  }), 16, { kind: "lead" }, { fg: (_color, text) => text }, { process: true });
  await new Promise((resolve) => setImmediate(resolve));
  component.render(80);
  for (let index = 0; index < 80; index += 1) component.handleInput("\u001b[B");
  assert.match(plain(component.render(80).join("\n")), /tool-39/);
  component.handleInput("\u001b[A");
  assert.doesNotMatch(plain(component.render(80).join("\n")), /tool-39/);
  component.handleInput("t");
  assert.match(plain(component.render(80).join("\n")), /tool-39/);
  component.handleInput("\u001b[A");
  const stepped = plain(component.render(80).join("\n"));
  assert.doesNotMatch(stepped, /tool-39/);
  assert.match(stepped, /tool-3[0-8]/);
  component.dispose();
});

test("left and right arrows enter, switch pages, and exit without tab", async () => {
  const { component } = await componentFor();
  component.handleInput("\u001b[C");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(plain(component.render(80).join("\n")), /\[Overview\]/);
  component.handleInput("\u001b[C");
  assert.match(plain(component.render(80).join("\n")), /\[Process\]/);
  component.handleInput("\u001b[C");
  assert.match(plain(component.render(80).join("\n")), /\[Output\]/);
  component.handleInput("\u001b[D");
  assert.match(plain(component.render(80).join("\n")), /\[Process\]/);
  component.handleInput("\u001b[D");
  assert.match(plain(component.render(80).join("\n")), /\[Overview\]/);
  component.handleInput("\u001b[D");
  const runPage = plain(component.render(80).join("\n"));
  assert.match(runPage, /Leader/);
  assert.doesNotMatch(runPage, /\[Overview\]/);
  component.dispose();
});

test("overlay frame is bounded by Pi viewport", () => {
  const framed = frameWikiOverlay({ width: 40, title: "wiki run-1", body: ["◆ Leader"], stats: "8 turns", footer: "esc", viewport: 8 });
  assert.match(framed.lines[0], /^╭.*╮$/);
  assert.match(framed.lines.at(-1), /^╰.*╯$/);
  assert.match(framed.lines.join("\n"), /^├.*context.*┤$/m);
  assert.ok(framed.lines.every((line) => visibleWidth(line) <= 40));
  for (const rows of [10, 20, 24]) assert.ok(wikiOverlayMaxHeight(rows) <= rows - 2);
});

test("title status reset re-enters the border color before the top rule", () => {
  const codes = { border: 90, error: 31 };
  const theme = { fg: (token, text) => `\u001b[${codes[token]}m${text}\u001b[39m` };
  const status = theme.fg("error", "failed");
  const [top] = frameWikiOverlay({ width: 40, title: `wiki run-1  ${status}`, body: [], footer: "esc", theme, viewport: 8 }).lines;

  assert.match(top, /\u001b\[31mfailed\u001b\[39m/, "status keeps its semantic color");
  assert.match(top, /failed\u001b\[39m\u001b\[90m \u001b\[39m\u001b\[90m─/, "rule explicitly re-enters border after the status reset");
  assert.doesNotMatch(top, /\u001b\[90mwiki/, "title prefix is not wrapped in border color");
  assert.equal(visibleWidth(top), 40);
});

test("frame renders with no theme, fg-only theme, and a full theme", () => {
  for (const capabilities of ["none", "fg", "full"]) {
    const { theme, calls } = recordingTheme(capabilities);
    const framed = frameWikiOverlay({ width: 40, title: "wiki run-1", body: ["◆ Leader"], stats: "8 turns", footer: "esc", viewport: 8, theme });
    assert.equal(plain(framed.lines[0]).at(0), "╭");
    assert.ok(framed.lines.every((line) => visibleWidth(line) === 40));
    if (capabilities !== "none") assert.ok(callFor(calls, "border", /[╭╮╰╯│]/));
    if (capabilities === "full") assert.ok(callFor(calls, "borderMuted", /[├┤─]/));
  }
});

test("terminal row changes invalidate same-width frame geometry", async () => {
  const terminal = { rows: 24 };
  let component;
  const terminalView = { ...view, status: "succeeded", completedAt: "2026-08-12T00:00:04Z" };
  await openWikiStatusOverlay({
    ui: {
      async custom(factory) {
        component = await factory(
          { requestRender() {}, terminal },
          { fg: (_color, text) => text },
          { matches: (data, binding) => data === "CONFIRM" && binding === "tui.select.confirm" },
          () => {},
        );
      },
    },
    handle: handle({ async view() { return terminalView; } }),
  });

  const assertCompleteFrame = (rendered, rows) => {
    assert.equal(rendered.length, wikiOverlayMaxHeight(rows));
    assert.match(plain(rendered.join("\n")), /context/);
    assert.match(plain(rendered.at(-1)), /select.*open.*esc/i);
    assert.match(plain(rendered.at(-1)), /^╰.*╯$/);
  };
  assertCompleteFrame(component.render(80), 24);
  terminal.rows = 12;
  assertCompleteFrame(component.render(80), 12);
  terminal.rows = 30;
  assertCompleteFrame(component.render(80), 30);
  component.dispose();
});

test("workbench switches at 100 columns, fixes the divider, and never overflows", async () => {
  const { component } = await componentFor();
  for (const width of [44, 80, 99]) {
    const rendered = component.render(width);
    assert.ok(rendered.length <= wikiOverlayMaxHeight(24));
    assert.ok(rendered.every((line) => visibleWidth(line) <= width));
    assert.match(rendered.join("\n"), /◆ Lead/);
    assert.deepEqual(dividerCoordinates(rendered), []);
  }
  let expectedColumn;
  for (const width of [100, 120, 160]) {
    const rendered = component.render(width);
    assert.ok(rendered.length <= wikiOverlayMaxHeight(24));
    assert.ok(rendered.every((line) => visibleWidth(line) <= width));
    assert.match(plain(rendered.join("\n")), /Leader.*Overview/s);
    const coordinates = dividerCoordinates(rendered);
    assert.ok(coordinates.length >= 5, `expected a full-height divider at width ${width}`);
    assert.equal(new Set(coordinates.map(({ column }) => column)).size, 1);
    expectedColumn ??= coordinates[0].column;
    assert.equal(coordinates[0].column, expectedColumn);
  }
  component.dispose();
});

test("loading, loaded inspection, context, and health keep the frame geometry stable", async () => {
  let resolveInspection;
  const pending = new Promise((resolve) => { resolveInspection = resolve; });
  const subject = handle({ async inspectAgent() { return await pending; } });
  const { component } = await componentFor(subject);
  const loading = component.render(120);
  resolveInspection(inspection());
  await new Promise((resolve) => setImmediate(resolve));
  const loaded = component.render(120);
  assert.equal(loaded.length, loading.length);
  assert.deepEqual(dividerCoordinates(loaded), dividerCoordinates(loading));
  component.dispose();

  for (const agent of [{ ...lead, usage: undefined }, { ...lead, health: "degraded" }]) {
    const variant = await componentFor(handle({
      async view() { return { ...view, progress: { ...view.progress, lead: agent } }; },
      async inspectAgent() { return { ...inspection(), agent }; },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    const rendered = variant.component.render(120);
    assert.equal(rendered.length, loading.length);
    assert.deepEqual(dividerCoordinates(rendered), dividerCoordinates(loading));
    variant.component.dispose();
  }
});

test("theme records semantic status, navigation, chrome, and context threshold tokens", async () => {
  const mixedBatch = { ...view.progress.currentBatch, total: 4, tasks: [
    { id: "running", role: "write", status: "running" },
    { id: "waiting", role: "review", status: "queued" },
    { id: "partial", role: "write", status: "incomplete" },
    { id: "failed", role: "review", status: "failed" },
  ] };
  const semanticView = {
    ...view,
    progress: {
      ...view.progress,
      batches: [{ batch: 1, status: "complete", completed: 1, total: 1, tasks: [{ id: "done", role: "review", status: "complete" }] }, mixedBatch],
      currentBatch: mixedBatch,
    },
  };
  const { theme, calls } = recordingTheme();
  const { component } = await componentFor(handle({ async view() { return semanticView; } }), 24, undefined, theme);
  component.render(120);
  assert.ok(callFor(calls, "accent", /Lead|Leader|running/));
  assert.ok(callFor(calls, "success", /✓|complete/));
  assert.ok(callFor(calls, "warning", /◐|incomplete|partial/));
  assert.ok(callFor(calls, "error", /✗|failed/));
  assert.ok(callFor(calls, "dim", /○|queued|attempt|\d+s/));
  assert.ok(callFor(calls, "muted", /Batch|context|turn|select|esc/i));
  assert.ok(callFor(calls, "border", /[╭╮╰╯│]/));
  assert.ok(callFor(calls, "borderMuted", /[├┤─]/));
  assert.ok(callFor(calls, "selectedBg", />.*Leader/));
  assert.ok(calls.some((call) => call.method === "bold"));
  component.dispose();

  for (const [contextPercent, expected] of [[70, undefined], [71, "warning"], [91, "error"]]) {
    const recorded = recordingTheme();
    const agent = { ...lead, usage: { turns: 8, contextPercent } };
    const variant = await componentFor(handle({
      async view() { return { ...view, progress: { ...view.progress, lead: agent } }; },
      async inspectAgent() { return { ...inspection(), agent }; },
    }), 24, { kind: "lead" }, recorded.theme);
    await new Promise((resolve) => setImmediate(resolve));
    variant.component.render(80);
    const percentCalls = recorded.calls.filter((call) => call.text.includes(`${contextPercent}%`));
    assert.ok(percentCalls.length > 0, `expected ${contextPercent}% to be themed`);
    if (expected) assert.ok(percentCalls.some((call) => call.token === expected));
    else assert.ok(percentCalls.every((call) => !["warning", "error"].includes(call.token)));
    variant.component.dispose();
  }
});

test("footers expose only actions available on the current page", async () => {
  const { component } = await componentFor();
  const runFooter = plain(component.render(80).at(-1));
  assert.match(runFooter, /select.*open.*close.*pause.*cancel.*esc/i);
  assert.doesNotMatch(runFooter, /tab|older|tail/i);

  component.handleInput("CONFIRM");
  await new Promise((resolve) => setImmediate(resolve));
  const agentFooter = plain(component.render(80).at(-1));
  assert.match(agentFooter, /scroll.*pages.*tail/i);
  assert.doesNotMatch(agentFooter, /select|pause|cancel|older|tab/i);

  component.handleInput("\u001b[D");
  component.handleInput("j");
  component.handleInput("j");
  component.handleInput("CONFIRM");
  await new Promise((resolve) => setImmediate(resolve));
  const activityFooter = plain(component.render(80).at(-1));
  assert.match(activityFooter, /scroll.*filter.*older.*tail.*back/i);
  assert.doesNotMatch(activityFooter, /select|pause|cancel|tab/i);
  component.dispose();
});

test("long task ids and Chinese content remain within every rendered width", async () => {
  const longId = `身份认证-${"很长".repeat(80)}`;
  const localized = {
    ...view,
    progress: {
      ...view.progress,
      language: "zh",
      currentBatch: { batch: 2, status: "running", completed: 0, total: 1, tasks: [{ id: longId, role: "write", status: "running" }] },
    },
  };
  const { theme } = recordingTheme();
  const { component } = await componentFor(handle({ async view() { return localized; } }), 24, undefined, theme);
  for (const width of [36, 44, 80, 100, 120, 160]) {
    const rendered = component.render(width);
    assert.ok(rendered.some((line) => line.includes("\u001b[")), `expected ANSI styling at width ${width}`);
    assert.ok(rendered.every((line) => visibleWidth(line) <= width), `overflow at width ${width}`);
  }
  component.dispose();
});

test("small viewports keep the selected target visible and Enter opens that target", async () => {
  const tasks = Array.from({ length: 18 }, (_, index) => ({ id: `task-${index + 1}`, role: index % 2 ? "review" : "write", status: "running" }));
  const batches = [
    { batch: 1, status: "complete", completed: 1, total: 1, tasks: [{ id: "hidden", role: "review", status: "complete" }] },
    { batch: 2, status: "partial", completed: 0, total: 6, tasks: tasks.slice(0, 6) },
    { batch: 3, status: "failed", completed: 0, total: 6, tasks: tasks.slice(6, 12) },
    { batch: 4, status: "running", completed: 0, total: 6, tasks: tasks.slice(12) },
  ];
  const crowded = { ...view, progress: { ...view.progress, currentBatch: batches[3], batches } };

  for (const width of [80, 120]) {
    const inspected = [];
    const subject = handle({
      async view() { return crowded; },
      async inspectAgent(target) { inspected.push(target); return inspection(target); },
    });
    const { component } = await componentFor(subject, 12);
    await new Promise((resolve) => setImmediate(resolve));
    for (const input of ["j", "j", "j", "PAGE_DOWN"]) {
      component.handleInput(input);
      await new Promise((resolve) => setImmediate(resolve));
      const rendered = plain(component.render(width).join("\n"));
      assert.equal((rendered.match(/> /g) ?? []).length, 1, `selection disappeared at width ${width} after ${input}`);
    }
    component.handleInput("CONFIRM");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(inspected.at(-1), { kind: "task", batch: 4, taskId: "task-13" });
    assert.match(plain(component.render(width).join("\n")), /task-13/);
    component.dispose();
  }
});

test("control keys only act on the run page and for legal run states", async () => {
  async function controlledComponent(status, initialTarget) {
    const calls = [];
    const runView = { ...view, status };
    const result = await componentFor(handle({ async view() { return runView; } }), 24, initialTarget, undefined, { onControl: async (action) => { calls.push(action); } });
    return { ...result, calls };
  }

  const invalidContexts = [
    await controlledComponent("running", { kind: "lead" }),
    await controlledComponent("running"),
    await controlledComponent("succeeded"),
  ];
  invalidContexts[1].component.handleInput("j");
  invalidContexts[1].component.handleInput("j");
  invalidContexts[1].component.handleInput("CONFIRM");
  for (const variant of invalidContexts) {
    for (const input of ["p", "r", "x"]) variant.component.handleInput(input);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(variant.calls, []);
    variant.component.dispose();
  }

  for (const [status, input, expected] of [["running", "p", "pause"], ["running", "x", "cancel"], ["paused", "r", "resume"], ["paused", "x", "cancel"]]) {
    const variant = await controlledComponent(status);
    variant.component.handleInput(input);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(variant.calls, [expected]);
    variant.component.dispose();
  }
});

test("activity list shows tool success and failure without start events", async () => {
  const recorded = recordingTheme();
  const { component } = await componentFor(handle({
    async activity() {
      return {
        entries: [
          { sequence: 1, at: "2026-08-12T00:00:01.000Z", kind: "tool", severity: "info", message: "read started", toolName: "read", completed: false },
          { sequence: 2, at: "2026-08-12T00:00:02.000Z", kind: "tool", severity: "info", message: "", toolName: "read", completed: true },
          { sequence: 3, at: "2026-08-12T00:00:03.000Z", kind: "tool", severity: "error", message: "Path is not assigned", toolName: "write", completed: true },
        ],
        nextBefore: undefined,
      };
    },
  }), 24, undefined, recorded.theme);
  component.handleInput("j");
  component.handleInput("j");
  component.handleInput("CONFIRM");
  await new Promise((resolve) => setImmediate(resolve));
  const rendered = plain(component.render(80).join("\n"));
  assert.match(rendered, new RegExp(`✓ ${formatLocalTime("2026-08-12T00:00:02.000Z")} {2}read(?:\\s|$)`));
  assert.match(rendered, new RegExp(`✗ ${formatLocalTime("2026-08-12T00:00:03.000Z")} {2}write {2}Path is not assigned`));
  assert.doesNotMatch(rendered, /read started|succeeded|write failed:/);
  assert.ok(callFor(recorded.calls, "success", /✓/));
  assert.ok(callFor(recorded.calls, "error", /Path is not assigned/));
  component.dispose();
});

test("wide run preview uses activity context before Enter", async () => {
  const { component } = await componentFor();
  component.handleInput("j");
  component.handleInput("j");
  await new Promise((resolve) => setImmediate(resolve));
  const rendered = plain(component.render(120).join("\n"));
  assert.match(rendered, /Activity\s+\[all\]/);
  assert.match(rendered, /context\s+—/);
  component.dispose();
});

test("leader and batch outcome symbols use their semantic theme roles", async () => {
  for (const [status, icon, token] of [["complete", "✓", "success"], ["incomplete", "◐", "warning"], ["failed", "✗", "error"]]) {
    const recorded = recordingTheme();
    const resultView = {
      ...view,
      progress: {
        stage: "prepare",
        language: "en",
        lead: { ...lead, status },
        batches: [
          { batch: 1, status: "complete", completed: 1, total: 1, tasks: [] },
          { batch: 2, status: "partial", completed: 1, total: 2, tasks: [] },
          { batch: 3, status: "failed", completed: 0, total: 1, tasks: [] },
        ],
      },
    };
    const { component } = await componentFor(handle({ async view() { return resultView; } }), 24, undefined, recorded.theme);
    const rendered = plain(component.render(120).join("\n"));
    assert.match(rendered, new RegExp(`${icon} Leader`));
    assert.match(rendered, /✓ Batch 1/);
    assert.match(rendered, /◐ Batch 2/);
    assert.match(rendered, /✗ Batch 3/);
    assert.ok(callFor(recorded.calls, token, new RegExp(`^${icon}$`)));
    assert.ok(callFor(recorded.calls, "success", /^✓$/));
    assert.ok(callFor(recorded.calls, "warning", /^◐$/));
    assert.ok(callFor(recorded.calls, "error", /^✗$/));
    component.dispose();
  }
});

test("completed, failed, and cancelled agents keep navigation and inspector semantics aligned", async () => {
  for (const { status, icon, token } of [
    { status: "complete", icon: "✓", token: "success" },
    { status: "failed", icon: "✗", token: "error" },
    { status: "cancelled", icon: "○", token: "muted" },
  ]) {
    const recorded = recordingTheme();
    const agent = {
      ...lead,
      status,
      activity: "settled",
      activeTools: [],
      summary: `${status} summary`,
    };
    const resultView = {
      ...view,
      status: "succeeded",
      completedAt: "2026-08-12T00:00:04Z",
      progress: { stage: "prepare", language: "en", lead: agent },
    };
    const { component } = await componentFor(handle({
      async view() { return resultView; },
      async inspectAgent() { return { ...inspection(), agent }; },
    }), 24, undefined, recorded.theme);
    await new Promise((resolve) => setImmediate(resolve));
    const rendered = plain(component.render(120).join("\n"));

    assert.match(rendered, new RegExp(`${icon} Leader\\s+settled`), `${status} navigation icon`);
    assert.match(rendered, new RegExp(`${icon} ${status} · settled`), `${status} inspector live icon`);
    assert.ok(recorded.calls.filter((call) => call.token === token && call.text === icon).length >= 2, `${status} navigation and live icon must both use ${token}`);
    if (status !== "failed") assert.ok(!callFor(recorded.calls, "accent", /^◆$/), `${status} must not render a running live icon`);
    if (status === "cancelled") {
      assert.match(rendered, /lead\s+cancelled/i);
      assert.ok(recorded.calls.every((call) => call.token !== "error"), "cancelled is muted, not failed");
    }
    component.dispose();
  }
});

test("degraded health does not replace terminal status semantics", async () => {
  for (const { status, icon, token } of [
    { status: "complete", icon: "✓", token: "success" },
    { status: "failed", icon: "✗", token: "error" },
    { status: "cancelled", icon: "○", token: "muted" },
  ]) {
    const recorded = recordingTheme();
    const agent = { ...lead, status, health: "degraded", activity: "settled", activeTools: [] };
    const resultView = {
      ...view,
      status: "succeeded",
      completedAt: "2026-08-12T00:00:04Z",
      progress: { stage: "prepare", language: "en", lead: agent },
    };
    const { component } = await componentFor(handle({
      async view() { return resultView; },
      async inspectAgent() { return { ...inspection(), agent }; },
    }), 24, undefined, recorded.theme);
    await new Promise((resolve) => setImmediate(resolve));
    const rendered = plain(component.render(120).join("\n"));

    assert.match(rendered, new RegExp(`${icon} Leader\\s+settled`));
    assert.match(rendered, new RegExp(`${icon} ${status} · settled`));
    assert.match(rendered, /warning  observability degraded/);
    assert.ok(recorded.calls.filter((call) => call.token === token && call.text === icon).length >= 2);
    assert.ok(callFor(recorded.calls, "warning", /observability degraded/));
    component.dispose();
  }
});

test("retrying stays warning in navigation, live status, and inspector under selected background", async () => {
  const recorded = recordingTheme();
  const agent = {
    ...lead,
    status: "retrying",
    activity: "retry_wait",
    activeTools: [],
    summary: "retry scheduled",
  };
  const retryingView = {
    ...view,
    status: "succeeded",
    completedAt: "2026-08-12T00:00:04Z",
    progress: { stage: "prepare", language: "en", lead: agent },
  };
  const { component } = await componentFor(handle({
    async view() { return retryingView; },
    async inspectAgent() { return { ...inspection(), agent }; },
  }), 24, undefined, recorded.theme);
  await new Promise((resolve) => setImmediate(resolve));
  const rendered = plain(component.render(120).join("\n"));

  assert.match(rendered, /◐ Leader\s+retry wait/);
  assert.match(rendered, /◐ retrying · retry wait/);
  assert.match(rendered, /lead\s+retrying\s+·\s+retry wait/i);
  assert.ok(recorded.calls.filter((call) => call.method === "fg" && call.token === "warning" && call.text === "◐").length >= 2);
  assert.ok(recorded.calls.filter((call) => call.method === "fg" && call.token === "warning" && call.text === "retrying").length >= 2);
  assert.ok(recorded.calls.every((call) => !(["◐", "retrying"].includes(call.text) && ["muted", "accent"].includes(call.token))));
  assert.ok(recorded.calls.some((call) => call.method === "bg" && call.token === "selectedBg" && plain(call.text).includes("◐ Leader")));
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
