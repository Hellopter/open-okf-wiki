import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWikiDelegateContract, WikiTaskExecutionError } from "../dist/delegate-contracts.js";
import { createPiLeadRuntime, PiWikiLeafAgent } from "../dist/lead-runtime.js";
import { materializeProductionSkill } from "../dist/skill-store.js";
import { wikiPlanParameters } from "../dist/wiki-spec.js";
import { PiSessionObserver } from "../dist/pi-session-observer.js";
import { WikiTaskRuntime } from "../dist/task-runtime.js";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-lead-"));
  t.after(async () => await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  await mkdir(path.join(root, "wiki"), { recursive: true });
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "a.ts"), "export const a = true;\n");
  await import("node:child_process").then(({ execFileSync }) => execFileSync("git", ["init", "--quiet"], { cwd: source }));
  await writeFile(path.join(root, "workspace.yaml"), [
    "version: 1", "language: en", "defaultSourceIgnores: true",
    "quality:", "  maxResearchRounds: 6", "  maxSubmissionAttempts: 3",
    "wiki:", "  exclude: []",
    "sources:", "  - path: source", "    origin:", "      type: link", `      localPath: ${JSON.stringify(source)}`, "",
  ].join("\n"));
  const candidateWikiRoot = path.join(root, ".okf-wiki", "runs", "run-1", "candidate", "wiki");
  await mkdir(candidateWikiRoot, { recursive: true });
  await writeFile(path.join(root, ".okf-wiki", "runs", "run-1", "run-state.json"), JSON.stringify({ version: 2, id: "run-1", status: "running", attempt: 1, executionToken: "execution-1" }));
  const skillRoot = await materializeProductionSkill(root, "run-1");
  return { root, candidateWikiRoot, skillRoot };
}

function request(root, candidateWikiRoot, skillRoot = path.join(root, ".okf-wiki", "runs", "run-1", "skill")) {
  return {
    runId: "run-1", cwd: root, preparation: "fresh", focus: undefined,
    sourcePlan: pinnedPlan(root), sourceFingerprint: "a".repeat(64), candidateWikiRoot, skillRoot, sourceScopeIds: ["source"], prompt: "Build the Wiki", attempt: 1, executionToken: "execution-1",
    signal: new AbortController().signal, record: async () => {}, generation, language: "en",
  };
}

function pinnedPlan(root) {
  const source = path.join(root, "source");
  return {
    workspaceRoot: root, workspaceRealPath: root, configPath: path.join(root, "workspace.yaml"), defaultSourceIgnores: true, excludes: [], fingerprint: "a".repeat(64),
    sources: [{ scopeId: "source", logicalPath: "source", absolutePath: source, realPath: source, repositoryRoot: source, repositoryIdentity: "test-source", head: "0".repeat(40), dirtyFingerprint: "b".repeat(64) }],
  };
}

const generation = { audience: [], purpose: "", focus: { include: [], exclude: [] }, granularity: { preferChildPagesFor: [] }, templates: { requiredSections: [] }, review: { mustCover: [] } };
const transactionalWriter = { async replacePage() {} };

function page(pageType, pagePath) {
  return { pageType, path: pagePath, title: pagePath, purpose: "Document behavior", readerQuestions: [], requiredFacets: [], findingIds: [] };
}

function spec(extraPages = [], domains = 1) {
  return {
    version: 1,
    overview: page("overview", "overview.md"),
    domains: Array.from({ length: domains }, (_, index) => {
      const id = index === 0 ? "core" : `domain-${index + 1}`;
      return { id, title: id, purpose: "Domain behavior", pages: [page("domain", `${id}/domain.md`), ...(index === 0 ? extraPages : [])] };
    }),
    crossLinks: [], sharedTerms: [], omissions: [],
  };
}

function validWikiPage(type, title) {
  return ["---", `type: ${type}`, `title: ${title}`, "description: Runtime behavior", "sources:", "  - id: source-a", "    resource: repo:source/a.ts#L1-L1", "---", "", "Runtime behavior is defined in source.[^source-a]", "", "[^source-a]: [Source](repo:source/a.ts#L1-L1)", ""].join("\n");
}

async function seedGovernedCandidate(candidateWikiRoot) {
  await mkdir(path.join(candidateWikiRoot, "core"), { recursive: true });
  await writeFile(path.join(candidateWikiRoot, "overview.md"), validWikiPage("Overview", "Overview"));
  await writeFile(path.join(candidateWikiRoot, "core", "domain.md"), validWikiPage("Domain", "Core"));
}

function sessionFactory(prompt) {
  return async (options) => {
    let aborted = false;
    const session = {
      state: {},
      messages: [],
      subscribe() { return () => {}; },
      setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
      async prompt(value) { await prompt(options.customTools, value, () => aborted); },
      async waitForIdle() {}, async abort() { aborted = true; }, dispose() {},
      getLastAssistantText() { return "done"; },
    };
    return { session };
  };
}

async function call(tools, name, params) {
  const tool = tools.find((value) => value.name === name);
  assert.ok(tool, `missing ${name}`);
  return await tool.execute("call-1", params, new AbortController().signal);
}

async function delegateAndCollect(tools, tasks, timeoutSeconds = 60) {
  const started = await call(tools, "wiki_delegate_start", { tasks });
  return await call(tools, "wiki_delegate_collect", {
    batchId: started.details.batchId,
    until: "all",
    timeoutSeconds,
  });
}

async function runtimeDelegate(runtime, tasks) {
  const signal = new AbortController().signal;
  const batchId = runtimeBatches.get(runtime) ?? 1;
  runtimeBatches.set(runtime, batchId + 1);
  const contracts = tasks.map((task) => createWikiDelegateContract(batchId, task, task.role === "review" ? { version: 1, candidateRevision: 1, treeDigest: "a".repeat(64), policyDigest: "b".repeat(64), paths: task.reviewPaths } : undefined));
  const started = await runtime.start(contracts, signal);
  return await runtime.collect(started.batchId, { until: "all", timeoutSeconds: 60 }, signal);
}

const runtimeBatches = new WeakMap();
function runtimeTransitions() {
  const batches = new Map();
  const saved = (batchId, taskId) => batches.get(batchId).get(taskId);
  return {
    async batchQueued(contracts) { batches.set(contracts[0].batchId, new Map(contracts.map((task) => [task.id, { task, phase: "queued", attempt: 0, collected: false }]))); },
    async taskStarted(batchId, taskId, input) { Object.assign(saved(batchId, taskId), { phase: "running", attempt: input.attempt, sessionFile: input.sessionFile, partial: input.partial }); },
    async taskPaused(batchId, taskId, input) { Object.assign(saved(batchId, taskId), { phase: "paused", attempt: input.attempt, pause: input.pause }); },
    async taskSettled(batchId, taskId, input) { Object.assign(saved(batchId, taskId), { phase: "terminal", receipt: input.receipt }); },
    async tasksCollected(batchId, taskIds) { for (const taskId of taskIds) saved(batchId, taskId).collected = true; },
  };
}

test("governed Lead rejects writes before wiki_plan without replacing an existing page", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const target = path.join(candidateWikiRoot, "overview.md");
  await writeFile(target, "existing\n");
  const runtime = createPiLeadRuntime({ createSession: sessionFactory(async (tools) => {
    await call(tools, "write", { path: "wiki/overview.md", content: "invalid replacement\n" });
  }) });
  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /wiki_plan before writing/);
  assert.equal(await readFile(target, "utf8"), "existing\n");
});

test("pre-write validation rejects invalid replacement after planning and preserves prior content", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const target = path.join(candidateWikiRoot, "overview.md");
  await writeFile(target, "existing\n");
  const runtime = createPiLeadRuntime({ createSession: sessionFactory(async (tools) => {
    await call(tools, "wiki_plan", { spec: spec() });
    await call(tools, "write", { path: "wiki/overview.md", content: "invalid replacement\n" });
  }) });
  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /validation failed before write/);
  assert.equal(await readFile(target, "utf8"), "existing\n");
});

test("governed Lead direct writes are disabled for multi-domain plans", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const runtime = createPiLeadRuntime({ createSession: sessionFactory(async (tools) => {
    await call(tools, "wiki_plan", { spec: spec([], 2) });
    await call(tools, "write", { path: "wiki/overview.md", content: "invalid\n" });
  }) });
  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /direct writing is disabled/);
});

test("wiki_delegate_start forbids mixing write and review in one revision snapshot", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const runtime = createPiLeadRuntime({ createSession: sessionFactory(async (tools) => {
    await call(tools, "wiki_plan", { spec: spec() });
    await call(tools, "wiki_delegate_start", { tasks: [
      { id: "write", role: "write", instruction: "write", sourceScopeIds: [], contextRefs: [], writePaths: ["wiki/overview.md"] },
      { id: "review", role: "review", instruction: "review", sourceScopeIds: [], contextRefs: [], reviewPaths: ["wiki/overview.md"] },
    ] });
  }) });
  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /may not mix write and review/);
});

test("governed Lead direct writes are disabled above three pages and permanently after compaction", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const large = spec([page("flow", "core/flows/runtime.md"), page("concept", "core/concepts/runtime.md")]);
  const largeRuntime = createPiLeadRuntime({ createSession: sessionFactory(async (tools) => {
    await call(tools, "wiki_plan", { spec: large });
    await call(tools, "write", { path: "wiki/overview.md", content: "invalid\n" });
  }) });
  await assert.rejects(largeRuntime.run(request(root, candidateWikiRoot)), /direct writing is disabled/);

  const compactRoot = await workspace(t);
  const compactRuntime = createPiLeadRuntime({ createSession: async (options) => {
    let listener;
    return { session: {
      state: {}, messages: [],
      subscribe(value) { listener = value; return () => { listener = undefined; }; },
      setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
      async prompt() {
        await call(options.customTools, "wiki_plan", { spec: spec() });
        listener({ type: "compaction_start", reason: "threshold" });
        listener({ type: "compaction_end", reason: "threshold", result: {}, aborted: false, willRetry: false });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await call(options.customTools, "write", { path: "wiki/overview.md", content: "invalid\n" });
      },
      async waitForIdle() {}, async abort() {}, dispose() {}, getLastAssistantText() { return ""; },
    } };
  } });
  await assert.rejects(compactRuntime.run(request(compactRoot.root, compactRoot.candidateWikiRoot)), /after context compaction/);
});

test("wiki_finish requires current pass review coverage and accepts a structured independent pass", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  await seedGovernedCandidate(candidateWikiRoot);
  let sessions = 0;
  const planned = spec();
  const reviewPaths = ["wiki/overview.md", "wiki/core/domain.md"];
  const runtime = createPiLeadRuntime({ createSession: async (options) => {
    sessions += 1;
    return sessionFactory(async (tools) => {
      if (sessions === 1) {
        await call(tools, "wiki_plan", { spec: planned });
        await assert.rejects(call(tools, "wiki_finish", { summary: "too early" }), /lacks passing independent review/);
        const started = await call(tools, "wiki_delegate_start", { tasks: [{ id: "review-all", role: "review", instruction: "review", sourceScopeIds: [], contextRefs: [], reviewPaths }] });
        await assert.rejects(call(tools, "wiki_finish", { summary: "active" }), /terminal state/);
        await call(tools, "wiki_delegate_collect", { batchId: started.details.batchId, until: "all", timeoutSeconds: 60 });
        await call(tools, "wiki_finish", { summary: "reviewed" });
      } else {
        const index = await call(tools, "read", { path: "wiki/index.md" });
        assert.match(JSON.stringify(index), /Overview/);
        await call(tools, "wiki_review_finish", { verdict: "pass", reviewedPaths: reviewPaths, findings: [], profileCoverage: [] });
      }
    })(options);
  } });
  assert.deepEqual(await runtime.run(request(root, candidateWikiRoot)), { kind: "complete", summary: "reviewed" });
});

test("changes_requested and stale spec-revision reviews block wiki_finish", async (t) => {
  for (const stale of [false, true]) {
    const { root, candidateWikiRoot } = await workspace(t);
    await seedGovernedCandidate(candidateWikiRoot);
    let sessions = 0;
    const planned = spec();
    const reviewPaths = ["wiki/overview.md", "wiki/core/domain.md"];
    const runtime = createPiLeadRuntime({ createSession: async (options) => {
      sessions += 1;
      return sessionFactory(async (tools) => {
        if (sessions === 1) {
          await call(tools, "wiki_plan", { spec: planned });
          await delegateAndCollect(tools, [{ id: "review-all", role: "review", instruction: "review", sourceScopeIds: [], contextRefs: [], reviewPaths }]);
          if (stale) await call(tools, "wiki_plan", { spec: planned });
          await call(tools, "wiki_finish", { summary: "blocked" });
        } else {
          await call(tools, "wiki_review_finish", {
            verdict: stale ? "pass" : "changes_requested", reviewedPaths: reviewPaths,
            findings: stale ? [] : [{ path: "wiki/overview.md", severity: "major", message: "Missing evidence", evidence: ["src/a.ts#L1"], suggestion: "Add evidence" }],
            profileCoverage: [],
          });
        }
      })(options);
    } });
    await assert.rejects(runtime.run(request(root, candidateWikiRoot)), stale ? /lacks passing independent review/ : /requested changes/);
  }
});

test("review receipt is rejected when a concurrent write changes its captured revision", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  await seedGovernedCandidate(candidateWikiRoot);
  const reviewPaths = ["wiki/overview.md", "wiki/core/domain.md"];
  let sessions = 0;
  let signalStarted;
  let releaseReview;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const released = new Promise((resolve) => { releaseReview = resolve; });
  const runtime = createPiLeadRuntime({ createSession: async (options) => {
    sessions += 1;
    return sessionFactory(async (tools) => {
      if (sessions === 1) {
        await call(tools, "wiki_plan", { spec: spec() });
        const startedBatch = await call(tools, "wiki_delegate_start", { tasks: [{ id: "review", role: "review", instruction: "review", sourceScopeIds: [], contextRefs: [], reviewPaths }] });
        await started;
        await call(tools, "write", { path: "wiki/overview.md", content: validWikiPage("Overview", "Overview") });
        releaseReview();
        const receipt = await call(tools, "wiki_delegate_collect", { batchId: startedBatch.details.batchId, until: "all", timeoutSeconds: 60 });
        assert.equal(receipt.details.receipts[0].status, "incomplete");
        await call(tools, "wiki_finish", { summary: "blocked" });
      } else {
        signalStarted();
        await released;
        await call(tools, "wiki_review_finish", { verdict: "pass", reviewedPaths: reviewPaths, findings: [], profileCoverage: [] });
      }
    })(options);
  } });
  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /lacks passing independent review/);
});

test("Lead projects duplicate task IDs independently by runtime batchId", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const reports = [];
  const runtime = createPiLeadRuntime({
    createSession: async (options) => sessionFactory(async (tools) => {
      if (tools.some((tool) => tool.name === "wiki_delegate_start")) {
        const task = { id: "same-id", role: "research", instruction: "research", sourceScopeIds: ["source"], contextRefs: [] };
        const first = await call(tools, "wiki_delegate_start", { tasks: [task] });
        const second = await call(tools, "wiki_delegate_start", { tasks: [task] });
        await call(tools, "wiki_delegate_collect", { batchId: first.details.batchId, until: "all", timeoutSeconds: 60 });
        await call(tools, "wiki_delegate_collect", { batchId: second.details.batchId, until: "all", timeoutSeconds: 60 });
      } else {
        await call(tools, "wiki_research_finish", { status: "complete", summary: "done", coverage: [], gaps: [] });
      }
    })(options),
  });
  const input = request(root, candidateWikiRoot);
  input.record = async (observation) => { if (observation.kind === "batch" && observation.phase === "completed") reports.push(observation); };
  await assert.rejects(runtime.run(input), /without wiki_finish/);

  assert.deepEqual(new Set(reports.map((data) => data.batch)), new Set([1, 2]));
  assert.ok(reports.every((data) => data.tasks.length === 1 && data.tasks[0].id === "same-id"));
});

test("wiki_finish rejects terminal delegated receipts that were not collected", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let terminalReported;
  const terminal = new Promise((resolve) => { terminalReported = resolve; });
  const runtime = createPiLeadRuntime({
    createSession: async (options) => sessionFactory(async (tools) => {
      if (tools.some((tool) => tool.name === "wiki_delegate_start")) {
        await call(tools, "wiki_plan", { spec: spec() });
        await call(tools, "wiki_delegate_start", { tasks: [{ id: "research", role: "research", instruction: "research", sourceScopeIds: ["source"], contextRefs: [] }] });
        await terminal;
        await call(tools, "wiki_finish", { summary: "not collected" });
      } else {
        await call(tools, "wiki_research_finish", { status: "complete", summary: "done", coverage: [], gaps: [] });
      }
    })(options),
  });
  const input = request(root, candidateWikiRoot);
  input.record = async (observation) => { if (observation.kind === "batch" && observation.phase === "completed" && observation.taskId === "research") terminalReported(); };
  await assert.rejects(runtime.run(input), /terminal delegated receipt to be collected/);
});

test("active delegated writer blocks review start", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let writerStarted;
  let releaseWriter;
  const started = new Promise((resolve) => { writerStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseWriter = resolve; });
  const runtime = createPiLeadRuntime({
    createSession: async (options) => {
      if (options.customTools.some((tool) => tool.name === "wiki_delegate_start")) {
        return sessionFactory(async (tools) => {
          await call(tools, "wiki_plan", { spec: spec() });
          const writer = await call(tools, "wiki_delegate_start", { tasks: [{ id: "writer", role: "write", instruction: "write", sourceScopeIds: [], contextRefs: [], writePaths: ["wiki/overview.md"] }] });
          await started;
          await assert.rejects(call(tools, "wiki_delegate_start", { tasks: [{ id: "review", role: "review", instruction: "review", sourceScopeIds: [], contextRefs: [], reviewPaths: ["wiki/overview.md"] }] }), /review is blocked while Wiki writes are active/);
          await call(tools, "wiki_delegate_cancel", { batchId: writer.details.batchId, reason: "test complete" });
        })(options);
      }
      let aborted = false;
      return { session: {
        state: {},
        async prompt() { writerStarted(); await blocked; },
        async waitForIdle() {},
        async abort() { aborted = true; releaseWriter(); },
        dispose() {},
        getLastAssistantText() { return aborted ? "" : "# written"; },
      } };
    },
  });
  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /without wiki_finish/);
});

test("delegated writer and Lead direct write share the same path lease", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let writerStarted;
  let releaseWriter;
  const started = new Promise((resolve) => { writerStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseWriter = resolve; });
  let leadWriteSettled = false;
  const runtime = createPiLeadRuntime({
    createSession: async (options) => {
      if (options.customTools.some((tool) => tool.name === "wiki_delegate_start")) {
        return sessionFactory(async (tools) => {
          await call(tools, "wiki_plan", { spec: spec() });
          const writer = await call(tools, "wiki_delegate_start", { tasks: [{ id: "writer", role: "write", instruction: "write", sourceScopeIds: [], contextRefs: [], writePaths: ["wiki/overview.md"] }] });
          await started;
          const leadWrite = call(tools, "write", { path: "wiki/overview.md", content: validWikiPage("Overview", "Overview") }).then(() => { leadWriteSettled = true; });
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(leadWriteSettled, false);
          await call(tools, "wiki_delegate_cancel", { batchId: writer.details.batchId, reason: "release path" });
          await leadWrite;
          assert.equal(leadWriteSettled, true);
        })(options);
      }
      let aborted = false;
      return { session: {
        state: {},
        async prompt() { writerStarted(); await blocked; },
        async waitForIdle() {},
        async abort() { aborted = true; releaseWriter(); },
        dispose() {},
        getLastAssistantText() { return aborted ? "" : "# written"; },
      } };
    },
  });
  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /without wiki_finish/);
  assert.match(await readFile(path.join(candidateWikiRoot, "overview.md"), "utf8"), /Runtime behavior/);
});

test("failed Lead persistence releases its write lease without advancing the revision", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  await mkdir(path.join(candidateWikiRoot, "overview.md"));
  let finishError;
  const runtime = createPiLeadRuntime({ createSession: sessionFactory(async (tools) => {
    await call(tools, "wiki_plan", { spec: spec() });
    await assert.rejects(
      call(tools, "write", { path: "wiki/overview.md", content: validWikiPage("Overview", "Overview") }),
    );
    try {
      await call(tools, "wiki_finish", { summary: "failed write" });
    } catch (error) {
      finishError = error;
    }
  }) });

  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /without wiki_finish/);
  assert.match(finishError.message, /lacks passing independent review/);
  assert.doesNotMatch(finishError.message, /writes are active/);
  const state = JSON.parse(await readFile(path.join(root, ".okf-wiki", "runs", "run-1", "lead-state.json"), "utf8"));
  assert.equal(state.specRevision, 1);
  assert.equal(state.candidateRevision, 1, "failed page replacement must not advance the global Candidate Revision");
});

test("wiki tools use json_schema constrained sampling and reject write tasks without writePaths", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let leadTools;
  const lead = createPiLeadRuntime({ createSession: sessionFactory(async (tools) => {
    leadTools = tools;
  }) });
  await assert.rejects(lead.run(request(root, candidateWikiRoot)), /without wiki_finish/);

  const plan = toolDefinition(leadTools, "wiki_plan");
  assert.equal(plan.parameters, wikiPlanParameters);
  assert.equal(Value.Check(plan.parameters, { spec: { version: 1, overview: "overview.md" } }), false);
  assert.equal(Value.Check(plan.parameters, { spec: {
    version: 1,
    overview: { pageType: "overview", path: "overview.md", title: "Overview", purpose: "Map", readerQuestions: [], requiredFacets: [], findingIds: [], description: "no" },
    domains: [{ id: "core", title: "Core", purpose: "Core", pages: [{ pageType: "domain", path: "core/domain.md", title: "Core", purpose: "Core", readerQuestions: [], requiredFacets: [], findingIds: [] }] }],
    crossLinks: [], sharedTerms: [], omissions: [],
  } }), false);

  const delegate = toolDefinition(leadTools, "wiki_delegate_start");
  const collect = toolDefinition(leadTools, "wiki_delegate_collect");
  const cancel = toolDefinition(leadTools, "wiki_delegate_cancel");
  const finish = toolDefinition(leadTools, "wiki_finish");
  for (const tool of [plan, delegate, collect, cancel, finish]) {
    assert.equal(tool.constrainedSampling.type, "json_schema");
    assert.equal(tool.constrainedSampling.strict, "prefer");
  }

  const writeWithoutPaths = {
    tasks: [{ id: "write", role: "write", instruction: "write", sourceScopeIds: [], contextRefs: [] }],
  };
  assert.equal(Value.Check(delegate.parameters, writeWithoutPaths), false);
  assert.equal(Value.Check(delegate.parameters, {
    tasks: [{ id: "write", role: "write", instruction: "write", sourceScopeIds: [], contextRefs: [], writePaths: ["wiki/overview.md"] }],
  }), true);
  assert.equal(toolDefinition(leadTools, "read").executionMode, "parallel");
  assert.equal(toolDefinition(leadTools, "grep").executionMode, "parallel");
  for (const tool of [plan, delegate, collect, cancel, finish]) assert.equal(tool.executionMode, "sequential");

  let reviewTools;
  const artifacts = artifactStore();
  const leaf = new PiWikiLeafAgent({
    sourcePlan: pinnedPlan(root),
    createSession: async (options) => {
      reviewTools = options.customTools;
      return sessionFactory(async (tools) => {
        await call(tools, "wiki_review_finish", {
          verdict: "pass", reviewedPaths: ["wiki/overview.md"], findings: [], profileCoverage: [],
        });
      })(options);
    },
  }, transactionalWriter);
  await leaf.run(
    { id: "review", role: "review", instruction: "review", sourceScopeIds: [], contextRefs: [], reviewPaths: ["wiki/overview.md"] },
    leafContext(root, candidateWikiRoot),
  );
  const reviewFinish = toolDefinition(reviewTools, "wiki_review_finish");
  assert.equal(reviewFinish.constrainedSampling.type, "json_schema");
  assert.equal(reviewFinish.constrainedSampling.strict, "prefer");
});

test("leaf sessions expose one explicit Pi role skill and keep writer-only prompt details isolated", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const artifacts = artifactStore();
  const prompts = {};
  const loadedSkills = {};
  const generationWithSections = { ...generation, templates: { requiredSections: ["Behavior", "Evidence"] } };

  for (const [role, task] of [
    ["writer", writeTask("page")],
    ["researcher", { id: "research", role: "research", instruction: "research", sourceScopeIds: ["source"], contextRefs: [] }],
    ["reviewer", { id: "review", role: "review", instruction: "review", sourceScopeIds: [], contextRefs: [], reviewPaths: ["wiki/overview.md"] }],
  ]) {
    const agent = new PiWikiLeafAgent({
      sourcePlan: pinnedPlan(root),
      skillRoot,
      createSession: async (options) => ({
        session: {
          state: {},
          setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
          async prompt(value) {
            prompts[role] = value;
            loadedSkills[role] = options.resourceLoader.getSkills().skills.map((skill) => skill.name);
            if (role === "researcher") {
              await call(options.customTools, "wiki_research_finish", {
                status: "complete", summary: "researched", coverage: ["auth"], gaps: [],
              });
            }
            if (role === "reviewer") {
              await call(options.customTools, "wiki_review_finish", {
                verdict: "pass", reviewedPaths: ["wiki/overview.md"], findings: [], profileCoverage: [],
              });
            }
          },
          async waitForIdle() {}, async abort() {}, dispose() {},
          getLastAssistantText() { return "# complete"; },
        },
      }),
    }, transactionalWriter, generationWithSections);
    await agent.run(task, leafContext(root, candidateWikiRoot));
  }

  assert.match(prompts.writer, /type: Domain/);
  assert.match(prompts.writer, /description: One-sentence reader summary/);
  assert.match(prompts.writer, /Overview\/Domain\/Architecture\/Module\/Flow\/Concept\/State\/Data/);
  assert.match(prompts.writer, /Required sections: Behavior, Evidence/);
  assert.match(prompts.writer, /references\/templates\/<pageType>\.md/);
  assert.match(prompts.writer, /^\/skill:wiki-production-writer /);
  assert.match(prompts.researcher, /^\/skill:wiki-production-researcher /);
  assert.match(prompts.researcher, /Readable source trees \(cwd-relative\): source/);
  assert.doesNotMatch(prompts.researcher, /Write `brief\.md`/);
  assert.doesNotMatch(prompts.researcher, /type: Domain/);
  assert.match(prompts.reviewer, /^\/skill:wiki-production-reviewer /);
  assert.doesNotMatch(prompts.reviewer, /type: Domain/);
  assert.deepEqual(loadedSkills, {
    writer: ["wiki-production-writer"],
    researcher: ["wiki-production-researcher"],
    reviewer: ["wiki-production-reviewer"],
  });
});

test("Pi Lead creates a persistent session, reopens its exact file, and exposes only the production skill", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const sessionDir = path.join(root, ".okf-wiki", "runs", "run-1", "sessions");
  const managers = [];
  const sessionOptions = [];
  const prompts = [];
  const skills = [];
  const createSession = async (options) => {
    sessionOptions.push(options);
    managers.push(options.sessionManager);
    skills.push(options.resourceLoader.getSkills().skills.map((skill) => skill.name));
    return sessionFactory(async (_tools, prompt) => { prompts.push(prompt); })(options);
  };
  const initialModel = { provider: "test", id: "initial-model" };
  const runtime = createPiLeadRuntime({ createSession, runSessionDirectory: sessionDir, model: initialModel, thinkingLevel: "high" });
  const fresh = request(root, candidateWikiRoot, skillRoot);
  fresh.runSessionDirectory = sessionDir;
  await assert.rejects(runtime.run(fresh), /without wiki_finish/);
  const sessionFile = managers[0].getSessionFile();
  assert.ok(sessionFile?.startsWith(path.join(sessionDir, "lead")));
  assert.equal(managers[0].isPersisted(), true);

  const resumed = request(root, candidateWikiRoot, skillRoot);
  resumed.preparation = "resume";
  resumed.runSessionDirectory = sessionDir;
  resumed.leadSessionFile = sessionFile;
  const changedModel = { provider: "test", id: "changed-model" };
  const resumedRuntime = createPiLeadRuntime({ createSession, runSessionDirectory: sessionDir, model: changedModel, thinkingLevel: "low" });
  await assert.rejects(resumedRuntime.run(resumed), /without wiki_finish/);
  assert.equal(managers[1].getSessionFile(), sessionFile);
  assert.deepEqual(skills, [["wiki-production"], ["wiki-production"]]);
  assert.ok(prompts.every((prompt) => prompt.startsWith("/skill:wiki-production ")));
  assert.equal(sessionOptions[0].model, initialModel);
  assert.equal(sessionOptions[0].thinkingLevel, "high");
  assert.equal(Object.hasOwn(sessionOptions[1], "model"), false);
  assert.equal(Object.hasOwn(sessionOptions[1], "thinkingLevel"), false);
});

test("Pi leaf reopens its exact persisted session without overriding the saved model", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const runSessionDirectory = path.join(root, ".okf-wiki", "runs", "run-1", "sessions");
  const taskSessionDirectory = path.join(runSessionDirectory, "tasks", "1", "resumed-leaf", "3");
  const sessionFile = SessionManager.create(root, taskSessionDirectory).getSessionFile();
  let receivedOptions;
  let prompt;
  const telemetry = [];
  const agent = new PiWikiLeafAgent({
    sourcePlan: pinnedPlan(root),
    skillRoot,
    sessionDir: runSessionDirectory,
    model: { provider: "test", id: "changed-model" },
    thinkingLevel: "low",
    createSession: async (options) => {
      receivedOptions = options;
      const created = await sessionFactory(async (_tools, value) => { prompt = value; })(options);
      created.session.sessionFile = options.sessionManager.getSessionFile();
      return created;
    },
  }, transactionalWriter);
  const context = { ...leafContext(root, candidateWikiRoot), attempt: 3, sessionFile, onTelemetry: async (value) => telemetry.push(value) };

  await agent.run(writeTask("resumed-leaf"), context);

  assert.equal(receivedOptions.sessionManager.getSessionFile(), sessionFile);
  assert.equal(Object.hasOwn(receivedOptions, "model"), false);
  assert.equal(Object.hasOwn(receivedOptions, "thinkingLevel"), false);
  assert.match(prompt, /^\/skill:wiki-production-writer /);
  assert.ok(telemetry.every((value) => value.attempt === 3));
  assert.ok(telemetry.some((value) => value.sessionFile === sessionFile));
});

test("Pi Lead rejects model fallback while reopening a persisted session", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  let disposed = false;
  const input = request(root, candidateWikiRoot, skillRoot);
  input.runSessionDirectory = path.join(root, ".okf-wiki", "runs", "run-1", "sessions");
  let sessionFile;
  const seed = createPiLeadRuntime({
    createSession: async (options) => {
      sessionFile = options.sessionManager.getSessionFile();
      return sessionFactory(async () => {})(options);
    },
  });
  await assert.rejects(seed.run(input), /without wiki_finish/);
  input.preparation = "resume";
  input.leadSessionFile = sessionFile;
  const runtime = createPiLeadRuntime({
    createSession: async () => ({
      session: {
        state: {},
        dispose() { disposed = true; },
      },
      modelFallbackMessage: "saved model is unavailable",
    }),
  });
  await assert.rejects(runtime.run(input), /Could not restore.*saved model is unavailable/);
  assert.equal(disposed, true);
});

test("resumed Pi sessions reject an exhausted turn budget before prompting", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const sessionDir = path.join(root, ".okf-wiki", "runs", "run-1", "sessions", "lead");
  const sessionFile = SessionManager.create(root, sessionDir).getSessionFile();
  let prompted = false;
  let receivedOptions;
  const input = request(root, candidateWikiRoot, skillRoot);
  input.preparation = "resume";
  input.leadSessionFile = sessionFile;
  input.runSessionDirectory = path.dirname(sessionDir);
  input.budgets = { maxDelegatedTasks: 10, maxDelegateBatches: 10, maxTurnsPerSession: 2, maxToolCallsPerSession: 10 };
  const runtime = createPiLeadRuntime({
    model: { provider: "test", id: "must-not-override-restored" },
    createSession: async (options) => {
      receivedOptions = options;
      return { session: {
        state: {},
        async prompt() { prompted = true; },
        async waitForIdle() {}, async abort() {}, dispose() {},
        getSessionStats() {
          return { assistantMessages: 2, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
        },
      } };
    },
  });
  await assert.rejects(runtime.run(input), (error) => error?.code === "session_turns_exhausted");
  assert.equal(prompted, false);
  assert.equal(Object.hasOwn(receivedOptions, "model"), false);
  assert.equal(Object.hasOwn(receivedOptions, "thinkingLevel"), false);
});

test("Pi tool budget rejects the first over-limit call before tool execution", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let secondError;
  const agent = new PiWikiLeafAgent({
    sourcePlan: pinnedPlan(root),
    budgets: { maxDelegatedTasks: 10, maxDelegateBatches: 10, maxTurnsPerSession: 10, maxToolCallsPerSession: 1 },
    createSession: async (options) => ({ session: {
      state: {},
      async prompt() {
        await call(options.customTools, "read", { path: "source/a.ts", offset: 1, limit: 1 });
        try {
          await call(options.customTools, "read", { path: "source/a.ts", offset: 1, limit: 1 });
        } catch (error) {
          secondError = error;
          throw error;
        }
      },
      async waitForIdle() {}, async abort() {}, dispose() {},
      getLastAssistantText() { return "# unused"; },
      getSessionStats() {
        return { assistantMessages: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
      },
    } }),
  }, transactionalWriter);
  await assert.rejects(agent.run({ ...writeTask("budget"), sourceScopeIds: ["source"] }, leafContext(root, candidateWikiRoot)), (error) => error?.code === "session_tool_calls_exhausted");
  assert.equal(secondError?.code, "session_tool_calls_exhausted");
  assert.deepEqual(secondError?.details, { limit: 1, toolCalls: 1 });
});

test("context artifacts are listed by exact path and read on demand without prompt injection", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const sha256 = "b".repeat(64);
  const relativePath = `.okf-wiki/blobs/${sha256}.md`;
  const secret = "SECRET ARTIFACT BODY\nsecond line\n";
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(path.join(root, relativePath), secret);
  let prompt;
  let readResult;
  const agent = new PiWikiLeafAgent({
    sourcePlan: pinnedPlan(root),
    skillRoot,
    createSession: async (options) => ({ session: {
      state: {},
      setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
      async prompt(value) {
        prompt = value;
        readResult = await call(options.customTools, "read", { path: relativePath, offset: 2, limit: 1 });
      },
      async waitForIdle() {}, async abort() {}, dispose() {},
      getLastAssistantText() { return "# complete"; },
    } }),
  }, transactionalWriter);
  const context = leafContext(root, candidateWikiRoot);
  context.contextArtifacts = {
    findings: { version: 1, runId: "run-1", nodeId: "research", attempt: 1, kind: "research", relativePath, sha256, sizeBytes: Buffer.byteLength(secret), mediaType: "text/markdown" },
  };
  await agent.run({ ...writeTask("artifact-reader"), contextRefs: ["findings"] }, context);
  assert.match(prompt, /findings: \.okf-wiki\/blobs\//);
  assert.match(prompt, /sha256 b{64}/);
  assert.doesNotMatch(prompt, /SECRET ARTIFACT BODY|second line/);
  assert.match(JSON.stringify(readResult), /second line/);
  assert.doesNotMatch(JSON.stringify(readResult), /SECRET ARTIFACT BODY/);
});

test("Lead completion without wiki_finish is rejected", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const runtime = createPiLeadRuntime({ createSession: sessionFactory(async () => {}) });
  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /without wiki_finish/);
});

test("delegated usage limit aborts Lead and bubbles as producer pause", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let sessions = 0;
  const runtime = createPiLeadRuntime({
    now: () => 1_000,
    createSession: async (options) => {
      sessions += 1;
      const lead = sessions === 1;
      let aborted = false;
      return { session: {
        state: lead ? {} : { errorMessage: "usage limit reached" },
        setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
        async prompt() {
          if (lead) {
            await call(options.customTools, "wiki_plan", { spec: spec() });
            const started = await call(options.customTools, "wiki_delegate_start", { tasks: [{
              id: "write", role: "write", instruction: "write", sourceScopeIds: [], contextRefs: [], writePaths: ["wiki/overview.md"],
            }] });
            await call(options.customTools, "wiki_delegate_collect", { batchId: started.details.batchId, until: "all", timeoutSeconds: 60 });
          }
        },
        async waitForIdle() {}, async abort() { aborted = true; }, dispose() {},
        getLastAssistantText() { return aborted ? "" : "leaf"; },
      } };
    },
  });
  const outcome = await runtime.run(request(root, candidateWikiRoot));
  assert.deepEqual(outcome, { kind: "pause", reason: "usage_limit", summary: "usage limit reached", retryAt: undefined });
  assert.equal(sessions, 2);
});

test("Lead resumes a quota-paused Pi leaf in the exact session and can finish", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  await seedGovernedCandidate(candidateWikiRoot);
  const runSessionDirectory = path.join(root, ".okf-wiki", "runs", "run-1", "sessions");
  const reviewPaths = ["wiki/overview.md", "wiki/core/domain.md"];
  const model = { provider: "test", id: "leaf-model" };
  let leadRuns = 0;
  let researchRuns = 0;
  let runtimeState;
  let firstLeafSessionFile;
  let resumedLeafOptions;
  const createSession = async (options) => {
    const toolNames = new Set(options.customTools.map((tool) => tool.name));
    const sessionFile = options.sessionManager.getSessionFile();
    let prompt;
    if (toolNames.has("wiki_delegate_start")) {
      leadRuns += 1;
      prompt = async () => {
        if (leadRuns === 1) {
          await call(options.customTools, "wiki_plan", { spec: spec() });
          const started = await call(options.customTools, "wiki_delegate_start", { tasks: [{
            id: "research", role: "research", instruction: "Research runtime behavior", sourceScopeIds: ["source"], contextRefs: [],
          }] });
          await call(options.customTools, "wiki_delegate_collect", { batchId: started.details.batchId, until: "all", timeoutSeconds: 60 });
          return;
        }
        const research = await call(options.customTools, "wiki_delegate_collect", { batchId: 1, until: "all", timeoutSeconds: 60 });
        assert.equal(research.details.receipts[0].status, "complete");
        assert.equal(research.details.receipts[0].attempts, 1);
        const contextRef = research.details.receipts[0].outputs[0].nodeId;
        const review = await call(options.customTools, "wiki_delegate_start", { tasks: [{
          id: "review", role: "review", instruction: "Review all pages", sourceScopeIds: [], contextRefs: [contextRef], reviewPaths,
        }] });
        await call(options.customTools, "wiki_delegate_collect", { batchId: review.details.batchId, until: "all", timeoutSeconds: 60 });
        await call(options.customTools, "wiki_finish", { summary: "resumed and reviewed" });
      };
    } else if (toolNames.has("wiki_research_finish")) {
      researchRuns += 1;
      if (researchRuns === 1) {
        firstLeafSessionFile = sessionFile;
        prompt = async () => { throw Object.assign(new Error("quota exceeded"), { retryAfterMs: 100 }); };
      } else {
        resumedLeafOptions = options;
        prompt = async () => await call(options.customTools, "wiki_research_finish", {
          status: "complete", summary: "research resumed", coverage: ["runtime"], gaps: [],
        });
      }
    } else {
      prompt = async () => await call(options.customTools, "wiki_review_finish", {
        verdict: "pass", reviewedPaths: reviewPaths, findings: [], profileCoverage: [],
      });
    }
    return { session: {
      sessionFile,
      state: {},
      subscribe() { return () => {}; },
      async prompt() { await prompt(); },
      async waitForIdle() {}, async abort() {}, dispose() {},
      getLastAssistantText() { return "# completed handoff"; },
    } };
  };
  const runtime = createPiLeadRuntime({ createSession, runSessionDirectory, model, thinkingLevel: "high", now: () => 1_000 });
  const initial = request(root, candidateWikiRoot, skillRoot);
  initial.runSessionDirectory = runSessionDirectory;

  assert.deepEqual(await runtime.run(initial), {
    kind: "pause", reason: "quota", summary: "quota exceeded", retryAt: new Date(1_100).toISOString(),
  });
  runtimeState = JSON.parse(await readFile(path.join(root, ".okf-wiki", "runs", "run-1", "lead-state.json"), "utf8")).delegates;
  const paused = runtimeState.batches[0].tasks[0];
  assert.equal(paused.phase, "paused");
  assert.equal(paused.attempt, 1);
  assert.equal(paused.sessionFile, firstLeafSessionFile);
  assert.equal(paused.pause.code, "quota");

  const resumed = request(root, candidateWikiRoot, skillRoot);
  resumed.preparation = "resume";
  resumed.runSessionDirectory = runSessionDirectory;
  assert.deepEqual(await runtime.run(resumed), { kind: "complete", summary: "resumed and reviewed" });

  assert.equal(resumedLeafOptions.sessionManager.getSessionFile(), firstLeafSessionFile);
  assert.equal(Object.hasOwn(resumedLeafOptions, "model"), false);
  assert.equal(Object.hasOwn(resumedLeafOptions, "thinkingLevel"), false);
  runtimeState = JSON.parse(await readFile(path.join(root, ".okf-wiki", "runs", "run-1", "lead-state.json"), "utf8")).delegates;
  const recovered = runtimeState.batches[0].tasks[0];
  assert.equal(recovered.phase, "terminal");
  assert.equal(recovered.attempt, 1);
  assert.equal(recovered.receipt.status, "complete");
  assert.equal(recovered.pause, undefined);
});

test("Lead provider quota returns a pause outcome", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const runtime = createPiLeadRuntime({ createSession: sessionFactory(async () => {
    throw Object.assign(new Error("quota exceeded"), { retryAfterMs: 2_000 });
  }), now: () => 1_000 });
  assert.deepEqual(await runtime.run(request(root, candidateWikiRoot)), {
    kind: "pause", reason: "quota", summary: "quota exceeded", retryAt: new Date(3_000).toISOString(),
  });
});

test("Lead preserves the external cancellation reason", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const controller = new AbortController();
  const reason = new Error("operator cancelled this run");
  const runtime = createPiLeadRuntime({ createSession: sessionFactory(async () => controller.abort(reason)) });
  const input = request(root, candidateWikiRoot);
  input.signal = controller.signal;
  await assert.rejects(runtime.run(input), (error) => error === reason);
});

test("Lead uses configured transient retry count", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let sessions = 0;
  const sleeps = [];
  const reports = [];
  const runtime = createPiLeadRuntime({
    language: "zh",
    transientRetries: 2,
    baseRetryDelayMs: 100,
    random: () => 0.5,
    sleep: async (ms) => { sleeps.push(ms); },
    createSession: sessionFactory(async (tools) => {
      sessions += 1;
      if (sessions < 3) throw Object.assign(new Error("429 too many requests"), { status: 429 });
      await call(tools, "wiki_plan", { spec: spec() });
    }),
  });

  const input = request(root, candidateWikiRoot);
  input.attempt = 7;
  await writeFile(path.join(root, ".okf-wiki", "runs", "run-1", "run-state.json"), JSON.stringify({ version: 2, id: "run-1", status: "running", attempt: 7, executionToken: input.executionToken }));
  input.leadSessionAttempt = 9;
  input.record = async (observation) => { reports.push(observation); };
  await assert.rejects(runtime.run(input), /without wiki_finish/);
  assert.equal(sessions, 3);
  assert.deepEqual(sleeps, [50, 100]);
  const retries = reports.filter((observation) => observation.kind === "telemetry" && observation.telemetry.activity === "retry_wait");
  assert.deepEqual(retries.map((observation) => observation.telemetry.attempt), [9, 10]);
});

test("Lead rejects invalid retry configuration", () => {
  assert.throws(() => createPiLeadRuntime({ transientRetries: -1 }), /non-negative integer/);
  assert.throws(() => createPiLeadRuntime({ baseRetryDelayMs: -1 }), /non-negative/);
  assert.throws(() => createPiLeadRuntime({ sessionTimeoutMs: 999 }), /integer from 1000/);
  assert.throws(() => createPiLeadRuntime({ sessionTimeoutMs: 1_000.5 }), /integer from 1000/);
  assert.throws(() => createPiLeadRuntime({ sessionTimeoutMs: 2_147_483_648 }), /integer from 1000/);
});

test("direct Pi leaf construction rejects invalid session deadlines before creating a session", () => {
  let sessions = 0;
  const artifacts = artifactStore();
  const createSession = async () => {
    sessions += 1;
    throw new Error("session must not be created");
  };

  for (const sessionTimeoutMs of [999, 2_147_483_648]) {
    assert.throws(
      () => new PiWikiLeafAgent({ sessionTimeoutMs, createSession }),
      /sessionTimeoutMs must be an integer from 1000 to 2147483647/,
    );
  }
  assert.equal(sessions, 0);
});

test("Lead applies the configured wall-clock session deadline", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let aborted = false;
  const runtime = createPiLeadRuntime({
    sessionTimeoutMs: 1_000,
    transientRetries: 0,
    createSession: async () => ({ session: {
      state: {},
      setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
      async prompt() { await new Promise(() => {}); },
      async waitForIdle() {}, async abort() { aborted = true; }, dispose() {},
      getLastAssistantText() { return ""; },
    } }),
  });

  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /timed out after 1000ms/);
  assert.equal(aborted, true);
});

test("Pi leaf retries have one owner and cap 5xx at two sessions and requests", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let sessions = 0;
  let requests = 0;
  let disposals = 0;
  const turnRetrySettings = [];
  const providerRetrySettings = [];
  const createSession = async (options) => {
    sessions += 1;
    turnRetrySettings.push(options.settingsManager.getRetrySettings());
    providerRetrySettings.push(options.settingsManager.getProviderRetrySettings());
    return { session: {
      state: {},
      setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
      async prompt() { requests += 1; throw Object.assign(new Error("service unavailable"), { status: 503 }); },
      async waitForIdle() {}, async abort() {}, dispose() { disposals += 1; },
      getLastAssistantText() { return ""; },
    } };
  };
  const artifacts = artifactStore();
  const runtime = new WikiTaskRuntime({
    runId: "run-1", sourceScopes: [], candidateWikiRoot, artifactStore: artifacts,
    agent: new PiWikiLeafAgent({ createSession, sourcePlan: pinnedPlan(root) }, transactionalWriter), transitions: runtimeTransitions(), sleep: async () => {}, random: () => 0,
  });
  const result = await runtimeDelegate(runtime, [writeTask("server")]);
  assert.equal(result.status, "failed");
  assert.equal(result.receipts[0].attempts, 2);
  assert.equal(sessions, 2);
  assert.equal(requests, 2);
  assert.equal(disposals, 2);
  assert.ok(turnRetrySettings.every((value) => value.enabled === false && value.maxRetries === 0));
  assert.ok(providerRetrySettings.every((value) => value.maxRetries === 0));
});

test("Pi leaf reports session context stats on task end", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const events = [];
  const createSession = async () => ({ session: {
    state: {},
    messages: [],
    setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
    async prompt() {},
    async waitForIdle() {}, async abort() {}, dispose() {},
    getLastAssistantText() { return "# complete"; },
    getSessionStats() {
      return {
        assistantMessages: 2,
        toolCalls: 3,
        tokens: { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, total: 1280 },
        cost: 0.01,
        contextUsage: { tokens: 4000, contextWindow: 200000, percent: 2 },
      };
    },
  } });
  const artifacts = artifactStore();
  const runtime = new WikiTaskRuntime({
    runId: "run-1", sourceScopes: [], candidateWikiRoot, artifactStore: artifacts,
    agent: new PiWikiLeafAgent({ createSession, sourcePlan: pinnedPlan(root) }, transactionalWriter), transitions: runtimeTransitions(),
    onTask: (event) => { events.push(event); },
  });
  await runtimeDelegate(runtime, [writeTask("stats")]);
  const end = events.find((event) => event.phase === "end");
  assert.deepEqual(end?.usage, {
    turns: 2,
    toolCalls: 3,
    input: 1200,
    output: 80,
    cacheRead: 0,
    cacheWrite: 0,
    total: 1280,
    cost: 0.01,
    contextTokens: 4000,
    contextWindow: 200000,
    contextPercent: 2,
  });
});

test("Pi leaf emits tool, compaction, and exact turn telemetry through Lead reports", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const reports = [];
  let listener;
  let turns = 0;
  const createSession = async () => ({ session: {
    state: {},
    messages: [],
    subscribe(value) { listener = value; return () => { listener = undefined; }; },
    setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
    async prompt() {
      listener({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
      listener({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: {}, isError: false });
      listener({ type: "compaction_start", reason: "threshold" });
      await new Promise((resolve) => setImmediate(resolve));
      listener({ type: "compaction_end", reason: "threshold", result: {}, aborted: false, willRetry: false });
      turns = 1;
      this.messages.push({ role: "assistant", content: [{ type: "text", text: "# complete" }], timestamp: 1 });
      listener({ type: "turn_end", message: this.messages[0], toolResults: [] });
    },
    async waitForIdle() {}, async abort() {}, dispose() {},
    getLastAssistantText() { return "# complete"; },
    getSessionStats() {
      return {
        assistantMessages: turns, toolCalls: 1,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0,
        contextUsage: { tokens: 15, contextWindow: 100, percent: 15 },
      };
    },
  } });
  const input = request(root, candidateWikiRoot);
  input.record = async (observation) => { reports.push(observation); };

  // The first session is Lead, the delegated Leaf is created by wiki_delegate_start.
  let sessionNumber = 0;
  const originalFactory = createSession;
  const orchestrated = createPiLeadRuntime({
    createSession: async (options) => {
      sessionNumber += 1;
      if (sessionNumber > 1) return originalFactory(options);
      return sessionFactory(async (tools) => {
        await call(tools, "wiki_plan", { spec: spec() });
        await delegateAndCollect(tools, [{ ...writeTask("live"), writePaths: ["wiki/overview.md"] }]);
      })(options);
    },
  });
  await assert.rejects(orchestrated.run(input), /without wiki_finish/);

  const telemetry = reports.filter((observation) => observation.kind === "telemetry" && observation.target.kind === "task").map((observation) => observation.telemetry);
  assert.ok(telemetry.some((value) => value.activity === "using_tool" && value.activeTools.some((tool) => tool.name === "read")));
  assert.ok(telemetry.some((value) => value.activity === "compacting"));
  const turn = telemetry.find((value) => value.usage?.turns === 1);
  assert.deepEqual(turn.target, { kind: "task", batch: 1, taskId: "live" });
  assert.equal(turn.attempt, 1);
});

test("Lead telemetry covers delegation, synthesis, finish, and settled lifecycle", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const reports = [];
  let sessions = 0;
  const runtime = createPiLeadRuntime({
    createSession: async (options) => {
      sessions += 1;
      let listener;
      const lead = sessions === 1;
      return { session: {
        state: {}, messages: [],
        subscribe(value) { listener = value; return () => { listener = undefined; }; },
        setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
        async prompt() {
          listener?.({ type: "agent_start" });
          if (lead) {
            await call(options.customTools, "wiki_plan", { spec: spec() });
            listener?.({ type: "tool_execution_start", toolCallId: "delegate-1", toolName: "wiki_delegate_start", args: { tasks: [{ id: "page", role: "write", instruction: "secret", sourceScopeIds: [], contextRefs: [] }] } });
            await delegateAndCollect(options.customTools, [{ ...writeTask("page"), writePaths: ["wiki/overview.md"] }]);
            listener?.({ type: "tool_execution_end", toolCallId: "delegate-1", toolName: "wiki_delegate_start", result: { private: "result" }, isError: false });
            listener?.({ type: "tool_execution_start", toolCallId: "finish-1", toolName: "wiki_finish", args: { summary: "private summary" } });
            await assert.rejects(call(options.customTools, "wiki_finish", { summary: "complete" }), /lacks passing independent review/);
            listener?.({ type: "tool_execution_end", toolCallId: "finish-1", toolName: "wiki_finish", result: {}, isError: true });
          }
          listener?.({ type: "agent_end", messages: [], willRetry: false });
          listener?.({ type: "agent_settled" });
        },
        async waitForIdle() {}, async abort() {}, dispose() {},
        getLastAssistantText() { return lead ? "done" : "# page"; },
      } };
    },
  });
  const input = request(root, candidateWikiRoot);
  input.record = async (observation) => { if (observation.kind === "telemetry" && observation.target.kind === "lead") reports.push(observation.telemetry); };

  await assert.rejects(runtime.run(input), /without wiki_finish/);

  assert.ok(reports.some((value) => value.activity === "delegating"));
  assert.ok(reports.some((value) => value.activity === "synthesizing"));
  assert.ok(reports.some((value) => value.activity === "finishing"));
  assert.equal(reports.at(-1).activity, "settled");
  assert.ok(reports.every((value) => value.target.kind === "lead"));
  const serialized = JSON.stringify(reports);
  assert.doesNotMatch(serialized, /private summary|private.*result|secret/);
});

test("Pi observer tracks parallel tools and sanitizes persisted summaries", async () => {
  const reports = [];
  let listener;
  let now = 1_000;
  const session = {
    subscribe(value) { listener = value; return () => { listener = undefined; }; },
    getSessionStats() { throw new Error("not available"); },
  };
  const observer = new PiSessionObserver(session, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/workspace",
    now: () => now,
    report(value) { reports.push(value); },
  });
  observer.start();
  listener({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "/workspace/src/a.ts", offset: 3, content: "must not persist" } });
  now += 20;
  listener({ type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: { path: "/workspace/wiki/a.md", content: "TOP SECRET BODY" } });
  now += 20;
  listener({ type: "tool_execution_update", toolCallId: "write-1", toolName: "write", args: { path: "/workspace/wiki/a.md", content: "TOP SECRET BODY" }, partialResult: { text: "SECRET RESULT" } });
  listener({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: "SECRET RESULT" }, isError: false });
  listener({ type: "tool_execution_end", toolCallId: "write-1", toolName: "write", result: { content: [{ type: "text", text: "Path is not assigned to this Wiki page writer: wiki/a.md\nSECRET RESULT" }] }, isError: true });
  listener({ type: "compaction_start", reason: "threshold" });
  listener({ type: "compaction_end", reason: "threshold", result: { summary: "SECRET COMPACTION" }, aborted: false, willRetry: false });
  listener({ type: "agent_end", messages: [], willRetry: false });
  assert.notEqual(reports.at(-1)?.activity, "settled");
  listener({ type: "agent_settled" });
  await observer.stop();

  assert.ok(reports.some((value) => value.activeTools?.length === 2));
  assert.equal(reports.at(-1).activity, "settled");
  const tools = reports.at(-1).process.filter((entry) => entry.kind === "tool");
  assert.deepEqual(tools.map((entry) => ({ message: entry.message, summary: entry.summary })), [
    { message: "", summary: "src/a.ts" },
    { message: "Path is not assigned to this Wiki page writer: wiki/a.md", summary: "wiki/a.md" },
  ]);
  assert.ok(tools.every((entry) => entry.completed));
  const serialized = JSON.stringify(reports);
  assert.doesNotMatch(serialized, /read started|write started|read completed|write completed/);
  assert.doesNotMatch(serialized, /TOP SECRET|SECRET RESULT|SECRET COMPACTION|must not persist/);
});

test("Pi observer coalesces streaming message updates to one latest checkpoint", async () => {
  const reports = [];
  let listener;
  const observer = new PiSessionObserver({
    subscribe(value) { listener = value; return () => { listener = undefined; }; },
  }, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/workspace",
    report(value) { reports.push(value); },
  });
  observer.start();
  const assistant = { role: "assistant", content: [] };
  for (let index = 0; index < 20; index += 1) {
    listener({ type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", delta: `secret-${index}` } });
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  await observer.stop();

  assert.equal(reports.length, 2);
  assert.equal(reports.at(-1).activity, "streaming");
  assert.doesNotMatch(JSON.stringify(reports), /secret-/);
});

test("Pi observer serializes immediate lifecycle checkpoints for a slow reporter", async () => {
  const reports = [];
  let listener;
  let releaseFirst;
  const firstDelivery = new Promise((resolve) => { releaseFirst = resolve; });
  const observer = new PiSessionObserver({
    subscribe(value) { listener = value; return () => { listener = undefined; }; },
    getSessionStats() { throw new Error("not available"); },
  }, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/workspace",
    async report(value) {
      if (reports.length === 0) await firstDelivery;
      reports.push(value);
    },
  });
  observer.start();
  listener({ type: "agent_start" });
  listener({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "/workspace/a.ts" } });
  listener({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: {}, isError: false });
  listener({ type: "agent_settled" });
  releaseFirst();
  await observer.stop();

  assert.deepEqual(reports.map((value) => value.activity), ["starting", "waiting_model", "using_tool", "waiting_model", "settled"]);
});

test("Pi observer reports one degraded transition and one recovery without recursion", async () => {
  let listener;
  let deliveries = 0;
  const health = [];
  const observer = new PiSessionObserver({
    subscribe(value) { listener = value; return () => { listener = undefined; }; },
  }, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/workspace",
    report() {
      deliveries += 1;
      if (deliveries <= 2) throw new Error("ledger unavailable");
    },
    onHealth(value) {
      health.push(value);
      if (value.status === "degraded") throw new Error("health sink unavailable");
    },
  });
  observer.start();
  listener({ type: "agent_start" });
  listener({ type: "turn_start", turnIndex: 0, timestamp: 1 });
  listener({ type: "agent_settled" });
  await observer.stop();

  assert.deepEqual(health.map((value) => value.status), ["degraded", "healthy"]);
  assert.match(health[0].message, /ledger unavailable/);
  assert.equal(deliveries, 4);
});

test("Pi leaf receives the configured Wiki language", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let prompt;
  const createSession = async () => ({ session: {
    state: {},
    setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
    async prompt(value) { prompt = value; },
    async waitForIdle() {}, async abort() {}, dispose() {},
    getLastAssistantText() { return "# 完成"; },
  } });
  const artifacts = artifactStore();
  const runtime = new WikiTaskRuntime({
    runId: "run-1", sourceScopes: [], candidateWikiRoot, artifactStore: artifacts,
    agent: new PiWikiLeafAgent({ createSession, language: "zh", sourcePlan: pinnedPlan(root) }, transactionalWriter), transitions: runtimeTransitions(),
  });

  const result = await runtimeDelegate(runtime, [writeTask("localized")]);
  assert.equal(result.status, "complete");
  assert.match(prompt, /Simplified Chinese/);
});

test("Pi research leaf returns structured coverage without requiring the Wiki reader language", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let prompt;
  const createSession = async (options) => ({ session: {
    state: {},
    setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
    async prompt(value) {
      prompt = value;
      await call(options.customTools, "wiki_research_finish", {
        status: "incomplete",
        summary: "auth surveyed",
        coverage: ["entry point"],
        gaps: [{ question: "Which caller retries?", sourceScopeIds: ["source"] }],
      });
    },
    async waitForIdle() {}, async abort() {}, dispose() {},
    getLastAssistantText() { return "# findings"; },
  } });
  const artifacts = artifactStore();
  const runtime = new WikiTaskRuntime({
    runId: "run-1", sourceScopes: ["source"], candidateWikiRoot, artifactStore: artifacts,
    agent: new PiWikiLeafAgent({ createSession, language: "zh", sourcePlan: pinnedPlan(root) }), transitions: runtimeTransitions(),
  });

  const result = await runtimeDelegate(runtime, [{
    id: "survey", role: "research", instruction: "Survey auth", sourceScopeIds: ["source"], contextRefs: [],
  }]);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.receipts[0].coverage, ["entry point"]);
  assert.deepEqual(result.receipts[0].gaps, [{ question: "Which caller retries?", sourceScopeIds: ["source"] }]);
  assert.match(prompt, /does not need to use the Wiki reader language/);
  assert.doesNotMatch(prompt, /Simplified Chinese/);
});

test("Pi leaf 429 honors Retry-After through the shared runtime gate with three total requests", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let sessions = 0;
  let requests = 0;
  const attempts = new Map();
  const sleeps = [];
  const createSession = async (options) => ({ session: {
    state: {},
    setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
    async prompt(prompt) {
      sessions += 1;
      requests += 1;
      const id = prompt.includes("limited") ? "limited" : "next";
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      const retry = options.settingsManager.getRetrySettings();
      const providerRetry = options.settingsManager.getProviderRetrySettings();
      assert.equal(retry.maxRetries, 0);
      assert.equal(providerRetry.maxRetries, 0);
      if (id === "limited" && attempt === 1) throw new WikiTaskExecutionError("429", "rate_limit", { retryAfterMs: 250 });
    },
    async waitForIdle() {}, async abort() {}, dispose() {},
    getLastAssistantText() { return "# complete"; },
  } });
  const artifacts = artifactStore();
  const runtime = new WikiTaskRuntime({
    runId: "run-1", sourceScopes: [], candidateWikiRoot, artifactStore: artifacts,
    agent: new PiWikiLeafAgent({ createSession, sourcePlan: pinnedPlan(root) }, transactionalWriter), transitions: runtimeTransitions(), concurrency: 2,
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 0, now: () => 0,
  });
  const result = await runtimeDelegate(runtime, [writeTask("limited"), writeTask("next")]);
  assert.equal(result.status, "complete");
  assert.deepEqual(sleeps, [250]);
  assert.deepEqual(Object.fromEntries(attempts), { limited: 2, next: 1 });
  assert.equal(sessions, 3);
  assert.equal(requests, 3);
});

test("Pi leaf looks up declared source scopeIds, not absolute source paths", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  let tools;
  const agent = new PiWikiLeafAgent({
    sourcePlan: pinnedPlan(root),
    skillRoot,
    createSession: async (options) => {
      tools = options.customTools;
      return sessionFactory(async () => {
        const read = await call(options.customTools, "read", { path: "source/a.ts" });
        assert.match(JSON.stringify(read), /export const a/);
        await assert.rejects(call(options.customTools, "read", { path: "." }), /outside the permitted workspace scope[\s\S]*source/);
        await assert.rejects(call(options.customTools, "grep", { path: root, pattern: "export" }), /outside the permitted workspace scope[\s\S]*source/);
        await assert.rejects(call(options.customTools, "find", { path: ".", pattern: "*.ts" }), /outside the permitted workspace scope[\s\S]*source/);
        for (const params of [{ path: "." }, {}, { path: root }]) {
          const listing = JSON.stringify(await call(options.customTools, "ls", params));
          assert.match(listing, /source/);
          assert.doesNotMatch(listing, /wiki/);
          assert.doesNotMatch(listing, /\.okf-wiki/);
        }
        await call(options.customTools, "wiki_research_finish", { status: "complete", summary: "surveyed", coverage: ["source"], gaps: [] });
      })(options);
    },
  });
  await agent.run(
    { id: "survey", role: "research", instruction: "Survey source", sourceScopeIds: ["source"], contextRefs: [] },
    leafContext(root, candidateWikiRoot),
  );
  assert.ok(tools.some((tool) => tool.name === "read"));
});

test("Pi research leaf with empty sourceScopeIds and no artifacts fails closed", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let created = false;
  const agent = new PiWikiLeafAgent({
    sourcePlan: pinnedPlan(root),
    createSession: async () => {
      created = true;
      throw new Error("session must not be created");
    },
  });
  await assert.rejects(
    agent.run(
      { id: "empty", role: "research", instruction: "Survey nothing", sourceScopeIds: [], contextRefs: [] },
      leafContext(root, candidateWikiRoot),
    ),
    /declared source roots or exact artifact paths/,
  );
  assert.equal(created, false);
});

function writeTask(id) {
  return { id, role: "write", instruction: `write ${id}`, sourceScopeIds: [], contextRefs: [], writePaths: [`wiki/${id}.md`] };
}

function toolDefinition(tools, name) {
  const tool = tools.find((value) => value.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool;
}

function leafContext(_cwd, candidateWikiRoot) {
  return {
    runId: "run-1", batch: 1, attempt: 1,
    contextArtifacts: {},
    candidateWikiRoot, signal: new AbortController().signal,
  };
}

function artifactStore() {
  return {
    async read() { throw new Error("unexpected artifact read"); },
    async write(input) {
      return { version: 1, ...input, relativePath: `.okf-wiki/blobs/${input.nodeId}-${input.attempt}.md`, sha256: "a".repeat(64), sizeBytes: input.content.length, mediaType: "text/markdown" };
    },
  };
}
