import assert from "node:assert/strict";
import test from "node:test";
import {
  attemptNumbers,
  cancelConfirm,
  deleteConfirm,
  keyToNavigatorIntent,
  layoutForWidth,
  NavigatorState,
  openWikiNavigator,
  phaseRetryImpact,
  phaseRows,
  PLAIN_THEME,
  renderDashboard,
  renderPanel,
  renderWikiArtifactText,
  renderWikiNavigatorFrame,
  renderWikiRunHistoryText,
  renderWikiRunText,
  retryImpact,
  WikiUiHost,
  WikiUiModel,
} from "../dist/index.js";

const plain = (value) => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const overlayRows = (rows) => Math.max(1, Math.min(Math.floor(rows * 0.92), Math.max(1, rows - 2)));

function summary(value) {
  return {
    id: value.id,
    cwd: value.cwd,
    requestedMode: value.requestedMode,
    effectiveMode: value.effectiveMode,
    focus: value.focus,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    totalNodes: value.nodes.length,
    succeededNodes: value.nodes.filter((node) => node.status === "succeeded").length,
    failedNodes: value.nodes.filter((node) => node.status === "failed" || node.status === "blocked").length,
    changedPaths: value.inspection?.changedPaths.length ?? 0,
  };
}

const run = {
  id: "run-1",
  version: 8,
  cwd: "/workspace",
  requestedMode: "refresh",
  effectiveMode: "refresh",
  language: "zh",
  status: "running",
  round: 2,
  sourceRestartCount: 0,
  maxResearchRounds: 6,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  events: [
    { id: "e1", at: "2026-08-08T00:00:00.000Z", kind: "run_started" },
    { id: "e2", at: "2026-08-08T00:00:01.000Z", kind: "node_started", nodeId: "research-a" },
  ],
  inspection: { head: "abcdef0123456789", changedPaths: ["src/engine.ts", "src/ui.ts"] },
  nodes: [
    { id: "inspect", kind: "inspect", label: "Inspect Git scope", phaseId: "inspect", phaseTitle: "Inspect", status: "succeeded", dependsOn: [], attempt: 1, inputFingerprint: "head:abc", input: {}, metrics: {}, activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" }, attemptHistory: [] },
    {
      id: "research-a",
      kind: "research",
      label: "Research workflow engine",
      phaseId: "research",
      phaseTitle: "Research",
      status: "running",
      dependsOn: ["inspect"],
      attempt: 2,
      input: { researchGroupId: "research:initial" },
      history: [
        { at: "2026-08-08T00:00:01.000Z", kind: "message", text: "I will inspect the workflow engine." },
        { at: "2026-08-08T00:00:02.000Z", kind: "tool_call", toolName: "read", target: "src/engine.ts", text: "{\"path\":\"src/engine.ts\"}" },
        { at: "2026-08-08T00:00:03.000Z", kind: "tool_result", toolName: "read", target: "src/engine.ts", summary: "1 result", text: "export class WikiWorkflowEngine {}" },
      ],
      attemptHistory: [{ attempt: 1, history: [{ at: "2026-08-08T00:00:00.000Z", kind: "tool_result", toolName: "read", target: "src/old.ts", summary: "1 result", text: "old output" }], metrics: {} }],
      activity: { state: "compacting", message: "Compacting context", updatedAt: "2026-08-08T00:00:00.000Z", retryDelayMs: 1500 },
      metrics: { model: "openai/gpt-5", contextTokens: 90000, contextWindow: 128000, contextEstimated: true, compactions: 1, autoRetries: 2 },
      output: "streamed evidence from the active agent",
      startedAt: "2026-08-08T00:00:00.000Z",
    },
    { id: "research-b", kind: "research", label: "Research source citations", phaseId: "research", phaseTitle: "Research", status: "queued", dependsOn: ["inspect"], attempt: 1, inputFingerprint: "", input: { researchGroupId: "research:initial" }, metrics: {}, activity: { state: "idle", updatedAt: "2026-08-08T00:00:00.000Z" }, attemptHistory: [] },
    { id: "write", kind: "write", label: "Write Wiki pages", phaseId: "write", phaseTitle: "Write", status: "queued", dependsOn: ["research-a", "research-b"], attempt: 1, inputFingerprint: "", input: { writeGroupId: "write:initial" }, metrics: {}, activity: { state: "idle", updatedAt: "2026-08-08T00:00:00.000Z" }, attemptHistory: [] },
  ],
};

function controllerFor(value = run, runs = [summary(value)]) {
  const listeners = new Set();
  let current = structuredClone(value);
  return {
    listRuns: () => runs.slice(),
    getRun: (runId) => {
      if (!runId || runId === current.id) return structuredClone(current);
      return undefined;
    },
    loadRun: async (runId) => (runId === current.id ? structuredClone(current) : undefined),
    getActiveRunId: () => current.id,
    getWorkspace: () => ({ root: "/workspace", language: "zh", sources: [{ path: "src" }] }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retryNode: async () => current,
    retryPhase: async () => current,
    deleteRun: async () => {},
    pause: () => {},
    resume: async () => {},
    cancel: async () => {},
  };
}

function openDashboard(model, runId = run.id) {
  const state = new NavigatorState();
  state.openDashboard(runId);
  state.sync(model);
  return state;
}

test("phaseRows exposes the complete Wiki workflow map", () => {
  assert.equal(layoutForWidth(68), 2);
  assert.equal(layoutForWidth(67), 1);
  assert.deepEqual(phaseRows(run).map((phase) => [phase.title, phase.nodeIds.length]), [
    ["Inspect", 1], ["Research", 2], ["Plan", 0], ["Write", 1], ["Verify", 0],
  ]);
});

test("dashboard shows all stages before dynamic agents are scheduled without a timeline", () => {
  const initial = { ...run, nodes: [run.nodes[0]] };
  const model = new WikiUiModel(controllerFor(initial));
  const state = openDashboard(model, initial.id);
  const frame = plain(renderWikiNavigatorFrame(state, model, 100, PLAIN_THEME, 24, "en").join("\n"));
  assert.match(frame, /Inspect/);
  assert.match(frame, /Research/);
  assert.match(frame, /Plan/);
  assert.match(frame, /Write/);
  assert.match(frame, /Verify/);
  assert.doesNotMatch(frame, /Source Survey|Targeted Research|Domain Repair|Structural Re-synthesis/);
  assert.doesNotMatch(frame, /Timeline/);
});

test("dashboard gives remaining rows directly to stages", () => {
  const model = new WikiUiModel(controllerFor(run));
  const state = openDashboard(model);
  const lines = renderDashboard(state, run, 100, PLAIN_THEME, 5, "en").map(plain);
  assert.equal(lines.length, 5);
  assert.match(lines[2], /Stages/);
});

test("dashboard two-pane render includes stages and agents", () => {
  const model = new WikiUiModel(controllerFor(run));
  const state = openDashboard(model);
  state.move(1, phaseRows(run).length); // research
  state.sync(model);
  state.pane = "agents";
  const body = plain(renderDashboard(state, run, 100, PLAIN_THEME, 16, "en").join("\n"));
  assert.match(body, /Stages|Research/);
  assert.match(body, /Research workflow engine/);
  assert.match(body, /Research source citations/);
});

test("navigator stack is runs → dashboard → agent only", () => {
  const model = new WikiUiModel(controllerFor(run));
  const state = new NavigatorState();
  assert.equal(state.view, "runs");
  state.openDashboard(run.id);
  assert.equal(state.view, "dashboard");
  state.sync(model);
  state.move(1, phaseRows(run).length);
  state.sync(model);
  state.pane = "agents";
  state.sync(model);
  assert.equal(state.drill(model), true);
  assert.equal(state.view, "agent");
  assert.equal(state.pagerOpen, false);
  assert.equal(state.drill(model), true);
  assert.equal(state.pagerOpen, true);
  assert.equal(state.back(), true);
  assert.equal(state.pagerOpen, false);
  assert.equal(state.view, "agent");
  assert.equal(state.back(), true);
  assert.equal(state.view, "dashboard");
  assert.equal(state.back(), true);
  assert.equal(state.view, "runs");
});

test("agent retry target requires an agent context, never the focused stage's first agent", () => {
  const model = new WikiUiModel(controllerFor(run));
  const state = openDashboard(model);
  state.move(1, phaseRows(run).length); // research, whose first agent is research-a
  state.sync(model);

  assert.equal(state.pane, "stages");
  assert.equal(state.selectedAgentId(model), undefined);

  state.switchPane("agents");
  assert.equal(state.selectedAgentId(model), "research-a");

  assert.equal(state.drill(model), true);
  assert.equal(state.view, "agent");
  assert.equal(state.selectedAgentId(model), "research-a");
});

test("agent selection survives dashboard synchronization after arrow navigation", () => {
  const model = new WikiUiModel(controllerFor(run));
  const state = openDashboard(model);
  state.move(1, phaseRows(run).length); // research
  state.sync(model);
  state.switchPane("agents");

  state.move(1, model.agents(state.runId, state.stageId).length);
  state.sync(model); // mirrors the render after a keypress

  assert.equal(state.agentCursor, 1);
  assert.equal(state.selectedAgentId(model), "research-b");
});

test("agent compact view and attempt cycling", () => {
  const model = new WikiUiModel(controllerFor(run));
  const state = openDashboard(model);
  state.move(1, phaseRows(run).length);
  state.sync(model);
  state.pane = "agents";
  state.agentCursor = 0;
  state.sync(model);
  assert.equal(state.drill(model), true);
  const compact = plain(renderWikiNavigatorFrame(state, model, 100, PLAIN_THEME, 30, "en").join("\n"));
  assert.match(compact, /Agent: Research workflow engine/);
  assert.match(compact, /compact|Enter/);
  assert.deepEqual(attemptNumbers(run.nodes[1]), [1, 2]);
  state.cycleAttempt(-1, attemptNumbers(run.nodes[1]));
  assert.equal(state.selectedAttempt, 1);
  state.openPager();
  const pager = plain(renderWikiNavigatorFrame(state, model, 100, PLAIN_THEME, 40, "en").join("\n"));
  assert.match(pager, /Messages & tool calls|old output|archived/);
});

test("retry impact preserves upstream and invalidates downstream", () => {
  const impact = retryImpact(run, "research-a");
  assert.ok(impact);
  assert.deepEqual(impact.preservedUpstream, ["inspect"]);
  assert.ok(impact.invalidatedDownstream.includes("write"));
  assert.equal(impact.writesWiki, true);
  assert.equal(impact.rechecksGit, true);

  const completed = structuredClone(run);
  completed.status = "succeeded";
  for (const node of completed.nodes) node.status = "succeeded";
  const phase = phaseRetryImpact(completed, "research");
  assert.ok(phase);
  assert.deepEqual(phase.targetIds, ["research-a", "research-b"]);
});

test("key map covers dual-track navigator intents", () => {
  const state = new NavigatorState();
  assert.equal(keyToNavigatorIntent("q", state), "close");
  assert.equal(keyToNavigatorIntent("j", state), "moveDown");
  assert.equal(keyToNavigatorIntent("?", state), "help");
  state.openDashboard("run-1");
  assert.equal(keyToNavigatorIntent("tab", state), "paneToggle");
  assert.equal(keyToNavigatorIntent("l", state), "paneRight");
  assert.equal(keyToNavigatorIntent("h", state), "paneLeft");
  assert.equal(keyToNavigatorIntent("R", state), "retryPhase");
  assert.equal(keyToNavigatorIntent("r", state), "retry");
  assert.equal(keyToNavigatorIntent("c", state), "cancel");
  assert.equal(keyToNavigatorIntent("x", state), "delete");
  state.openConfirmation({ kind: "cancel", runId: "run-1", title: "Cancel?", message: "Keep output" });
  assert.equal(keyToNavigatorIntent("enter", state), "confirm");
  assert.equal(keyToNavigatorIntent("q", state), "back");
  assert.equal(keyToNavigatorIntent("j", state), "none");
});

test("task panel renders compact progress and retains terminal runs", () => {
  const active = renderPanel({ run, language: "en", retainTerminal: false }, PLAIN_THEME, 80, "compact");
  assert.match(plain(active.join("\n")), /Wiki running/);
  assert.match(plain(active.join("\n")), /\/wiki open/);

  const finished = structuredClone(run);
  finished.status = "succeeded";
  const kept = renderPanel({ run: finished, language: "en", retainTerminal: true }, PLAIN_THEME, 80, "compact");
  assert.match(plain(kept.join("\n")), /finished run kept|\/wiki open/);
  const dropped = renderPanel({ run: finished, language: "en", retainTerminal: false }, PLAIN_THEME, 80, "compact");
  assert.deepEqual(dropped, []);
});

test("status and history text stay concise for non-TUI commands", () => {
  assert.match(renderWikiRunText(run), /Wiki Run run-1/);
  assert.match(renderWikiRunText(run), /Research workflow engine/);
  const history = renderWikiRunHistoryText([summary(run)]);
  assert.match(history, /Wiki History/);
  assert.doesNotMatch(history, /run-1/);
});

test("blocked run text surfaces code, issues, and remaining budget", () => {
  const blocked = structuredClone(run);
  blocked.status = "blocked";
  blocked.blockedReason = "Validation produced the same unresolved error set twice";
  blocked.blockedDetails = {
    code: "same_validation_twice",
    issues: [
      { code: "link", page: "core/architecture.md", message: "broken link" },
      { code: "depth", page: "api/request-flow.md", message: "too shallow" },
    ],
    remainingBudget: { localRepairRounds: 0, used: 3 },
  };
  const text = renderWikiRunText(blocked);
  assert.match(text, /Blocked: Validation produced the same unresolved error set twice/);
  assert.match(text, /Code: same_validation_twice/);
  assert.match(text, /Remaining budget: localRepairRounds=0, used=3/);
  assert.match(text, /\[link\] core\/architecture\.md: broken link/);
  assert.match(text, /\[depth\] api\/request-flow\.md: too shallow/);
});

test("Navigator agent and artifact text surface persisted handoff refs", () => {
  const withArtifact = structuredClone(run);
  withArtifact.nodes[1].handoff = {
    version: 1,
    runId: "run-1",
    nodeId: "research-a",
    attempt: 2,
    kind: "research",
    relativePath: ".okf-wiki/runs/run-1/research-a/attempt-2/research.md",
    sha256: "a".repeat(64),
    sizeBytes: 321,
    mediaType: "text/markdown",
  };
  const model = new WikiUiModel(controllerFor(withArtifact));
  const state = openDashboard(model);
  state.move(1, phaseRows(withArtifact).length);
  state.sync(model);
  state.pane = "agents";
  state.agentCursor = 0;
  state.sync(model);
  assert.equal(state.drill(model), true);
  const frame = plain(renderWikiNavigatorFrame(state, model, 100, PLAIN_THEME, 28, "en").join("\n"));
  assert.match(frame, /Artifact: .*research\.md \(321 B\)/);
  assert.match(renderWikiArtifactText(withArtifact), /Research workflow engine \| attempt 2 \| research/);
});

test("runs list frame and empty state", () => {
  const emptyModel = new WikiUiModel({
    listRuns: () => [],
    getRun: () => undefined,
    loadRun: async () => undefined,
    getActiveRunId: () => undefined,
    subscribe: () => () => {},
    retryNode: async () => undefined,
    retryPhase: async () => undefined,
    deleteRun: async () => {},
    pause: () => {},
    resume: async () => {},
    cancel: async () => {},
  });
  const state = new NavigatorState();
  const empty = plain(renderWikiNavigatorFrame(state, emptyModel, 80, PLAIN_THEME, 12, "en").join("\n"));
  assert.match(empty, /No Wiki generation history/);

  const model = new WikiUiModel(controllerFor(run, [summary(run), { ...summary(run), id: "run-history", status: "succeeded", focus: "architecture" }]));
  const list = plain(renderWikiNavigatorFrame(new NavigatorState(), model, 80, PLAIN_THEME, 12, "en").join("\n"));
  assert.match(list, /Wiki Runs|architecture|Wiki generation/);
});

test("live navigator keeps a complete frame and refreshes SelectList entries on updates and resize", async () => {
  const summaries = Array.from({ length: 40 }, (_, index) => ({
    ...summary(run),
    id: `run-${index + 1}`,
    focus: `Run ${index + 1}`,
  }));
  const listeners = new Set();
  const controller = {
    ...controllerFor(run, summaries),
    getActiveRunId: () => undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const tui = {
    terminal: { rows: 24 },
    requestRender() {},
  };
  let component;
  const ui = {
    custom(factory) {
      return new Promise((resolve) => {
        component = factory(tui, PLAIN_THEME, {}, resolve);
      });
    },
    notify() {},
  };

  const pending = openWikiNavigator(ui, controller, { language: "en" });
  const initial = component.render(80).map(plain);
  assert.equal(initial.length, overlayRows(24));
  assert.match(initial[0], /^╭─ wiki workflow /);
  assert.match(initial[0], /╮$/);
  assert.match(initial.at(-1), /^╰─+╯$/);
  assert.ok(initial.slice(1, -1).every((line) => line.startsWith("│ ") && line.endsWith(" │")));

  component.handleInput("\x1b[B");
  summaries[0].focus = "Updated Run";
  summaries[0].status = "succeeded";
  for (const listener of listeners) listener();
  const refreshed = component.render(80).map(plain);
  assert.match(refreshed.join("\n"), /Updated Run/);
  assert.match(refreshed.find((line) => /Run 2/.test(line)), /^│ → /);

  tui.terminal.rows = 40;
  const resized = component.render(80).map(plain);
  assert.equal(resized.length, overlayRows(40));
  assert.ok(
    resized.filter((line) => /Run \d+/.test(line)).length > refreshed.filter((line) => /Run \d+/.test(line)).length,
    "resize should increase SelectList's visible window",
  );

  tui.terminal.rows = 5;
  const compact = component.render(80).map(plain);
  assert.equal(compact.length, overlayRows(5));
  assert.match(compact[0], /╮$/);
  assert.match(compact.at(-1), /^╰─+╯$/);

  component.dispose();
  await pending;
});

test("navigator resumes the selected recoverable history by run id", async () => {
  const historical = { ...structuredClone(run), id: "run-history", status: "paused" };
  const resumed = [];
  const controller = {
    ...controllerFor(historical),
    getActiveRunId: () => undefined,
    resume: async (runId) => { resumed.push(runId); },
  };
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  let component;
  const ui = {
    custom(factory) {
      return new Promise((resolve) => {
        component = factory(tui, PLAIN_THEME, {}, resolve);
      });
    },
    notify() {},
  };

  const pending = openWikiNavigator(ui, controller, { initialRunId: historical.id, language: "en" });
  component.handleInput("p");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(resumed, ["run-history"]);

  component.dispose();
  await pending;
});

test("navigator confirmation stays inside the overlay and keeps its keyboard ownership", async () => {
  const calls = [];
  const controller = {
    ...controllerFor(run),
    cancel: async () => { calls.push("cancel"); },
  };
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  let component;
  let doneCalls = 0;
  const ui = {
    custom(factory) {
      return new Promise((resolve) => {
        component = factory(tui, PLAIN_THEME, {}, (value) => {
          doneCalls++;
          resolve(value);
        });
      });
    },
    confirm: () => { throw new Error("navigator must not delegate confirmation to Pi"); },
    notify() {},
  };

  const pending = openWikiNavigator(ui, controller, { language: "en" });
  component.handleInput("c");
  assert.match(component.render(80).map(plain).join("\n"), /Cancel Wiki Run\?/);

  component.handleInput("q");
  assert.equal(doneCalls, 0, "q dismisses a confirmation before it closes the navigator");
  assert.doesNotMatch(component.render(80).map(plain).join("\n"), /Cancel Wiki Run\?/);

  component.handleInput("c");
  component.handleInput("\r");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["cancel"]);
  assert.equal(doneCalls, 0);

  component.handleInput("q");
  await pending;
  assert.equal(doneCalls, 1);
});

test("planning nodes are grouped into the Plan stage", () => {
  const synthesized = structuredClone(run);
  synthesized.nodes.splice(3, 0, {
    id: "synthesis",
    kind: "synthesis",
    label: "Synthesize Wiki specification",
    phaseId: "plan",
    phaseTitle: "Plan",
    status: "succeeded",
    dependsOn: ["research-a", "research-b"],
    attempt: 1,
    inputFingerprint: "",
    input: {},
    result: { decision: "finalize", spec: { domains: [] }, rationale: "Research is sufficient." },
    metrics: {},
    activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" },
    attemptHistory: [],
  });
  synthesized.nodes.find((node) => node.id === "write").dependsOn = ["synthesis"];
  assert.deepEqual(phaseRows(synthesized).map((phase) => [phase.title, phase.nodeIds.length]), [
    ["Inspect", 1], ["Research", 2], ["Plan", 1], ["Write", 1], ["Verify", 0],
  ]);
});

test("static validation, semantic review, and finalization share the Verify stage", () => {
  const verified = structuredClone(run);
  verified.nodes.push(
    {
      id: "validate",
      kind: "validate",
      label: "Validate Wiki",
      phaseId: "verify",
      phaseTitle: "Verify",
      status: "succeeded",
      dependsOn: ["write"],
      attempt: 1,
      inputFingerprint: "",
      input: { verificationGroupId: "verify:initial" },
      metrics: {},
      activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" },
      attemptHistory: [],
    },
    {
      id: "review",
      kind: "review",
      label: "Review Wiki",
      phaseId: "verify",
      phaseTitle: "Verify",
      status: "succeeded",
      dependsOn: ["validate"],
      attempt: 1,
      inputFingerprint: "",
      input: { verificationGroupId: "verify:initial" },
      metrics: {},
      activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" },
      attemptHistory: [],
    },
    {
      id: "finalize",
      kind: "finalize",
      label: "Finalize Wiki",
      phaseId: "verify",
      phaseTitle: "Verify",
      status: "succeeded",
      dependsOn: ["review"],
      attempt: 1,
      inputFingerprint: "",
      input: { verificationGroupId: "verify:initial" },
      metrics: {},
      activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" },
      attemptHistory: [],
    },
  );

  assert.deepEqual(phaseRows(verified).find((phase) => phase.id === "verify").nodeIds, ["validate", "review", "finalize"]);
  assert.deepEqual(phaseRetryImpact(verified, "verify").targetIds, ["validate", "review", "finalize"]);
});

test("agent pager G/end then k decreases scroll and leaves non-follow", () => {
  const model = new WikiUiModel(controllerFor(run));
  const state = openDashboard(model);
  state.move(1, phaseRows(run).length);
  state.sync(model);
  state.pane = "agents";
  state.agentCursor = 0;
  state.sync(model);
  assert.equal(state.drill(model), true);
  assert.equal(state.openPager(), true);
  assert.equal(state.followOutput, true);

  // Render once so lastMaxScroll is real (content is longer than viewport).
  renderWikiNavigatorFrame(state, model, 80, PLAIN_THEME, 14, "en");
  assert.ok(state.lastMaxScroll > 0, "pager content should exceed viewport");
  assert.equal(state.detailScroll, state.lastMaxScroll);

  state.jump("end", 0);
  assert.equal(state.followOutput, true);
  renderWikiNavigatorFrame(state, model, 80, PLAIN_THEME, 14, "en");
  const atEnd = state.detailScroll;
  assert.equal(atEnd, state.lastMaxScroll);

  state.move(-1, 0); // k
  assert.equal(state.followOutput, false);
  assert.equal(state.detailScroll, atEnd - 1);
  assert.ok(state.detailScroll < state.lastMaxScroll);

  // f off while at a mid position keeps non-follow and a clamped scroll.
  state.detailScroll = Math.max(0, state.lastMaxScroll - 2);
  state.followOutput = true;
  state.toggleFollow(); // turn off
  assert.equal(state.followOutput, false);
  renderWikiNavigatorFrame(state, model, 80, PLAIN_THEME, 14, "en");
  assert.equal(state.followOutput, false);
  assert.ok(state.detailScroll <= state.lastMaxScroll);
});

test("open landing uses dashboard only for an active run id", () => {
  // Mirrors openWikiNavigator landing: active id → dashboard, else runs list.
  const activeState = new NavigatorState();
  const activeId = "run-active";
  if (activeId) activeState.openDashboard(activeId);
  else activeState.openRuns();
  assert.equal(activeState.view, "dashboard");
  assert.equal(activeState.runId, "run-active");

  const idleState = new NavigatorState();
  const none = undefined;
  if (none) idleState.openDashboard(none);
  else idleState.openRuns();
  assert.equal(idleState.view, "runs");
});

test("confirm prompts localize cancel/delete titles", () => {
  assert.match(cancelConfirm("en").title, /Cancel/);
  assert.match(cancelConfirm("zh").title, /取消/);
  assert.match(deleteConfirm("en").message, /saved run record/i);
});

test("host retains terminal panel content across rebind", () => {
  const finished = structuredClone(run);
  finished.status = "succeeded";
  for (const node of finished.nodes) node.status = "succeeded";

  const snapshot = structuredClone(finished);
  const listeners = new Set();
  const engine = {
    getSnapshot: () => structuredClone(snapshot),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const widgets = [];
  const ui = {
    setStatus() {},
    setWidget(key, content) { widgets.push({ key, content }); },
    notify() {},
  };
  const pi = { sendMessage() {} };
  const host = new WikiUiHost();
  const controller = controllerFor(finished, [summary(finished)]);
  host.bind({
    engine,
    ui,
    pi,
    language: "en",
    getController: () => controller,
  });

  // Deliver terminal retention via engine event path.
  for (const listener of [...listeners]) {
    listener(snapshot, { kind: "run_completed", at: snapshot.updatedAt, id: "done-1" });
  }

  // Rebind (as /wiki open does) must not clear retained terminal panel state.
  host.bind({
    engine,
    ui,
    pi,
    language: "en",
    getController: () => controller,
  });

  const latestWidget = widgets.filter((item) => item.key === "okf-wiki-tasks" && item.content).at(-1);
  assert.ok(latestWidget, "task panel widget should remain installed after rebind");
  const component = latestWidget.content({}, PLAIN_THEME);
  const panelLines = component.render(80);
  assert.ok(panelLines.length > 0, "terminal panel should still render content after rebind");
  assert.match(plain(panelLines.join("\n")), /Wiki|\/wiki open|agents/i);

  host.unbind({ clearRetention: true });
});

test("host freezes lower status widgets while the navigator overlay is open", async () => {
  const snapshot = structuredClone(run);
  const listeners = new Set();
  const engine = {
    getSnapshot: () => structuredClone(snapshot),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const statuses = [];
  const widgets = [];
  let navigator;
  const ui = {
    setStatus(key, text) { statuses.push({ key, text }); },
    setWidget(key, content) { widgets.push({ key, content }); },
    notify() {},
    custom(factory) {
      return new Promise((resolve) => {
        navigator = factory({ terminal: { rows: 24 }, requestRender() {} }, PLAIN_THEME, {}, resolve);
      });
    },
  };
  const host = new WikiUiHost();
  host.bind({
    engine,
    ui,
    pi: { sendMessage() {} },
    language: "en",
    getController: () => controllerFor(run),
  });

  const pending = host.openNavigator({ ui, hasUI: true, mode: "tui" });
  assert.ok(navigator, "navigator overlay should open");
  assert.equal(widgets.at(-1).content, undefined, "task panel is removed before opening the overlay");
  const widgetCountWhileOpen = widgets.length;
  const statusCountWhileOpen = statuses.length;

  for (const listener of listeners) {
    listener(snapshot, { kind: "node_activity", at: snapshot.updatedAt, id: "activity-1" });
  }
  assert.equal(widgets.length, widgetCountWhileOpen, "live engine updates must not redraw beneath the overlay");
  assert.equal(statuses.length, statusCountWhileOpen, "status updates are held until the overlay closes");

  navigator.handleInput("q");
  await pending;
  assert.ok(widgets.at(-1).content, "task panel is restored after the overlay closes");
  assert.ok(statuses.length > statusCountWhileOpen, "latest status is restored after the overlay closes");

  host.unbind({ clearRetention: true });
});
