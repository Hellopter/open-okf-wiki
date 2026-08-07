import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWikiExtension } from "../dist/extension.js";
import { createSessionOrchestrator } from "../dist/orch/session-backend.js";
import { createMockAgentRunner } from "../dist/orch/agent-runner.js";

const core = {
  initWorkspace: async (root) => ({ root, initialized: true, sources: [] }),
  ensureRuntime: async () => ({ ok: true }),
  loadWorkspace: async (root) => ({ root, initialized: true, sources: [] }),
  getWorkspaceStatus: async (root) => ({
    root,
    initialized: true,
    sources: [],
    activeRunId: undefined,
  }),
  addClonedSource: async () => ({ id: "clone", kind: "clone" }),
  addLinkedSource: async () => ({ id: "linked", kind: "linked" }),
  removeSource: async () => undefined,
  listSources: async () => [],
  prepareRun: async (root, opts) => ({
    status: "ok",
    runId: "domain-1",
    workdir: join(root, ".wiki-agent", "runs", "domain-1", "workdir"),
    workspaceRoot: root,
    mode: opts?.mode ?? "auto",
    startAt: "gate",
    summary: "already at gate",
  }),
  mergeSurveyReceipts: async () => ({
    status: "ok",
    pass: 1,
    artifactsPath: "analysis/receipts/discovery-artifacts-pass-1.json",
    missingUnitIds: [],
    retryUnitIds: [],
    needsDomainLabels: false,
  }),
  publishCheckpoint: async () => ({ status: "ok" }),
  openPlanGate: async () => ({ ok: true }),
  checkPlanGate: async () => ({ ok: true }),
  validateCandidate: async () => ({ ok: true }),
  getRunPaths: async () => undefined,
};

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

function commandContext(root, overrides = {}) {
  const statuses = [];
  const notifications = [];
  return {
    cwd: root,
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

const EXPECTED_COMMANDS = [
  "wiki",
  "wiki-help",
  "wiki-init",
  "wiki-run",
  "wiki-source",
];

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "okf-wiki-ext-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function install(pi, root, orchFactory) {
  createWikiExtension({
    core,
    orchestratorFactory: ({ workspaceRoot, core: c }) =>
      orchFactory
        ? orchFactory({ workspaceRoot, core: c })
        : createSessionOrchestrator({
            workspaceRoot,
            core: c,
            getTools: () => [],
            agentRunner: createMockAgentRunner(async () => ({ status: "ok", summary: "mock" })),
          }),
  })(pi);
}

test("extension registers commands and tool; session start works", async () => {
  await withRoot(async (root) => {
    const pi = fakePi();
    let orch;
    install(pi, root, ({ workspaceRoot, core: c }) => {
      orch = createSessionOrchestrator({
        workspaceRoot,
        core: c,
        getTools: () => [],
        agentRunner: createMockAgentRunner(async () => ({ status: "ok", summary: "mock" })),
      });
      return orch;
    });

    assert.deepEqual([...pi.commands.keys()].sort(), [...EXPECTED_COMMANDS].sort());
    assert.equal(pi.tools[0].name, "okf_wiki");

    await pi.handlers.get("session_start")({}, commandContext(root));
    await pi.commands.get("wiki").handler("run", commandContext(root));
    assert.ok(orch.getActiveSnapshot()?.orchRunId?.startsWith("session-"));
    assert.equal(orch.backend, "session");
    await orch.waitFor?.();
    orch.dispose();
  });
});

test("empty /wiki opens the Navigator and does not start a run", async () => {
  await withRoot(async (root) => {
    const pi = fakePi();
    install(pi, root);
    const ctx = commandContext(root);
    await pi.commands.get("wiki").handler("", ctx);
    assert.equal(pi.sent.length, 0);
    assert.match(ctx.notifications.at(-1).message, /Navigator requires interactive Pi/);
  });
});

test("JSON status and stop work after a run", async () => {
  await withRoot(async (root) => {
    const pi = fakePi();
    let orch;
    install(pi, root, ({ workspaceRoot, core: c }) => {
      orch = createSessionOrchestrator({
        workspaceRoot,
        core: c,
        getTools: () => [],
        agentRunner: createMockAgentRunner(async () => ({ status: "ok", summary: "ok" })),
      });
      return orch;
    });

    await pi.handlers.get("session_start")({}, commandContext(root));
    await pi.commands.get("wiki").handler("run", commandContext(root));
    await orch.waitFor?.();

    await pi.commands.get("wiki").handler("status --json", commandContext(root));
    const status = JSON.parse(pi.sent.at(-1).message.content);
    assert.equal(status.workspace.root, root);
    assert.ok(status.orchestration);

    const hangCore = {
      ...core,
      prepareRun: async () => new Promise(() => {}),
    };
    const pi2 = fakePi();
    let orch2;
    createWikiExtension({
      core: hangCore,
      orchestratorFactory: ({ workspaceRoot, core: c }) => {
        orch2 = createSessionOrchestrator({
          workspaceRoot,
          core: c,
          getTools: () => [],
          agentRunner: createMockAgentRunner(async () => ({ status: "ok" })),
        });
        return orch2;
      },
    })(pi2);
    await pi2.handlers.get("session_start")({}, commandContext(root));
    await pi2.commands.get("wiki").handler("run", commandContext(root));
    const ctrl = commandContext(root);
    await pi2.commands.get("wiki").handler("stop", ctrl);
    assert.match(ctrl.notifications.at(-1).message, /Stopped/i);
    orch2.dispose();
    orch.dispose();
  });
});

test("removed observation aliases are not registered", async () => {
  const pi = fakePi();
  install(pi, "/tmp");
  for (const name of ["wiki-status", "wiki-agents", "wiki-inspect"]) {
    assert.ok(!pi.commands.has(name));
  }
});
