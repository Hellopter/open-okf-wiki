import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createWikiExtension } from "../dist/extension.js";

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
  const calls = { starts: [], sessionIds: [], models: [], registries: [] };
  Object.assign(manager, {
    calls,
    listRuns: () => [],
    listLiveRuns: () => [],
    setSessionId: (id) => calls.sessionIds.push(id),
    setMainModel: (model) => calls.models.push(model),
    setModelRegistry: (registry) => calls.registries.push(registry),
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
  return {
    commands,
    tools,
    handlers,
    sent: [],
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    sendMessage(message) {
      this.sent.push(message);
    },
  };
}

function commandContext() {
  return {
    cwd: "/workspace",
    hasUI: false,
    ui: { notify: () => {}, setStatus: () => {} },
    modelRegistry: { id: "registry" },
    model: { provider: "test", id: "model" },
    sessionManager: { getSessionId: () => "session-1" },
  };
}

test("extension keeps host tools out of the main session and injects its named workflow toolset", async () => {
  const manager = fakeManager();
  const pi = fakePi();
  createWikiExtension({ core, managerFactory: () => manager })(pi);

  assert.deepEqual([...pi.commands.keys()], ["wiki"]);
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["okf_wiki"]);
  assert.equal(pi.handlers.has("session_start"), true);

  pi.handlers.get("session_start")({}, commandContext());
  const command = pi.commands.get("wiki");
  await command.handler("repository architecture", commandContext());

  assert.equal(manager.calls.starts.length, 1);
  assert.equal(manager.calls.starts[0].options.toolset, "okf-wiki");
  assert.equal(manager.calls.starts[0].args.workflowRunId, "pi-workflow-1");
  assert.deepEqual(manager.calls.sessionIds, ["session-1"]);
  assert.deepEqual(manager.calls.models, ["test/model"]);
});

test("status reports concrete Pi workflow IDs alongside the domain status", async () => {
  const manager = fakeManager();
  manager.listRuns = () => [{ runId: "pi-workflow-42", status: "paused" }];
  const pi = fakePi();
  createWikiExtension({ core, managerFactory: () => manager })(pi);
  await pi.commands.get("wiki").handler("status", commandContext());
  assert.match(pi.sent.at(-1).content, /pi-workflow-42 \(paused\)/);
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
  await pi.commands.get("wiki").handler("first documentation pass", commandContext());
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

test("changing session cwd pauses live work before creating the replacement manager", () => {
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
  pi.handlers.get("session_start")({}, { ...commandContext(), cwd: "/replacement" });
  assert.equal(paused, 1);
  assert.deepEqual(nextManager.calls.sessionIds, ["session-1"]);
});
