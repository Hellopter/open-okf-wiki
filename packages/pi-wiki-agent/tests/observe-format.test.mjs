import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  agentStatusGlyph,
  applyWikiNavigatorKey,
  createWikiNavigatorState,
  formatAgentLine,
  formatCoverageLine,
  formatDuration,
  formatStatusBar,
  isAgentStale,
  openWikiNavigator,
  phaseStatusGlyph,
  renderWikiNavigator,
} from "../dist/observe/index.js";

const NOW = 1_700_000_000_000;

function fixtureSnapshot(overrides = {}) {
  return {
    version: 1,
    domainRunId: "dom-1",
    orchRunId: "orch-1",
    workspaceRoot: "/tmp/wiki",
    mode: "auto",
    focus: "auth",
    backend: "session",
    overall: "running",
    currentPhase: "Survey",
    phases: [
      { name: "Bootstrap", status: "done" },
      { name: "Survey", status: "active" },
      { name: "Plan", status: "pending" },
    ],
    coverage: {
      pass: 1,
      unitsTotal: 12,
      unitsWithReceipt: 4,
      missingUnitIds: ["u5", "u6"],
      retryUnitIds: [],
    },
    agents: [
      {
        agentId: "bootstrap:1",
        label: "Bootstrap",
        role: "bootstrap",
        phase: "Bootstrap",
        status: "succeeded",
        elapsedMs: 45_000,
        receiptsWritten: 1,
      },
      {
        agentId: "survey:1:1",
        label: "Survey lane 1",
        role: "survey",
        phase: "Survey",
        status: "succeeded",
        elapsedMs: 45_000,
        receiptsWritten: 2,
      },
      {
        agentId: "survey:1:2",
        label: "Survey lane 2",
        role: "survey",
        phase: "Survey",
        status: "running",
        elapsedMs: 65_000,
        startedAt: NOW - 65_000,
        receiptsWritten: 1,
        lastHeartbeatAt: NOW - 5_000,
        lastTool: { name: "read_file", path: "src/a.ts", at: NOW - 8_000 },
      },
      {
        agentId: "plan:1",
        label: "Plan",
        role: "plan",
        phase: "Plan",
        status: "queued",
        elapsedMs: 0,
        receiptsWritten: 0,
      },
    ],
    updatedAt: NOW - 2_000,
    ...overrides,
  };
}

test("compact formatting keeps status bar at run level", () => {
  const snap = fixtureSnapshot();
  assert.equal(formatDuration(184_000), "3m04s");
  assert.equal(agentStatusGlyph("running"), "●");
  assert.equal(phaseStatusGlyph("done"), "✓");
  assert.equal(formatCoverageLine(snap.coverage), "pass1 4/12 receipts missing:2");
  assert.match(formatAgentLine(snap.agents[2], { now: NOW, staleWarnMs: 30_000 }), /read_file/);
  assert.equal(isAgentStale(snap.agents[2], 30_000, NOW), false);
  const bar = formatStatusBar(snap, { now: NOW, staleWarnMs: 30_000 });
  assert.match(bar, /^Wiki Survey 4\/12/);
  assert.match(bar, /1 running/);
  assert.ok(!/focus:/.test(bar));
});

test("Navigator moves phase to agents to execution stream", () => {
  const snap = fixtureSnapshot();
  let state = createWikiNavigatorState(snap);
  assert.equal(state.view, "overview");
  assert.equal(state.pane, "phases");
  assert.equal(state.phaseIndex, 1);

  const overview = renderWikiNavigator(state, { initialized: true, root: "/tmp/wiki", sourceCount: 1 }, { width: 80, now: NOW });
  assert.ok(overview.some((line) => line.includes("Phases")));
  assert.ok(overview.some((line) => line.includes("Agents · Survey")));

  state = applyWikiNavigatorKey(state, "right").state;
  assert.equal(state.pane, "agents");
  assert.equal(state.agentIndex, 1);
  const detail = applyWikiNavigatorKey(state, "enter");
  assert.equal(detail.action, "load-transcript");
  assert.equal(detail.agentId, "survey:1:2");
  state = { ...detail.state, transcriptLoading: false, transcriptLines: ["first", "latest"] };
  assert.equal(state.view, "detail");
  assert.ok(renderWikiNavigator(state, { initialized: true, root: "/tmp/wiki", sourceCount: 1 }, { now: NOW }).some((line) => line.includes("Execution stream")));
  assert.equal(applyWikiNavigatorKey(state, "left").state.view, "overview");
  assert.equal(applyWikiNavigatorKey(state, "p").action, "pause");
  assert.equal(applyWikiNavigatorKey({ ...state, snapshot: { ...snap, overall: "paused" } }, "p").action, "resume");
});

test("openWikiNavigator renders a bordered focusable dialog and follows updates", async () => {
  let component;
  let listener;
  let redraws = 0;
  let unsubscribed = 0;
  let transcriptCalls = 0;
  let options;
  const opened = openWikiNavigator(
    {
      hasUI: true,
      ui: {
        notify: () => undefined,
        custom: (factory, customOptions) =>
          new Promise((resolve) => {
            options = customOptions;
            component = factory(
              { terminal: { rows: 30 }, requestRender: () => redraws++ },
              { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text },
              {},
              resolve,
            );
          }),
      },
    },
    {
      getSnapshot: () => fixtureSnapshot(),
      idle: { initialized: true, root: "/tmp/wiki", sourceCount: 1 },
      subscribe: (cb) => {
        listener = cb;
        return () => unsubscribed++;
      },
      getTranscript: async () => {
        transcriptCalls++;
        return ["first", "latest"];
      },
    },
  );

  assert.deepEqual(options, {
    overlay: true,
    overlayOptions: { width: "94%", maxHeight: "92%", anchor: "center", margin: 1 },
  });
  const dialog = component.render(70);
  assert.equal(dialog[0][0], "╭");
  assert.equal(dialog.at(-1).at(-1), "╯");
  assert.ok(dialog.every((line) => visibleWidth(line) === 70));
  assert.equal(dialog.length, 27);

  component.handleInput("\u001b[C");
  component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transcriptCalls, 1);
  assert.ok(component.render(70).some((line) => line.includes("latest")));

  listener(fixtureSnapshot({ updatedAt: NOW + 1 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(redraws > 0);
  component.handleInput("q");
  await opened;
  assert.equal(unsubscribed, 1);
});

test("Navigator presents an idle window and has no text fallback", async () => {
  const notifications = [];
  const result = await openWikiNavigator(
    { hasUI: false, ui: { notify: (message) => notifications.push(message) } },
    { getSnapshot: () => undefined, idle: { initialized: false, root: "/tmp/wiki", sourceCount: 0 } },
  );
  assert.equal(result, "unsupported");
  assert.match(notifications[0], /status --json/);

  const idle = renderWikiNavigator(createWikiNavigatorState(), { initialized: false, root: "/tmp/wiki", sourceCount: 0 });
  assert.ok(idle.some((line) => /not initialized/i.test(line)));
});

test("idle Navigator switches to overview when a run starts", async () => {
  let component;
  let listener;
  const opened = openWikiNavigator(
    {
      hasUI: true,
      ui: {
        notify: () => undefined,
        custom: (factory) =>
          new Promise((resolve) => {
            component = factory(
              { terminal: { rows: 24 }, requestRender: () => undefined },
              { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text },
              {},
              resolve,
            );
          }),
      },
    },
    {
      getSnapshot: () => undefined,
      idle: { initialized: true, root: "/tmp/wiki", sourceCount: 1 },
      subscribe: (cb) => {
        listener = cb;
        return () => undefined;
      },
    },
  );

  assert.ok(component.render(70).some((line) => /No active Wiki run/.test(line)));
  listener(fixtureSnapshot());
  assert.ok(component.render(70).some((line) => line.includes("Agents · Survey")));
  component.handleInput("q");
  await opened;
});
