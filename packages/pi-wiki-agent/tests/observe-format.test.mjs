import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  agentStatusGlyph,
  applyInspectorKey,
  createInspectorState,
  formatAgentDetail,
  formatAgentLine,
  formatAgentsTable,
  formatCoverageLine,
  formatDuration,
  formatPhasesLine,
  formatSnapshotText,
  formatStatusBar,
  isAgentStale,
  openWikiInspector,
  phaseStatusGlyph,
  renderInspector,
} from "../dist/observe/index.js";

const NOW = 1_700_000_000_000;

function fixtureSnapshot(overrides = {}) {
  return {
    version: 1,
    domainRunId: "dom-1",
    orchRunId: "orch-1",
    workspaceRoot: "/tmp/wiki",
    workdir: "/tmp/wiki/.wiki-agent/runs/dom-1/workdir",
    mode: "auto",
    focus: "auth",
    backend: "session",
    overall: "running",
    currentPhase: "Survey",
    phases: [
      { name: "Bootstrap", status: "done" },
      { name: "Survey", status: "active" },
      { name: "Plan", status: "pending" },
      { name: "Gate", status: "pending" },
      { name: "Write", status: "pending" },
    ],
    coverage: {
      pass: 1,
      unitsTotal: 12,
      unitsWithReceipt: 4,
      missingUnitIds: ["u5", "u6", "u7", "u8", "u9", "u10", "u11", "u12"],
      retryUnitIds: [],
    },
    agents: [
      {
        agentId: "survey:1:1",
        label: "Survey lane 1",
        role: "survey",
        phase: "Survey",
        status: "succeeded",
        elapsedMs: 45_000,
        startedAt: NOW - 90_000,
        endedAt: NOW - 45_000,
        receiptsWritten: 2,
        lastTool: { name: "okf_publish", at: NOW - 50_000 },
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
        agentId: "survey:1:3",
        label: "Survey lane 3",
        role: "survey",
        phase: "Survey",
        status: "running",
        elapsedMs: 70_000,
        startedAt: NOW - 70_000,
        receiptsWritten: 0,
        // Heartbeat old enough to be stale with 30s warn.
        lastHeartbeatAt: NOW - 60_000,
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
    focusedAgentId: "survey:1:2",
    updatedAt: NOW - 2_000,
    ...overrides,
  };
}

test("formatDuration covers seconds, minutes, and hours", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(12_000), "12s");
  assert.equal(formatDuration(184_000), "3m04s");
  assert.equal(formatDuration(3_720_000), "1h02m");
  assert.equal(formatDuration(-5), "0s");
});

test("status glyphs map agent and phase states", () => {
  assert.equal(agentStatusGlyph("succeeded"), "✓");
  assert.equal(agentStatusGlyph("running"), "●");
  assert.equal(agentStatusGlyph("failed"), "!");
  assert.equal(agentStatusGlyph("queued"), "·");
  assert.equal(phaseStatusGlyph("done"), "✓");
  assert.equal(phaseStatusGlyph("active"), "●");
  assert.equal(phaseStatusGlyph("pending"), "·");
});

test("formatCoverageLine and formatPhasesLine match compact forms", () => {
  const snap = fixtureSnapshot();
  assert.equal(formatCoverageLine(snap.coverage), "pass1 4/12 receipts missing:8");
  assert.equal(formatPhasesLine(snap.phases), "Bootstrap✓ Survey● Plan· Gate· Write·");
});

test("formatAgentLine and agents table mark focus and stale", () => {
  const snap = fixtureSnapshot();
  const line = formatAgentLine(snap.agents[1], { now: NOW, staleWarnMs: 30_000 });
  assert.match(line, /survey:1:2/);
  assert.match(line, /●/);
  assert.match(line, /running/);
  assert.match(line, /read_file/);

  const stale = formatAgentLine(snap.agents[2], { now: NOW, staleWarnMs: 30_000 });
  assert.match(stale, /!stale/);
  assert.equal(isAgentStale(snap.agents[2], 30_000, NOW), true);
  assert.equal(isAgentStale(snap.agents[1], 30_000, NOW), false);

  const table = formatAgentsTable(snap, { now: NOW });
  assert.match(table, /^> survey:1:2/m);
  assert.match(table, /^  survey:1:1/m);
});

test("formatSnapshotText includes phases, coverage, agents, and ids", () => {
  const text = formatSnapshotText(fixtureSnapshot(), { now: NOW });
  assert.match(text, /orch-1/);
  assert.match(text, /dom-1/);
  assert.match(text, /Bootstrap✓/);
  assert.match(text, /pass1 4\/12/);
  assert.match(text, /survey:1:2/);
  assert.match(text, /Focused agent: survey:1:2/);
});

test("formatAgentDetail lists identity and tool context", () => {
  const snap = fixtureSnapshot();
  const detail = formatAgentDetail(snap.agents[1], snap, { now: NOW });
  assert.match(detail, /Agent: survey:1:2/);
  assert.match(detail, /Role: survey/);
  assert.match(detail, /Last tool: read_file/);
  assert.match(detail, /Focused: yes/);
});

test("formatStatusBar is a compact one-liner", () => {
  const bar = formatStatusBar(fixtureSnapshot(), { now: NOW, staleWarnMs: 30_000 });
  assert.match(bar, /^Wiki Survey 4\/12/);
  assert.match(bar, /2 running/);
  assert.match(bar, /focus:survey:1:2/);
  assert.match(bar, /1 stale/);
  assert.match(bar, / · /);
});

test("inspector selection, effects, transcript navigation, and render", () => {
  const snap = fixtureSnapshot();
  let state = createInspectorState(snap);
  assert.equal(selectedId(state), "survey:1:2");

  const down = applyInspectorKey(state, "down");
  assert.equal(down.action, undefined);
  state = down.state;
  assert.equal(selectedId(state), "survey:1:3");

  const up = applyInspectorKey(state, "k");
  assert.equal(up.action, undefined);
  state = up.state;
  assert.equal(selectedId(state), "survey:1:2");

  const enter = applyInspectorKey(state, "enter");
  assert.equal(enter.action, "focus");
  assert.equal(enter.agentId, "survey:1:2");
  assert.equal(enter.state.snapshot.focusedAgentId, "survey:1:2");

  assert.equal(applyInspectorKey(state, "q").action, "close");
  assert.equal(applyInspectorKey(state, "p").action, "pause");
  assert.equal(applyInspectorKey({ ...state, snapshot: { ...state.snapshot, overall: "paused" } }, "p").action, "resume");

  const transcript = applyInspectorKey(state, "t");
  assert.equal(transcript.action, "load-transcript");
  state = {
    ...transcript.state,
    transcriptLoading: false,
    transcriptLines: Array.from({ length: 16 }, (_, i) => `line-${i + 1}`),
    transcriptOffset: 4,
  };
  assert.equal(state.panel, "transcript");
  assert.equal(state.transcriptOffset, 4);
  assert.equal(applyInspectorKey(state, "g").state.transcriptOffset, 0);
  assert.equal(applyInspectorKey(state, "G").state.transcriptOffset, 4);

  const rendered = renderInspector(createInspectorState(snap), { now: NOW, interactive: true, maxAgentRows: 2 });
  assert.ok(rendered.some((l) => l.includes("Wiki inspector")));
  assert.ok(rendered.some((l) => l.includes("survey:1:2")));
  assert.ok(rendered.some((l) => /↑\/↓ move/.test(l)));
  assert.ok(rendered.some((l) => /more agents/.test(l)));

  const staticRendered = renderInspector(createInspectorState(snap), { now: NOW });
  assert.ok(!staticRendered.some((l) => /pause\/resume/.test(l)));

});

test("openWikiInspector uses a focused component for raw arrow keys and live updates", async () => {
  let component;
  let redraws = 0;
  let focused;
  let listener;
  let unsubscribed = 0;
  let transcriptCalls = 0;
  let customOptions;
  const opened = openWikiInspector(
    {
      hasUI: true,
      ui: {
        notify: () => undefined,
        custom: (factory, options) =>
          new Promise((resolve) => {
            customOptions = options;
            component = factory(
              { terminal: { rows: 30 }, requestRender: () => redraws++ },
              { fg: (_color, text) => text },
              {},
              resolve,
            );
          }),
      },
    },
    {
      getSnapshot: () => fixtureSnapshot(),
      subscribe: (cb) => {
        listener = cb;
        return () => unsubscribed++;
      },
      getTranscript: async () => {
        transcriptCalls++;
        return ["first", "latest"];
      },
      onFocus: (agentId) => {
        focused = agentId;
      },
    },
  );

  assert.ok(component);
  assert.deepEqual(customOptions, {
    overlay: true,
    overlayOptions: { width: 100, minWidth: 40, anchor: "center", margin: 1 },
  });
  const dialog = component.render(24);
  assert.equal(dialog[0][0], "┌");
  assert.equal(dialog.at(-1).at(-1), "┘");
  assert.ok(dialog.every((line) => visibleWidth(line) === 24));
  assert.ok(dialog.length <= 28);
  component.handleInput("\u001b[B");
  assert.ok(component.render(100).some((line) => line.includes("> survey:1:3")));
  component.handleInput("\r");
  assert.equal(focused, "survey:1:3");
  component.handleInput("t");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transcriptCalls, 1);
  assert.ok(component.render(100).some((line) => line.includes("latest")));

  listener(fixtureSnapshot({ updatedAt: NOW + 1 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(redraws > 0);
  component.handleInput("q");
  await opened;
  assert.equal(unsubscribed, 1);
});

test("openWikiInspector returns static fallback without a TUI", async () => {
  const notes = [];
  const fallback = [];
  const result = await openWikiInspector(
    {
      hasUI: false,
      ui: {
        notify: (msg) => notes.push(msg),
      },
    },
    {
      getSnapshot: () => fixtureSnapshot(),
      onFallbackText: (lines) => fallback.push(...lines),
    },
  );
  assert.equal(result, "unsupported");
  assert.ok(notes.length > 0);
  assert.ok(fallback.some((l) => /Wiki inspector/.test(l)));
  assert.ok(!fallback.some((l) => /pause\/resume/.test(l)));
});

function selectedId(state) {
  return state.snapshot.agents[state.selectedIndex]?.agentId;
}
