import assert from "node:assert/strict";
import test from "node:test";
import { createWikiExtension } from "../dist/extension.js";

function fakePi() {
  const commands = new Map();
  const handlers = new Map();
  return {
    commands, handlers, tools: [], sent: [], activeTools: ["read"],
    on(event, handler) { handlers.set(event, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { this.tools.push(tool); },
    sendMessage(message, options) { this.sent.push({ message, options }); },
    getActiveTools() { return this.activeTools; },
    setActiveTools(tools) { this.activeTools = tools; },
  };
}

function ctx(root) {
  const notifications = [];
  return {
    cwd: root, hasUI: false, modelRegistry: {}, model: { provider: "test", id: "m" },
    ui: { notify: (message, level) => notifications.push({ message, level }), setStatus: () => undefined }, notifications,
  };
}

function core(root) {
  return {
    initWorkspace: async () => ({ root, initialized: true, sources: [] }), ensureRuntime: async () => ({ ok: true }),
    loadWorkspace: async () => ({ root, initialized: true, sources: [] }),
    getWorkspaceStatus: async () => ({ root, initialized: true, activeRunId: "run-1", active: { runId: "run-1", status: "proposed" }, sources: [] }),
    addClonedSource: async () => ({ id: "clone", kind: "clone" }), addLinkedSource: async () => ({ id: "linked", kind: "linked" }),
    removeSource: async () => undefined, listSources: async () => [],
    prepareRun: async () => ({ status: "ok", runId: "run-1", root }), completeRunPlanning: async () => ({ runId: "run-1", status: "proposed", requiresApproval: true }),
    approveRun: async () => ({ runId: "run-1", status: "writing" }), resumeRun: async () => ({ runId: "run-1", status: "writing" }),
    setRunStatus: async () => ({ runId: "run-1", status: "writing" }), validateRunBundle: async () => ({ runId: "run-1", status: "completed" }),
    getRunPaths: async () => undefined, getRunState: async () => ({ runId: "run-1", status: "proposed" }),
    claimRun: async () => ({ ok: true, claimed: true }), releaseRun: async () => ({ ok: true, released: true }),
  };
}

function orchestrator(starts) {
  return {
    backend: "session",
    async start(input) { starts.push(input); return { orchRunId: `orch-${starts.length}`, runId: input.runId ?? "run-1" }; },
    async pause() { return true; }, async resume() { return true; }, async stop() { return true; },
    list() { return []; }, getSnapshot() { return undefined; }, getActiveSnapshot() { return undefined; },
    subscribe() { return () => undefined; }, async getTranscript() { return []; }, syncFromBackend() {}, updateSnapshot() {},
  };
}

test("extension exposes only the v4 command surface and starts generate/approve actions", async () => {
  const root = "/tmp/okf-wiki-extension";
  const pi = fakePi();
  const starts = [];
  createWikiExtension({ core: core(root), orchestratorFactory: () => orchestrator(starts) })(pi);
  assert.deepEqual([...pi.commands.keys()].sort(), ["wiki", "wiki-generate", "wiki-help", "wiki-init", "wiki-source"]);
  assert.ok(pi.tools.some((tool) => tool.name === "okf_wiki"));
  await pi.handlers.get("session_start")({}, ctx(root));
  await pi.commands.get("wiki").handler("generate auth", ctx(root));
  await pi.commands.get("wiki").handler("approve run-1", ctx(root));
  assert.deepEqual(starts, [
    { workspaceRoot: root, action: "generate", focus: "auth" },
    { workspaceRoot: root, action: "approve", runId: "run-1" },
  ]);
});

test("status remains host-grounded and old commands are rejected", async () => {
  const root = "/tmp/okf-wiki-extension-status";
  const pi = fakePi();
  createWikiExtension({ core: core(root), orchestratorFactory: () => orchestrator([]) })(pi);
  const commandContext = ctx(root);
  await pi.commands.get("wiki").handler("status --json", commandContext);
  assert.equal(JSON.parse(pi.sent.at(-1).message.content).workspace.activeRunId, "run-1");
  await pi.commands.get("wiki").handler("--write", commandContext);
  assert.match(commandContext.notifications.at(-1).message, /was removed/);
});
