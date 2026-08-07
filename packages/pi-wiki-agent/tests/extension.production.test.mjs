/**
 * Loads the real @okf-wiki/wiki-agent-kit and asserts the extension surfaces
 * commands without session_start crashes.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as kit from "@okf-wiki/wiki-agent-kit";
import { createCoreAdapter, createWikiExtension } from "../dist/index.js";

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
    const pi = fakePi();
    createWikiExtension({
      core: createCoreAdapter(kit),
    })(pi);

    for (const name of [
      "wiki",
      "wiki-help",
      "wiki-init",
      "wiki-generate",
      "wiki-source",
    ]) {
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

    await pi.handlers.get("session_start")({}, ctx);
    assert.ok(Array.isArray(statuses));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
