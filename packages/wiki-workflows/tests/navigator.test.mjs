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
  version: 3,
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
    { id: "inspect", kind: "inspect", label: "Inspect Git scope", phaseId: "inspect", phaseTitle: "Inspect", status: "succeeded", dependsOn: [], attempt: 1, inputFingerprint: "head:abc", input: {}, metrics: {}, activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" } },
    {
      id: "research-a",
      kind: "research",
      label: "Research workflow engine",
      phaseId: "source-survey",
      phaseTitle: "Source Survey",
      status: "running",
      dependsOn: ["inspect"],
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
    { id: "research-b", kind: "research", label: "Research source citations", phaseId: "source-survey", phaseTitle: "Source Survey", status: "queued", dependsOn: ["inspect"], attempt: 1, inputFingerprint: "", input: {}, metrics: {}, activity: { state: "idle", updatedAt: "2026-08-08T00:00:00.000Z" } },
    { id: "write", kind: "write", label: "Write Wiki pages", phaseId: "domain-writing", phaseTitle: "Domain Writing", status: "queued", dependsOn: ["research-a", "research-b"], attempt: 1, inputFingerprint: "", input: {}, metrics: {}, activity: { state: "idle", updatedAt: "2026-08-08T00:00:00.000Z" } },
  ],
};

function drillToResearchDetail(value = run) {
  let state = createWikiNavigatorState(value, [summary(value)]);
  ({ state } = reduceWikiNavigator(state, "enter", value, [summary(value)], value.id));
  ({ state } = reduceWikiNavigator(state, "down", value));
  ({ state } = reduceWikiNavigator(state, "enter", value));
  ({ state } = reduceWikiNavigator(state, "enter", value));
  return state;
}

test("keeps a sidebar only where the terminal has room", () => {
  assert.equal(layoutForWidth(68), 2);
  assert.equal(layoutForWidth(67), 1);
  assert.deepEqual(phaseRows(run).map((phase) => [phase.title, phase.nodeIds.length]), [
    ["Inspect", 1], ["Source Survey", 2], ["Synthesis", 0], ["Targeted Research", 0], ["Domain Writing", 1],
    ["Validation", 0], ["Global Review", 0], ["Domain Repair", 0], ["Structural Re-synthesis", 0],
  ]);
});

test("shows the complete workflow before dynamic stages are scheduled", () => {
  const initial = { ...run, nodes: [run.nodes[0]] };
  let state = createWikiNavigatorState(initial, [summary(initial)]);
  ({ state } = reduceWikiNavigator(state, "enter", initial, [summary(initial)], initial.id));
  const allStages = plain(renderWikiNavigator(state, initial, 100, undefined, 20).join("\n"));
  assert.match(allStages, /Inspect 1\/1/);
  assert.match(allStages, /Source Survey not started/);
  assert.match(allStages, /Targeted Research conditional/);
  assert.match(allStages, /Structural Re-synthesis conditional/);

  ({ state } = reduceWikiNavigator(state, "down", initial));
  ({ state } = reduceWikiNavigator(state, "down", initial));
  ({ state } = reduceWikiNavigator(state, "down", initial));
  assert.equal(state.selectedPhaseId, "targeted-research");
  const selected = plain(renderWikiNavigator(state, initial, 100, undefined, 20).join("\n"));
  assert.match(selected, /Targeted Research \| conditional/);
  assert.match(selected, /Runs only when synthesis identifies an evidence gap/);
  assert.match(selected, /No agents are scheduled/);
  assert.doesNotMatch(selected, /R retry phase/);
  assert.equal(reduceWikiNavigator(state, "enter", initial).state.view, "phases");
  assert.deepEqual(reduceWikiNavigator(state, "R", initial).action, {
    type: "notify",
    message: "Targeted Research has not been scheduled yet",
    level: "info",
  });
});

test("renders synthesis as an independent control-submission stage", () => {
  const synthesized = structuredClone(run);
  synthesized.nodes.splice(3, 0, {
    id: "synthesis",
    kind: "synthesis",
    label: "Synthesize Wiki specification",
    phaseId: "synthesis",
    phaseTitle: "Synthesis",
    status: "succeeded",
    dependsOn: ["research-a", "research-b"],
    attempt: 1,
    inputFingerprint: "",
    input: {},
    result: { decision: "finalize", spec: { domains: [] }, rationale: "Research is sufficient." },
    metrics: {},
    activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" },
  });
  synthesized.nodes.find((node) => node.id === "write").dependsOn = ["synthesis"];

  assert.deepEqual(phaseRows(synthesized).map((phase) => [phase.title, phase.nodeIds.length]), [
    ["Inspect", 1], ["Source Survey", 2], ["Synthesis", 1], ["Targeted Research", 0], ["Domain Writing", 1],
    ["Validation", 0], ["Global Review", 0], ["Domain Repair", 0], ["Structural Re-synthesis", 0],
  ]);

  let state = createWikiNavigatorState(synthesized, [summary(synthesized)]);
  ({ state } = reduceWikiNavigator(state, "enter", synthesized, [summary(synthesized)], synthesized.id));
  ({ state } = reduceWikiNavigator(state, "down", synthesized));
  ({ state } = reduceWikiNavigator(state, "down", synthesized));
  ({ state } = reduceWikiNavigator(state, "enter", synthesized));
  ({ state } = reduceWikiNavigator(state, "enter", synthesized));
  const detail = plain(renderWikiNavigator(state, synthesized, 100, undefined, 40).join("\n"));
  assert.match(detail, /\| Synthesis/);
  assert.match(detail, /Control submission/);
  assert.match(detail, /finalize/);
});

test("phase retry confirmation targets only the latest synthesis iteration", () => {
  const repeated = structuredClone(run);
  for (const node of repeated.nodes) node.status = "succeeded";
  repeated.nodes.push(
    {
      id: "synthesis-expand",
      kind: "synthesis",
      label: "Synthesize Wiki specification",
      phaseId: "synthesis",
      phaseTitle: "Synthesis",
      status: "succeeded",
      dependsOn: ["research-a", "research-b"],
      attempt: 1,
      inputFingerprint: "",
      input: { round: 1 },
      metrics: {},
      activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" },
    },
    {
      id: "research-targeted",
      kind: "research",
      label: "Research persistence",
      phaseId: "targeted-research",
      phaseTitle: "Targeted Research",
      status: "succeeded",
      dependsOn: ["synthesis-expand"],
      attempt: 1,
      inputFingerprint: "",
      input: { batch: 1 },
      metrics: {},
      activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" },
    },
    {
      id: "synthesis-final",
      kind: "synthesis",
      label: "Re-synthesize Wiki specification",
      phaseId: "synthesis",
      phaseTitle: "Synthesis",
      status: "succeeded",
      dependsOn: ["research-targeted"],
      attempt: 1,
      inputFingerprint: "",
      input: { round: 2 },
      metrics: {},
      activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" },
    },
  );
  repeated.nodes.find((node) => node.id === "write").dependsOn = ["synthesis-final"];

  const impact = phaseRetryImpact(repeated, "synthesis");
  assert.deepEqual(impact?.targetIds, ["synthesis-final"]);
  assert.deepEqual(impact?.invalidatedDownstream, ["write"]);
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
  assert.match(phaseScreen, /Source Survey 0\/2/);

  ({ state } = reduceWikiNavigator(state, "down", run));
  assert.equal(state.selectedNodeId, "research-a");
  ({ state } = reduceWikiNavigator(state, "enter", run));
  assert.equal(state.view, "agents");
  const agents = plain(renderWikiNavigator(state, run, 100, undefined, 12).join("\n"));
  assert.match(agents, /Source Survey \| 2 agents/);
  assert.match(agents, /Research source citations/);

  ({ state } = reduceWikiNavigator(state, "enter", run));
  assert.equal(state.view, "detail");
  const detail = plain(renderWikiNavigator(state, run, 100, undefined, 40).join("\n"));
  assert.match(detail, /Messages & tool calls/);
  assert.match(detail, /tool read/);
  assert.doesNotMatch(detail, /assistant tool/);
  assert.match(detail, /src\/engine\.ts/);
  assert.doesNotMatch(detail, /\{"path":"src\/engine\.ts"\}/);
  assert.doesNotMatch(detail, /2026.*tool read/);
  assert.match(detail, /Latest assistant output/);
  assert.match(detail, /streamed evidence from the active agent/);
  assert.match(detail, /Markdown handoff/);
  assert.match(detail, /90,000 \/ 128,000 \(70%\) estimated/);
  assert.match(detail, /Execution \| Context: 90,000 \/ 128,000 \(70%\) estimated/);

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
  failed.nodes[1].status = "failed";
  failed.nodes[1].error = {
    message: "Agent did not call wiki_submit_synthesis before completing",
    code: "missing_submission",
    requiredSubmissionTool: "wiki_submit_synthesis",
  };
  const detail = plain(renderWikiNavigator(drillToResearchDetail(failed), failed, 100, undefined, 40).join("\n"));
  assert.match(detail, /Failure/);
  assert.match(detail, /Required submission: wiki_submit_synthesis/);
});

test("views render into a fixed-height viewport", () => {
  const state = drillToResearchDetail();
  const lines = renderWikiNavigator(state, run, 80, undefined, 11);
  assert.equal(lines.length, 11);
  assert.match(plain(lines.join("\n")), /\d+-\d+\/\d+ follow/);
});

test("keeps execution stats at the bottom of the agent detail", () => {
  const state = drillToResearchDetail();
  const detail = plain(renderWikiNavigator(state, run, 80, undefined, 18).join("\n"));
  const execution = detail.indexOf("Execution | Context:");
  const controls = detail.indexOf("j/k scroll");
  assert.ok(execution > detail.indexOf("Markdown handoff"));
  assert.ok(execution < controls);
});

test("pins navigator controls to the footer and gives execution states distinct icons", () => {
  const runs = [summary(run)];
  const root = renderWikiNavigator(createWikiNavigatorState(run, runs), run, 80, undefined, 12, undefined, runs, run.id);
  assert.equal(plain(root.at(-2)).trim(), "");
  assert.match(plain(root.at(-1)), /j\/k runs/);
  assert.match(plain(root.join("\n")), /●/);

  let state = createWikiNavigatorState(run, runs);
  ({ state } = reduceWikiNavigator(state, "enter", run, runs, run.id));
  const phases = renderWikiNavigator(state, run, 80, undefined, 12, undefined, runs, run.id);
  assert.equal(plain(phases.at(-2)).trim(), "");
  assert.match(plain(phases.at(-1)), /j\/k phases/);
  assert.match(plain(phases.join("\n")), /✓/);
  assert.doesNotMatch(plain(phases.join("\n")), /✓✓|●●/);

  const detail = renderWikiNavigator(drillToResearchDetail(), run, 80, undefined, 12, undefined, runs, run.id);
  assert.equal(plain(detail.at(-2)).trim(), "");
  assert.match(plain(detail.at(-1)), /j\/k scroll/);

  const succeeded = { ...run, status: "succeeded" };
  const failed = { ...run, status: "failed" };
  assert.match(plain(renderWikiNavigator(createWikiNavigatorState(succeeded, [summary(succeeded)]), succeeded, 80, undefined, 12, undefined, [summary(succeeded)], succeeded.id).join("\n")), /✓/);
  assert.match(plain(renderWikiNavigator(createWikiNavigatorState(failed, [summary(failed)]), failed, 80, undefined, 12, undefined, [summary(failed)], failed.id).join("\n")), /✗/);
});

test("g/G and scrolling remain local to the current view", () => {
  let state = createWikiNavigatorState(run, [summary(run)]);
  ({ state } = reduceWikiNavigator(state, "enter", run, [summary(run)], run.id));
  ({ state } = reduceWikiNavigator(state, "G", run));
  assert.equal(state.selectedPhaseId, "structural-resynthesis");
  assert.equal(state.selectedNodeId, undefined);
  ({ state } = reduceWikiNavigator(state, "g", run));
  assert.equal(state.selectedPhaseId, "inspect");
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
  const retryable = structuredClone(run);
  retryable.nodes.find((node) => node.id === "research-a").status = "succeeded";
  const impact = retryImpact(retryable, "research-a");
  assert.deepEqual(impact?.preservedUpstream, ["inspect"]);
  assert.deepEqual(impact?.invalidatedDownstream, ["write"]);
  assert.equal(impact?.writesWiki, true);

  let state = createWikiNavigatorState(retryable, [summary(retryable)]);
  ({ state } = reduceWikiNavigator(state, "enter", retryable, [summary(retryable)], retryable.id));
  ({ state } = reduceWikiNavigator(state, "down", retryable));
  ({ state } = reduceWikiNavigator(state, "enter", retryable));
  ({ state } = reduceWikiNavigator(state, "r", retryable));
  assert.deepEqual(state.confirmation, { kind: "retry", nodeId: "research-a" });
  const transition = reduceWikiNavigator(state, "enter", retryable);
  assert.deepEqual(transition.action, { type: "retry", runId: "run-1", nodeId: "research-a" });
  const rendered = plain(renderWikiNavigator(state, retryable, 80).join("\n"));
  assert.match(rendered, /Keep upstream: Inspect Git scope/);
  assert.match(rendered, /can write wiki/);
});

test("phase retry groups explicit phase identities and refuses only running agents", () => {
  const completed = structuredClone(run);
  completed.status = "succeeded";
  for (const node of completed.nodes) {
    node.status = "succeeded";
    node.phaseId = node.kind === "research" ? "source-survey" : node.kind === "write" ? "domain-writing" : "inspect";
    node.phaseTitle = node.kind === "research" ? "Source Survey" : undefined;
  }
  assert.deepEqual(phaseRows(completed).find((phase) => phase.id === "source-survey")?.nodeIds, ["research-a", "research-b"]);
  const impact = phaseRetryImpact(completed, "source-survey");
  assert.deepEqual(impact?.targetIds, ["research-a", "research-b"]);
  assert.deepEqual(impact?.invalidatedDownstream, ["write"]);

  let state = createWikiNavigatorState(completed, [summary(completed)]);
  ({ state } = reduceWikiNavigator(state, "enter", completed, [summary(completed)], completed.id));
  ({ state } = reduceWikiNavigator(state, "down", completed));
  ({ state } = reduceWikiNavigator(state, "R", completed, [summary(completed)], completed.id));
  assert.deepEqual(state.confirmation, { kind: "retryPhase", phaseId: "source-survey" });
  assert.deepEqual(reduceWikiNavigator(state, "enter", completed).action, { type: "retryPhase", runId: "run-1", phaseId: "source-survey" });

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
  failed.nodes[3].status = "failed";
  failed.nodes[3].error = { message: "wiki/index.md citation is invalid" };
  const text = renderWikiRunText(failed);
  assert.match(text, /Wiki Run run-1 \| refresh \| blocked/);
  assert.match(text, /Blocked: Repeated review defects/);
  assert.match(text, /Write Wiki pages \[failed\].*citation is invalid/);
});
