import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createWikiExtension } from "../dist/extension.js";
import { createCoreAdapter } from "../dist/core-adapter.js";

const core = {
  initWorkspace: async (root) => ({ root, initialized: true, sources: [] }),
  ensureRuntime: async () => ({ ok: true }),
  loadWorkspace: async (root) => ({ root, initialized: true, sources: [] }),
  getWorkspaceStatus: async (root) => ({ root, initialized: true, sources: [], activeRunId: undefined }),
  addClonedSource: async () => ({ id: "clone", kind: "clone" }),
  addLinkedSource: async () => ({ id: "linked", kind: "linked" }),
  removeSource: async () => undefined,
  listSources: async () => [],
  prepareRun: async () => ({ status: "ok" }),
  mergeSurveyReceipts: async () => ({ ok: true }),
  publishCheckpoint: async () => ({ ok: true }),
  openPlanGate: async () => ({ ok: true }),
  checkPlanGate: async () => ({ ok: true }),
  validateCandidate: async () => ({ ok: true }),
  getRunPaths: async () => undefined,
};

function fakeManager() {
  const manager = new EventEmitter();
  const calls = { starts: [], sessionIds: [], models: [], registries: [], adopts: [] };
  Object.assign(manager, {
    calls,
    listRuns: () => [],
    listLiveRuns: () => [],
    setSessionId: (id) => calls.sessionIds.push(id),
    setMainModel: (model) => calls.models.push(model),
    setModelRegistry: (registry) => calls.registries.push(registry),
    adoptLiveRunsToSession: (id) => {
      calls.adopts.push(id);
      return 0;
    },
    startInBackground: (_script, args, options) => {
      calls.starts.push({ args, options });
      return { runId: "pi-workflow-1", promise: Promise.resolve({}) };
    },
    pause: () => true,
    resume: async () => true,
    stop: () => true,
  });
  return manager;
}

function fakePi() {
  const commands = new Map();
  const tools = [];
  const handlers = new Map();
  const activeTools = ["bash", "read"];
  return {
    commands,
    tools,
    handlers,
    sent: [],
    activeTools,
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    sendMessage(message, options) {
      this.sent.push({ message, options });
    },
    getActiveTools() {
      return [...this.activeTools];
    },
    setActiveTools(names) {
      this.activeTools = [...names];
    },
  };
}

function commandContext(overrides = {}) {
  const statuses = [];
  const notifications = [];
  return {
    cwd: "/workspace",
    hasUI: false,
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (key, text) => statuses.push({ key, text }),
    },
    modelRegistry: { id: "registry" },
    model: { provider: "test", id: "model" },
    sessionManager: { getSessionId: () => "session-1" },
    statuses,
    notifications,
    ...overrides,
  };
}

const EXPECTED_COMMANDS = ["wiki", "wiki-help", "wiki-status", "wiki-init", "wiki-run", "wiki-source"];

test("extension registers wiki command and aliases, injects toolset", async () => {
  const manager = fakeManager();
  const pi = fakePi();
  createWikiExtension({ core, managerFactory: () => manager })(pi);

  assert.deepEqual([...pi.commands.keys()].sort(), [...EXPECTED_COMMANDS].sort());
  assert.deepEqual(
    pi.tools.map((tool) => tool.name),
    ["okf_wiki"],
  );
  assert.equal(pi.handlers.has("session_start"), true);
  assert.equal(typeof pi.commands.get("wiki").getArgumentCompletions, "function");

  await pi.handlers.get("session_start")({}, commandContext());
  await pi.commands.get("wiki").handler("run repository architecture", commandContext());

  assert.equal(manager.calls.starts.length, 1);
  assert.equal(manager.calls.starts[0].options.toolset, "okf-wiki");
  assert.equal(manager.calls.starts[0].args.workflowRunId, "pi-workflow-1");
  assert.deepEqual(manager.calls.sessionIds, ["session-1"]);
  assert.deepEqual(manager.calls.models, ["test/model"]);
  assert.deepEqual(manager.calls.adopts, ["session-1"]);
  assert.ok(pi.activeTools.includes("okf_wiki"));
});

test("empty /wiki shows help and does not start a run", async () => {
  const manager = fakeManager();
  const pi = fakePi();
  createWikiExtension({ core, managerFactory: () => manager })(pi);

  await pi.commands.get("wiki").handler("", commandContext());
  assert.equal(manager.calls.starts.length, 0);
  assert.match(pi.sent.at(-1).message.content, /OKF Wiki/);
  assert.match(pi.sent.at(-1).message.content, /does not auto-start/i);
  assert.equal(pi.sent.at(-1).message.display, true);
});

test("empty /wiki and wiki-help do not call initWorkspace", async () => {
  let inits = 0;
  const trackingCore = {
    ...core,
    loadWorkspace: async () => undefined,
    initWorkspace: async (root) => {
      inits++;
      return { root, initialized: true, sources: [] };
    },
  };
  const manager = fakeManager();
  const pi = fakePi();
  createWikiExtension({ core: trackingCore, managerFactory: () => manager })(pi);

  await pi.commands.get("wiki").handler("", commandContext());
  await pi.commands.get("wiki-help").handler("", commandContext());
  await pi.commands.get("wiki").handler("help", commandContext());
  assert.equal(inits, 0);
  assert.equal(manager.calls.starts.length, 0);
});

test("status and source-list do not auto-init when workspace is missing", async () => {
  let inits = 0;
  const missingCore = {
    ...core,
    loadWorkspace: async () => undefined,
    initWorkspace: async (root) => {
      inits++;
      return { root, initialized: true, sources: [] };
    },
  };
  const manager = fakeManager();
  const pi = fakePi();
  createWikiExtension({ core: missingCore, managerFactory: () => manager })(pi);

  await pi.commands.get("wiki").handler("status", commandContext());
  assert.match(pi.sent.at(-1).message.content, /No Wiki workspace\. Run \/wiki init\./);
  await pi.commands.get("wiki").handler("source list", commandContext());
  assert.match(pi.sent.at(-1).message.content, /No Wiki workspace\. Run \/wiki init\./);
  assert.equal(inits, 0);
});

test("okf_wiki tool rejects write mode", async () => {
  const manager = fakeManager();
  const pi = fakePi();
  createWikiExtension({ core, managerFactory: () => manager })(pi);
  const tool = pi.tools.find((entry) => entry.name === "okf_wiki");
  assert.ok(tool);

  await assert.rejects(
    () =>
      tool.execute(
        "call-1",
        { action: "run", mode: "write" },
        undefined,
        undefined,
        { cwd: "/workspace" },
      ),
    /Use \/wiki --write/,
  );
  assert.equal(manager.calls.starts.length, 0);
});

test("multi-word focus still runs; run verb works for single-word focus", async () => {
  const manager = fakeManager();
  const pi = fakePi();
  createWikiExtension({ core, managerFactory: () => manager })(pi);

  await pi.commands.get("wiki").handler("repository architecture", commandContext());
  assert.equal(manager.calls.starts.length, 1);
  assert.equal(manager.calls.starts[0].args.request.focus, "repository architecture");

  await pi.commands.get("wiki").handler("run auth", commandContext());
  assert.equal(manager.calls.starts.length, 2);
  assert.equal(manager.calls.starts[1].args.request.focus, "auth");
});

test("aliases route to the shared executor", async () => {
  const manager = fakeManager();
  const pi = fakePi();
  createWikiExtension({ core, managerFactory: () => manager })(pi);

  await pi.commands.get("wiki-help").handler("", commandContext());
  assert.match(pi.sent.at(-1).message.content, /Usage:/);

  await pi.commands.get("wiki-status").handler("", commandContext());
  assert.match(pi.sent.at(-1).message.content, /Wiki workspace|No Wiki workspace|Sources:/i);

  await pi.commands.get("wiki-run").handler("domain model", commandContext());
  assert.equal(manager.calls.starts.length, 1);
  assert.equal(manager.calls.starts[0].args.request.focus, "domain model");
});

test("status reports concrete Pi workflow IDs alongside the domain status", async () => {
  const manager = fakeManager();
  manager.listRuns = () => [{ runId: "pi-workflow-42", status: "paused", updatedAt: "2026-01-01" }];
  const pi = fakePi();
  createWikiExtension({ core, managerFactory: () => manager })(pi);
  await pi.commands.get("wiki").handler("status", commandContext());
  assert.match(pi.sent.at(-1).message.content, /pi-workflow-42 \(paused\)/);
});

test("first automatic workspace initialization links the session root as project source", async () => {
  const linked = [];
  const autoCore = {
    ...core,
    loadWorkspace: async () => undefined,
    initWorkspace: async (root) => ({ root, initialized: true, sources: [] }),
    addLinkedSource: async (_root, source) => {
      linked.push(source);
      return { id: source.id, kind: "linked", root: source.path };
    },
  };
  const manager = fakeManager();
  const pi = fakePi();
  createWikiExtension({ core: autoCore, managerFactory: () => manager })(pi);
  await pi.commands.get("wiki").handler("run first documentation pass", commandContext());
  assert.deepEqual(linked, [{ id: "project", path: "/workspace", ignore: ["sources/**"] }]);
  assert.equal(manager.calls.starts.length, 1);
});

test("explicit initialization also links the session root as the default project source", async () => {
  const linked = [];
  const initCore = {
    ...core,
    loadWorkspace: async () => undefined,
    initWorkspace: async (root) => ({ root, initialized: true, sources: [] }),
    addLinkedSource: async (_root, source) => {
      linked.push(source);
      return { id: source.id, kind: "linked", root: source.path };
    },
  };
  const manager = fakeManager();
  const pi = fakePi();
  createWikiExtension({ core: initCore, managerFactory: () => manager })(pi);
  await pi.commands.get("wiki").handler("init --name docs --lang zh", commandContext());
  assert.deepEqual(linked, [{ id: "project", path: "/workspace", ignore: ["sources/**"] }]);
  assert.equal(manager.calls.starts.length, 0);
});

test("changing session cwd pauses live work before creating the replacement manager", async () => {
  const oldManager = fakeManager();
  const nextManager = fakeManager();
  let paused = 0;
  oldManager.listLiveRuns = () => [{ runId: "pi-old", status: "running" }];
  oldManager.pause = (runId) => {
    assert.equal(runId, "pi-old");
    paused++;
    return true;
  };
  const pi = fakePi();
  const managers = [oldManager, nextManager];
  createWikiExtension({ core, managerFactory: () => managers.shift() })(pi);
  const ctx = commandContext({ cwd: "/replacement", hasUI: true });
  await pi.handlers.get("session_start")({}, ctx);
  assert.equal(paused, 1);
  assert.deepEqual(nextManager.calls.sessionIds, ["session-1"]);
  assert.match(ctx.notifications[0].message, /Paused 1 active wiki workflow/);
});

test("session_start with SYNC core (returns undefined, not promise) must not throw", async () => {
  const syncModule = {
    initWorkspace: (root) => ({ root, initialized: true, sources: [] }),
    ensureRuntime: () => ({ ok: true }),
    loadWorkspace: () => undefined, // sync undefined — classic crash for .then
    getWorkspaceStatus: (root) => ({ root, initialized: false, sources: [] }),
    addClonedSource: () => ({ id: "clone", kind: "clone" }),
    addLinkedSource: () => ({ id: "linked", kind: "linked" }),
    removeSource: () => undefined,
    listSources: () => [],
    prepareRun: () => ({ status: "ok" }),
    mergeSurveyReceipts: () => ({ ok: true }),
    publishCheckpoint: () => ({ ok: true }),
    openPlanGate: () => ({ ok: true }),
    checkPlanGate: () => ({ ok: true }),
    validateCandidate: () => ({ ok: true }),
    getRunPaths: () => undefined,
  };
  const adapter = createCoreAdapter(syncModule);
  const manager = fakeManager();
  const pi = fakePi();
  createWikiExtension({ core: adapter, managerFactory: () => manager })(pi);

  const ctx = commandContext();
  await assert.doesNotReject(() => pi.handlers.get("session_start")({}, ctx));
  // Status bar should still be set to the not-initialized hint.
  assert.ok(ctx.statuses.some((entry) => /not initialized/i.test(entry.text ?? "")));
});

test("session_start swallows core failures instead of throwing", async () => {
  const broken = {
    ...core,
    loadWorkspace: async () => {
      throw new Error("boom");
    },
    getWorkspaceStatus: async () => {
      throw new Error("boom");
    },
  };
  const manager = fakeManager();
  const pi = fakePi();
  createWikiExtension({ core: broken, managerFactory: () => manager })(pi);
  await assert.doesNotReject(() => pi.handlers.get("session_start")({}, commandContext()));
});

test("session_shutdown suspends delivery, pauses live runs, and clears status", async () => {
  const manager = fakeManager();
  let paused = 0;
  manager.listLiveRuns = () => [{ runId: "live-1", status: "running" }];
  manager.pause = () => {
    paused++;
    return true;
  };
  const pi = fakePi();
  createWikiExtension({ core, managerFactory: () => manager })(pi);
  const ctx = commandContext();
  await pi.handlers.get("session_shutdown")({}, ctx);
  assert.equal(paused, 1);
  assert.ok(ctx.statuses.some((entry) => entry.key === "okf-wiki" && entry.text === undefined));
});
