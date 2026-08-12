import assert from "node:assert/strict";
import test from "node:test";
import { createWikiExtension } from "../dist/extension.js";

const TEST_WIKI_CONFIG = {
  exclude: [], terminology: {}, domains: [],
  runtime: { maxConcurrentAgents: 2, nodeTimeoutSeconds: 1200, maxAutoRetries: 3, maxTransientSessionAttempts: 2, rateLimitCooldownSeconds: 15 },
};
const TEST_POLICY_INPUT = { ...TEST_WIKI_CONFIG, quality: { maxSubmissionAttempts: 3 } };

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
    sourceRestartCount: 0,
    maxResearchRounds: 6,
    policy: { version: 3, ...TEST_WIKI_CONFIG, quality: { maxSubmissionAttempts: 3 }, promptBundleHash: "prompt-bundle" },
    policyHash: "policy-hash",
    nodes: [],
    events: [],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function pointerFrom(snap) {
  return {
    customType: "okf-wiki-run",
    workspace: snap.cwd,
    pointerVersion: 1,
    runId: snap.id,
    revision: snap.revision ?? 0,
    status: snap.status,
    updatedAt: snap.updatedAt,
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
    serialize: () => current && pointerFrom(current),
    restore(value) {
      calls.push(["restore", value]);
      // Engine accepts full snapshots only (history store); pointer sessions are rejected.
      if (!value || typeof value !== "object" || value.version !== 1 || !value.id) return undefined;
      current = structuredClone(value);
      // Mirror engine recovery: running → paused.
      if (current.status === "running") {
        current = { ...current, status: "paused" };
      }
      return structuredClone(current);
    },
    async applyRestoredArtifactHealth() {
      calls.push(["applyRestoredArtifactHealth"]);
      return [];
    },
    reconcilePolicy(policy) {
      calls.push(["reconcilePolicy", policy]);
      return current && structuredClone(current);
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
    pause() {
      calls.push(["pause"]);
      if (current?.status === "running") current = { ...current, status: "paused" };
    },
    async resume() { calls.push(["resume"]); },
    async stop() {
      calls.push(["stop"]);
      if (current && (current.status === "running" || current.status === "paused")) {
        current = { ...current, status: "paused" };
      }
    },
    async cancel() {
      calls.push(["cancel"]);
      if (current) current = { ...current, status: "cancelled" };
    },
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
    workspace: workspaceInput = { root: "/workspace", language: "zh", wiki: TEST_WIKI_CONFIG },
    onHistorySave,
    onWaitForIdle,
    onRecoverPending,
    coordinatorBusyOwner,
  } = options;
  const workspace = { wiki: TEST_WIKI_CONFIG, ...workspaceInput };
  const commands = new Map();
  const handlers = new Map();
  const appended = [];
  const messages = [];
  const notices = [];
  const statuses = [];
  const widgets = [];
  const workspaceCalls = [];
  const recoveryCalls = [];
  const coordinatorCalls = [];
  let coordinatorOwner = coordinatorBusyOwner;
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
      return { ...workspace, quality: workspace.quality ?? { maxResearchRounds: 6, maxSubmissionAttempts: 3 }, sources: [] };
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
    async listFresh() { return await this.list(); },
    async delete(id) { return history.delete(id); },
    getRunsDir: () => "/history",
    getArtifactsRoot: () => "/workspace/.okf-wiki/runs",
  };
  const publicationStore = {
    async recoverPending() {
      recoveryCalls.push(workspace.root);
      return onRecoverPending ? await onRecoverPending() : [];
    },
  };
  const workspaceCoordinator = {
    async acquire(runId) {
      coordinatorCalls.push(["acquire", runId]);
      if (coordinatorOwner) return undefined;
      coordinatorOwner = { version: 1, pid: process.pid, token: "test-token", runId, createdAt: "2026-08-08T00:00:00.000Z" };
      return { workspace: workspace.root, owner: coordinatorOwner };
    },
    async updateRun(lock, runId) {
      coordinatorCalls.push(["updateRun", runId]);
      coordinatorOwner = { ...lock.owner, runId };
      lock.owner = coordinatorOwner;
    },
    async release(lock) {
      coordinatorCalls.push(["release", lock.owner.runId]);
      if (coordinatorOwner?.token === lock.owner.token) coordinatorOwner = undefined;
    },
    async currentOwner() { return coordinatorOwner; },
  };
  createWikiExtension({
    createEngine: () => engine,
    workspaceService,
    createHistoryStore: () => historyStore,
    createPublicationStore: () => publicationStore,
    createWorkspaceCoordinator: () => workspaceCoordinator,
  })(pi);
  return { appended, commands, coordinatorCalls, ctx, engine, handlers, history, messages, notices, recoveryCalls, statuses, widgets, workspaceCalls };
}

async function eventually(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("registers one command, starts in the background, and persists pointer-only session state", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);
  assert.deepEqual(subject.recoveryCalls, ["/workspace"], "pending publication is recovered before session commands run");

  assert.deepEqual([...subject.commands.keys()], ["wiki"]);
  await subject.commands.get("wiki").handler("generate lang=en authentication", subject.ctx);

  assert.deepEqual(subject.engine.calls[0], ["start", {
    cwd: "/workspace",
    mode: "generate",
    language: "en",
    focus: "authentication",
    maxResearchRounds: 6,
    wikiPolicy: TEST_POLICY_INPUT,
  }]);
  assert.equal(subject.appended.at(-1).customType, "okf-wiki-run");
  const entry = subject.appended.at(-1).data;
  assert.equal(entry.pointerVersion, 1);
  assert.equal(entry.runId, "run-1");
  assert.equal(entry.status, "running");
  assert.equal(entry.workspace, "/workspace");
  assert.equal("snapshot" in entry, false, "session entry must be pointer-only");
  assert.equal(subject.history.get("run-1")?.language, "en", "full snapshot is in history store");
  assert.equal(subject.messages.length, 0, "starting a run must not add a model-context message");
});

test("restores from pointer via history store and persists interruption", async () => {
  const restoredSnap = snapshot({ id: "restored", status: "running" });
  const other = pointerFrom(snapshot({ id: "other", cwd: "/other" }));
  const restored = pointerFrom(restoredSnap);
  const subject = fixture({
    entries: [
      { type: "custom", customType: "okf-wiki-run", data: other },
      { type: "custom", customType: "okf-wiki-run", data: restored },
    ],
    branchEntries: [
      { type: "custom", customType: "okf-wiki-run", data: other },
      { type: "custom", customType: "okf-wiki-run", data: restored },
    ],
  });
  // History store holds the full snapshot the pointer references.
  subject.history.set("restored", restoredSnap);

  await subject.handlers.get("session_start")({}, subject.ctx);
  assert.equal(subject.engine.calls[0][0], "restore");
  assert.equal(subject.engine.calls[0][1].id, "restored");
  assert.equal(subject.engine.calls[0][1].version, 1, "restore receives full snapshot, not pointer");
  // Recovery converts running → paused and rewrites history.
  assert.equal(subject.history.get("restored")?.status, "paused");
  assert.equal(subject.appended.at(-1)?.data?.status, "paused");

  await subject.handlers.get("session_shutdown")({}, subject.ctx);
  assert.deepEqual(subject.engine.calls.slice(-2).map(([name]) => name), ["interrupt", "waitForIdle"]);
  assert.equal(subject.appended.at(-1).data.workspace, "/workspace");
  assert.equal("snapshot" in subject.appended.at(-1).data, false);
});

test("publication recovery failure blocks snapshot restore with an actionable error", async () => {
  const restoredSnap = snapshot({ id: "recovery-blocked", status: "running" });
  const restored = pointerFrom(restoredSnap);
  const subject = fixture({
    entries: [{ type: "custom", customType: "okf-wiki-run", data: restored }],
    branchEntries: [{ type: "custom", customType: "okf-wiki-run", data: restored }],
    onRecoverPending: async () => { throw new Error("inconsistent publish paths"); },
  });
  subject.history.set(restoredSnap.id, restoredSnap);

  await subject.handlers.get("session_start")({}, subject.ctx);
  assert.equal(subject.engine.calls.some(([name]) => name === "restore"), false);
  assert.ok(subject.notices.some(({ message, level }) => level === "error"
    && /publication recovery failed/i.test(message)
    && /publish journal/i.test(message)));
});

test("missing history for a valid pointer does not half-restore", async () => {
  const restored = pointerFrom(snapshot({ id: "missing-history" }));
  const subject = fixture({
    entries: [{ type: "custom", customType: "okf-wiki-run", data: restored }],
    branchEntries: [{ type: "custom", customType: "okf-wiki-run", data: restored }],
  });

  await subject.handlers.get("session_start")({}, subject.ctx);
  assert.equal(subject.engine.calls.some(([name]) => name === "restore"), false);
  assert.equal(subject.engine.getSnapshot(), undefined);
  assert.ok(subject.notices.some(({ message, level }) => level === "warning"
    && /no durable history/.test(message)
    && /\/wiki generate/.test(message)));
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

test("fresh sessions require an explicit cleanup when multiple project runs are recoverable", async () => {
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

  assert.equal(subject.engine.calls.some(([name]) => name === "restore"), false);
  assert.match(subject.notices.at(-1).message, /multiple recoverable wiki runs/i);
  assert.match(subject.notices.at(-1).message, /run-alpha.*run-zeta|run-zeta.*run-alpha/i);
});

test("bare cancel also rejects ambiguous recoverable project history", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);
  subject.history.set("run-one", snapshot({ id: "run-one", status: "paused" }));
  subject.history.set("run-two", snapshot({
    id: "run-two", status: "running", updatedAt: "2026-08-08T00:01:00.000Z",
  }));

  await subject.commands.get("wiki").handler("cancel", subject.ctx);

  assert.equal(subject.engine.calls.some(([name]) => name === "restore" || name === "cancel"), false);
  assert.match(subject.notices.at(-1).message, /multiple recoverable Wiki runs/i);
  assert.match(subject.notices.at(-1).message, /\/wiki cancel <runId>/i);
  assert.equal(subject.coordinatorCalls.at(-1)[0], "release");
});

test("session start discovers and pauses a single interrupted run without a Pi pointer", async () => {
  const subject = fixture();
  subject.history.set("run-interrupted", snapshot({ id: "run-interrupted", status: "running" }));

  await subject.handlers.get("session_start")({}, subject.ctx);

  assert.equal(subject.engine.calls.find(([name]) => name === "restore")?.[1].id, "run-interrupted");
  assert.equal(subject.history.get("run-interrupted").status, "paused");
  assert.ok(subject.coordinatorCalls.some(([name, id]) => name === "updateRun" && id === "run-interrupted"));
  assert.ok(subject.coordinatorCalls.some(([name]) => name === "release"));
});

test("generate rejects recoverable project history and releases ownership", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);
  subject.history.set("run-paused", snapshot({ id: "run-paused", status: "paused" }));

  await subject.commands.get("wiki").handler("generate", subject.ctx);

  assert.equal(subject.engine.calls.some(([name]) => name === "start"), false);
  assert.match(subject.notices.at(-1).message, /resume run-paused.*cancel run-paused/i);
  assert.equal(subject.coordinatorCalls.at(-1)[0], "release");
});

test("live owner makes session startup and mutation commands read-only", async () => {
  const owner = { version: 1, pid: 4242, token: "other", runId: "run-other", createdAt: "2026-08-08T00:00:00.000Z" };
  const subject = fixture({ coordinatorBusyOwner: owner });

  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);

  assert.deepEqual(subject.recoveryCalls, []);
  assert.equal(subject.engine.calls.some(([name]) => name === "start"), false);
  assert.ok(subject.notices.some(({ message }) => /process 4242.*run run-other/i.test(message)));
});

test("failed project history does not block a new generation", async () => {
  const subject = fixture();
  subject.history.set("run-failed", snapshot({ id: "run-failed", status: "failed" }));

  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);

  assert.equal(subject.engine.calls.some(([name]) => name === "restore"), false);
  assert.equal(subject.engine.calls.find(([name]) => name === "start")?.[1].mode, "generate");
  assert.equal(subject.history.get("run-failed").status, "failed");
  assert.equal(subject.history.get("run-1").status, "running");
});

test("cancel accepts an interrupted run id from project history", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);
  subject.history.set("run-cancel-me", snapshot({ id: "run-cancel-me", status: "paused" }));

  await subject.commands.get("wiki").handler("cancel run-cancel-me", subject.ctx);

  assert.equal(subject.engine.calls.find(([name]) => name === "restore")?.[1].id, "run-cancel-me");
  assert.equal(subject.history.get("run-cancel-me").status, "cancelled");
  assert.equal(subject.coordinatorCalls.at(-1)[0], "release");
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
  assert.equal(selected.engine.calls.at(-3)[0], "restore");
  assert.equal(selected.engine.calls.at(-3)[1].id, "run-selected");

  const failed = fixture();
  await failed.handlers.get("session_start")({}, failed.ctx);
  failed.history.set("run-failed", snapshot({ id: "run-failed", status: "failed" }));
  await failed.commands.get("wiki").handler("resume run-failed", failed.ctx);

  assert.equal(failed.engine.calls.some(([name]) => name === "restore"), false);
  assert.match(failed.notices.at(-1).message, /targeted node or phase retry/);
});

test("pause binds the latest recoverable history when the engine has no current run", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);
  subject.history.set("run-paused", snapshot({
    id: "run-paused",
    status: "running",
    updatedAt: "2026-08-08T00:03:00.000Z",
  }));

  await subject.commands.get("wiki").handler("pause", subject.ctx);

  assert.equal(subject.engine.calls.some(([name]) => name === "restore"), true);
  assert.deepEqual(subject.engine.calls.slice(-2).map(([name]) => name), ["pause", "waitForIdle"]);
  assert.equal(subject.history.get("run-paused")?.status, "paused");
  assert.ok(subject.notices.some(({ message }) => /paused/i.test(message)));
});

test("pause retains workspace ownership until active agents become idle", async () => {
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

  await subject.commands.get("wiki").handler("pause", subject.ctx);
  await idleSignal;
  assert.notEqual(subject.coordinatorCalls.at(-1)?.[0], "release");

  releaseIdle();
  while (subject.coordinatorCalls.at(-1)?.[0] !== "release") await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(subject.engine.calls.slice(-2).map(([name]) => name), ["pause", "waitForIdle"]);
});

test("pause keeps ownership when its settled checkpoint cannot be persisted", async () => {
  const subject = fixture({
    onHistorySave: async (value) => {
      if (value.status === "paused") throw new Error("paused checkpoint unavailable");
    },
  });
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);

  await subject.commands.get("wiki").handler("pause", subject.ctx);
  await eventually(() => subject.notices.some(({ message }) => /paused checkpoint unavailable/.test(message)));

  assert.notEqual(subject.coordinatorCalls.at(-1)?.[0], "release");
  assert.equal(subject.coordinatorCalls.at(-1)?.[1], "run-1");
});

test("terminal completion keeps ownership when terminal history persistence fails", async () => {
  const subject = fixture({
    onHistorySave: async (value) => {
      if (value.status === "succeeded") throw new Error("terminal checkpoint unavailable");
    },
  });
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);

  subject.engine.complete("succeeded");
  await eventually(() => subject.notices.some(({ message }) => /terminal checkpoint unavailable/.test(message)));

  assert.notEqual(subject.coordinatorCalls.at(-1)?.[0], "release");
  assert.equal(subject.coordinatorCalls.at(-1)?.[1], "run-1");
});

test("stop and cancel retain ownership when their final checkpoint fails", async () => {
  for (const action of ["stop", "cancel"]) {
    const subject = fixture({
      onHistorySave: async (value) => {
        if (value.status === "paused" || value.status === "cancelled") throw new Error(`${action} checkpoint unavailable`);
      },
    });
    await subject.handlers.get("session_start")({}, subject.ctx);
    await subject.commands.get("wiki").handler("generate", subject.ctx);

    await subject.commands.get("wiki").handler(action, subject.ctx);

    await eventually(() => subject.notices.some(({ message }) => message.includes(`${action} checkpoint unavailable`)));
    assert.notEqual(subject.coordinatorCalls.at(-1)?.[0], "release", `${action} must retain ownership`);
    assert.equal(subject.coordinatorCalls.at(-1)?.[1], "run-1");
  }
});

test("a run resumed without an id releases ownership after terminal completion", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);
  subject.history.set("run-resumed", snapshot({ id: "run-resumed", status: "paused" }));

  await subject.commands.get("wiki").handler("resume", subject.ctx);
  subject.engine.complete("succeeded");
  await eventually(() => subject.coordinatorCalls.at(-1)?.[0] === "release");

  assert.ok(subject.engine.calls.some(([name, value]) => name === "restore" && value.id === "run-resumed"));
  assert.equal(subject.coordinatorCalls.at(-1)[1], "run-resumed");
});

test("a new run cannot reuse ownership while terminal completion is still settling", async () => {
  let idleCalls = 0;
  let releaseTerminalIdle;
  const terminalIdleGate = new Promise((resolve) => { releaseTerminalIdle = resolve; });
  const subject = fixture({
    onWaitForIdle: async () => {
      idleCalls += 1;
      if (idleCalls === 1) await terminalIdleGate;
    },
  });
  await subject.handlers.get("session_start")({}, subject.ctx);
  await subject.commands.get("wiki").handler("generate", subject.ctx);
  subject.engine.complete("succeeded");
  while (idleCalls === 0) await new Promise((resolve) => setImmediate(resolve));

  subject.history.set("run-paused-next", snapshot({ id: "run-paused-next", status: "paused" }));
  await subject.commands.get("wiki").handler("resume run-paused-next", subject.ctx);
  assert.ok(subject.notices.some(({ message }) => message.includes("active operation for run run-1")));
  assert.ok(!subject.coordinatorCalls.some(([name, runId]) => name === "updateRun" && runId === "run-paused-next"));
  assert.notDeepEqual(subject.coordinatorCalls.at(-1), ["release", "run-1"]);

  releaseTerminalIdle();
  await eventually(() => subject.coordinatorCalls.at(-1)?.[0] === "release");
  assert.deepEqual(subject.coordinatorCalls.at(-1), ["release", "run-1"]);
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

test("project history write failures are reported without losing Pi session pointer", async () => {
  const subject = fixture({
    mode: "tui",
    hasUI: true,
    onHistorySave: async () => { throw new Error("disk unavailable"); },
  });
  await subject.handlers.get("session_start")({}, subject.ctx);

  await subject.commands.get("wiki").handler("generate", subject.ctx);

  assert.equal(subject.appended.at(-1).data.runId, "run-1");
  assert.equal("snapshot" in subject.appended.at(-1).data, false);
  assert.ok(subject.notices.some(({ message, level }) => level === "error"
    && /history could not be saved: disk unavailable/.test(message)));
});

test("does not restore legacy full-snapshot session entries and notifies regenerate", async () => {
  const legacy = {
    customType: "okf-wiki-run",
    workspace: "/workspace",
    snapshot: snapshot({ version: 5, id: "legacy" }),
  };
  const subject = fixture({ entries: [
    { type: "custom", customType: "okf-wiki-run", data: legacy },
  ], branchEntries: [
    { type: "custom", customType: "okf-wiki-run", data: legacy },
  ] });

  await subject.handlers.get("session_start")({}, subject.ctx);
  assert.equal(subject.engine.calls.some(([name]) => name === "restore"), false);
  assert.equal(subject.engine.getSnapshot(), undefined);
  assert.ok(subject.notices.some(({ message, level }) => level === "warning"
    && /incompatible/.test(message)
    && /\/wiki generate/.test(message)
    && /legacy full-snapshot/.test(message)));
});

test("does not restore legacy v6 full-snapshot session entries", async () => {
  const legacy = {
    customType: "okf-wiki-run",
    workspace: "/workspace",
    snapshot: snapshot({ version: 6, id: "legacy-v6" }),
  };
  const subject = fixture({ entries: [
    { type: "custom", customType: "okf-wiki-run", data: legacy },
  ], branchEntries: [
    { type: "custom", customType: "okf-wiki-run", data: legacy },
  ] });

  await subject.handlers.get("session_start")({}, subject.ctx);
  assert.equal(subject.engine.calls.some(([name]) => name === "restore"), false);
  assert.equal(subject.engine.getSnapshot(), undefined);
  assert.ok(subject.notices.some(({ message, level }) => level === "warning"
    && /incompatible/.test(message)
    && /\/wiki generate/.test(message)));
});

test("does not restore malformed pointer session entries", async () => {
  const malformed = {
    customType: "okf-wiki-run",
    workspace: "/workspace",
    pointerVersion: 1,
    // missing runId/revision/status/updatedAt
  };
  const subject = fixture({ entries: [
    { type: "custom", customType: "okf-wiki-run", data: malformed },
  ], branchEntries: [
    { type: "custom", customType: "okf-wiki-run", data: malformed },
  ] });

  await subject.handlers.get("session_start")({}, subject.ctx);
  assert.equal(subject.engine.calls.some(([name]) => name === "restore"), false);
  assert.equal(subject.engine.getSnapshot(), undefined);
  assert.ok(subject.notices.some(({ message, level }) => level === "warning"
    && /incompatible/.test(message)
    && /\/wiki generate/.test(message)));
});

test("rejects incompatible history snapshots pointed to by a valid pointer", async () => {
  const pointer = {
    customType: "okf-wiki-run",
    workspace: "/workspace",
    pointerVersion: 1,
    runId: "bad-history",
    revision: 0,
    status: "paused",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
  const subject = fixture({
    entries: [{ type: "custom", customType: "okf-wiki-run", data: pointer }],
    branchEntries: [{ type: "custom", customType: "okf-wiki-run", data: pointer }],
  });
  // Corrupt v7 body in history — fake restore rejects non-v7 / missing id; use nodes:null to fail real path.
  // fakeEngine.restore requires version 7 + id; return undefined for nodes null by overriding after load.
  subject.history.set("bad-history", snapshot({ id: "bad-history", version: 5 }));

  // Override restore to reject like the real engine for incompatible snapshots.
  const originalRestore = subject.engine.restore;
  subject.engine.restore = (value) => {
    subject.engine.calls.push(["restore", value]);
    if (value?.version !== 1) return undefined;
    return originalRestore(value);
  };

  await subject.handlers.get("session_start")({}, subject.ctx);
  assert.equal(subject.engine.getSnapshot(), undefined);
  assert.ok(subject.notices.some(({ message, level }) => level === "warning"
    && /incompatible/.test(message)
    && /\/wiki generate/.test(message)));
});

test("status, pause, resume, stop, and cancel use the same single-run controller", async () => {
  const subject = fixture();
  await subject.handlers.get("session_start")({}, subject.ctx);
  const command = subject.commands.get("wiki");

  await command.handler("generate", subject.ctx);
  await command.handler("status", subject.ctx);
  await command.handler("pause", subject.ctx);
  await command.handler("resume", subject.ctx);
  await command.handler("stop", subject.ctx);
  await command.handler("cancel", subject.ctx);

  assert.match(subject.messages[0].content, /Wiki Run run-1/);
  for (const expected of ["pause", "reconcilePolicy", "resume", "stop", "cancel"]) {
    assert.ok(subject.engine.calls.some(([name]) => name === expected), `${expected} reaches the shared engine`);
  }
  assert.ok(subject.engine.calls.filter(([name]) => name === "waitForIdle").length >= 2,
    "stop and cancel settle agents before releasing ownership");
  assert.ok(subject.notices.some(({ message }) => /aborted|resume to continue/i.test(message)));
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
    "init ", "source ", "generate ", "refresh ", "open", "status", "history", "artifacts ", "pause", "resume ", "stop", "cancel", "help",
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
    maxResearchRounds: 6,
    wikiPolicy: TEST_POLICY_INPUT,
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
