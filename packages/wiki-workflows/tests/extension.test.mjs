import assert from "node:assert/strict";
import test from "node:test";
import { createWikiExtension } from "../dist/extension.js";

function snapshot(overrides = {}) {
  return {
    version: 5,
    id: "run-1",
    cwd: "/workspace",
    requestedMode: "generate",
    effectiveMode: "generate",
    language: "zh",
    status: "running",
    round: 0,
    sourceRestartCount: 0,
    nodes: [],
    events: [],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function fakeEngine(initial, hooks = {}) {
  let current = initial;
  const listeners = new Set();
  const calls = [];
  const publish = (kind) => {
    for (const listener of [...listeners]) listener(current, { kind, at: current?.updatedAt ?? "2026-08-08T00:00:00.000Z", id: `${kind}-1` });
  };
  return {
    calls,
    get listenerCount() { return listeners.size; },
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
    /** Test helper: mark the current run terminal and emit a completion event. */
    complete(status = "succeeded") {
      if (!current) return;
      current = { ...current, status, updatedAt: "2026-08-08T00:01:00.000Z" };
      const kind = status === "cancelled" ? "run_cancelled"
        : status === "blocked" ? "run_blocked"
          : status === "failed" ? "run_failed"
            : "run_completed";
      publish(kind);
      return structuredClone(current);
    },
    pause() { calls.push(["pause"]); },
    async resume() { calls.push(["resume"]); },
    async cancel() { calls.push(["cancel"]); },
    async interrupt() { calls.push(["interrupt"]); },
    async waitForIdle() {
      calls.push(["waitForIdle"]);
      await hooks.onWaitForIdle?.();
      return current && structuredClone(current);
    },
    async retryNode(nodeId) { calls.push(["retry", nodeId]); },
    async retryPhase(phaseId) { calls.push(["retryPhase", phaseId]); },
    async forkAndRetryNode(value, nodeId) {
      calls.push(["forkAndRetryNode", value.id, nodeId]);
      current = snapshot({ id: `${value.id}-retry`, status: "running", parentRunId: value.id });
      return structuredClone(current);
    },
    async forkAndRetryPhase(value, phaseId) {
      calls.push(["forkAndRetryPhase", value.id, phaseId]);
      current = snapshot({ id: `${value.id}-retry`, status: "running", parentRunId: value.id });
      return structuredClone(current);
    },
  };
}

function fixture(options = {}) {
  const {
    entries = [],
    branchEntries = entries,
    mode = "print",
    hasUI = false,
    workspace = { root: "/workspace", language: "zh" },
    onHistorySave,
    onWaitForIdle,
  } = options;
  const commands = new Map();
  const handlers = new Map();
  const appended = [];
  const messages = [];
  const notices = [];
  const statuses = [];
  const widgets = [];
  const workspaceCalls = [];
  const history = new Map();
  const engine = fakeEngine(undefined, { onWaitForIdle });
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(customType, data) { appended.push({ customType, data }); },
    sendMessage(message, options) { messages.push({ ...message, options }); },
  };
  const ctx = {
    cwd: "/workspace",
    model: undefined,
    thinkingLevel: undefined,
    mode,
    hasUI,
    ui: {
      notify(message, level) { notices.push({ message, level }); },
      setStatus(key, text) { statuses.push({ key, text }); },
      setWidget(key, content, options) { widgets.push({ key, content, options }); },
      setWorkingMessage() {},
      confirm: async () => false,
      custom: async () => undefined,
    },
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => branchEntries,
    },
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
  const historyStore = {
    async save(value) {
      await onHistorySave?.(value);
      history.set(value.id, structuredClone(value));
    },
    async load(id) { return history.has(id) ? structuredClone(history.get(id)) : undefined; },
    async list() {
      return [...history.values()].map((value) => ({
        id: value.id, cwd: value.cwd, requestedMode: value.requestedMode, effectiveMode: value.effectiveMode,
        focus: value.focus, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt,
        totalNodes: value.nodes.length, succeededNodes: value.nodes.filter((node) => node.status === "succeeded").length,
        failedNodes: value.nodes.filter((node) => node.status === "failed" || node.status === "blocked").length,
        changedPaths: value.inspection?.changedPaths.length ?? 0,
      })).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    },
    async delete(id) { return history.delete(id); },
    getRunsDir: () => "/history",
    getArtifactsRoot: () => "/workspace/.okf-wiki/runs",
  };
  createWikiExtension({ createEngine: () => engine, workspaceService, createHistoryStore: () => historyStore })(pi);
  return { appended, commands, ctx, engine, handlers, history, messages, notices, statuses, widgets, workspaceCalls };
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
  const staleFork = { customType: "okf-wiki-run", workspace: "/workspace", snapshot: snapshot({ id: "stale-fork" }) };
  const subject = fixture({
    entries: [
      { type: "custom", customType: "okf-wiki-run", data: other },
      { type: "custom", customType: "okf-wiki-run", data: restored },
      { type: "custom", customType: "okf-wiki-run", data: staleFork },
    ],
    branchEntries: [
    { type: "custom", customType: "okf-wiki-run", data: other },
    { type: "custom", customType: "okf-wiki-run", data: restored },
    ],
  });

  await subject.handlers.get("session_start")({}, subject.ctx);
  assert.equal(subject.engine.calls[0][0], "restore");
  assert.equal(subject.engine.calls[0][1].snapshot.id, "restored");

  await subject.handlers.get("session_shutdown")({}, subject.ctx);
  assert.deepEqual(subject.engine.calls.slice(-2).map(([name]) => name), ["interrupt", "waitForIdle"]);
  assert.equal(subject.appended.at(-1).data.workspace, "/workspace");
});

test("session shutdown is idempotent when no Wiki run exists", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);

  await subject.handlers.get("session_shutdown")({}, subject.ctx);

  assert.deepEqual(subject.engine.calls, [["interrupt"], ["waitForIdle"]]);
  assert.equal(subject.appended.length, 0);
  assert.equal(subject.engine.listenerCount, 0);
});

test("session shutdown waits for engine quiescence before final persistence", async () => {
  let releaseIdle;
  let idleStarted;
  const idleGate = new Promise((resolve) => { releaseIdle = resolve; });
  const idleSignal = new Promise((resolve) => { idleStarted = resolve; });
  const subject = fixture({
    onWaitForIdle: async () => {
      idleStarted();
      await idleGate;
    },
  });
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);
  const appendedBeforeShutdown = subject.appended.length;

  const shutdown = subject.handlers.get("session_shutdown")({}, subject.ctx);
  await idleSignal;
  assert.equal(subject.appended.length, appendedBeforeShutdown);

  releaseIdle();
  await shutdown;
  assert.ok(subject.appended.length > appendedBeforeShutdown);
  assert.equal(subject.engine.listenerCount, 0);
});

test("fresh sessions resume the latest recoverable project run", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);
  subject.history.set("run-older", snapshot({
    id: "run-older",
    status: "paused",
    updatedAt: "2026-08-08T00:01:00.000Z",
  }));
  subject.history.set("run-alpha", snapshot({
    id: "run-alpha",
    status: "running",
    updatedAt: "2026-08-08T00:02:00.000Z",
  }));
  subject.history.set("run-zeta", snapshot({
    id: "run-zeta",
    status: "paused",
    updatedAt: "2026-08-08T00:02:00.000Z",
  }));

  await subject.commands.get("wiki").handler("resume", subject.ctx);

  assert.deepEqual(subject.engine.calls.slice(-2).map((call) => call[0]), ["restore", "resume"]);
  assert.equal(subject.engine.calls.at(-2)[1].id, "run-zeta");
  assert.equal(subject.appended.at(-1).data.snapshot.id, "run-zeta");
});

test("resume accepts an exact historical run id and rejects terminal runs", async () => {
  const selected = fixture();
  await selected.handlers.get("session_start")({}, selected.ctx);
  selected.history.set("run-selected", snapshot({ id: "run-selected", status: "paused" }));
  selected.history.set("run-newer", snapshot({
    id: "run-newer",
    status: "paused",
    updatedAt: "2026-08-08T00:02:00.000Z",
  }));

  await selected.commands.get("wiki").handler("resume run-selected", selected.ctx);
  assert.equal(selected.engine.calls.at(-2)[0], "restore");
  assert.equal(selected.engine.calls.at(-2)[1].id, "run-selected");

  const failed = fixture();
  await failed.handlers.get("session_start")({}, failed.ctx);
  failed.history.set("run-failed", snapshot({ id: "run-failed", status: "failed" }));
  await failed.commands.get("wiki").handler("resume run-failed", failed.ctx);

  assert.equal(failed.engine.calls.some(([name]) => name === "restore"), false);
  assert.match(failed.notices.at(-1).message, /targeted node or phase retry/);
});

test("navigator r forks a failed historical run for targeted retry", async () => {
  const subject = fixture({ mode: "tui", hasUI: true });
  const failedRun = snapshot({
    id: "run-failed-retry",
    status: "failed",
    nodes: [{
      id: "inspect",
      kind: "inspect",
      label: "Inspect Git scope",
      phaseId: "inspect",
      phaseTitle: "Inspect",
      status: "failed",
      dependsOn: [],
      attempt: 1,
      inputFingerprint: "input",
      input: {},
      attemptHistory: [],
      metrics: {},
      activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" },
      error: { message: "inspection failed", code: "execution_failed" },
    }],
  });
  subject.history.set(failedRun.id, failedRun);
  let component;
  subject.ctx.ui.custom = (factory) => new Promise((resolve) => {
    component = factory(
      { terminal: { rows: 24 }, requestRender() {} },
      { fg: (_color, text) => text, bold: (text) => text },
      {},
      resolve,
    );
  });
  await subject.handlers.get("session_start")({}, subject.ctx);

  const opening = subject.commands.get("wiki").handler("open", subject.ctx);
  while (!component) await new Promise((resolve) => setImmediate(resolve));
  component.render(80);
  component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  component.render(80);
  component.handleInput("l");
  component.render(80);
  component.handleInput("r");
  assert.match(component.render(80).join("\n"), /Inspect Git scope/);
  component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(subject.engine.calls.some((call) => call[0] === "forkAndRetryNode"
    && call[1] === "run-failed-retry" && call[2] === "inspect"));
  component.dispose();
  await opening;
});

test("session shutdown waits for pending terminal history writes", async () => {
  let releaseTerminalSave;
  let terminalSaveStarted;
  const terminalSaveGate = new Promise((resolve) => { releaseTerminalSave = resolve; });
  const terminalSaveSignal = new Promise((resolve) => { terminalSaveStarted = resolve; });
  const subject = fixture({
    onHistorySave: async (value) => {
      if (value.status !== "succeeded") return;
      terminalSaveStarted();
      await terminalSaveGate;
    },
  });
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);
  subject.engine.complete("succeeded");
  await terminalSaveSignal;

  let shutdownFinished = false;
  const shutdown = subject.handlers.get("session_shutdown")({}, subject.ctx).then(() => { shutdownFinished = true; });
  await Promise.resolve();
  assert.equal(shutdownFinished, false);

  releaseTerminalSave();
  await shutdown;
  assert.equal(subject.history.get("run-1").status, "succeeded");
});

test("project history write failures are reported without losing Pi session state", async () => {
  const subject = fixture({
    mode: "tui",
    hasUI: true,
    onHistorySave: async () => { throw new Error("disk unavailable"); },
  });
  await subject.handlers.get("session_start")({}, subject.ctx);

  await subject.commands.get("wiki").handler("generate", subject.ctx);

  assert.equal(subject.appended.at(-1).data.snapshot.id, "run-1");
  assert.ok(subject.notices.some(({ message, level }) => level === "error"
    && /history could not be saved: disk unavailable/.test(message)));
});

test("does not restore legacy v4 session entries", async () => {
  const legacy = {
    customType: "okf-wiki-run",
    workspace: "/workspace",
    snapshot: snapshot({ version: 4, id: "legacy" }),
  };
  const subject = fixture({ entries: [
    { type: "custom", customType: "okf-wiki-run", data: legacy },
  ] });

  await subject.handlers.get("session_start")({}, subject.ctx);
  assert.equal(subject.engine.calls.some(([name]) => name === "restore"), false);
  assert.equal(subject.engine.getSnapshot(), undefined);
});

test("does not restore structurally corrupt v5 session entries", async () => {
  const malformed = {
    customType: "okf-wiki-run",
    workspace: "/workspace",
    snapshot: snapshot({ id: "malformed", nodes: [null] }),
  };
  const subject = fixture({ entries: [
    { type: "custom", customType: "okf-wiki-run", data: malformed },
  ] });

  await subject.handlers.get("session_start")({}, subject.ctx);
  assert.equal(subject.engine.calls.some(([name]) => name === "restore"), false);
  assert.equal(subject.engine.getSnapshot(), undefined);
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

test("history prints a concise project summary without requiring run IDs", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);
  const command = subject.commands.get("wiki");
  await command.handler("generate architecture", subject.ctx);
  await command.handler("history", subject.ctx);

  assert.equal(subject.history.size, 1);
  assert.match(subject.messages.at(-1).content, /Wiki History/);
  assert.match(subject.messages.at(-1).content, /architecture/);
  assert.doesNotMatch(subject.messages.at(-1).content, /run-1/);
});

test("artifacts lists persisted handoffs for a requested historical run", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);
  const command = subject.commands.get("wiki");
  const historical = snapshot({ id: "run-history", status: "succeeded", nodes: [{
    id: "inspect",
    kind: "inspect",
    label: "Inspect Git scope",
    status: "succeeded",
    dependsOn: [],
    attempt: 1,
    inputFingerprint: "input",
    input: {},
    attemptHistory: [],
    metrics: {},
    activity: { state: "completed", updatedAt: "2026-08-08T00:00:00.000Z" },
    handoff: {
      version: 1,
      runId: "run-history",
      nodeId: "inspect",
      attempt: 1,
      kind: "inspection",
      relativePath: ".okf-wiki/runs/run-history/inspect/attempt-1/inspection.json",
      sha256: "a".repeat(64),
      sizeBytes: 12,
      mediaType: "application/json",
    },
  }] });
  subject.history.set(historical.id, historical);

  await command.handler("artifacts run-history", subject.ctx);
  assert.match(subject.messages.at(-1).content, /Wiki Artifacts run-history/);
  assert.match(subject.messages.at(-1).content, /Inspect Git scope \| attempt 1 \| inspection/);
  assert.match(subject.messages.at(-1).content, /inspection\.json/);
});

test("TUI status uses native notification instead of a model-context message", async () => {
  const subject = fixture({ mode: "tui", hasUI: true });
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);
  await subject.commands.get("wiki").handler("status", subject.ctx);
  assert.equal(subject.messages.length, 0);
  assert.equal(subject.notices.length, 2);
  assert.match(subject.notices[0].message, /\/wiki open/);
  assert.match(subject.notices[0].message, /generate/);
  assert.match(subject.notices.at(-1).message, /Wiki Run run-1/);
});

test("session host installs setStatus and setWidget without auto-opening the navigator", async () => {
  const subject = fixture({ mode: "tui", hasUI: true });
  await subject.handlers.get("session_start")({}, subject.ctx);
  assert.ok(subject.widgets.some((item) => item.key === "okf-wiki-tasks"));
  assert.ok(subject.statuses.some((item) => item.key === "okf-wiki"));

  await subject.commands.get("wiki").handler("generate", subject.ctx);
  assert.ok(subject.statuses.some((item) => item.key === "okf-wiki" && /Wiki/.test(String(item.text ?? ""))));
  assert.ok(subject.widgets.filter((item) => item.key === "okf-wiki-tasks").length >= 2);
  assert.equal(subject.messages.filter((item) => item.customType === "okf-wiki-result").length, 0);
});

test("TUI help preserves line breaks for Pi's wrapping text renderer", async () => {
  const subject = fixture({ mode: "tui", hasUI: true });
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("help", subject.ctx);

  assert.equal(subject.messages.length, 0);
  assert.match(subject.notices.at(-1).message, /Usage:\n/);
  assert.match(subject.notices.at(-1).message, /\n  \/wiki init/);
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
    "init ", "source ", "generate ", "refresh ", "open", "status", "history", "artifacts ", "pause", "resume ", "cancel", "help",
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

  assert.deepEqual(subject.workspaceCalls.filter(([name]) => name !== "load"), [
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

test("generate does not call ui.custom (navigator stays on-demand)", async () => {
  let customCalls = 0;
  const subject = fixture({ mode: "tui", hasUI: true });
  subject.ctx.ui.custom = async () => {
    customCalls += 1;
    return undefined;
  };
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);
  assert.equal(customCalls, 0);
  assert.equal(subject.messages.filter((item) => item.customType === "okf-wiki-result").length, 0);
});

test("terminal run event delivers sendMessage with okf-wiki-result", async () => {
  const subject = fixture({ mode: "tui", hasUI: true });
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);
  subject.engine.complete("succeeded");

  const deliveries = subject.messages.filter((item) => item.customType === "okf-wiki-result");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].display, true);
  assert.deepEqual(deliveries[0].options, { triggerTurn: false, deliverAs: "followUp" });
  assert.match(String(deliveries[0].content), /Wiki|generate|succeeded|run/i);
});

test("run_failed delivers one terminal result message", async () => {
  const subject = fixture({ mode: "tui", hasUI: true });
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);
  subject.engine.complete("failed");

  const deliveries = subject.messages.filter((item) => item.customType === "okf-wiki-result");
  assert.equal(deliveries.length, 1);
  assert.match(String(deliveries[0].content), /failed/i);
});

test("open lands on runs list when the only snapshot is terminal", async () => {
  const openLandings = [];
  const subject = fixture({ mode: "tui", hasUI: true });
  subject.ctx.ui.custom = async (factory) => {
    // Capture whether open opened a navigator; the factory builds the overlay component.
    openLandings.push("opened");
    // Immediately dispose without rendering a full TUI.
    const component = factory(
      { terminal: { rows: 24 }, requestRender() {} },
      {
        fg: (_c, text) => text,
        bold: (text) => text,
      },
      {},
      () => {},
    );
    // Component should exist; dispose must call done safely.
    assert.equal(typeof component.render, "function");
    assert.equal(typeof component.dispose, "function");
    component.dispose();
    return undefined;
  };
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);
  subject.engine.complete("succeeded");

  await subject.commands.get("wiki").handler("open", subject.ctx);
  assert.equal(openLandings.length, 1);
  // Terminal snapshots are not "active"; host still opens navigator (runs list landing).
  assert.ok(subject.statuses.some((item) => item.key === "okf-wiki"));
});

test("blocked runs are terminal history and open on the runs list", async () => {
  const subject = fixture({ mode: "tui", hasUI: true });
  subject.ctx.ui.custom = async (factory) => {
    let doneCalls = 0;
    const component = factory(
      { terminal: { rows: 24 }, requestRender() {} },
      { fg: (_c, text) => text, bold: (text) => text },
      {},
      () => { doneCalls++; },
    );
    // Escape closes the root runs view. A dashboard landing would only pop back
    // to that list, leaving the overlay open.
    component.handleInput("\x1b");
    assert.equal(doneCalls, 1);
    return undefined;
  };

  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);
  subject.engine.complete("blocked");

  await subject.commands.get("wiki").handler("open", subject.ctx);
});
