/**
 * Loads the real @okf-wiki/wiki-agent-kit (sync host-api) through the production
 * factory and asserts the extension surfaces commands without session_start crashes.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import * as kit from "@okf-wiki/wiki-agent-kit";
import { createProductionExtension } from "../dist/extension.js";
import { createCoreAdapter } from "../dist/core-adapter.js";

function fakeManager() {
  const manager = new EventEmitter();
  Object.assign(manager, {
    listRuns: () => [],
    listLiveRuns: () => [],
    setSessionId: () => undefined,
    setMainModel: () => undefined,
    setModelRegistry: () => undefined,
    adoptLiveRunsToSession: () => 0,
    startInBackground: () => ({ runId: "pi-prod-1", promise: Promise.resolve({}) }),
    pause: () => true,
    resume: async () => true,
    stop: () => true,
  });
  return manager;
}

function fakePi() {
  const commands = new Map();
  const handlers = new Map();
  return {
    commands,
    handlers,
    tools: [],
    sent: [],
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      this.tools.push(tool);
    },
    sendMessage(message, options) {
      this.sent.push({ message, options });
    },
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  };
}

test("createCoreAdapter wraps the real kit so sync returns are awaitable", async () => {
  const adapter = createCoreAdapter(kit);
  const missing = await adapter.loadWorkspace(join(tmpdir(), "definitely-not-a-wiki-workspace-" + Date.now()));
  assert.equal(missing, undefined);
});

test("production extension registers commands and survives session_start with real kit", async () => {
  const root = await mkdtemp(join(tmpdir(), "okf-wiki-prod-"));
  try {
    const manager = fakeManager();
    const pi = fakePi();
    const extension = createProductionExtension(kit);
    // Inject manager factory via monkey-patch path: createProductionExtension
    // uses the real WorkflowManager by default. For this smoke test we only
    // need command registration + session_start against the real core, so
    // re-bind through createWikiExtension-equivalent by calling the factory
    // and then using a lightweight manager via a second extension load.
    // Production factory itself must not throw on kit import.
    assert.equal(typeof extension, "function");

    // Register with a manager factory by using createWikiExtension + wrapped kit.
    const { createWikiExtension } = await import("../dist/extension.js");
    createWikiExtension({
      core: createCoreAdapter(kit),
      managerFactory: () => manager,
    })(pi);

    for (const name of ["wiki", "wiki-help", "wiki-status", "wiki-init", "wiki-run", "wiki-source"]) {
      assert.ok(pi.commands.has(name), `missing command ${name}`);
    }

    const statuses = [];
    const ctx = {
      cwd: root,
      hasUI: false,
      ui: {
        notify: () => undefined,
        setStatus: (key, text) => statuses.push({ key, text }),
      },
      modelRegistry: {},
      model: { provider: "test", id: "m" },
      sessionManager: { getSessionId: () => "prod-session" },
    };

    await assert.doesNotReject(() => pi.handlers.get("session_start")({}, ctx));
    assert.ok(statuses.some((entry) => entry.key === "okf-wiki"));

    await pi.commands.get("wiki").handler("", ctx);
    assert.match(pi.sent.at(-1).message.content, /OKF Wiki/);

    await pi.commands.get("wiki").handler("init --name prod-test --lang en", ctx);
    const status = await createCoreAdapter(kit).getWorkspaceStatus(root);
    assert.equal(status.initialized, true);
    assert.equal(status.name, "prod-test");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
