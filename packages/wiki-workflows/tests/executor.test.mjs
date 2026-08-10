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

function fakeSession(activeTools = ["read", "grep", "find", "ls", "edit", "write", "wiki_delete", "wiki_submit_plan", "wiki_submit_synthesis", "wiki_submit_review"]) {
  return {
    subscribe: () => () => {},
    setAutoCompactionEnabled() {},
    setAutoRetryEnabled() {},
    async abort() {},
    async prompt() {},
    async waitForIdle() {},
    state: {},
    getLastAssistantText: () => "{}",
    getActiveToolNames: () => activeTools,
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    getContextUsage: () => undefined,
    dispose() {},
  };
}

function executionRequest(cwd, role = "researcher", onOutput, onHistory, kind = "research") {
  return {
    runId: "run",
    node: { id: "node", kind, label: "Research", status: "running", dependsOn: [], attempt: 1, inputFingerprint: "", input: {}, attemptHistory: [], metrics: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, compactions: 0, autoRetries: 0 }, activity: { state: "running", updatedAt: new Date().toISOString() } },
    cwd,
    prompt: "test",
    role,
    writePaths: role === "writer" ? ["wiki/domain/page.md"] : undefined,
    language: "zh",
    signal: new AbortController().signal,
    onOutput,
    onHistory,
  };
}

function finalizedSpec() {
  return {
    domains: [
      {
        id: "overview",
        title: "Overview",
        purpose: "Orient readers across the documented domains.",
        researchScopeIds: [],
        pages: [{
          pageType: "overview",
          path: "overview/overview.md",
          title: "System overview",
          purpose: "Provide a global reader orientation.",
          sources: ["api/src/index.ts#L1-L2"],
          requiredSections: ["Scope"],
          diagrams: [{ kind: "flowchart", applicability: "not_applicable", purpose: "System boundaries", reason: "The available source evidence covers one bounded module." }],
        }],
      },
      {
        id: "domain",
        title: "Domain",
        purpose: "Explain the verified domain boundary.",
        researchScopeIds: [],
        pages: [{
          pageType: "module",
          path: "domain/page.md",
          title: "Domain module",
          purpose: "Explain the module responsibility.",
          sources: ["api/src/index.ts#L1-L2"],
          requiredSections: ["Responsibility"],
          diagrams: [{ kind: "class", applicability: "not_applicable", purpose: "Class relationships", reason: "No meaningful class boundary is established." }],
        }],
      },
    ],
    crossLinks: [],
    sharedTerms: [],
  };
}

test("planner submits control data through a dedicated tool instead of final JSON text", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-plan-");
  let tools;
  let enabledTools;
  const session = fakeSession();
  session.getLastAssistantText = () => "## Planning notes\nThe plan is ready.";
  session.prompt = async () => {
    const submit = tools.find((tool) => tool.name === "wiki_submit_plan");
    await submit.execute("submit-plan", {
      candidateDomains: [{ id: "architecture", title: "Architecture", purpose: "Explain the system" }],
      researchScopes: [],
      rationale: "One domain covers the current scope.",
    });
  };
  const executor = new PiAgentExecutor({
    createSession: async (options) => {
      tools = options.customTools;
      enabledTools = options.tools;
      session.getActiveToolNames = () => enabledTools;
      return { session };
    },
  });

  const result = await executor.execute(executionRequest(workspace, "planner", undefined, undefined, "plan"));
  assert.deepEqual(result.result, {
    candidateDomains: [{ id: "architecture", title: "Architecture", purpose: "Explain the system" }],
    researchScopes: [],
    rationale: "One domain covers the current scope.",
  });
  assert.equal(result.output, "## Planning notes\nThe plan is ready.");
  assert.ok(enabledTools.includes("wiki_submit_plan"));
  assert.equal(tools.some((tool) => tool.name === "wiki_submit_review"), false);
});

test("synthesizer submits a typed finalized WikiSpec through its dedicated tool", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-synthesis-");
  let tools;
  let enabledTools;
  const session = fakeSession();
  session.prompt = async () => {
    const submit = tools.find((tool) => tool.name === "wiki_submit_synthesis");
    await submit.execute("submit-synthesis", {
      decision: "finalize",
      spec: finalizedSpec(),
      rationale: "The source research is sufficient to assign one bounded domain.",
    });
  };
  const executor = new PiAgentExecutor({
    createSession: async (options) => {
      tools = options.customTools;
      enabledTools = options.tools;
      session.getActiveToolNames = () => enabledTools;
      return { session };
    },
  });

  const result = await executor.execute(executionRequest(workspace, "synthesizer", undefined, undefined, "synthesis"));
  assert.equal(result.result.decision, "finalize");
  assert.equal(result.result.spec.domains[1].pages[0].path, "domain/page.md");
  assert.ok(enabledTools.includes("wiki_submit_synthesis"));
  assert.equal(tools.some((tool) => tool.name === "wiki_submit_plan"), false);
});

test("reviewer submits control data through its dedicated tool", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-review-");
  let tools;
  let enabledTools;
  const session = fakeSession();
  session.getLastAssistantText = () => "## Review complete\nNo defects found.";
  session.prompt = async () => {
    const submit = tools.find((tool) => tool.name === "wiki_submit_review");
    await submit.execute("submit-review", { defects: [], summary: "All checks passed." });
  };
  const executor = new PiAgentExecutor({
    createSession: async (options) => {
      tools = options.customTools;
      enabledTools = options.tools;
      session.getActiveToolNames = () => enabledTools;
      return { session };
    },
  });

  const result = await executor.execute(executionRequest(workspace, "reviewer", undefined, undefined, "review"));
  assert.deepEqual(result.result, { defects: [], summary: "All checks passed." });
  assert.equal(result.output, "## Review complete\nNo defects found.");
  assert.ok(enabledTools.includes("wiki_submit_review"));
  assert.equal(tools.some((tool) => tool.name === "wiki_submit_plan"), false);
});

test("fails closed when Pi does not activate the required control tool", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-hidden-control-");
  const session = fakeSession(["read", "grep", "find", "ls"]);
  let prompted = false;
  session.prompt = async () => { prompted = true; };
  const executor = new PiAgentExecutor({ createSession: async () => ({ session }) });

  await assert.rejects(
    () => executor.execute(executionRequest(workspace, "planner", undefined, undefined, "plan")),
    /wiki_submit_plan is not active/,
  );
  assert.equal(prompted, false);
});

test("planner submission rejects semantic contract violations before completing the node", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-plan-contract-");
  let tools;
  const session = fakeSession();
  session.prompt = async () => {
    const submit = tools.find((tool) => tool.name === "wiki_submit_plan");
    await assert.rejects(
      () => submit.execute("invalid-plan", {
        candidateDomains: [],
        researchScopes: [],
        rationale: "test",
      }),
      /candidate domain/,
    );
    await assert.rejects(
      () => submit.execute("too-many-scopes", {
        candidateDomains: [{ id: "architecture", title: "Architecture", purpose: "Explain" }],
        researchScopes: ["a", "b", "c", "d", "e"].map((id) => ({ id, task: id })),
        rationale: "test",
      }),
      /at most 4 research scopes/,
    );
    await submit.execute("valid-plan", {
      candidateDomains: [{ id: "architecture", title: "Architecture", purpose: "Explain" }],
      researchScopes: [],
      rationale: "test",
    });
  };
  const executor = new PiAgentExecutor({
    createSession: async (options) => {
      tools = options.customTools;
      session.getActiveToolNames = () => options.tools;
      return { session };
    },
  });

  const result = await executor.execute(executionRequest(workspace, "planner", undefined, undefined, "plan"));
  assert.equal(result.result.candidateDomains[0].id, "architecture");
});

test("missing planner submission preserves final text and reports the required tool", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-missing-plan-");
  let followUps = 0;
  const outputs = [];
  const session = fakeSession();
  session.getLastAssistantText = () => "I have a prose plan but no control submission.";
  session.followUp = async () => { followUps += 1; };
  const executor = new PiAgentExecutor({ createSession: async () => ({ session }) });

  await assert.rejects(
    () => executor.execute(executionRequest(workspace, "planner", (output) => outputs.push(output), undefined, "plan")),
    /wiki_submit_plan/,
  );
  assert.equal(followUps, 1);
  assert.deepEqual(outputs, [
    "I have a prose plan but no control submission.",
    "I have a prose plan but no control submission.",
  ]);
});

test("writer completion is Markdown text and has no JSON result contract", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-write-summary-");
  const session = fakeSession();
  session.getLastAssistantText = () => "## Changed\n- `architecture.md`";
  const executor = new PiAgentExecutor({ createSession: async () => ({ session }) });

  const result = await executor.execute(executionRequest(workspace, "writer", undefined, undefined, "write"));
  assert.equal(result.result, undefined);
  assert.equal(result.output, "## Changed\n- `architecture.md`");
});

test("writer tools permit only explicitly assigned paths in their domain", async () => {
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
    writePaths: ["wiki/domain/page.md", "wiki/domain/outside/escape.md"],
    language: "zh",
    signal: new AbortController().signal,
  });

  const write = tools.find((tool) => tool.name === "write");
  const edit = tools.find((tool) => tool.name === "edit");
  const remove = tools.find((tool) => tool.name === "wiki_delete");
  await write.execute("call-1", { path: "wiki/domain/page.md", content: "# page\n" });
  assert.equal(await readFile(path.join(workspace, "wiki/domain/page.md"), "utf8"), "# page\n");
  await edit.execute("call-2", { path: "wiki/domain/page.md", edits: [{ oldText: "# page", newText: "# updated" }] });
  assert.equal(await readFile(path.join(workspace, "wiki/domain/page.md"), "utf8"), "# updated\n");
  await mkdir(path.join(workspace, "wiki", "other"), { recursive: true });
  await writeFile(path.join(workspace, "wiki", "other", "page.md"), "# other\n");

  await assert.rejects(() => write.execute("call-3", { path: "README.md", content: "no" }));
  await assert.rejects(() => write.execute("call-4", { path: "wiki/other/page.md", content: "no" }), /not assigned/);
  await assert.rejects(() => edit.execute("call-5", { path: "wiki/other/page.md", edits: [{ oldText: "x", newText: "y" }] }), /not assigned/);
  await assert.rejects(() => remove.execute("call-6", { path: "wiki/other/page.md" }), /not assigned/);
  await symlink(outside, path.join(workspace, "wiki", "domain", "outside"));
  await assert.rejects(() => write.execute("call-7", { path: "wiki/domain/outside/escape.md", content: "no" }));
  await remove.execute("call-8", { path: "wiki/domain/page.md" });
  await assert.rejects(() => readFile(path.join(workspace, "wiki/domain/page.md"), "utf8"));
});

test("writer execution fails closed without an assigned page list", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-missing-writes-");
  const executor = new PiAgentExecutor({ createSession: async () => ({ session: fakeSession() }) });
  const request = executionRequest(workspace, "writer", undefined, undefined, "write");
  request.writePaths = undefined;
  await assert.rejects(() => executor.execute(request), /require at least one assigned Wiki page/);
});

test("writer execution rejects index pages owned by validator navigation", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-index-");
  const executor = new PiAgentExecutor({ createSession: async () => ({ session: fakeSession() }) });
  const request = executionRequest(workspace, "writer", undefined, undefined, "write");
  request.writePaths = ["wiki/domain/index.md"];
  await assert.rejects(() => executor.execute(request), /non-index Markdown page/);
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
  assert.deepEqual(output, ["live response", "{}"]);
});

test("retains completed assistant messages and tool calls for the run navigator", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-history-");
  const snapshots = [];
  const session = fakeSession();
  session.subscribe = (listener) => {
    listener({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "I will inspect the source." }] },
    });
    listener({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/index.ts" } });
    listener({
      type: "tool_execution_end",
      toolCallId: "read-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "export const ready = true;" }] },
      isError: false,
    });
    return () => {};
  };
  const executor = new PiAgentExecutor({ createSession: async () => ({ session }) });
  const result = await executor.execute(executionRequest(workspace, "researcher", undefined, (history) => snapshots.push(history)));

  assert.equal(snapshots.length, 3);
  assert.deepEqual(result.history?.map((entry) => [entry.kind, entry.toolName]), [
    ["message", undefined], ["tool_call", "read"], ["tool_result", "read"],
  ]);
  assert.match(result.history?.[1].text ?? "", /src\/index\.ts/);
  assert.match(result.history?.[2].text ?? "", /ready = true/);
  assert.equal(result.history?.[1].target, "src/index.ts");
  assert.equal(result.history?.[2].target, "src/index.ts");
  assert.equal(result.history?.[2].summary, "Completed");
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
