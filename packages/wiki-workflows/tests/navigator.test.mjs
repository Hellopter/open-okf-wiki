import assert from "node:assert/strict";
import test from "node:test";
import {
  createWikiNavigatorState,
  layoutForWidth,
  phaseRows,
  reduceWikiNavigator,
  renderWikiNavigator,
  renderWikiRunText,
  retryImpact,
} from "../dist/navigator.js";

const plain = (value) => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

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
        { at: "2026-08-08T00:00:02.000Z", kind: "tool_call", toolName: "read", text: "{\"path\":\"src/engine.ts\"}" },
        { at: "2026-08-08T00:00:03.000Z", kind: "tool_result", toolName: "read", text: "export class WikiWorkflowEngine {}" },
      ],
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
  let state = createWikiNavigatorState(value);
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

test("idle console exposes the configured workspace without creating a run", () => {
  const rendered = plain(renderWikiNavigator(createWikiNavigatorState(), undefined, 80, undefined, 12, {
    root: "/docs",
    language: "en",
    sources: [{ path: "api" }, { path: "web" }],
  }).join("\n"));
  assert.match(rendered, /Wiki Workspace/);
  assert.match(rendered, /Path: \/docs/);
  assert.match(rendered, /Language: English/);
  assert.match(rendered, /Sources: api, web/);
  assert.match(rendered, /No Wiki run/);
});

test("drills from phase selection to a selected agent transcript", () => {
  let state = createWikiNavigatorState(run);
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
  assert.match(detail, /Latest assistant output/);
  assert.match(detail, /streamed evidence from the active agent/);
  assert.match(detail, /Markdown handoff/);
  assert.match(detail, /90,000 \/ 128,000 \(70%\) estimated/);
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
  let state = createWikiNavigatorState(run);
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
  assert.deepEqual(reduceWikiNavigator(state, "escape", run).action, { type: "close" });
});

test("retry confirmation preserves upstream and invalidates only downstream", () => {
  const impact = retryImpact(run, "plan");
  assert.deepEqual(impact?.preservedUpstream, ["inspect"]);
  assert.deepEqual(impact?.invalidatedDownstream, ["research-a", "research-b", "write"]);
  assert.equal(impact?.writesWiki, true);

  let state = createWikiNavigatorState(run);
  ({ state } = reduceWikiNavigator(state, "down", run));
  ({ state } = reduceWikiNavigator(state, "enter", run));
  ({ state } = reduceWikiNavigator(state, "r", run));
  assert.deepEqual(state.confirmation, { kind: "retry", nodeId: "plan" });
  const transition = reduceWikiNavigator(state, "enter", run);
  assert.deepEqual(transition.action, { type: "retry", nodeId: "plan" });
  const rendered = plain(renderWikiNavigator(state, run, 80).join("\n"));
  assert.match(rendered, /Keep upstream: Inspect Git scope/);
  assert.match(rendered, /can write wiki/);
});

test("running agents refuse retry, while pause and cancel preserve explicit intent", () => {
  const running = drillToResearchDetail();
  const denied = reduceWikiNavigator(running, "r", run);
  assert.deepEqual(denied.action, { type: "notify", message: "Wait for the selected agent to settle before retrying", level: "warning" });

  assert.deepEqual(reduceWikiNavigator(running, "p", run).action, { type: "pause" });
  const cancel = reduceWikiNavigator(running, "c", run);
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
