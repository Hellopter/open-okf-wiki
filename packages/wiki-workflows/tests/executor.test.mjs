import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_CONTROL_SUBMISSION_BYTES,
  WikiControlSubmissionSizeError,
  parseReviewSubmission,
  parseSynthesisSubmission,
} from "../dist/control-submissions.js";
import { PiAgentExecutor, WikiAgentProtocolError } from "../dist/executor.js";
import { addWikiSource, initializeWikiWorkspace } from "../dist/workspace.js";

async function initializedWorkspace(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await initializeWikiWorkspace({ cwd: root });
  return root;
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fakeSession(activeTools = ["read", "grep", "find", "ls", "edit", "write", "wiki_delete", "wiki_submit_synthesis", "wiki_submit_review"]) {
  return {
    subscribe: () => () => {},
    setAutoCompactionEnabled() {},
    setAutoRetryEnabled() {},
    async abort() {},
    async prompt() {},
    async followUp() {},
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

test("synthesizer submits a typed finalized WikiSpec through its dedicated tool", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-synthesis-");
  let tools;
  let enabledTools;
  let submitResult;
  let followUps = 0;
  const session = fakeSession();
  session.followUp = async () => { followUps += 1; };
  session.prompt = async () => {
    const submit = tools.find((tool) => tool.name === "wiki_submit_synthesis");
    submitResult = await submit.execute("submit-synthesis", {
      decision: "finalize",
      researchScopes: null,
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
  assert.equal(tools.some((tool) => tool.name === "wiki_submit_review"), false);
  const submit = tools.find((tool) => tool.name === "wiki_submit_synthesis");
  assert.equal(submit.parameters.type, "object");
  assert.deepEqual(submit.parameters.required, ["decision", "researchScopes", "spec", "rationale"]);
  assert.deepEqual(submit.parameters.properties.researchScopes.anyOf.map((item) => item.type), ["array", "null"]);
  assert.deepEqual(submit.parameters.properties.spec.anyOf.map((item) => item.type), ["object", "null"]);
  assert.deepEqual(submit.parameters.properties.spec.anyOf[0].properties.domains.items.properties.pages.items.properties.diagrams.items.required, ["kind", "applicability", "purpose", "reason"]);
  assert.deepEqual(submit.constrainedSampling, { type: "json_schema", strict: "prefer" });
  assert.equal(submitResult.terminate, true);
  assert.equal(followUps, 0);
});

test("reviewer submits control data through its dedicated tool", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-review-");
  let tools;
  let enabledTools;
  let submitResult;
  const session = fakeSession();
  session.getLastAssistantText = () => "## Review complete\nNo defects found.";
  session.prompt = async () => {
    const submit = tools.find((tool) => tool.name === "wiki_submit_review");
    submitResult = await submit.execute("submit-review", { defects: [], summary: "All checks passed." });
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
  assert.equal(tools.some((tool) => tool.name === "wiki_submit_synthesis"), false);
  const submit = tools.find((tool) => tool.name === "wiki_submit_review");
  assert.deepEqual(submit.constrainedSampling, { type: "json_schema", strict: "prefer" });
  assert.equal(submitResult.terminate, true);
});

test("synthesis rejects branch fields that do not match its decision", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-synthesis-branch-");
  let tools;
  const session = fakeSession();
  session.prompt = async () => {
    const submit = tools.find((tool) => tool.name === "wiki_submit_synthesis");
    await submit.execute("submit-synthesis", {
      decision: "expand",
      researchScopes: [{ id: "missing", sourcePaths: ["src"], task: "Inspect the missing boundary." }],
      spec: finalizedSpec(),
      rationale: "One more bounded source survey is needed.",
    });
  };
  const executor = new PiAgentExecutor({
    createSession: async (options) => {
      tools = options.customTools;
      return { session };
    },
  });

  await assert.rejects(
    () => executor.execute(executionRequest(workspace, "synthesizer", undefined, undefined, "synthesis")),
    /must set spec to null/,
  );
});

test("synthesis requires explicit null for its inactive branch", () => {
  assert.throws(
    () => parseSynthesisSubmission({
      decision: "expand",
      researchScopes: [{ id: "missing", sourcePaths: ["src"], task: "Inspect the missing boundary." }],
      rationale: "One more bounded source survey is needed.",
    }),
    /must set spec to null/,
  );
  assert.throws(
    () => parseSynthesisSubmission({
      decision: "finalize",
      spec: finalizedSpec(),
      rationale: "The source research is sufficient to assign one bounded domain.",
    }),
    /must set researchScopes to null/,
  );
});

test("synthesis accepts required nullable inactive branch fields", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-synthesis-nullable-");
  let tools;
  const session = fakeSession();
  session.prompt = async () => {
    const submit = tools.find((tool) => tool.name === "wiki_submit_synthesis");
    await submit.execute("submit-synthesis", {
      decision: "expand",
      researchScopes: [{ id: "missing", sourcePaths: ["src"], task: "Inspect the missing boundary." }],
      spec: null,
      rationale: "One more bounded source survey is needed.",
    });
  };
  const executor = new PiAgentExecutor({
    createSession: async (options) => {
      tools = options.customTools;
      return { session };
    },
  });

  const result = await executor.execute(executionRequest(workspace, "synthesizer", undefined, undefined, "synthesis"));
  assert.deepEqual(result.result, {
    decision: "expand",
    researchScopes: [{ id: "missing", sourcePaths: ["src"], task: "Inspect the missing boundary." }],
    rationale: "One more bounded source survey is needed.",
  });
});

test("required diagrams use a nullable reason without changing the finalized WikiSpec", () => {
  const spec = finalizedSpec();
  const diagram = spec.domains[0].pages[0].diagrams[0];
  diagram.applicability = "required";
  diagram.reason = null;

  const result = parseSynthesisSubmission({
    decision: "finalize",
    researchScopes: null,
    spec,
    rationale: "The source research is sufficient to assign one bounded domain.",
  });
  assert.equal(result.decision, "finalize");
  assert.equal(result.spec.domains[0].pages[0].diagrams[0].reason, undefined);
});

test("a later valid submission recovers from a rejected control call", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-submission-recovery-");
  let tools;
  let followUps = 0;
  const session = fakeSession();
  session.prompt = async () => {
    const submit = tools.find((tool) => tool.name === "wiki_submit_review");
    await assert.rejects(
      () => submit.execute("invalid-review", { defects: [], summary: "x".repeat(MAX_CONTROL_SUBMISSION_BYTES) }),
      WikiControlSubmissionSizeError,
    );
  };
  session.followUp = async () => {
    followUps += 1;
    const submit = tools.find((tool) => tool.name === "wiki_submit_review");
    await submit.execute("valid-review", { defects: [], summary: "All checks passed." });
  };
  const executor = new PiAgentExecutor({
    createSession: async (options) => {
      tools = options.customTools;
      return { session };
    },
  });

  const result = await executor.execute(executionRequest(workspace, "reviewer", undefined, undefined, "review"));
  assert.deepEqual(result.result, { defects: [], summary: "All checks passed." });
  assert.equal(followUps, 1);
});

test("reports the final rejected control call with its classified error", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-submission-error-");
  let tools;
  const session = fakeSession();
  session.prompt = async () => {
    const submit = tools.find((tool) => tool.name === "wiki_submit_review");
    await assert.rejects(
      () => submit.execute("invalid-review", { defects: [], summary: "x".repeat(MAX_CONTROL_SUBMISSION_BYTES) }),
      WikiControlSubmissionSizeError,
    );
  };
  const executor = new PiAgentExecutor({
    createSession: async (options) => {
      tools = options.customTools;
      return { session };
    },
  });

  await assert.rejects(
    () => executor.execute(executionRequest(workspace, "reviewer", undefined, undefined, "review")),
    (error) => error instanceof WikiAgentProtocolError
      && error.code === "submission_too_large"
      && /control payload limit/.test(error.message),
  );
});

test("rejects oversized Unicode review control payloads before they enter the DAG", () => {
  const oversizedDetail = "测".repeat(Math.ceil(MAX_CONTROL_SUBMISSION_BYTES / 2));
  assert.throws(
    () => parseReviewSubmission({
      defects: [{
        id: "too-large",
        domainId: "domain",
        page: "domain/page.md",
        kind: "depth",
        detail: oversizedDetail,
      }],
      summary: "Review found one issue.",
    }),
    (error) => error instanceof WikiControlSubmissionSizeError
      && error.code === "submission_too_large"
      && error.sizeBytes > MAX_CONTROL_SUBMISSION_BYTES,
  );
});

test("accepts the exact UTF-8 control limit and rejects one byte over", () => {
  const emptySubmission = { defects: [], summary: "" };
  const summaryAtLimit = "x".repeat(MAX_CONTROL_SUBMISSION_BYTES - Buffer.byteLength(JSON.stringify(emptySubmission), "utf8"));
  const atLimit = { defects: [], summary: summaryAtLimit };

  assert.deepEqual(parseReviewSubmission(atLimit), atLimit);
  assert.throws(
    () => parseReviewSubmission({ defects: [], summary: `${summaryAtLimit}x` }),
    (error) => error instanceof WikiControlSubmissionSizeError
      && error.sizeBytes === MAX_CONTROL_SUBMISSION_BYTES + 1,
  );
});

test("fails closed when Pi does not activate the required control tool", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-hidden-control-");
  const session = fakeSession(["read", "grep", "find", "ls"]);
  let prompted = false;
  session.prompt = async () => { prompted = true; };
  const executor = new PiAgentExecutor({ createSession: async () => ({ session }) });

  await assert.rejects(
    () => executor.execute(executionRequest(workspace, "synthesizer", undefined, undefined, "synthesis")),
    /wiki_submit_synthesis is not active/,
  );
  assert.equal(prompted, false);
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

test("researcher execution requires non-empty source roots before starting a child session", async () => {
  const workspace = await initializedWorkspace("okf-wiki-executor-research-roots-");
  let sessions = 0;
  const executor = new PiAgentExecutor({
    createSession: async () => {
      sessions += 1;
      return { session: fakeSession() };
    },
  });

  await assert.rejects(
    () => executor.execute(executionRequest(workspace)),
    /researcher requests require at least one source root/,
  );
  const emptyRoots = executionRequest(workspace);
  emptyRoots.readRoots = [];
  await assert.rejects(
    () => executor.execute(emptyRoots),
    /researcher requests require at least one source root/,
  );
  assert.equal(sessions, 0);
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
  await executor.execute(executionRequest(workspace, "writer", undefined, undefined, "write"));
  selected = second;
  await executor.execute(executionRequest(workspace, "writer", undefined, undefined, "write"));
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
  await executor.execute(executionRequest(workspace, "writer", (value) => output.push(value), undefined, "write"));
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
  const result = await executor.execute(executionRequest(workspace, "writer", undefined, (history) => snapshots.push(history), "write"));

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
  const otherSource = path.join(parent, "web");
  await mkdir(path.join(source, "src"), { recursive: true });
  await mkdir(path.join(otherSource, "src"), { recursive: true });
  await writeFile(path.join(source, "src", "index.ts"), "export const api = true;\n");
  await writeFile(path.join(otherSource, "src", "index.ts"), "export const web = true;\n");
  git(source, "init", "--quiet");
  git(otherSource, "init", "--quiet");
  const docs = path.join(parent, "docs");
  await initializeWikiWorkspace({ cwd: docs });
  await addWikiSource({ cwd: docs, source: { kind: "link", path: source } });
  await addWikiSource({ cwd: docs, source: { kind: "link", path: otherSource } });
  let tools;
  const executor = new PiAgentExecutor({
    createSession: async (options) => {
      tools = options.customTools;
      return { session: fakeSession() };
    },
  });

  const sourceSurvey = executionRequest(docs);
  sourceSurvey.readRoots = ["api"];
  await executor.execute(sourceSurvey);
  const read = tools.find((tool) => tool.name === "read");
  const result = await read.execute("call-1", { path: "api/src/index.ts" });
  assert.match(result.content[0].text, /api = true/);
  await assert.rejects(() => read.execute("call-2", { path: "../api/src/index.ts" }));
  await assert.rejects(() => read.execute("call-3", { path: "web/src/index.ts" }), /permitted workspace scope/);
  await assert.rejects(() => read.execute("call-4", { path: "wiki/overview/overview.md" }), /permitted workspace scope/);

  const mapper = executionRequest(docs);
  mapper.readRoots = ["api", "web"];
  await executor.execute(mapper);
  const mapperRead = tools.find((tool) => tool.name === "read");
  const mapperResult = await mapperRead.execute("call-5", { path: "web/src/index.ts" });
  assert.match(mapperResult.content[0].text, /web = true/);
});
