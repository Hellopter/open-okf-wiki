import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  agentStatusGlyph,
  applyWikiNavigatorKey,
  createWikiNavigatorState,
  formatAgentLine,
  formatDuration,
  formatWikiObservationEntries,
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
    runId: "run-1",
    orchestrationId: "orch-1",
    workspaceRoot: "/tmp/wiki",
    mode: "auto",
    focus: "auth",
    backend: "session",
    overall: "running",
    currentPhase: "Survey",
    phases: [
      { name: "Prepare", status: "done" },
      { name: "Survey", status: "active" },
      { name: "Plan", status: "pending" },
    ],
    agents: [
      {
        agentId: "main:1",
        label: "Main",
        role: "main",
        phase: "Prepare",
        status: "succeeded",
        elapsedMs: 45_000,
      },
      {
        agentId: "source:project",
        label: "Source survey: project",
        role: "source-researcher",
        phase: "Survey",
        status: "succeeded",
        elapsedMs: 45_000,
      },
      {
        agentId: "source:shared",
        label: "Source survey: shared",
        role: "source-researcher",
        phase: "Survey",
        status: "running",
        elapsedMs: 65_000,
        startedAt: NOW - 65_000,
        lastHeartbeatAt: NOW - 5_000,
        lastTool: { name: "read_file", path: "src/a.ts", at: NOW - 8_000 },
      },
      {
        agentId: "main:2",
        label: "Main",
        role: "main",
        phase: "Plan",
        status: "queued",
        elapsedMs: 0,
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
  assert.match(formatAgentLine(snap.agents[2], { now: NOW, staleWarnMs: 30_000 }), /read_file/);
  assert.equal(isAgentStale(snap.agents[2], 30_000, NOW), false);
  const bar = formatStatusBar(snap, { now: NOW, staleWarnMs: 30_000 });
  assert.match(bar, /^Wiki Survey/);
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
  assert.equal(detail.agentId, "source:shared");
  state = { ...detail.state, transcriptLoading: false, transcriptLines: ["first", "latest"] };
  assert.equal(state.view, "detail");
  assert.ok(renderWikiNavigator(state, { initialized: true, root: "/tmp/wiki", sourceCount: 1 }, { now: NOW }).some((line) => line.includes("Execution stream")));
  assert.equal(applyWikiNavigatorKey(state, "left").state.view, "overview");
  assert.equal(applyWikiNavigatorKey(state, "p").action, "pause");
  assert.equal(applyWikiNavigatorKey({ ...state, snapshot: { ...snap, overall: "paused" } }, "p").action, "resume");
});

test("Navigator keeps the wide phase-agent divider through every body row", () => {
  const state = createWikiNavigatorState(fixtureSnapshot());
  const lines = renderWikiNavigator(
    state,
    { initialized: true, root: "/tmp/wiki", sourceCount: 1 },
    { width: 80, maxRows: 14, interactive: true, now: NOW },
  );
  const top = lines.findIndex((line) => line.includes("┌") && line.includes("┬") && line.includes("┐"));
  const bottom = lines.findIndex((line) => line.includes("└") && line.includes("┴") && line.includes("┘"));
  assert.ok(top >= 0);
  assert.ok(bottom > top + 1);
  for (const line of lines.slice(top + 1, bottom)) assert.match(line, /│.*│.*│/);
  assert.equal(lines.length, 14);
});

test("observation formatter shows useful tool and agent state without serializing JSON", () => {
  const lines = formatWikiObservationEntries([
    { role: "tool", kind: "tool_start", timestamp: 1, toolCallId: "one", toolName: "read", path: "src/observe/navigator.ts" },
    { role: "tool", kind: "tool_end", timestamp: 2, toolCallId: "one", toolName: "read", isError: false },
    { role: "assistant", kind: "text", timestamp: 3, text: "The pane uses a fixed frame.\nThe divider now reaches the bottom." },
    { role: "system", kind: "retry_start", timestamp: 4, attempt: 2, maxAttempts: 3, delayMs: 4_000, error: "rate limited" },
    { role: "system", kind: "compaction_end", timestamp: 5, tokensBefore: 176_000, tokensAfter: 24_000, success: true },
    { role: "tool", kind: "tool_end", timestamp: 6, toolName: "write", path: "docs/wiki.md", isError: true, error: "permission denied" },
    { role: "system", kind: "text", timestamp: 7, text: '{"large":"raw JSON must not appear"}' },
  ]);
  assert.deepEqual(lines.slice(0, 3), [
    "→ read  src/observe/navigator.ts",
    "assistant  The pane uses a fixed frame.",
    "           The divider now reaches the bottom.",
  ]);
  assert.ok(lines.some((line) => /Retry 2\/3.*waiting 4s.*rate limited/.test(line)));
  assert.ok(lines.some((line) => /Context compacted.*176k → 24k/.test(line)));
  assert.ok(lines.some((line) => /write.*docs\/wiki.md.*permission denied/.test(line)));
  assert.ok(!lines.some((line) => line.includes('"large"')));

});

test("Navigator renders context, usage, and transient Pi activity", () => {
  const snapshot = fixtureSnapshot({
    agents: fixtureSnapshot().agents.map((agent) =>
      agent.agentId === "source:shared"
        ? {
            ...agent,
            context: { tokens: 24_100, contextWindow: 200_000, percent: 12 },
            latestUsage: { input: 4_800, output: 700, cacheRead: 3_100, total: 8_600 },
            tokenUsage: { total: 46_200 },
            compactionCount: 1,
            activity: { kind: "retrying", attempt: 1, maxAttempts: 3, delayMs: 2_000, message: "rate limited" },
          }
        : agent,
    ),
  });
  let state = createWikiNavigatorState(snapshot);
  state = applyWikiNavigatorKey(state, "right").state;
  state = applyWikiNavigatorKey(state, "enter").state;
  state = { ...state, transcriptLoading: false };
  const lines = renderWikiNavigator(state, { initialized: true, root: "/tmp/wiki", sourceCount: 1 }, { now: NOW, maxRows: 30 });
  assert.ok(lines.some((line) => /Context 24k \/ 200k \(12%\)/.test(line)));
  assert.ok(lines.some((line) => /Retry 1\/3.*waiting 2s.*rate limited/.test(line)));
  assert.ok(lines.some((line) => /This turn in 4\.8k.*out 700.*cache 3\.1k/.test(line)));
  assert.ok(lines.some((line) => /Run total 46k/.test(line)));
  assert.ok(lines.some((line) => /Context compacted 1x/.test(line)));
});

test("Navigator presents an approval workbench without exposing a run id", () => {
  const snapshot = fixtureSnapshot({
    overall: "proposed",
    currentPhase: "Approval",
    planSummary: "6 pages, 3 evidence briefs, 2 required diagrams",
    qualitySummary: { verdict: "pass", passed: 9, failed: 0, findings: 2 },
    planPreview: "# Plan\n\n## Runtime\n" + Array.from({ length: 24 }, (_value, index) => `- Concept ${index + 1}`).join("\n"),
  });
  let state = createWikiNavigatorState(snapshot);
  assert.equal(state.view, "proposal");
  const lines = renderWikiNavigator(state, { initialized: true, root: "/tmp/wiki", sourceCount: 1 }, { width: 80, maxRows: 20, interactive: true });
  assert.ok(lines.some((line) => line.includes("Plan approval")));
  assert.ok(lines.some((line) => line.includes("PASS") && line.includes("9 passed")));
  assert.ok(lines.some((line) => line.includes("Concept 1")));
  assert.ok(!lines.some((line) => line.includes("run-1")));
  assert.equal(applyWikiNavigatorKey(state, "a").action, "approve");
  assert.equal(applyWikiNavigatorKey(state, "r").action, "reject");

  state = { ...state, proposalPageRows: 2, proposalPreviewRows: 24 };
  assert.equal(applyWikiNavigatorKey(state, "G").state.proposalOffset, 22);
  assert.equal(applyWikiNavigatorKey(state, "left").state.view, "overview");
  assert.equal(applyWikiNavigatorKey({ ...state, view: "overview" }, "v").state.view, "proposal");
});

test("Navigator dialog wraps long prompts, messages, and file paths", async () => {
  let component;
  const longPath = `src/${"very-long-segment-".repeat(12)}file.ts`;
  const snapshot = fixtureSnapshot({
    agents: fixtureSnapshot().agents.map((agent) =>
      agent.agentId === "source:shared"
        ? { ...agent, prompt: `Inspect ${longPath}`, lastTool: { name: "read_file", path: longPath, at: NOW } }
        : agent,
    ),
  });
  const opened = openWikiNavigator(
    {
      hasUI: true,
      ui: {
        notify: () => undefined,
        custom: (factory) =>
          new Promise((resolve) => {
            component = factory(
              { terminal: { rows: 30 }, requestRender: () => undefined },
              { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text },
              {},
              resolve,
            );
          }),
      },
    },
    {
      getSnapshot: () => snapshot,
      idle: { initialized: true, root: "/tmp/wiki", sourceCount: 1 },
      getTranscript: async () => [{ role: "assistant", kind: "text", timestamp: NOW, text: `Checked ${longPath}` }],
    },
  );

  component.render(66);
  component.handleInput("\u001b[C");
  component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  const dialog = component.render(66);
  assert.ok(dialog.some((line) => line.includes("Input prompt:")));
  assert.ok(dialog.some((line) => line.includes("Last tool: read_file")));
  assert.ok(dialog.some((line) => line.includes("very-long-segment")));
  assert.ok(dialog.every((line) => visibleWidth(line) === 66));

  component.handleInput("q");
  await opened;
});

test("Navigator keeps the execution stream visible when an input prompt is long", () => {
  const snapshot = fixtureSnapshot({
    agents: fixtureSnapshot().agents.map((agent) =>
      agent.agentId === "source:shared"
        ? { ...agent, prompt: Array.from({ length: 40 }, (_value, index) => `Prompt instruction ${index + 1}`).join("\n") }
        : agent,
    ),
  });
  let state = createWikiNavigatorState(snapshot);
  state = applyWikiNavigatorKey(state, "right").state;
  state = applyWikiNavigatorKey(state, "enter").state;
  state = {
    ...state,
    transcriptLoading: false,
    transcriptLines: ["assistant  inspected the source", "→ read  src/service.ts"],
  };

  const detail = renderWikiNavigator(
    state,
    { initialized: true, root: "/tmp/wiki", sourceCount: 1 },
    { width: 70, maxRows: 16, interactive: true, now: NOW },
  );
  assert.ok(detail.some((line) => line.includes("Input prompt: …")));
  assert.ok(detail.some((line) => line.includes("Execution stream")));
  assert.ok(detail.some((line) => line.includes("assistant  inspected the source")));

  const prompt = applyWikiNavigatorKey(state, "i").state;
  assert.equal(prompt.view, "prompt");
  const fullPrompt = renderWikiNavigator(
    prompt,
    { initialized: true, root: "/tmp/wiki", sourceCount: 1 },
    { width: 70, maxRows: 16, interactive: true, now: NOW },
  );
  assert.ok(fullPrompt.some((line) => line.includes("Prompt instruction 1")));
  assert.equal(applyWikiNavigatorKey(prompt, "left").state.view, "detail");
});

test("Navigator approval controls invoke active-run callbacks", async () => {
  let component;
  let approved = 0;
  let rejected = 0;
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
      getSnapshot: () => fixtureSnapshot({ overall: "proposed", planPreview: "# Plan\n- one" }),
      idle: { initialized: true, root: "/tmp/wiki", sourceCount: 1 },
      onApprove: async () => {
        approved++;
        return true;
      },
      onReject: async () => {
        rejected++;
        return true;
      },
    },
  );

  component.handleInput("a");
  component.handleInput("r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(approved, 1);
  assert.equal(rejected, 1);
  component.handleInput("q");
  await opened;
});

test("Navigator switches from live execution to the proposal workbench on a proposed snapshot", async () => {
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
      getSnapshot: () => fixtureSnapshot(),
      idle: { initialized: true, root: "/tmp/wiki", sourceCount: 1 },
      subscribe: (cb) => {
        listener = cb;
        return () => undefined;
      },
    },
  );

  assert.ok(component.render(70).some((line) => line.includes("Agents · Survey")));
  listener(fixtureSnapshot({
    overall: "proposed",
    currentPhase: "Approval",
    planSummary: "Plan ready for review",
    planPreview: "# Plan\n\n- Write the runtime page",
  }));
  const dialog = component.render(70);
  assert.ok(dialog.some((line) => line.includes("approval required")));
  assert.ok(dialog.some((line) => line.includes("Write the runtime page")));
  component.handleInput("q");
  await opened;
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
        return [
          { role: "assistant", kind: "text", timestamp: 1, text: "first" },
          { role: "assistant", kind: "text", timestamp: 2, text: "latest" },
        ];
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

test("Navigator paging uses visible transcript rows after context and activity headers", async () => {
  let component;
  const snapshot = fixtureSnapshot({
    agents: fixtureSnapshot().agents.map((agent) =>
      agent.agentId === "source:shared"
        ? {
            ...agent,
            context: { tokens: 24_100, contextWindow: 200_000, percent: 12 },
            latestUsage: { input: 4_800, output: 700, cacheRead: 3_100, cacheWrite: 0, total: 8_600 },
            tokenUsage: { input: 20_000, output: 5_000, cacheRead: 20_000, cacheWrite: 1_200, total: 46_200 },
            compactionCount: 1,
            activity: { kind: "retrying", at: NOW, attempt: 1, maxAttempts: 3, delayMs: 2_000, message: "rate limited" },
          }
        : agent,
    ),
  });
  const opened = openWikiNavigator(
    {
      hasUI: true,
      ui: {
        notify: () => undefined,
        custom: (factory) =>
          new Promise((resolve) => {
            component = factory(
              { terminal: { rows: 20 }, requestRender: () => undefined },
              { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text },
              {},
              resolve,
            );
          }),
      },
    },
    {
      getSnapshot: () => snapshot,
      idle: { initialized: true, root: "/tmp/wiki", sourceCount: 1 },
      getTranscript: async () =>
        Array.from({ length: 8 }, (_value, index) => ({ role: "assistant", kind: "text", timestamp: index, text: `stream-${index}` })),
    },
  );

  component.render(70);
  component.handleInput("\u001b[C");
  component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  let dialog = component.render(70);
  assert.ok(dialog.some((line) => line.includes("stream-7")));
  assert.ok(dialog.some((line) => line.includes("Execution stream · following")));

  component.handleInput("g");
  dialog = component.render(70);
  assert.ok(dialog.some((line) => line.includes("stream-0")));
  assert.ok(!dialog.some((line) => line.includes("stream-7")));

  for (let index = 0; index < 20; index++) component.handleInput("\u001b[B");
  dialog = component.render(70);
  assert.ok(dialog.some((line) => line.includes("stream-7")));
  assert.ok(dialog.some((line) => line.includes("Execution stream · following")));
  assert.ok(!dialog.some((line) => line.includes("newer line")));

  component.handleInput("g");
  component.render(70);
  component.handleInput("G");
  dialog = component.render(70);
  assert.ok(dialog.some((line) => line.includes("stream-7")));
  assert.ok(dialog.some((line) => line.includes("Execution stream · following")));

  component.handleInput("q");
  await opened;
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
