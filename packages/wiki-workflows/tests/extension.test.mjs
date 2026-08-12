import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiExtension, wikiArgumentCompletions } from "../dist/extension.js";

async function fixture(t) {
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
  let next = 0;
  const handles = new Map();
  const handleFor = (id) => handles.get(id);
  const createHandle = (view) => {
    views.set(view.id, view);
    const handle = {
      id: view.id,
      async view() { return views.get(view.id); },
      async *events() {
        yield { version: 1, runId: view.id, sequence: 1, at: view.createdAt, type: "progress", message: "Researching" };
        yield { version: 1, runId: view.id, sequence: 2, at: view.createdAt, type: "completed", message: "Wiki published" };
      },
      async result() { return { runId: view.id, output: {}, validation: {}, publication: {} }; },
      async control(action) {
        calls.push([action, view.id]);
        const status = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
        views.set(view.id, { ...views.get(view.id), status });
        return views.get(view.id);
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
        operation: request.operation ?? "update",
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
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    sendMessage(message) { messages.push(message.content); },
  };
  const context = {
    cwd,
    mode: "print",
    hasUI: false,
    model: undefined,
    thinkingLevel: undefined,
    ui: { notify(message, level) { notices.push({ message, level }); } },
  };
  createWikiExtension({ createProducer: () => producer })(pi);
  await handlers.get("session_start")({}, context);
  const run = async (args) => await commands.get("wiki").handler(args, context);
  return { cwd, calls, messages, notices, run };
}

test("maps run controls onto WikiProducer", async (t) => {
  const subject = await fixture(t);
  await subject.run("auth flows");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.calls[0][0], "start");
  assert.equal(subject.calls[0][1].operation, "update");
  assert.equal(subject.calls[0][1].focus, "auth flows");
  assert.ok(subject.messages.some((message) => /Researching/.test(message)));

  await subject.run("regenerate public API");
  assert.equal(subject.calls.findLast((call) => call[0] === "start")[1].operation, "regenerate");
  await subject.run("status run-1");
  assert.match(subject.messages.at(-1), /Wiki run-1/);
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
    "init", "source", "regenerate", "status", "runs", "pause", "resume", "cancel",
  ]);
  assert.equal(wikiArgumentCompletions("status "), null);
  assert.deepEqual(wikiArgumentCompletions("re").map((item) => item.label), ["regenerate", "resume"]);
  assert.deepEqual(wikiArgumentCompletions("source ").map((item) => item.label), ["add"]);
  assert.deepEqual(wikiArgumentCompletions("source add ").map((item) => item.label), ["link", "clone"]);
});
