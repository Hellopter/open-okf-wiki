import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { WikiTaskExecutionError } from "../dist/delegate-contracts.js";
import { createPiLeadRuntime, PiWikiLeafAgent } from "../dist/lead-runtime.js";
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
    "wiki:", "  exclude: []", "  terminology: {}", "  domains: []",
    "sources:", "  - path: source", "    origin:", "      type: link", `      localPath: ${JSON.stringify(source)}`, "",
  ].join("\n"));
  const candidateWikiRoot = path.join(root, ".okf-wiki", "runs", "run-1", "candidate", "wiki");
  await mkdir(candidateWikiRoot, { recursive: true });
  return { root, candidateWikiRoot };
}

function request(root, candidateWikiRoot) {
  return {
    runId: "run-1", cwd: root, operation: "regenerate", preparation: "fresh", focus: undefined,
    inspection: {}, sourceFingerprint: "source-1", candidateWikiRoot, sourceScopeIds: [], prompt: "Build the Wiki", attempt: 1,
    signal: new AbortController().signal, report: async () => {}, generation,
  };
}

const generation = { audience: [], purpose: "", focus: { include: [], exclude: [] }, granularity: { preferChildPagesFor: [] }, templates: { requiredSections: [] }, review: { mustCover: [] } };

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

test("wiki_delegate forbids mixing write and review in one revision snapshot", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const runtime = createPiLeadRuntime({ createSession: sessionFactory(async (tools) => {
    await call(tools, "wiki_plan", { spec: spec() });
    await call(tools, "wiki_delegate", { tasks: [
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
        await call(tools, "wiki_delegate", { tasks: [{ id: "review-all", role: "review", instruction: "review", sourceScopeIds: [], contextRefs: [], reviewPaths }] });
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
          await call(tools, "wiki_delegate", { tasks: [{ id: "review-all", role: "review", instruction: "review", sourceScopeIds: [], contextRefs: [], reviewPaths }] });
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
        const delegated = call(tools, "wiki_delegate", { tasks: [{ id: "review", role: "review", instruction: "review", sourceScopeIds: [], contextRefs: [], reviewPaths }] });
        await started;
        await call(tools, "write", { path: "wiki/overview.md", content: validWikiPage("Overview", "Overview") });
        releaseReview();
        const receipt = await delegated;
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

  const delegate = toolDefinition(leadTools, "wiki_delegate");
  const finish = toolDefinition(leadTools, "wiki_finish");
  for (const tool of [plan, delegate, finish]) {
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

  let reviewTools;
  const artifacts = artifactStore();
  const leaf = new PiWikiLeafAgent(artifacts, {
    createSession: async (options) => {
      reviewTools = options.customTools;
      return sessionFactory(async (tools) => {
        await call(tools, "wiki_review_finish", {
          verdict: "pass", reviewedPaths: ["wiki/overview.md"], findings: [], profileCoverage: [],
        });
      })(options);
    },
  });
  await leaf.run(
    { id: "review", role: "review", instruction: "review", sourceScopeIds: [], contextRefs: [], reviewPaths: ["wiki/overview.md"] },
    leafContext(root, candidateWikiRoot),
  );
  const reviewFinish = toolDefinition(reviewTools, "wiki_review_finish");
  assert.equal(reviewFinish.constrainedSampling.type, "json_schema");
  assert.equal(reviewFinish.constrainedSampling.strict, "prefer");
});

test("writer leaf prompt includes frontmatter example only for the writer role", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const artifacts = artifactStore();
  const prompts = {};
  const generationWithSections = { ...generation, templates: { requiredSections: ["Behavior", "Evidence"] } };

  for (const [role, task] of [
    ["writer", writeTask("page")],
    ["researcher", { id: "research", role: "research", instruction: "research", sourceScopeIds: [], contextRefs: [] }],
    ["reviewer", { id: "review", role: "review", instruction: "review", sourceScopeIds: [], contextRefs: [], reviewPaths: ["wiki/overview.md"] }],
  ]) {
    const agent = new PiWikiLeafAgent(artifacts, {
      createSession: async (options) => ({
        session: {
          state: {},
          setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
          async prompt(value) {
            prompts[role] = value;
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
    }, undefined, generationWithSections);
    await agent.run(task, leafContext(root, candidateWikiRoot));
  }

  assert.match(prompts.writer, /type: Domain/);
  assert.match(prompts.writer, /description: One-sentence reader summary/);
  assert.match(prompts.writer, /Overview\/Domain\/Architecture\/Module\/Flow\/Concept\/State\/Data/);
  assert.match(prompts.writer, /Required sections: Behavior, Evidence/);
  assert.doesNotMatch(prompts.researcher, /type: Domain/);
  assert.doesNotMatch(prompts.reviewer, /type: Domain/);
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
            await call(options.customTools, "wiki_delegate", { tasks: [{
              id: "write", role: "write", instruction: "write", sourceScopeIds: [], contextRefs: [], writePaths: ["wiki/overview.md"],
            }] });
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

test("Lead provider quota returns a pause outcome", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const runtime = createPiLeadRuntime({ createSession: sessionFactory(async () => {
    throw Object.assign(new Error("quota exceeded"), { retryAfterMs: 2_000 });
  }), now: () => 1_000 });
  assert.deepEqual(await runtime.run(request(root, candidateWikiRoot)), {
    kind: "pause", reason: "quota", summary: "quota exceeded", retryAt: new Date(3_000).toISOString(),
  });
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
  input.report = async (_message, data) => { reports.push(data); };
  await assert.rejects(runtime.run(input), /without wiki_finish/);
  assert.equal(sessions, 3);
  assert.deepEqual(sleeps, [50, 100]);
  const retries = reports.filter((data) => data?.phase === "agent_update" && data.telemetry?.activity === "retry_wait");
  assert.deepEqual(retries.map((data) => data.telemetry.attempt), [1, 2]);
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
      () => new PiWikiLeafAgent(artifacts, { sessionTimeoutMs, createSession }),
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
  const autoRetryValues = [];
  const createSession = async (options) => {
    sessions += 1;
    turnRetrySettings.push(options.settingsManager.getRetrySettings());
    providerRetrySettings.push(options.settingsManager.getProviderRetrySettings());
    return { session: {
      state: {},
      setAutoCompactionEnabled() {}, setAutoRetryEnabled(value) { autoRetryValues.push(value); },
      async prompt() { requests += 1; throw Object.assign(new Error("service unavailable"), { status: 503 }); },
      async waitForIdle() {}, async abort() {}, dispose() { disposals += 1; },
      getLastAssistantText() { return ""; },
    } };
  };
  const artifacts = artifactStore();
  const runtime = new WikiTaskRuntime({
    runId: "run-1", cwd: root, sourceScopes: {}, candidateWikiRoot, artifactStore: artifacts,
    agent: new PiWikiLeafAgent(artifacts, { createSession }), sleep: async () => {}, random: () => 0,
  });
  const result = await runtime.delegate([writeTask("server")], new AbortController().signal);
  assert.equal(result.status, "failed");
  assert.equal(result.receipts[0].attempts, 2);
  assert.equal(sessions, 2);
  assert.equal(requests, 2);
  assert.equal(disposals, 2);
  assert.deepEqual(autoRetryValues, [false, false]);
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
    runId: "run-1", cwd: root, sourceScopes: {}, candidateWikiRoot, artifactStore: artifacts,
    agent: new PiWikiLeafAgent(artifacts, { createSession }),
    onTask: (event) => { events.push(event); },
  });
  await runtime.delegate([writeTask("stats")], new AbortController().signal);
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
  input.report = async (_message, data) => { reports.push(data); };

  // The first session is Lead, the delegated Leaf is created by wiki_delegate.
  let sessionNumber = 0;
  const originalFactory = createSession;
  const orchestrated = createPiLeadRuntime({
    createSession: async (options) => {
      sessionNumber += 1;
      if (sessionNumber > 1) return originalFactory(options);
      return sessionFactory(async (tools) => {
        await call(tools, "wiki_plan", { spec: spec() });
        await call(tools, "wiki_delegate", { tasks: [{ ...writeTask("live"), writePaths: ["wiki/overview.md"] }] });
      })(options);
    },
  });
  await assert.rejects(orchestrated.run(input), /without wiki_finish/);

  const telemetry = reports.filter((data) => data?.phase === "update").map((data) => data.telemetry);
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
            listener?.({ type: "tool_execution_start", toolCallId: "delegate-1", toolName: "wiki_delegate", args: { tasks: [{ id: "page", role: "write", instruction: "secret", sourceScopeIds: [], contextRefs: [] }] } });
            await call(options.customTools, "wiki_delegate", { tasks: [{ ...writeTask("page"), writePaths: ["wiki/overview.md"] }] });
            listener?.({ type: "tool_execution_end", toolCallId: "delegate-1", toolName: "wiki_delegate", result: { private: "result" }, isError: false });
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
  input.report = async (_message, data) => { if (data?.phase === "agent_update") reports.push(data.telemetry); };

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
    runId: "run-1", cwd: root, sourceScopes: {}, candidateWikiRoot, artifactStore: artifacts,
    agent: new PiWikiLeafAgent(artifacts, { createSession, language: "zh" }),
  });

  const result = await runtime.delegate([writeTask("localized")], new AbortController().signal);
  assert.equal(result.status, "complete");
  assert.match(prompt, /Simplified Chinese/);
});

test("Pi research leaf does not require the Wiki reader language", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let prompt;
  const createSession = async () => ({ session: {
    state: {},
    setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
    async prompt(value) { prompt = value; },
    async waitForIdle() {}, async abort() {}, dispose() {},
    getLastAssistantText() { return "# findings"; },
  } });
  const artifacts = artifactStore();
  const runtime = new WikiTaskRuntime({
    runId: "run-1", cwd: root, sourceScopes: { source: "source" }, candidateWikiRoot, artifactStore: artifacts,
    agent: new PiWikiLeafAgent(artifacts, { createSession, language: "zh" }),
  });

  const result = await runtime.delegate([{
    id: "survey", role: "research", instruction: "Survey auth", sourceScopeIds: ["source"], contextRefs: [],
  }], new AbortController().signal);
  assert.equal(result.status, "complete");
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
    runId: "run-1", cwd: root, sourceScopes: {}, candidateWikiRoot, artifactStore: artifacts,
    agent: new PiWikiLeafAgent(artifacts, { createSession }), concurrency: 2,
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 0, now: () => 0,
  });
  const result = await runtime.delegate([writeTask("limited"), writeTask("next")], new AbortController().signal);
  assert.equal(result.status, "complete");
  assert.deepEqual(sleeps, [250]);
  assert.deepEqual(Object.fromEntries(attempts), { limited: 2, next: 1 });
  assert.equal(sessions, 3);
  assert.equal(requests, 3);
});

function writeTask(id) {
  return { id, role: "write", instruction: `write ${id}`, sourceScopeIds: [], contextRefs: [], writePaths: [`wiki/${id}.md`] };
}

function toolDefinition(tools, name) {
  const tool = tools.find((value) => value.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool;
}

function leafContext(cwd, candidateWikiRoot) {
  return {
    runId: "run-1", batch: 1, attempt: 1, cwd,
    sourceRoots: { source: "source" },
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
