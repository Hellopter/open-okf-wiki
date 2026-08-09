import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiAgentExecutor } from "../dist/executor.js";
import { addWikiSource, initializeWikiWorkspace } from "../dist/workspace.js";

async function initializedWorkspace(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await initializeWikiWorkspace({ cwd: root });
  return root;
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fakeSession() {
  return {
    subscribe: () => () => {},
    setAutoCompactionEnabled() {},
    setAutoRetryEnabled() {},
    async abort() {},
    async prompt() {},
    async waitForIdle() {},
    state: {},
    getLastAssistantText: () => "{}",
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    getContextUsage: () => undefined,
    dispose() {},
  };
}

function executionRequest(cwd, role = "researcher", onOutput) {
  return {
    runId: "run",
    node: { id: "node", kind: "research", label: "Research", status: "running", dependsOn: [], attempt: 1, inputFingerprint: "", input: {}, attemptHistory: [], metrics: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, compactions: 0, autoRetries: 0 }, activity: { state: "running", updatedAt: new Date().toISOString() } },
    cwd,
    prompt: "test",
    role,
    language: "zh",
    signal: new AbortController().signal,
    onOutput,
  };
}

test("writer tools permit only real paths under wiki", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-");
  const outside = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-outside-"));
  let tools;
  const executor = new PiAgentExecutor({
    createSession: async (options) => {
      tools = options.customTools;
      return { session: fakeSession() };
    },
  });
  await executor.execute({
    runId: "run",
    node: { id: "write", kind: "write", label: "Write", status: "running", dependsOn: [], attempt: 1, inputFingerprint: "", input: {}, attemptHistory: [], metrics: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, compactions: 0, autoRetries: 0 }, activity: { state: "running", updatedAt: new Date().toISOString() } },
    cwd: workspace,
    prompt: "test",
    role: "writer",
    language: "zh",
    signal: new AbortController().signal,
  });

  const write = tools.find((tool) => tool.name === "write");
  await write.execute("call-1", { path: "wiki/page.md", content: "# page\n" });
  assert.equal(await readFile(path.join(workspace, "wiki/page.md"), "utf8"), "# page\n");

  await assert.rejects(() => write.execute("call-2", { path: "README.md", content: "no" }));
  await assert.rejects(() => write.execute("call-3", { path: "../escape.md", content: "no" }));
  await symlink(outside, path.join(workspace, "wiki", "outside"));
  await assert.rejects(() => write.execute("call-4", { path: "wiki/outside/escape.md", content: "no" }));
});

test("resolves Pi model selection immediately before every child session", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-model-");
  const first = { provider: "test", id: "first" };
  const second = { provider: "test", id: "second" };
  let selected = first;
  const observed = [];
  const executor = new PiAgentExecutor({
    getModel: () => selected,
    createSession: async (options) => {
      observed.push(options.model);
      return { session: fakeSession() };
    },
  });
  await executor.execute(executionRequest(workspace));
  selected = second;
  await executor.execute(executionRequest(workspace));
  assert.deepEqual(observed, [first, second]);
});

test("forwards streamed assistant text to the workflow engine", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-stream-");
  const output = [];
  const session = fakeSession();
  session.subscribe = (listener) => {
    listener({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "live response" }] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "live response", partial: {} },
    });
    return () => {};
  };
  const executor = new PiAgentExecutor({ createSession: async () => ({ session }) });
  await executor.execute(executionRequest(workspace, "researcher", (value) => output.push(value)));
  assert.deepEqual(output, ["live response"]);
});

test("research tools may read only sources declared by workspace.yaml", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-executor-source-"));
  const source = path.join(parent, "api");
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "src", "index.ts"), "export const api = true;\n");
  git(source, "init", "--quiet");
  const docs = path.join(parent, "docs");
  await initializeWikiWorkspace({ cwd: docs });
  await addWikiSource({ cwd: docs, source: { kind: "link", path: source } });
  let tools;
  const executor = new PiAgentExecutor({
    createSession: async (options) => {
      tools = options.customTools;
      return { session: fakeSession() };
    },
  });

  await executor.execute(executionRequest(docs));
  const read = tools.find((tool) => tool.name === "read");
  const result = await read.execute("call-1", { path: "api/src/index.ts" });
  assert.match(result.content[0].text, /api = true/);
  await assert.rejects(() => read.execute("call-2", { path: "../api/src/index.ts" }));
});
