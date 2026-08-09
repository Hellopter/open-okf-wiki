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

function fixture({ entries = [], mode = "print", hasUI = false, workspace = { root: "/workspace", language: "zh" } } = {}) {
  const commands = new Map();
  const handlers = new Map();
  const appended = [];
  const messages = [];
  const notices = [];
  const workspaceCalls = [];
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
      setWorkingMessage() {},
    },
    sessionManager: { getEntries: () => entries },
  };
  const workspaceService = {
    async initialize(request) {
      workspaceCalls.push(["initialize", request]);
      return { action: "initialized", workspace: request.workspace ?? request.cwd, language: request.language ?? "zh" };
    },
    async addSource(request) {
      workspaceCalls.push(["addSource", request]);
      return { action: request.source.kind === "link" ? "linked" : "cloned", workspace: workspace.root, language: workspace.language, sourcePath: request.source.kind === "link" ? "api" : "web" };
    },
    async load(cwd) {
      workspaceCalls.push(["load", cwd]);
      return { ...workspace, sources: [] };
    },
  };
  createWikiExtension({ createEngine: () => engine, workspaceService })(pi);
  return { appended, commands, ctx, engine, handlers, messages, notices, workspaceCalls };
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

test("the bare command shows help and does not open a blocking Navigator", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("", subject.ctx);

  assert.equal(subject.engine.calls.length, 0);
  assert.equal(subject.messages.length, 1);
  assert.match(subject.messages[0].content, /\/wiki init/);
});

test("Wiki subcommands are discoverable through Pi argument completion", () => {
  const subject = fixture();
  const complete = subject.commands.get("wiki").getArgumentCompletions;

  assert.deepEqual(complete("").map(({ value }) => value), [
    "init ", "source ", "generate ", "refresh ", "open", "status", "pause", "resume", "cancel", "help",
  ]);
  assert.deepEqual(complete("in").map(({ value }) => value), ["init "]);
  assert.deepEqual(complete("source ").map(({ value }) => value), ["source add "]);
  assert.deepEqual(complete("source add ").map(({ value }) => value), ["source add link ", "source add clone "]);
  assert.deepEqual(complete("init --lang ").map(({ value }) => value), ["init --lang zh", "init --lang en"]);
  assert.equal(complete("init --workspace "), null);
  assert.deepEqual(complete("generate ").map(({ value }) => value), ["generate lang=zh", "generate lang=en"]);
});

test("initialization persists language and source commands use project names without IDs", async () => {
  const subject = fixture({ workspace: { root: "/docs", language: "en" } });
  await subject.handlers.get("session_start")({}, subject.ctx);
  const command = subject.commands.get("wiki");

  await command.handler("init --workspace docs --lang en", subject.ctx);
  await command.handler("source add link /projects/api --workspace docs", subject.ctx);
  await command.handler("source add clone https://example.test/web.git --ref main --workspace docs", subject.ctx);
  await command.handler("source add link /projects/api --id ignored", subject.ctx);

  assert.deepEqual(subject.workspaceCalls, [
    ["initialize", { cwd: "/workspace", workspace: "docs", language: "en" }],
    ["addSource", { cwd: "/workspace", workspace: "docs", source: { kind: "link", path: "/projects/api" } }],
    ["addSource", { cwd: "/workspace", workspace: "docs", source: { kind: "clone", url: "https://example.test/web.git", ref: "main" } }],
  ]);
  assert.match(subject.notices.at(-1).message, /Usage: \/wiki source add link/);
});

test("generation uses the workspace language by default and starts from its root", async () => {
  const subject = fixture({ workspace: { root: "/docs", language: "en" } });
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate architecture", subject.ctx);

  assert.deepEqual(subject.engine.calls[0], ["start", {
    cwd: "/docs",
    mode: "generate",
    language: "en",
    focus: "architecture",
  }]);
});
