import assert from "node:assert/strict";
import test from "node:test";
import {
  createWikiNavigatorState,
  layoutForWidth,
  phaseRows,
  reduceWikiNavigator,
  renderWikiNavigator,
  renderWikiRunHistoryText,
  renderWikiRunText,
  phaseRetryImpact,
  retryImpact,
} from "../dist/navigator.js";

const plain = (value) => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

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
  version: 1,
  cwd: "/workspace",
  requestedMode: "refresh",
  effectiveMode: "refresh",
  language: "zh",
  status: "running",
  round: 2,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  events: [],
  inspection: { head: "abcdef0123456789", changedPaths: ["src/engine.ts", "src/ui.ts"] },
  nodes: [
    { id: "inspect", kind: "inspect", label: "Inspect Git scope", status: "succeeded", dependsOn: [], attempt: 1, inputFingerprint: "head:abc", input: {}, metrics: {}, activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" } },
    {
      id: "plan",
      kind: "plan",
      label: "Plan Wiki changes",
      status: "succeeded",
      dependsOn: ["inspect"],
      attempt: 1,
      inputFingerprint: "head:abc",
      input: {},
      result: { pages: ["wiki/architecture.md"] },
      metrics: {},
      activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" },
    },
    {
      id: "research-a",
      kind: "research",
      label: "Research workflow engine",
      status: "running",
      dependsOn: ["plan"],
      attempt: 2,
      input: {},
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
    { id: "research-b", kind: "research", label: "Research source citations", status: "queued", dependsOn: ["plan"], attempt: 1, inputFingerprint: "", input: {}, metrics: {}, activity: { state: "idle", updatedAt: "2026-08-08T00:00:00.000Z" } },
    { id: "write", kind: "write", label: "Write Wiki pages", status: "queued", dependsOn: ["research-a", "research-b"], attempt: 1, inputFingerprint: "", input: {}, metrics: {}, activity: { state: "idle", updatedAt: "2026-08-08T00:00:00.000Z" } },
  ],
};

function drillToResearchDetail(value = run) {
  let state = createWikiNavigatorState(value, [summary(value)]);
  ({ state } = reduceWikiNavigator(state, "enter", value, [summary(value)], value.id));
  ({ state } = reduceWikiNavigator(state, "down", value));
  ({ state } = reduceWikiNavigator(state, "down", value));
  ({ state } = reduceWikiNavigator(state, "enter", value));
  ({ state } = reduceWikiNavigator(state, "enter", value));
  return state;
}

test("keeps a sidebar only where the terminal has room", () => {
  assert.equal(layoutForWidth(68), 2);
  assert.equal(layoutForWidth(67), 1);
  assert.deepEqual(phaseRows(run).map((phase) => [phase.title, phase.nodeIds.length]), [
    ["Inspect", 1], ["Plan", 1], ["Research", 2], ["Write", 1],
  ]);
});

test("root view lists project history without exposing manual run IDs", () => {
  const rendered = plain(renderWikiNavigator(createWikiNavigatorState(), undefined, 80, undefined, 12, {
    root: "/docs",
    language: "en",
    sources: [{ path: "api" }, { path: "web" }],
  }).join("\n"));
  assert.match(rendered, /Wiki Runs/);
  assert.match(rendered, /No Wiki generation history yet/);

  const historical = { ...run, id: "run-history", status: "succeeded", focus: "architecture" };
  const history = plain(renderWikiNavigator(createWikiNavigatorState(run, [summary(run), summary(historical)]), run, 80, undefined, 12, undefined, [summary(run), summary(historical)], run.id).join("\n"));
  assert.match(history, /architecture/);
  assert.doesNotMatch(renderWikiRunHistoryText([summary(historical)]), /run-history/);
});

test("completed non-current history requires an explicit delete confirmation", () => {
  const historical = { ...run, id: "run-history", status: "succeeded", updatedAt: "2026-08-07T00:00:00.000Z" };
  const runs = [summary(run), summary(historical)];
  let state = createWikiNavigatorState(run, runs);
  ({ state } = reduceWikiNavigator(state, "down", run, runs, run.id));
  ({ state } = reduceWikiNavigator(state, "x", undefined, runs, run.id));
  assert.deepEqual(state.confirmation, { kind: "delete", runId: "run-history" });
  assert.deepEqual(reduceWikiNavigator(state, "enter", undefined, runs, run.id).action, { type: "deleteRun", runId: "run-history" });
  assert.match(plain(renderWikiNavigator(state, undefined, 80, undefined, 12, undefined, runs, run.id).join("\n")), /Delete Wiki History/);
});

test("drills from phase selection to a selected agent transcript", () => {
  let state = createWikiNavigatorState(run, [summary(run)]);
  ({ state } = reduceWikiNavigator(state, "enter", run, [summary(run)], run.id));
  const phaseScreen = plain(renderWikiNavigator(state, run, 100, undefined, 12).join("\n"));
  assert.match(phaseScreen, /Phases/);
  assert.match(phaseScreen, /Select a phase/);
  assert.match(phaseScreen, /Research 0\/2/);

  ({ state } = reduceWikiNavigator(state, "down", run));
  ({ state } = reduceWikiNavigator(state, "down", run));
  assert.equal(state.selectedNodeId, "research-a");
  ({ state } = reduceWikiNavigator(state, "enter", run));
  assert.equal(state.view, "agents");
  const agents = plain(renderWikiNavigator(state, run, 100, undefined, 12).join("\n"));
  assert.match(agents, /Research \| 2 agents/);
  assert.match(agents, /Research source citations/);

  ({ state } = reduceWikiNavigator(state, "enter", run));
  assert.equal(state.view, "detail");
  const detail = plain(renderWikiNavigator(state, run, 100, undefined, 40).join("\n"));
  assert.match(detail, /Messages & tool calls/);
  assert.match(detail, /assistant tool read/);
  assert.match(detail, /tool read/);
  assert.match(detail, /src\/engine\.ts/);
  assert.doesNotMatch(detail, /\{"path":"src\/engine\.ts"\}/);
  assert.doesNotMatch(detail, /2026.*tool read/);
  assert.match(detail, /Latest assistant output/);
  assert.match(detail, /streamed evidence from the active agent/);
  assert.match(detail, /Markdown handoff/);
  assert.match(detail, /90,000 \/ 128,000 \(70%\) estimated/);

  ({ state } = reduceWikiNavigator(state, "enter", run));
  const expanded = plain(renderWikiNavigator(state, run, 100, undefined, 40).join("\n"));
  assert.match(expanded, /\{"path":"src\/engine\.ts"\}/);

  ({ state } = reduceWikiNavigator(state, "[", run));
  const archived = plain(renderWikiNavigator(state, run, 100, undefined, 40).join("\n"));
  assert.match(archived, /attempt 1 \(archived\)/);
  assert.match(archived, /src\/old\.ts/);
});

test("protocol failures identify the required control submission in the detail view", () => {
  const failed = structuredClone(run);
  failed.nodes[2].status = "failed";
  failed.nodes[2].error = {
    message: "Agent did not call wiki_submit_plan before completing",
    code: "missing_submission",
    requiredSubmissionTool: "wiki_submit_plan",
  };
  const detail = plain(renderWikiNavigator(drillToResearchDetail(failed), failed, 100, undefined, 40).join("\n"));
  assert.match(detail, /Failure/);
  assert.match(detail, /Required submission: wiki_submit_plan/);
});

test("views render into a fixed-height viewport", () => {
  const state = drillToResearchDetail();
  const lines = renderWikiNavigator(state, run, 80, undefined, 11);
  assert.equal(lines.length, 11);
  assert.match(plain(lines.join("\n")), /\d+-\d+\/\d+ follow/);
});

test("g/G and scrolling remain local to the current view", () => {
  let state = createWikiNavigatorState(run, [summary(run)]);
  ({ state } = reduceWikiNavigator(state, "enter", run, [summary(run)], run.id));
  ({ state } = reduceWikiNavigator(state, "G", run));
  assert.equal(state.selectedNodeId, "write");
  ({ state } = reduceWikiNavigator(state, "g", run));
  assert.equal(state.selectedNodeId, "inspect");

  state = drillToResearchDetail();
  const page = reduceWikiNavigator(state, "pageDown", run);
  assert.equal(page.state.selectedNodeId, "research-a");
  assert.equal(page.state.detailScroll, 12);
  assert.equal(page.state.followOutput, false);
  const start = reduceWikiNavigator(page.state, "g", run);
  assert.equal(start.state.detailFromEnd, false);
  const end = reduceWikiNavigator(start.state, "G", run);
  assert.equal(end.state.detailFromEnd, true);
  assert.equal(end.state.followOutput, true);
});

test("escape follows the phase, agent, detail hierarchy", () => {
  let state = drillToResearchDetail();
  ({ state } = reduceWikiNavigator(state, "escape", run));
  assert.equal(state.view, "agents");
  ({ state } = reduceWikiNavigator(state, "escape", run));
  assert.equal(state.view, "phases");
  ({ state } = reduceWikiNavigator(state, "escape", run));
  assert.equal(state.view, "runs");
  assert.deepEqual(reduceWikiNavigator(state, "escape", run).action, { type: "close" });
});

test("retry confirmation preserves upstream and invalidates only downstream", () => {
  const impact = retryImpact(run, "plan");
  assert.deepEqual(impact?.preservedUpstream, ["inspect"]);
  assert.deepEqual(impact?.invalidatedDownstream, ["research-a", "research-b", "write"]);
  assert.equal(impact?.writesWiki, true);

  let state = createWikiNavigatorState(run, [summary(run)]);
  ({ state } = reduceWikiNavigator(state, "enter", run, [summary(run)], run.id));
  ({ state } = reduceWikiNavigator(state, "down", run));
  ({ state } = reduceWikiNavigator(state, "enter", run));
  ({ state } = reduceWikiNavigator(state, "r", run));
  assert.deepEqual(state.confirmation, { kind: "retry", nodeId: "plan" });
  const transition = reduceWikiNavigator(state, "enter", run);
  assert.deepEqual(transition.action, { type: "retry", runId: "run-1", nodeId: "plan" });
  const rendered = plain(renderWikiNavigator(state, run, 80).join("\n"));
  assert.match(rendered, /Keep upstream: Inspect Git scope/);
  assert.match(rendered, /can write wiki/);
});

test("phase retry groups explicit phase identities and refuses only running agents", () => {
  const completed = structuredClone(run);
  completed.status = "succeeded";
  for (const node of completed.nodes) {
    node.status = "succeeded";
    node.phaseId = node.kind === "research" ? "research:batch" : `phase:${node.id}`;
    node.phaseTitle = node.kind === "research" ? "Research" : undefined;
  }
  assert.deepEqual(phaseRows(completed).find((phase) => phase.id === "research:batch")?.nodeIds, ["research-a", "research-b"]);
  const impact = phaseRetryImpact(completed, "research:batch");
  assert.deepEqual(impact?.targetIds, ["research-a", "research-b"]);
  assert.deepEqual(impact?.invalidatedDownstream, ["write"]);

  let state = createWikiNavigatorState(completed, [summary(completed)]);
  ({ state } = reduceWikiNavigator(state, "enter", completed, [summary(completed)], completed.id));
  ({ state } = reduceWikiNavigator(state, "down", completed));
  ({ state } = reduceWikiNavigator(state, "down", completed));
  ({ state } = reduceWikiNavigator(state, "R", completed, [summary(completed)], completed.id));
  assert.deepEqual(state.confirmation, { kind: "retryPhase", phaseId: "research:batch" });
  assert.deepEqual(reduceWikiNavigator(state, "enter", completed).action, { type: "retryPhase", runId: "run-1", phaseId: "research:batch" });

  completed.nodes.find((node) => node.id === "research-a").status = "running";
  state = { ...state, confirmation: undefined };
  assert.deepEqual(reduceWikiNavigator(state, "R", completed, [summary(completed)], completed.id).action, {
    type: "notify",
    message: "Wait for running agents in the selected phase to settle before retrying it",
    level: "warning",
  });
});

test("running agents refuse retry, while pause and cancel preserve explicit intent", () => {
  const running = drillToResearchDetail();
  const denied = reduceWikiNavigator(running, "r", run, [summary(run)], run.id);
  assert.deepEqual(denied.action, { type: "notify", message: "Wait for the selected agent to settle before retrying", level: "warning" });

  assert.deepEqual(reduceWikiNavigator(running, "p", run, [summary(run)], run.id).action, { type: "pause" });
  const cancel = reduceWikiNavigator(running, "c", run, [summary(run)], run.id);
  assert.deepEqual(cancel.state.confirmation, { kind: "cancel" });
  assert.deepEqual(reduceWikiNavigator(cancel.state, "enter", run).action, { type: "cancel" });
});

test("plain fallback exposes status and node failures without terminal UI", () => {
  const failed = structuredClone(run);
  failed.status = "blocked";
  failed.blockedReason = "Repeated review defects";
  failed.nodes[4].status = "failed";
  failed.nodes[4].error = { message: "wiki/index.md citation is invalid" };
  const text = renderWikiRunText(failed);
  assert.match(text, /Wiki Run run-1 \| refresh \| blocked/);
  assert.match(text, /Blocked: Repeated review defects/);
  assert.match(text, /Write Wiki pages \[failed\].*citation is invalid/);
});
