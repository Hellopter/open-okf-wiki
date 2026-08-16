import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPiLeadRuntime, PiWikiLeafAgent } from "../dist/lead-runtime.js";
import { materializeProductionSkill } from "../dist/skill-store.js";
import { createWikiRunLedger } from "../dist/run-ledger.js";

const OWNER_TOKEN = "owner-token-000001";
const EXECUTION_TOKEN = "execution-token-01";
const generation = {
  audience: [], purpose: "", focus: { include: [], exclude: [] }, granularity: { preferChildPagesFor: [] },
  templates: { requiredSections: [] }, review: { mustCover: [] },
};

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
  const ledger = createWikiRunLedger(path.join(root, ".okf-wiki"));
  const at = new Date().toISOString();
  await ledger.create({ id: "run-1", cwd: root, at });
  await ledger.transition("run-1", {
    kind: "attempt_started", at, executionToken: EXECUTION_TOKEN,
    owner: { ownerToken: OWNER_TOKEN, pid: process.pid },
  });
  const skillRoot = await materializeProductionSkill(root, "run-1");
  return { root, candidateWikiRoot, skillRoot };
}

function pinnedPlan(root) {
  const source = path.join(root, "source");
  return {
    workspaceRoot: root, workspaceRealPath: root, configPath: path.join(root, "workspace.yaml"),
    defaultSourceIgnores: true, excludes: [], fingerprint: "a".repeat(64),
    sources: [{ scopeId: "source", logicalPath: "source", absolutePath: source, realPath: source, repositoryRoot: source, repositoryIdentity: "test-source", head: "0".repeat(40), dirtyFingerprint: "b".repeat(64) }],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function request(root, candidateWikiRoot, skillRoot = path.join(root, ".okf-wiki", "runs", "run-1", "skill")) {
  return {
    runId: "run-1", cwd: root, preparation: "fresh", sourcePlan: pinnedPlan(root), sourceFingerprint: "a".repeat(64),
    candidateWikiRoot, skillRoot, sourceScopeIds: ["source"], prompt: "Build the Wiki", attempt: 1,
    executionToken: EXECUTION_TOKEN, signal: new AbortController().signal, generation, language: "en",
    record: async () => {},
  };
}

function fakeSession(prompt, extra = {}) {
  return {
    state: extra.state ?? {},
    messages: [],
    subscribe() { return () => {}; },
    setAutoCompactionEnabled() {}, setAutoRetryEnabled() {},
    async prompt(value) { await prompt?.(value); },
    async waitForIdle() {},
    async abort() { extra.aborted?.(); },
    dispose() { extra.disposed?.(); },
    getLastAssistantText() { return extra.text ?? "done"; },
    ...extra.session,
  };
}

function sessionFactory(prompt, extra) {
  return async (options) => ({ session: fakeSession((value) => prompt?.(options, value), extra) });
}

async function execute(tools, name, params) {
  const tool = tools.find((value) => value.name === name);
  assert.ok(tool, `missing ${name}`);
  return await tool.execute("call-1", params, new AbortController().signal);
}

function leafContext(_cwd, candidateWikiRoot) {
  return { runId: "run-1", batch: 1, attempt: 1, contextArtifacts: {}, candidateWikiRoot, signal: new AbortController().signal };
}

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
    return sessionFactory((_options, prompt) => { prompts.push(prompt); })(options);
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
  const resumedRuntime = createPiLeadRuntime({ createSession, runSessionDirectory: sessionDir, model: { provider: "test", id: "changed-model" }, thinkingLevel: "low" });
  await assert.rejects(resumedRuntime.run(resumed), /without wiki_finish/);
  assert.equal(managers[1].getSessionFile(), sessionFile);
  assert.deepEqual(skills, [["wiki-production"], ["wiki-production"]]);
  assert.ok(prompts.every((prompt) => !prompt.startsWith("/skill:")));
  assert.ok(prompts.every((prompt) => prompt.includes("board.md") && prompt.includes("topology.md")));
  assert.equal(sessionOptions[0].model, initialModel);
  assert.equal(sessionOptions[0].thinkingLevel, "high");
  assert.equal(Object.hasOwn(sessionOptions[1], "model"), false);
  assert.equal(Object.hasOwn(sessionOptions[1], "thinkingLevel"), false);
});

test("Pi leaf reopens its exact persisted session without overriding the saved model", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const runSessionDirectory = path.join(root, ".okf-wiki", "runs", "run-1", "sessions");
  const sessionFile = SessionManager.create(root, path.join(runSessionDirectory, "tasks", "1", "resumed-leaf", "3")).getSessionFile();
  let receivedOptions;
  let prompt;
  const agent = new PiWikiLeafAgent({
    sourcePlan: pinnedPlan(root), skillRoot,
    sessionDir: runSessionDirectory,
    model: { provider: "test", id: "changed-model" },
    thinkingLevel: "low",
    createSession: async (options) => {
      receivedOptions = options;
      return sessionFactory((_options, value) => { prompt = value; }, { text: "# complete" })(options);
    },
  }, { async replacePage() {} });
  await agent.run(
    { id: "resumed-leaf", role: "write", instruction: "write resumed-leaf", sourceScopeIds: [], contextRefs: [], writePaths: ["wiki/resumed-leaf.md"] },
    { ...leafContext(root, candidateWikiRoot), attempt: 3, sessionFile },
  );
  assert.equal(receivedOptions.sessionManager.getSessionFile(), sessionFile);
  assert.equal(Object.hasOwn(receivedOptions, "model"), false);
  assert.equal(Object.hasOwn(receivedOptions, "thinkingLevel"), false);
  assert.ok(!prompt.startsWith("/skill:"));
  assert.match(prompt, /# Writer|Write one cluster|write resumed-leaf/);
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
      return sessionFactory()(options);
    },
  });
  await assert.rejects(seed.run(input), /without wiki_finish/);
  input.preparation = "resume";
  input.leadSessionFile = sessionFile;
  const runtime = createPiLeadRuntime({
    createSession: async () => ({ session: fakeSession(undefined, { disposed() { disposed = true; } }), modelFallbackMessage: "saved model is unavailable" }),
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
      return { session: fakeSession(() => { prompted = true; }, {
        session: {
          getSessionStats() {
            return { assistantMessages: 2, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
          },
        },
      }) };
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
    createSession: async (options) => ({ session: fakeSession(async () => {
      await execute(options.customTools, "read", { path: "source/a.ts", offset: 1, limit: 1 });
      try {
        await execute(options.customTools, "read", { path: "source/a.ts", offset: 1, limit: 1 });
      } catch (error) {
        secondError = error;
        throw error;
      }
    }, { text: "# unused" }) }),
  }, { async replacePage() {} });
  await assert.rejects(
    agent.run(
      { id: "budget", role: "write", instruction: "write budget", sourceScopeIds: ["source"], contextRefs: [], writePaths: ["wiki/budget.md"] },
      leafContext(root, candidateWikiRoot),
    ),
    (error) => error?.code === "session_tool_calls_exhausted",
  );
  assert.equal(secondError?.code, "session_tool_calls_exhausted");
  assert.deepEqual(secondError?.details, { limit: 1, toolCalls: 1 });
});

test("Lead records observations during the session, not only after run settles", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const seen = [];
  const entered = deferred();
  const release = deferred();
  const runtime = createPiLeadRuntime({
    createSession: sessionFactory(async () => {
      entered.resolve();
      await release.promise;
    }),
  });
  const input = request(root, candidateWikiRoot);
  input.record = async (observation) => { seen.push(observation); };
  const running = runtime.run(input);
  await entered.promise;
  assert.ok(seen.some((observation) => observation.kind === "progress"));
  release.resolve();
  await assert.rejects(running, /without wiki_finish/);
});

test("Lead completion without wiki_finish is rejected", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const runtime = createPiLeadRuntime({ createSession: sessionFactory() });
  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /without wiki_finish/);
});

test("Lead quota and usage-limit return pause outcomes", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const quota = createPiLeadRuntime({
    createSession: sessionFactory(() => { throw Object.assign(new Error("quota exceeded"), { retryAfterMs: 2_000 }); }),
    now: () => 1_000,
  });
  const quotaSeen = [];
  const quotaInput = request(root, candidateWikiRoot);
  quotaInput.record = async (observation) => { quotaSeen.push(observation); };
  const quotaOutcome = await quota.run(quotaInput);
  assert.deepEqual(quotaOutcome, {
    kind: "pause", reason: "quota", summary: "quota exceeded", retryAt: new Date(3_000).toISOString(),
  });
  assert.ok(quotaSeen.some((observation) => observation.kind === "progress"));

  const usage = createPiLeadRuntime({
    createSession: sessionFactory(undefined, { state: { errorMessage: "usage limit reached" } }),
  });
  const usageSeen = [];
  const usageInput = request(root, candidateWikiRoot);
  usageInput.record = async (observation) => { usageSeen.push(observation); };
  const usageOutcome = await usage.run(usageInput);
  assert.deepEqual(usageOutcome, {
    kind: "pause", reason: "usage_limit", summary: "usage limit reached", retryAt: undefined,
  });
  assert.ok(usageSeen.some((observation) => observation.kind === "progress"));
});

test("Lead preserves the external cancellation reason", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  const controller = new AbortController();
  const reason = new Error("operator cancelled this run");
  const runtime = createPiLeadRuntime({ createSession: sessionFactory(() => controller.abort(reason)) });
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
    transientRetries: 2,
    baseRetryDelayMs: 100,
    random: () => 0.5,
    sleep: async (ms) => { sleeps.push(ms); },
    createSession: sessionFactory(() => {
      sessions += 1;
      if (sessions < 3) throw Object.assign(new Error("429 too many requests"), { status: 429 });
    }),
  });
  const input = request(root, candidateWikiRoot);
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
  assert.throws(() => new PiWikiLeafAgent({ sessionTimeoutMs: 999, createSession: async () => { throw new Error("unused"); } }), /integer from 1000/);
});

test("Lead applies the configured wall-clock session deadline", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let aborted = false;
  const runtime = createPiLeadRuntime({
    sessionTimeoutMs: 1_000,
    transientRetries: 0,
    createSession: async () => ({ session: fakeSession(() => new Promise(() => {}), { aborted() { aborted = true; } }) }),
  });
  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /timed out after 1000ms/);
  assert.equal(aborted, true);
});

test("Lead 5xx retry cap uses host retries and disables Pi session retries", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let sessions = 0;
  const retries = [];
  const runtime = createPiLeadRuntime({
    transientRetries: 1,
    sleep: async () => {},
    createSession: async (options) => {
      sessions += 1;
      retries.push({
        turn: options.settingsManager.getRetrySettings(),
        provider: options.settingsManager.getProviderRetrySettings(),
      });
      return { session: fakeSession(() => { throw Object.assign(new Error("service unavailable"), { status: 503 }); }) };
    },
  });
  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /service unavailable/);
  assert.equal(sessions, 2);
  assert.ok(retries.every((value) => value.turn.enabled === false && value.turn.maxRetries === 0 && value.provider.maxRetries === 0));
});

test("Lead 429 honors Retry-After", async (t) => {
  const { root, candidateWikiRoot } = await workspace(t);
  let sessions = 0;
  const sleeps = [];
  const runtime = createPiLeadRuntime({
    transientRetries: 1,
    sleep: async (ms) => { sleeps.push(ms); },
    createSession: sessionFactory(() => {
      sessions += 1;
      if (sessions === 1) throw Object.assign(new Error("429 too many requests"), { status: 429, retryAfterMs: 250 });
    }),
  });
  await assert.rejects(runtime.run(request(root, candidateWikiRoot)), /without wiki_finish/);
  assert.equal(sessions, 2);
  assert.deepEqual(sleeps, [250]);
});

test("Pi leaf looks up declared source scopeIds, not absolute source paths", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const sourceAbs = path.join(root, "source");
  let prompt;
  const agent = new PiWikiLeafAgent({
    sourcePlan: pinnedPlan(root),
    skillRoot,
    createSession: async (options) => sessionFactory(async (_options, value) => {
      prompt = value;
      const read = await execute(options.customTools, "read", { path: "source/a.ts" });
      assert.match(JSON.stringify(read), /export const a/);
      await assert.rejects(execute(options.customTools, "read", { path: "." }), /outside the permitted workspace scope[\s\S]*source/);
      await assert.rejects(execute(options.customTools, "grep", { path: root, pattern: "export" }), /outside the permitted workspace scope[\s\S]*source/);
      await execute(options.customTools, "wiki_research_finish", { status: "complete", summary: "surveyed", coverage: ["source"], gaps: [] });
    }, { text: "# surveyed" })(options),
  });
  await agent.run(
    { id: "survey", role: "research", instruction: "Survey source", sourceScopeIds: ["source"], contextRefs: [] },
    leafContext(root, candidateWikiRoot),
  );
  assert.match(prompt, /Readable source trees \(cwd-relative\): source/);
  assert.doesNotMatch(prompt, new RegExp(sourceAbs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
