import assert from "node:assert/strict";
import test from "node:test";
import { createWikiExtension } from "../dist/index.js";

function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) { handlers.set(event, handler); },
    registerCommand() {},
    registerTool() {},
    getActiveTools() { return []; },
    setActiveTools() {},
    sendMessage() {},
  };
}

test("extension exposes live model and registry getters to newly created orchestrators", async () => {
  const pi = fakePi();
  let captured;
  const idleOrchestrator = {
    backend: "session",
    async start() { return { orchestrationId: "orch", runId: "run" }; },
    async pause() { return false; }, async resume() { return false; }, async stop() { return false; },
    list() { return []; }, getSnapshot() {}, getActiveSnapshot() {}, subscribe() { return () => {}; }, async getTranscript() { return []; }, syncFromBackend() {},
  };
  createWikiExtension({
    core: { async getWorkspaceStatus() { throw new Error("not initialized"); } },
    orchestratorFactory(options) { captured = options; return idleOrchestrator; },
  })(pi);
  const registry = { id: "registry" };
  await pi.handlers.get("session_start")({}, {
    cwd: "/tmp/okf-wiki-model",
    hasUI: false,
    model: { provider: "test", id: "model" },
    modelRegistry: registry,
    ui: { notify() {}, setStatus() {} },
  });
  assert.equal(captured.getMainModel(), "test/model");
  assert.equal(captured.getModelRegistry(), registry);
});
