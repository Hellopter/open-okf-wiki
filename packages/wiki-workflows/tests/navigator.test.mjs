import assert from "node:assert/strict";
import test from "node:test";
import {
  createWikiNavigatorState,
  layoutForWidth,
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
  events: [
    { id: "event-1", at: "2026-08-08T00:00:01.000Z", kind: "node_started", nodeId: "research", message: "Research started" },
    { id: "event-2", at: "2026-08-08T00:00:02.000Z", kind: "node_activity", nodeId: "research", message: "Compacting context" },
  ],
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
      id: "research",
      kind: "research",
      label: "Research workflow engine",
      status: "running",
      dependsOn: ["plan"],
      attempt: 2,
      input: {},
      activity: { state: "compacting", message: "Compacting context", updatedAt: "2026-08-08T00:00:00.000Z", retryDelayMs: 1500 },
      metrics: { model: "openai/gpt-5", contextTokens: 90000, contextWindow: 128000, contextEstimated: true, compactions: 1, autoRetries: 2 },
      startedAt: "2026-08-08T00:00:00.000Z",
    },
    { id: "write", kind: "write", label: "Write Wiki pages", status: "queued", dependsOn: ["research"], attempt: 1, inputFingerprint: "", input: {}, metrics: {}, activity: { state: "idle", updatedAt: "2026-08-08T00:00:00.000Z" } },
  ],
};

test("selects the documented responsive layouts", () => {
  assert.equal(layoutForWidth(96), 3);
  assert.equal(layoutForWidth(72), 2);
  assert.equal(layoutForWidth(71), 1);
});

test("three-column rendering includes tree, telemetry, and Git scope", () => {
  const lines = renderWikiNavigator(createWikiNavigatorState(run), run, 120);
  const rendered = plain(lines.join("\n"));
  assert.match(rendered, /Nodes/);
  assert.match(rendered, /Node: Inspect Git scope/);
  assert.match(rendered, /Changed: 2 files/);

  const state = { ...createWikiNavigatorState(run), selectedNodeId: "research" };
  const telemetry = plain(renderWikiNavigator(state, run, 120).join("\n"));
  assert.match(telemetry, /Inspect/);
  assert.match(telemetry, /Plan/);
  assert.match(telemetry, /Research/);
  assert.match(telemetry, /selected/);
  assert.match(telemetry, /90,000 \/ 128,000 \(70%\) estimated/);
  assert.match(telemetry, /compactions 1/);
  assert.match(telemetry, /auto retries 2/);
  assert.match(telemetry, /Started: 2026-08-08 00:00:00Z/);
  assert.match(telemetry, /Recent run events/);
  assert.match(telemetry, /node_activity/);

  const relations = plain(renderWikiNavigator({ ...createWikiNavigatorState(run), selectedNodeId: "plan" }, run, 160).join("\n"));
  assert.match(relations, /\[succeeded\] <upstream> Inspect Git scope/);
  assert.match(relations, /\[running\] <downstream> Research/);
});

test("retry confirmation preserves upstream and invalidates only downstream", () => {
  const impact = retryImpact(run, "plan");
  assert.deepEqual(impact?.preservedUpstream, ["inspect"]);
  assert.deepEqual(impact?.invalidatedDownstream, ["research", "write"]);
  assert.equal(impact?.writesWiki, true);

  let state = { ...createWikiNavigatorState(run), selectedNodeId: "plan" };
  ({ state } = reduceWikiNavigator(state, "r", run));
  assert.deepEqual(state.confirmation, { kind: "retry", nodeId: "plan" });
  const transition = reduceWikiNavigator(state, "enter", run);
  assert.deepEqual(transition.action, { type: "retry", nodeId: "plan" });
  const rendered = plain(renderWikiNavigator(state, run, 80).join("\n"));
  assert.match(rendered, /Keep upstream: Inspect Git scope/);
  assert.match(rendered, /Re-run: Plan Wiki changes, Research workflow engine, Write Wiki pages/);
  assert.match(rendered, /can write wiki/);
});

test("running nodes refuse retry, while pause and cancel preserve explicit intent", () => {
  const running = { ...createWikiNavigatorState(run), selectedNodeId: "research" };
  const denied = reduceWikiNavigator(running, "r", run);
  assert.deepEqual(denied.action, { type: "notify", message: "Wait for the selected node to settle before retrying", level: "warning" });

  assert.deepEqual(reduceWikiNavigator(running, "p", run).action, { type: "pause" });
  const cancel = reduceWikiNavigator(running, "c", run);
  assert.deepEqual(cancel.state.confirmation, { kind: "cancel" });
  assert.deepEqual(reduceWikiNavigator(cancel.state, "enter", run).action, { type: "cancel" });
});

test("detail paging scrolls output and toggles live follow without changing node selection", () => {
  const state = { ...createWikiNavigatorState(run), selectedNodeId: "research", showDetail: true };
  const page = reduceWikiNavigator(state, "pageDown", run);
  assert.equal(page.state.selectedNodeId, "research");
  assert.equal(page.state.detailScroll, 12);
  assert.equal(page.state.followOutput, false);
  const follow = reduceWikiNavigator(page.state, "f", run);
  assert.equal(follow.state.followOutput, true);
  const start = reduceWikiNavigator(follow.state, "g", run);
  assert.equal(start.state.detailFromEnd, false);
  assert.equal(start.state.followOutput, false);
  const end = reduceWikiNavigator(start.state, "G", run);
  assert.equal(end.state.detailFromEnd, true);
  assert.equal(end.state.followOutput, true);

  const long = structuredClone(run);
  long.nodes[2].output = "word ".repeat(300);
  const output = plain(renderWikiNavigator(end.state, long, 70, undefined, 8).join("\n"));
  assert.match(output, /Output \d+-\d+\/\d+ follow/);
});

test("renders raw agent output beside the structured result", () => {
  const live = structuredClone(run);
  live.nodes[2].result = { evidence: "parsed" };
  live.nodes[2].output = "streamed evidence from the active agent";
  const rendered = plain(renderWikiNavigator({ ...createWikiNavigatorState(live), selectedNodeId: "research" }, live, 120).join("\n"));
  assert.match(rendered, /Result/);
  assert.match(rendered, /Output/);
  assert.match(rendered, /streamed evidence from the active agent/);
});

test("retry telemetry exposes attempt count and backoff", () => {
  const retrying = structuredClone(run);
  retrying.nodes[2].activity = {
    state: "retrying",
    message: "Provider retry",
    retryAttempt: 2,
    retryMaxAttempts: 3,
    retryDelayMs: 1500,
    updatedAt: "2026-08-08T00:00:03.000Z",
  };
  const rendered = plain(renderWikiNavigator({ ...createWikiNavigatorState(retrying), selectedNodeId: "research" }, retrying, 120).join("\n"));
  assert.match(rendered, /Provider retry 2\/3 in 1.5s/);
});

test("plain fallback exposes status and node failures without terminal UI", () => {
  const failed = structuredClone(run);
  failed.status = "blocked";
  failed.blockedReason = "Repeated review defects";
  failed.nodes[3].status = "failed";
  failed.nodes[3].error = { message: "wiki/index.md citation is invalid" };
  const text = renderWikiRunText(failed);
  assert.match(text, /Wiki Run run-1 \| refresh \| blocked/);
  assert.match(text, /Blocked: Repeated review defects/);
  assert.match(text, /Write Wiki pages \[failed\].*citation is invalid/);
});
