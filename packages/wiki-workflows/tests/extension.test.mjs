import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiExtension, wikiArgumentCompletions } from "../dist/extension.js";

async function fixture(t, options = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "wiki-extension-"));
  t.after(async () => await rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "workspace.yaml"), [
    "version: 1",
    "language: en",
    "defaultSourceIgnores: true",
    "sources: []",
    "",
  ].join("\n"));

  const views = new Map();
  const calls = [];
  const statuses = [];
  const widgets = [];
  const customs = [];
  let next = 0;
  const handles = new Map();
  const eventCalls = [];
  let releaseEvents;
  const heldEvents = new Promise((resolve) => { releaseEvents = resolve; });
  const handleFor = (id) => handles.get(id);
  const createHandle = (view) => {
    views.set(view.id, view);
    const handle = {
      id: view.id,
      async view() { return views.get(view.id); },
      async *updates(after = 0, signal) {
        eventCalls.push([view.id, after, signal]);
        const telemetry = {
          version: 1, runId: view.id, sequence: 1, at: view.createdAt, type: "telemetry",
          phase: "agent_update", target: { kind: "lead" }, message: "usage update",
        };
        yield { event: telemetry, view: { ...views.get(view.id), lastEventSequence: 1 } };
        const progress = { version: 1, runId: view.id, sequence: 2, at: view.createdAt, type: "progress", message: "Researching" };
        yield { event: progress, view: { ...views.get(view.id), lastEventSequence: 2 } };
        if (options.holdEvents) {
          await Promise.race([
            heldEvents,
            new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true })),
          ]);
          if (signal?.aborted) return;
        }
        const completed = { version: 1, runId: view.id, sequence: 3, at: view.createdAt, type: "completed", message: "Wiki published" };
        yield { event: completed, view: { ...views.get(view.id), status: "succeeded", lastEventSequence: 3 } };
      },
      async result() { return { runId: view.id, output: {}, validation: {}, publication: {} }; },
      async control(action) {
        calls.push([action, view.id]);
        const status = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
        views.set(view.id, { ...views.get(view.id), status });
        return views.get(view.id);
      },
      async inspectAgent(target) {
        calls.push(["inspectAgent", view.id, target]);
        const current = views.get(view.id);
        const agent = target.kind === "lead" ? current?.progress?.lead : undefined;
        return agent ? { runId: view.id, agent, process: [] } : undefined;
      },
    };
    handles.set(view.id, handle);
    return handle;
  };
  const producer = {
    async start(request) {
      calls.push(["start", request]);
      const id = `run-${++next}`;
      return createHandle({
        id,
        cwd,
        focus: request.focus,
        status: "running",
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        lastEventSequence: 0,
      });
    },
    async open(id) { return handleFor(id); },
    async list() { return [...views.values()].reverse(); },
  };
  const handlers = new Map();
  const commands = new Map();
  const messages = [];
  const notices = [];
  const hasUI = options.hasUI === true;
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    sendMessage(message) { messages.push(message.content); },
  };
  const context = {
    cwd,
    mode: options.mode ?? (hasUI ? "tui" : "print"),
    hasUI,
    model: undefined,
    thinkingLevel: undefined,
    ui: {
      notify(message, level) {
        notices.push({ message, level });
        if (hasUI) messages.push(message);
      },
      setStatus(key, text) { statuses.push([key, text]); },
      setWidget(key, content) { widgets.push([key, content]); },
      custom(factory) { customs.push(factory); return Promise.resolve(); },
      theme: { fg: (_color, text) => text },
    },
  };
  createWikiExtension({ createProducer: () => producer })(pi);
  await handlers.get("session_start")({}, context);
  const run = async (args) => await commands.get("wiki").handler(args, context);
  return { cwd, calls, eventCalls, releaseEvents, messages, notices, statuses, widgets, customs, views, handlers, context, run };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("maps run controls onto WikiProducer", async (t) => {
  const subject = await fixture(t);
  await subject.run("auth flows");
  await flush();
  assert.equal(subject.calls[0][0], "start");
  assert.deepEqual(subject.calls[0][1], { cwd: subject.cwd, focus: "auth flows" });
  assert.equal(subject.calls[0][1].focus, "auth flows");
  assert.ok(subject.messages.some((message) => /Researching/.test(message)));

  await subject.run("public API");
  assert.equal(subject.calls.findLast((call) => call[0] === "start")[1].focus, "public API");
  await subject.run("status run-1");
  assert.ok(subject.messages.some((message) => /Wiki run-1/.test(message)));
  await subject.run("runs");
  assert.match(subject.messages.at(-1), /Wiki runs/);
  await subject.run("pause");
  assert.deepEqual(subject.calls.at(-1), ["pause", "run-2"]);
  await subject.run("resume run-2");
  assert.deepEqual(subject.calls.at(-1), ["resume", "run-2"]);
  await subject.run("cancel run-2");
  assert.deepEqual(subject.calls.at(-1), ["cancel", "run-2"]);
});

test("reports parser and producer failures without a TUI", async (t) => {
  const subject = await fixture(t);
  await subject.run("resume bad/id");
  assert.match(subject.messages.at(-1), /Invalid Wiki run id/);
  await subject.run("pause");
  assert.match(subject.notices.at(-1).message, /No Wiki run/);
});

test("workspace management commands produce plain output", async (t) => {
  const subject = await fixture(t);
  const parent = path.dirname(subject.cwd);
  const source = path.join(parent, `source-${Date.now()}`);
  await mkdir(source, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: source });
  t.after(async () => await rm(source, { recursive: true, force: true }));

  const workspace = path.join(parent, `managed-${Date.now()}`);
  await subject.run(`init ${JSON.stringify(workspace)} --lang zh --exclude "vendor/**"`);
  assert.match(subject.messages.at(-1), /Wiki workspace initialized/);
  assert.match(await readFile(path.join(workspace, "workspace.yaml"), "utf8"), /vendor\/\*\*/);
  await subject.run(`source add link ${JSON.stringify(source)} --name api --workspace ${JSON.stringify(workspace)}`);
  assert.match(subject.messages.at(-1), /Wiki source added: api/);
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
});

test("completion exposes management and run commands", () => {
  assert.deepEqual(wikiArgumentCompletions("").map((item) => item.label), [
    "init", "source", "status", "runs", "pause", "resume", "cancel",
  ]);
  assert.equal(wikiArgumentCompletions("status "), null);
  assert.deepEqual(wikiArgumentCompletions("status run-1 task-9 "), [{
    value: "status run-1 task-9 --process",
    label: "--process",
    description: "Show compact process history",
  }]);
  assert.deepEqual(wikiArgumentCompletions("re").map((item) => item.label), ["resume"]);
  assert.deepEqual(wikiArgumentCompletions("source ").map((item) => item.label), ["add"]);
  assert.deepEqual(wikiArgumentCompletions("source add ").map((item) => item.label), ["link", "clone"]);
});

test("status without progress still prints Wiki run-1", async (t) => {
  const subject = await fixture(t);
  await subject.run("auth flows");
  const before = subject.messages.length;
  await subject.run("status run-1");
  assert.ok(subject.messages.slice(before).some((message) => /Wiki run-1/.test(message)));
});

test("status with lead calls inspectAgent", async (t) => {
  const subject = await fixture(t);
  await subject.run("auth flows");
  const current = subject.views.get("run-1");
  subject.views.set("run-1", {
    ...current,
    progress: {
      stage: "lead",
      lead: { target: { kind: "lead" }, role: "lead", status: "running", attempt: 1, activity: "streaming", activeTools: [] },
    },
  });
  const expectedSnapshotTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "medium",
  }).format(Date.parse(current.updatedAt));
  await subject.run("status run-1 lead");
  assert.ok(subject.calls.some((call) => call[0] === "inspectAgent" && call[2].kind === "lead"));
  assert.ok(subject.messages.some((message) => /Wiki run-1/.test(message) && /lead/.test(message)));
  assert.ok(!subject.messages.some((message) => / ·  process/.test(message)));
  assert.ok(subject.messages.at(-1).endsWith(`snapshot as of ${expectedSnapshotTime}`));

  await subject.run("status run-1 lead --process");
  assert.match(subject.messages.at(-1), /Wiki run-1  ·  lead  ·  process/);
  assert.ok(subject.messages.at(-1).endsWith(`snapshot as of ${expectedSnapshotTime}`));

  await subject.run("status run-1 batch-2/missing");
  assert.ok(subject.calls.some((call) => call[0] === "inspectAgent" && call[2].taskId === "missing"));
  assert.match(subject.messages.at(-1), /Wiki run-1 has no agent "batch-2\/missing"/);
});

test("print mode never touches TUI status APIs or the overlay", async (t) => {
  const subject = await fixture(t);
  await subject.run("auth flows");
  await flush();
  await subject.run("status run-1");
  await subject.run("status run-1 lead");
  assert.equal(subject.statuses.length, 0);
  assert.equal(subject.widgets.length, 0);
  assert.equal(subject.customs.length, 0);
  assert.ok(subject.messages.some((message) => /Wiki run-1/.test(message)));
  assert.ok(subject.messages.some((message) => /Researching/.test(message)));
});

test("RPC mode can refresh surfaces but never opens a TUI overlay", async (t) => {
  const subject = await fixture(t, { hasUI: true, mode: "rpc" });
  await subject.run("auth flows");
  await subject.run("status run-1");
  assert.equal(subject.customs.length, 0);
  assert.ok(subject.statuses.length > 0);
  assert.ok(subject.messages.some((message) => /snapshot as of/.test(message)));
});

test("telemetry refreshes the surface without producing a notification", async (t) => {
  const subject = await fixture(t, { hasUI: true });
  await subject.run("auth flows");
  await flush();
  assert.ok(!subject.messages.some((message) => /usage update/.test(message)));
  assert.ok(subject.messages.some((message) => /Researching/.test(message)));
});

test("status reuses one live stream and shutdown aborts it", async (t) => {
  const subject = await fixture(t, { hasUI: true, holdEvents: true });
  await subject.run("auth flows");
  await flush();
  await subject.run("status run-1");
  await subject.run("status run-1");
  assert.equal(subject.eventCalls.length, 1);
  const signal = subject.eventCalls[0][2];
  assert.equal(signal.aborted, false);
  await subject.handlers.get("session_shutdown")();
  assert.equal(signal.aborted, true);
  subject.releaseEvents();
});

test("hasUI refreshes footer and widget after a run", async (t) => {
  const subject = await fixture(t, { hasUI: true, holdEvents: true });
  await subject.run("auth flows");
  await flush();
  assert.ok(subject.widgets.some(([key, lines]) => key === "wiki" && Array.isArray(lines)));
  assert.ok(subject.statuses.some(([key, text]) => key === "wiki" && text === undefined));

  const current = subject.views.get("run-1");
  subject.views.set("run-1", {
    ...current,
    progress: {
      stage: "lead",
      lead: { target: { kind: "lead" }, role: "lead", status: "running", attempt: 1, activity: "delegating", activeTools: [] },
      currentBatch: { batch: 1, status: "running", completed: 1, total: 3, tasks: [{ id: "pages/auth.md", role: "write", status: "running" }] },
    },
  });
  await subject.run("status run-1");
  const runningWidget = [...subject.widgets].reverse().find(([key]) => key === "wiki");
  const runningStatus = [...subject.statuses].reverse().find(([key]) => key === "wiki");
  assert.ok(Array.isArray(runningWidget?.[1]) && runningWidget[1].some((line) => /pages\/auth\.md/.test(line)));
  assert.equal(runningStatus?.[1], undefined);

  subject.views.set("run-1", { ...subject.views.get("run-1"), status: "succeeded" });
  await subject.run("status run-1");
  const settledWidget = [...subject.widgets].reverse().find(([key]) => key === "wiki");
  const settledStatus = [...subject.statuses].reverse().find(([key]) => key === "wiki");
  assert.equal(settledWidget?.[1], undefined);
  assert.match(String(settledStatus?.[1] ?? ""), /published|✓/);

  await subject.handlers.get("session_shutdown")();
  assert.ok(subject.statuses.some(([key, text]) => key === "wiki" && text === undefined));
  assert.ok(subject.widgets.some(([key, content]) => key === "wiki" && content === undefined));
});
