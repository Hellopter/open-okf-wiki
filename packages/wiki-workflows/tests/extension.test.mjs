import assert from "node:assert/strict";
import test from "node:test";
import { createWikiExtension } from "../dist/extension.js";

function snapshot(overrides = {}) {
  return {
    version: 1,
    id: "run-1",
    cwd: "/workspace",
    requestedMode: "generate",
    effectiveMode: "generate",
    language: "zh",
    status: "running",
    round: 0,
    nodes: [],
    events: [],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function fakeEngine(initial) {
  let current = initial;
  const listeners = new Set();
  const calls = [];
  const publish = (kind) => {
    for (const listener of listeners) listener(current, { kind, at: current.updatedAt, id: `${kind}-1` });
  };
  return {
    calls,
    start(request) {
      calls.push(["start", request]);
      current = snapshot({ requestedMode: request.mode, effectiveMode: request.mode, language: request.language ?? "zh", focus: request.focus });
      publish("run_started");
      return structuredClone(current);
    },
    getSnapshot: () => current && structuredClone(current),
    serialize: () => current && { customType: "okf-wiki-run", workspace: current.cwd, snapshot: structuredClone(current) },
    restore(value) {
      calls.push(["restore", value]);
      current = structuredClone(value.snapshot ?? value);
      return structuredClone(current);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pause() { calls.push(["pause"]); },
    async resume() { calls.push(["resume"]); },
    async cancel() { calls.push(["cancel"]); },
    async interrupt() { calls.push(["interrupt"]); },
    async retryNode(nodeId) { calls.push(["retry", nodeId]); },
  };
}

function fixture({ entries = [], mode = "print", hasUI = false } = {}) {
  const commands = new Map();
  const handlers = new Map();
  const appended = [];
  const messages = [];
  const notices = [];
  const engine = fakeEngine();
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(customType, data) { appended.push({ customType, data }); },
    sendMessage(message) { messages.push(message); },
  };
  const ctx = {
    cwd: "/workspace",
    model: undefined,
    thinkingLevel: undefined,
    mode,
    hasUI,
    ui: {
      notify(message, level) { notices.push({ message, level }); },
      setStatus() {},
    },
    sessionManager: { getEntries: () => entries },
  };
  createWikiExtension({ createEngine: () => engine })(pi);
  return { appended, commands, ctx, engine, handlers, messages, notices };
}

test("registers one command, starts in the background, and persists non-context run state", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);

  assert.deepEqual([...subject.commands.keys()], ["wiki"]);
  await subject.commands.get("wiki").handler("generate lang=en authentication", subject.ctx);

  assert.deepEqual(subject.engine.calls[0], ["start", {
    cwd: "/workspace",
    mode: "generate",
    language: "en",
    focus: "authentication",
  }]);
  assert.equal(subject.appended.at(-1).customType, "okf-wiki-run");
  assert.equal(subject.appended.at(-1).data.snapshot.language, "en");
  assert.equal(subject.messages.length, 0, "starting a run must not add a model-context message");
});

test("restores only the latest matching-workspace custom entry and persists interruption", async () => {
  const other = { customType: "okf-wiki-run", workspace: "/other", snapshot: snapshot({ cwd: "/other" }) };
  const restored = { customType: "okf-wiki-run", workspace: "/workspace", snapshot: snapshot({ id: "restored" }) };
  const subject = fixture({ entries: [
    { type: "custom", customType: "okf-wiki-run", data: other },
    { type: "custom", customType: "okf-wiki-run", data: restored },
  ] });

  await subject.handlers.get("session_start")({}, subject.ctx);
  assert.equal(subject.engine.calls[0][0], "restore");
  assert.equal(subject.engine.calls[0][1].snapshot.id, "restored");

  await subject.handlers.get("session_shutdown")({}, subject.ctx);
  assert.equal(subject.engine.calls.at(-1)[0], "interrupt");
  assert.equal(subject.appended.at(-1).data.workspace, "/workspace");
});

test("status, pause, resume, and cancel use the same single-run controller", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);
  const command = subject.commands.get("wiki");

  await command.handler("generate", subject.ctx);
  await command.handler("status", subject.ctx);
  await command.handler("pause", subject.ctx);
  await command.handler("resume", subject.ctx);
  await command.handler("cancel", subject.ctx);

  assert.match(subject.messages[0].content, /Wiki Run run-1/);
  assert.deepEqual(subject.engine.calls.slice(-3).map(([name]) => name), ["pause", "resume", "cancel"]);
});

test("TUI status uses native notification instead of a model-context message", async () => {
  const subject = fixture({ mode: "tui", hasUI: true });
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);
  await subject.commands.get("wiki").handler("status", subject.ctx);
  assert.equal(subject.messages.length, 0);
  assert.equal(subject.notices.length, 2);
  assert.match(subject.notices.at(-1).message, /Wiki Run run-1/);
});
