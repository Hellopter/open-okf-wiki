import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WikiTaskExecutionError } from "../dist/delegate-contracts.js";
import { createPiLeadRuntime, PiWikiLeafAgent } from "../dist/lead-runtime.js";
import { WikiTaskRuntime } from "../dist/task-runtime.js";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-lead-"));
  t.after(async () => await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  await mkdir(path.join(root, "wiki"), { recursive: true });
  await writeFile(path.join(root, "workspace.yaml"), [
    "version: 1", "language: en", "defaultSourceIgnores: true",
    "quality:", "  maxResearchRounds: 6", "  maxSubmissionAttempts: 3",
    "wiki:", "  exclude: []", "  terminology: {}", "  domains: []",
    "sources: []", "",
  ].join("\n"));
  const candidateWikiRoot = path.join(root, ".okf-wiki", "runs", "run-1", "candidate", "wiki");
  await mkdir(candidateWikiRoot, { recursive: true });
  return { root, candidateWikiRoot };
}

function request(root, candidateWikiRoot) {
  return {
    runId: "run-1", cwd: root, operation: "regenerate", preparation: "fresh", focus: undefined,
    inspection: {}, sourceFingerprint: "source-1", candidateWikiRoot, sourceScopeIds: [], prompt: "Build the Wiki", attempt: 1,
    signal: new AbortController().signal, report: async () => {},
  };
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

test("Lead can write the candidate and finish without delegating", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const runtime = createPiLeadRuntime({ createSession: sessionFactory(async (tools) => {
    await call(tools, "write", { path: "wiki/overview.md", content: "# Overview\n" });
    await call(tools, "wiki_finish", { summary: "Candidate complete" });
  }) });
  const outcome = await runtime.run(request(root, candidateWikiRoot));
  assert.deepEqual(outcome, { kind: "complete", summary: "Candidate complete" });
  assert.equal(await readFile(path.join(candidateWikiRoot, "overview.md"), "utf8"), "# Overview\n");
  await assert.rejects(readFile(path.join(root, "wiki", "overview.md")), /ENOENT/);
});

test("Lead rejects Markdown paths that publication would reject", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  for (const invalidPath of ["wiki/Architecture.md", "wiki/feature map.md", "wiki/wiki/architecture.md", "wiki/index.md"]) {
    const runtime = createPiLeadRuntime({ createSession: sessionFactory(async (tools) => {
      await call(tools, "write", { path: invalidPath, content: "# Invalid\n" });
    }) });
    await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /safe concept pages or log\.md/, invalidPath);
  }

  const runtime = createPiLeadRuntime({ createSession: sessionFactory(async (tools) => {
    await call(tools, "write", { path: "wiki/log.md", content: "# Changes\n" });
    await call(tools, "wiki_finish", { summary: "Log written" });
  }) });
  assert.deepEqual(await runtime.run(request(root, candidateWikiRoot)), { kind: "complete", summary: "Log written" });
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
          if (lead) await call(options.customTools, "wiki_delegate", { tasks: [{
            id: "write", role: "write", instruction: "write", sourceScopeIds: [], contextRefs: [], writePaths: ["wiki/page.md"],
            }] });
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
  const runtime = createPiLeadRuntime({
    language: "zh",
    transientRetries: 2,
    baseRetryDelayMs: 100,
    random: () => 0.5,
    sleep: async (ms) => { sleeps.push(ms); },
    createSession: sessionFactory(async (tools) => {
      sessions += 1;
      if (sessions < 3) throw Object.assign(new Error("429 too many requests"), { status: 429 });
      await call(tools, "wiki_finish", { summary: "完成" });
    }),
  });

  assert.deepEqual(await runtime.run(request(root, candidateWikiRoot)), { kind: "complete", summary: "完成" });
  assert.equal(sessions, 3);
  assert.deepEqual(sleeps, [50, 100]);
});

test("Lead rejects invalid retry configuration", () => {
  assert.throws(() => createPiLeadRuntime({ transientRetries: -1 }), /non-negative integer/);
  assert.throws(() => createPiLeadRuntime({ baseRetryDelayMs: -1 }), /non-negative/);
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
        await call(tools, "wiki_delegate", { tasks: [writeTask("live")] });
        await call(tools, "wiki_finish", { summary: "complete" });
      })(options);
    },
  });
  await orchestrated.run(input);

  const telemetry = reports.filter((data) => data?.phase === "update").map((data) => data.telemetry);
  assert.ok(telemetry.some((value) => value.activity === "tool" && value.activeTool.name === "read"));
  assert.ok(telemetry.some((value) => value.activity === "compacting" && value.contextRecalculating));
  const turn = telemetry.find((value) => value.usage?.turns === 1);
  assert.equal(turn.taskId, "live");
  assert.equal(turn.attempt, 1);
  assert.equal(turn.contextRecalculating, false);
  assert.equal(turn.history[0].text, "# complete");
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

function artifactStore() {
  return {
    async read() { throw new Error("unexpected artifact read"); },
    async write(input) {
      return { version: 1, ...input, relativePath: `.okf-wiki/blobs/${input.nodeId}-${input.attempt}.md`, sha256: "a".repeat(64), sizeBytes: input.content.length, mediaType: "text/markdown" };
    },
  };
}
