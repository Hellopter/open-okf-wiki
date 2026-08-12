import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_CONTROL_ARTIFACT_BYTES,
  MAX_RESEARCH_ARTIFACT_BYTES,
  parseResearchSubmission,
  parseReviewSubmission,
  parseSynthesisSubmission,
} from "../dist/control-submissions.js";
import {
  CORRECTION_MAX,
  PI_SESSION_POLICY,
  PiAgentExecutor,
  WikiAgentContextBudgetError,
  WikiAgentProtocolError,
} from "../dist/executor.js";
import { addWikiSource, initializeWikiWorkspace } from "../dist/workspace.js";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function workspaceWithSources(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-executor-v6-"));
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  const docs = path.join(parent, "docs");
  await initializeWikiWorkspace({ cwd: docs });
  for (const name of ["api", "web"]) {
    const source = path.join(parent, name);
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(path.join(source, "src", "index.ts"), `export const ${name} = true;\n`);
    git(source, "init", "--quiet");
    await addWikiSource({ cwd: docs, source: { kind: "link", path: source } });
  }
  return docs;
}

function metrics() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, compactions: 0, autoRetries: 0 };
}

function node(kind) {
  return {
    id: `${kind}-node`, kind, label: kind, phaseId: kind, phaseTitle: kind,
    status: "running", dependsOn: [], attempt: 1, inputFingerprint: "", input: {},
    attemptHistory: [], metrics: metrics(), activity: { state: "running", updatedAt: new Date().toISOString() },
  };
}

function fakeSession(activeTools) {
  let disposed = false;
  let reset = false;
  const lifecycle = [];
  return {
    subscribe: () => () => {},
    setAutoCompactionEnabled() {},
    setAutoRetryEnabled() {},
    async abort() {},
    async prompt() {},
    async followUp() {},
    async waitForIdle() { lifecycle.push("waitForIdle"); },
    state: {},
    agent: {
      reset() {
        reset = true;
        lifecycle.push("reset");
      },
    },
    getLastAssistantText: () => "complete",
    getActiveToolNames: () => activeTools ?? ["read", "grep", "find", "ls", "edit", "write", "wiki_submit_research", "wiki_submit_synthesis_expand", "wiki_submit_synthesis_finalize", "wiki_submit_page", "wiki_submit_review"],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    getContextUsage: () => undefined,
    dispose() {
      disposed = true;
      lifecycle.push("dispose");
    },
    get disposed() { return disposed; },
    get resetCalled() { return reset; },
    get lifecycle() { return lifecycle; },
  };
}

function request(cwd, kind, role) {
  const artifactWritePath = role === "writer" ? undefined : `.okf-wiki/runs/run/${kind}-node/attempt-1/${kind}.json`;
  return {
    runId: "run",
    node: node(kind),
    cwd,
    prompt: "test",
    role,
    readRoots: role === "researcher" ? ["api"] : undefined,
    artifactWritePath,
    writePaths: role === "writer" ? ["wiki/domain/page.md"] : undefined,
    validatePageSubmission: role === "writer"
      ? async (page) => ({ ok: true, submission: { page, sha256: "a".repeat(64) } })
      : undefined,
    language: "zh",
    signal: new AbortController().signal,
  };
}

async function writeAndSubmit(tools, name, content) {
  if (name === "wiki_submit_research" && Array.isArray(content.findings)) {
    if (content.findings.length > 0) {
      await tools.find((tool) => tool.name === "wiki_research_put_findings").execute("stage", {
        findings: content.findings.map((finding, index) => ({ slot: `finding-${index}`, finding })),
      });
    }
    content = { summary: content.summary, gaps: content.gaps };
  }
  if (name === "wiki_submit_synthesis_finalize" && content.spec) {
    for (const domain of content.spec.domains ?? []) {
      await tools.find((tool) => tool.name === "wiki_plan_put_domain").execute(`stage-${domain.id}`, { domain });
    }
    await tools.find((tool) => tool.name === "wiki_plan_set_coordination").execute("coordination", {
      crossLinks: content.spec.crossLinks ?? [],
      sharedTerms: content.spec.sharedTerms ?? [],
      omissions: content.spec.omissions ?? [],
    });
    content = { rationale: content.rationale };
  }
  if (name === "wiki_submit_review" && Array.isArray(content.defects)) {
    if (content.defects.length > 0) {
      await tools.find((tool) => tool.name === "wiki_review_put_defects").execute("stage-review", {
        defects: content.defects.map((defect, index) => ({ slot: `defect-${index}`, defect })),
      });
    }
    content = { summary: content.summary };
  }
  return await tools.find((tool) => tool.name === name).execute("submit", content);
}

function finalizedSpec() {
  return {
    domains: [
      { id: "overview", title: "Overview", purpose: "Orient readers", pages: [{ pageType: "overview", path: "overview/overview.md", title: "Overview", purpose: "Orient readers", readerQuestions: ["What does the system contain?"], requiredFacets: ["domain map"], findingIds: [] }] },
      { id: "domain", title: "Domain", purpose: "Explain the domain", pages: [
        { pageType: "domain", path: "domain/domain.md", title: "Domain", purpose: "Connect domain knowledge", readerQuestions: ["How does this domain fit together?"], requiredFacets: ["models", "flows", "state", "invariants", "boundaries"], findingIds: ["finding-api"] },
        { pageType: "module", path: "domain/page.md", title: "Page", purpose: "Explain the page", readerQuestions: ["How is the API exposed?"], requiredFacets: ["interface"], findingIds: ["finding-api"] },
      ] },
    ],
    omissions: [],
  };
}

test("synthesis submission accepts the page-level contract and optional coordination arrays", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "synthesis", "synthesizer");
  execution.readRoots = ["api"];
  let tools;
  const session = fakeSession();
  session.prompt = async () => {
    await writeAndSubmit(tools, "wiki_submit_synthesis_finalize", { spec: finalizedSpec(), rationale: "Complete." });
  };
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    tools = options.customTools;
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });

  const result = await executor.execute(execution);
  assert.deepEqual(result.result.spec.crossLinks, []);
  assert.deepEqual(result.result.spec.sharedTerms, []);
  const submit = tools.find((tool) => tool.name === "wiki_submit_synthesis_finalize");
  const guidance = [submit.description, ...submit.promptGuidelines].join("\n");
  assert.match(guidance, /wiki_plan_put_domain/);
  assert.doesNotMatch(guidance, /requiredSections|diagrams|sources/);
});

test("review submission is a discriminated local/structural union without model IDs", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "review", "reviewer");
  execution.wikiReadPaths = ["wiki/domain/page.md"];
  await mkdir(path.join(cwd, "wiki/domain"), { recursive: true });
  await writeFile(path.join(cwd, "wiki/domain/page.md"), "# Page\n");
  let tools;
  const session = fakeSession();
  const defects = [
    { kind: "depth", page: "domain/page.md", detail: "Explain the boundary." },
    { kind: "coverage", detail: "Add the missing domain." },
  ];
  session.prompt = async () => await writeAndSubmit(tools, "wiki_submit_review", { defects, summary: "Two defects." });
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    tools = options.customTools;
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });
  const result = await executor.execute(execution);
  assert.deepEqual(result.result.defects, defects);
  const guidance = tools.find((tool) => tool.name === "wiki_submit_review").promptGuidelines.join("\n");
  assert.doesNotMatch(guidance, /domainId|\"id\"|format/);
  assert.throws(() => parseReviewSubmission({ defects: [{ ...defects[0], id: "model-id" }], summary: "bad" }), /unsupported field: id/);
});

test("writer validates the exact page, reports all issues, and accepts a same-session repair", async (t) => {
  const cwd = await workspaceWithSources(t);
  await mkdir(path.join(cwd, "wiki/domain"), { recursive: true });
  await writeFile(path.join(cwd, "wiki/domain/retained.md"), "# Retained\n");
  const execution = request(cwd, "write", "writer");
  execution.readRoots = ["api"];
  execution.wikiReadPaths = ["wiki/domain/retained.md"];
  let validationCalls = 0;
  execution.validatePageSubmission = async (page) => {
    validationCalls += 1;
    if (validationCalls === 1) return {
      ok: false,
      issues: [
        { code: "citation-footnote", message: "Claim must cite [^api-core]." },
        { code: "mermaid-syntax", message: "Diagram block is not closed." },
      ],
    };
    return { ok: true, submission: { page, sha256: "b".repeat(64) } };
  };
  let tools;
  const session = fakeSession();
  session.prompt = async () => {
    assert.equal(tools.some((tool) => tool.name === "wiki_delete"), false);
    const write = tools.find((tool) => tool.name === "write");
    const read = tools.find((tool) => tool.name === "read");
    const submit = tools.find((tool) => tool.name === "wiki_submit_page");
    await write.execute("write", { path: "wiki/domain/page.md", content: "# Page\n" });
    assert.match((await read.execute("read-source", { path: "api/src/index.ts" })).content[0].text, /api = true/);
    assert.match((await read.execute("read-retained", { path: "wiki/domain/retained.md" })).content[0].text, /Retained/);
    await assert.rejects(() => write.execute("wrong", { path: "wiki/domain/other.md", content: "no" }), /not assigned/);
    await assert.rejects(() => read.execute("other-source", { path: "web/src/index.ts" }), /permitted workspace scope/);
    const invalid = await submit.execute("invalid", { page: "domain/page.md" });
    assert.equal(invalid.details.accepted, false);
    assert.equal(invalid.details.remainingAttempts, 2);
    assert.deepEqual(invalid.details.issues.map((issue) => issue.code), ["citation-footnote", "mermaid-syntax"]);
    const wrongPage = await submit.execute("wrong-page", { page: "domain/other.md" });
    assert.equal(wrongPage.details.accepted, false);
    assert.match(wrongPage.details.issues[0].message, /does not match the assigned page/);
    await write.execute("repair", { path: "wiki/domain/page.md", content: "# Page\n\nRepaired.\n" });
    await submit.execute("valid", { page: "domain/page.md" });
  };
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    tools = options.customTools;
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });
  const result = await executor.execute(execution);
  assert.deepEqual(result.result, { page: "domain/page.md", sha256: "b".repeat(64) });
  assert.equal(validationCalls, 2);
  assert.equal(await readFile(path.join(cwd, "wiki/domain/page.md"), "utf8"), "# Page\n\nRepaired.\n");
});

test("wikiReadPaths grant exact files and reject unassigned pages and symlink escapes", async (t) => {
  const cwd = await workspaceWithSources(t);
  await mkdir(path.join(cwd, "wiki/domain"), { recursive: true });
  await writeFile(path.join(cwd, "wiki/domain/page.md"), "# Assigned\n");
  await writeFile(path.join(cwd, "wiki/domain/other.md"), "# Other\n");
  const execution = request(cwd, "review", "reviewer");
  execution.wikiReadPaths = ["wiki/domain/page.md"];
  let tools;
  const session = fakeSession();
  session.prompt = async () => await writeAndSubmit(tools, "wiki_submit_review", { defects: [], summary: "Complete." });
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    tools = options.customTools;
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });
  await executor.execute(execution);
  const read = tools.find((tool) => tool.name === "read");
  assert.match((await read.execute("assigned", { path: "wiki/domain/page.md" })).content[0].text, /Assigned/);
  await assert.rejects(() => read.execute("unassigned", { path: "wiki/domain/other.md" }), /permitted workspace scope/);
  const outside = path.join(cwd, "outside.md");
  await writeFile(outside, "# Outside\n");
  await rm(path.join(cwd, "wiki/domain/page.md"));
  await symlink(outside, path.join(cwd, "wiki/domain/page.md"));
  await assert.rejects(() => read.execute("symlink", { path: "wiki/domain/page.md" }), /permitted workspace scope/);
});

test("research uses a submitted structured JSON artifact limited to 256 KiB", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "research", "researcher");
  let tools;
  const session = fakeSession();
  const artifact = {
    summary: "API entry point.",
    findings: [{
      kind: "concept",
      title: "API flag",
      readerQuestion: "Where is the API exported?",
      priority: "normal",
      evidence: ["api/src/index.ts#L1"],
    }],
    gaps: [],
  };
  session.prompt = async () => {
    const tooLarge = await writeAndSubmit(tools, "wiki_submit_research", {
      ...artifact,
      summary: "中".repeat(Math.ceil((MAX_RESEARCH_ARTIFACT_BYTES + 1) / 3)),
    });
    assert.equal(tooLarge.details.accepted, false);
    assert.match(tooLarge.details.issues[0].message, new RegExp(`${MAX_RESEARCH_ARTIFACT_BYTES}-byte`));
    await writeAndSubmit(tools, "wiki_submit_research", artifact);
  };
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    tools = options.customTools;
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });
  assert.deepEqual((await executor.execute(execution)).result, artifact);
  assert.deepEqual(parseResearchSubmission(artifact), artifact);
  assert.doesNotThrow(() => parseReviewSubmission({ defects: [], summary: "x".repeat(64 * 1024) }));
  assert.throws(() => parseReviewSubmission({ defects: [], summary: "x".repeat(MAX_CONTROL_ARTIFACT_BYTES + 1) }), /262144-byte/);
});

test("direct-object research submissions do not require an artifact write path", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "research", "researcher");
  execution.artifactWritePath = undefined;
  let tools;
  const session = fakeSession();
  const artifact = { summary: "Direct result.", findings: [], gaps: [] };
  session.prompt = async () => {
    assert.equal(tools.some((tool) => tool.name === "wiki_write_handoff"), false);
    await writeAndSubmit(tools, "wiki_submit_research", artifact);
  };
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    tools = options.customTools;
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });

  assert.deepEqual((await executor.execute(execution)).result, artifact);
});

test("a rejected control submission gets one correction turn", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "review", "reviewer");
  execution.wikiReadPaths = ["wiki/domain/page.md"];
  await mkdir(path.join(cwd, "wiki/domain"), { recursive: true });
  await writeFile(path.join(cwd, "wiki/domain/page.md"), "# Page\n");
  let tools;
  let followUps = 0;
  const session = fakeSession();
  session.prompt = async () => {
    const rejected = await tools.find((tool) => tool.name === "wiki_review_put_defects").execute("bad", {
      defects: [{ slot: "bad", defect: { kind: "topology", page: "domain/page.md", detail: "bad branch" } }],
    });
    assert.equal(rejected.details.ok, false);
    assert.match(rejected.details.message, /unsupported field: page/);
  };
  session.followUp = async () => {
    followUps += 1;
    await writeAndSubmit(tools, "wiki_submit_review", { defects: [], summary: "Corrected." });
  };
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    tools = options.customTools;
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });
  const result = await executor.execute(execution);
  assert.deepEqual(result.result, { defects: [], summary: "Corrected." });
  assert.equal(followUps, 1);
  assert.equal(followUps, CORRECTION_MAX, "correction is bounded to CORRECTION_MAX");
  assert.equal(result.metrics?.correctionAttempts, 1);
  assert.equal(result.metrics?.salvageAttempts, 0);
});

test("missing the required submission fails with a classified protocol error", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "synthesis", "synthesizer");
  execution.readRoots = ["api"];
  const session = fakeSession();
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });
  await assert.rejects(
    () => executor.execute(execution),
    (error) => error instanceof WikiAgentProtocolError && error.code === "missing_submission",
  );
});

test("an exhausted structured submission budget does not add a fourth correction turn", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "review", "reviewer");
  execution.wikiReadPaths = ["wiki/domain/page.md"];
  await mkdir(path.join(cwd, "wiki/domain"), { recursive: true });
  await writeFile(path.join(cwd, "wiki/domain/page.md"), "# Page\n");
  let tools;
  let followUps = 0;
  const session = fakeSession();
  session.prompt = async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await writeAndSubmit(tools, "wiki_submit_review", {
        defects: [], summary: " ",
      });
      assert.equal(result.details.accepted, false);
      assert.equal(result.details.remainingAttempts, 3 - attempt);
      assert.equal(result.terminate, attempt === 3);
    }
  };
  session.followUp = async () => { followUps += 1; };
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    tools = options.customTools;
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });

  await assert.rejects(
    () => executor.execute(execution),
    (error) => error instanceof WikiAgentProtocolError && error.code === "invalid_submission",
  );
  assert.equal(followUps, 0);
});

test("residual context errorMessage after a successful submit still succeeds without salvage", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "research", "researcher");
  const artifact = {
    summary: "API entry point.",
    findings: [{
      kind: "concept",
      title: "API flag",
      readerQuestion: "Where is the API exported?",
      priority: "normal",
      evidence: ["api/src/index.ts#L1"],
    }],
    gaps: [],
  };
  let tools;
  let followUps = 0;
  const session = fakeSession();
  session.prompt = async () => {
    await writeAndSubmit(tools, "wiki_submit_research", artifact);
    // Late residual overflow after the submit was already recorded must not fail the node.
    session.state.errorMessage = "context overflow recovery failed";
  };
  session.followUp = async () => {
    followUps += 1;
  };
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    tools = options.customTools;
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });

  const result = await executor.execute(execution);
  assert.deepEqual(result.result, artifact);
  assert.equal(followUps, 0, "recorded submission must win over residual context pressure");
  assert.equal(result.metrics?.salvageAttempts, 0);
  assert.equal(result.metrics?.correctionAttempts, 0);
});

test("context overflow terminates the expanded session without a salvage follow-up", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "research", "researcher");
  let followUps = 0;
  const session = fakeSession();
  session.prompt = async () => {
    session.state.errorMessage = "context overflow recovery failed";
  };
  session.followUp = async () => {
    followUps += 1;
  };
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });

  await assert.rejects(
    () => executor.execute(execution),
    (error) => error instanceof WikiAgentContextBudgetError
      && error.code === "context_budget_exceeded"
      && /context overflow recovery failed/.test(error.message),
  );
  assert.equal(followUps, 0, "overflow must be retried only in a fresh outer node session");
});

test("child sessions use an isolated fixed compaction and retry policy", async (t) => {
  const cwd = await workspaceWithSources(t);
  let settings;
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    settings = options.settingsManager;
    const session = fakeSession(options.tools);
    session.prompt = async () => {
      await options.customTools.find((tool) => tool.name === "write").execute("write", {
        path: "wiki/domain/page.md",
        content: "# Page\n",
      });
      await options.customTools.find((tool) => tool.name === "wiki_submit_page").execute("submit", {
        page: "domain/page.md",
      });
    };
    return { session };
  } });

  await executor.execute(request(cwd, "write", "writer"));
  assert.deepEqual(settings.getCompactionSettings(), PI_SESSION_POLICY.compaction);
  assert.deepEqual(settings.getRetrySettings(), {
    enabled: true,
    maxRetries: PI_SESSION_POLICY.retry.maxRetries,
    baseDelayMs: PI_SESSION_POLICY.retry.baseDelayMs,
  });
  assert.deepEqual(settings.getProviderRetrySettings(), {
    timeoutMs: undefined,
    maxRetries: 0,
    maxRetryDelayMs: 60_000,
  });
});

test("runtime policy configures up to sixteen in-session auto retries", async (t) => {
  const cwd = await workspaceWithSources(t);
  let settings;
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    settings = options.settingsManager;
    const session = fakeSession(options.tools);
    session.prompt = async () => {
      await options.customTools.find((tool) => tool.name === "write").execute("write", {
        path: "wiki/domain/page.md",
        content: "# Page\n",
      });
      await options.customTools.find((tool) => tool.name === "wiki_submit_page").execute("submit", {
        page: "domain/page.md",
      });
    };
    return { session };
  } });
  executor.setRuntimePolicy({
    quality: { maxSubmissionAttempts: 3 },
    runtime: {
      maxConcurrentAgents: 2,
      nodeTimeoutSeconds: 1_200,
      maxAutoRetries: 16,
      maxTransientSessionAttempts: 2,
      rateLimitCooldownSeconds: 15,
    },
  });

  await executor.execute(request(cwd, "write", "writer"));
  assert.equal(settings.getRetrySettings().maxRetries, 16);
  assert.equal(PI_SESSION_POLICY.retry.maxRetries, 3, "the shared default must remain immutable");
});

test("streaming output consumes text deltas and retains only an 8 KiB tail", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "research", "researcher");
  let tools;
  let listener;
  const outputs = [];
  execution.onOutput = (output) => { outputs.push(output); };
  const session = fakeSession();
  session.subscribe = (fn) => {
    listener = fn;
    return () => {};
  };
  session.prompt = async () => {
    for (let index = 0; index < 20; index += 1) {
      const delta = String(index % 10).repeat(1024);
      listener({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat((index + 1) * 1024) }] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: {} },
      });
    }
    await writeAndSubmit(tools, "wiki_submit_research", {
      summary: "API entry point.",
      findings: [],
      gaps: [],
    });
  };
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    tools = options.customTools;
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });

  await executor.execute(execution);
  const streamed = outputs.slice(0, 20);
  assert.ok(streamed.every((output) => output.length <= 8 * 1024));
  assert.match(streamed.at(-1), /^\[\.\.\./, "the stream should be a bounded tail after 8 KiB");
  assert.doesNotMatch(streamed.at(-1), /^x+$/, "stream updates must use deltas rather than cloning the full message");
});

test("runtime gate caps child sessions at two and falls back to one after 429", async (t) => {
  const cwd = await workspaceWithSources(t);
  const releases = [];
  const sessions = [];
  const listeners = [];
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    const session = fakeSession(options.tools);
    session.subscribe = (fn) => {
      listeners[index] = fn;
      return () => {};
    };
    const index = sessions.length;
    session.prompt = async () => {
      await new Promise((resolve) => { releases[index] = resolve; });
      await options.customTools.find((tool) => tool.name === "write").execute(`write-${index}`, {
        path: "wiki/domain/page.md",
        content: `# Page ${index}\n`,
      });
      await options.customTools.find((tool) => tool.name === "wiki_submit_page").execute(`submit-${index}`, {
        page: "domain/page.md",
      });
    };
    sessions.push(session);
    return { session };
  } });

  const executions = Array.from({ length: 4 }, () => executor.execute(request(cwd, "write", "writer")));
  await waitUntil(() => sessions.length === 2 && typeof releases[1] === "function");
  assert.equal(sessions.length, 2, "default concurrency is two");
  listeners[0]({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 100,
    errorMessage: "429 Too Many Requests",
  });
  releases[0]();
  releases[1]();
  await waitUntil(() => sessions.length === 3 && typeof releases[2] === "function");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.length, 3, "429 cooldown admits only one replacement session");
  releases[2]();
  await waitUntil(() => sessions.length === 4 && typeof releases[3] === "function");
  releases[3]();
  await Promise.all(executions);
});

test("node deadline aborts, disposes, and releases a session that never settles", async (t) => {
  const cwd = await workspaceWithSources(t);
  const sessions = [];
  const executor = new PiAgentExecutor({
    nodeTimeoutMs: 1_000,
    maxConcurrentAgents: 1,
    createSession: async (options) => {
      const index = sessions.length;
      const session = fakeSession(options.tools);
      let aborts = 0;
      if (index === 0) {
        session.prompt = async () => await new Promise(() => {});
        session.waitForIdle = async () => await new Promise(() => {});
      } else {
        session.prompt = async () => {
          await options.customTools.find((tool) => tool.name === "write").execute("write-after-timeout", {
            path: "wiki/domain/page.md",
            content: "# After timeout\n",
          });
          await options.customTools.find((tool) => tool.name === "wiki_submit_page").execute("submit-after-timeout", {
            page: "domain/page.md",
          });
        };
      }
      session.abort = async () => { aborts += 1; };
      Object.defineProperty(session, "abortCalls", { get: () => aborts });
      sessions.push(session);
      return { session };
    },
  });

  await assert.rejects(
    () => executor.execute(request(cwd, "write", "writer")),
    /timed out after 1000ms/,
  );
  assert.ok(sessions[0].abortCalls >= 1);
  assert.equal(sessions[0].disposed, true);

  await executor.execute(request(cwd, "write", "writer"));
  assert.equal(sessions.length, 2, "the released slot allows a subsequent execution to start");
  assert.equal(sessions[1].disposed, true);
});

test("setMaxConcurrentAgents expands queued work from two sessions to four", async (t) => {
  const cwd = await workspaceWithSources(t);
  const releases = [];
  const sessions = [];
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    const index = sessions.length;
    const session = fakeSession(options.tools);
    session.prompt = async () => {
      await new Promise((resolve) => { releases[index] = resolve; });
      await options.customTools.find((tool) => tool.name === "write").execute(`write-expand-${index}`, {
        path: "wiki/domain/page.md",
        content: `# Expanded ${index}\n`,
      });
      await options.customTools.find((tool) => tool.name === "wiki_submit_page").execute(`submit-expand-${index}`, {
        page: "domain/page.md",
      });
    };
    sessions.push(session);
    return { session };
  } });

  const executions = Array.from({ length: 4 }, () => executor.execute(request(cwd, "write", "writer")));
  await waitUntil(() => sessions.length === 2 && typeof releases[1] === "function");
  executor.setMaxConcurrentAgents(4);
  await waitUntil(() => sessions.length === 4 && typeof releases[3] === "function");
  releases.forEach((release) => release());
  await Promise.all(executions);
  assert.equal(sessions.length, 4);
});

test("wiki_submit_research returns actionable issues and accepts a same-session repair", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "research", "researcher");
  let tools;
  const session = fakeSession();
  const valid = {
    summary: "API entry point.",
    findings: [{
      kind: "concept",
      title: "API flag",
      readerQuestion: "Where is the API exported?",
      priority: "normal",
      evidence: ["api/src/index.ts#L1"],
    }],
    gaps: [],
  };
  session.prompt = async () => {
    const stage = tools.find((tool) => tool.name === "wiki_research_put_findings");
    const outOfScope = await stage.execute("out-of-scope", {
        findings: [{ slot: "finding", finding: {
          kind: "concept",
          title: "Web",
          readerQuestion: "Where is web?",
          priority: "normal",
          evidence: ["web/src/index.ts#L1"],
        } }],
      });
    assert.equal(outOfScope.details.ok, false);
    assert.match(outOfScope.details.message, /outside the assigned scope/);
    const missing = await stage.execute("missing", {
        findings: [{ slot: "finding", finding: {
          kind: "concept",
          title: "Missing",
          readerQuestion: "Where is missing?",
          priority: "normal",
          evidence: ["api/src/missing.ts#L1"],
        } }],
      });
    assert.equal(missing.details.ok, false);
    assert.match(missing.details.message, /file is missing/);
    await writeAndSubmit(tools, "wiki_submit_research", valid);
  };
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    tools = options.customTools;
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });

  assert.deepEqual((await executor.execute(execution)).result, valid);
});

test("auto_retry_start events increment metrics.autoRetries via onActivity", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "research", "researcher");
  const artifact = {
    summary: "API entry point.",
    findings: [{
      kind: "concept",
      title: "API flag",
      readerQuestion: "Where is the API exported?",
      priority: "normal",
      evidence: ["api/src/index.ts#L1"],
    }],
    gaps: [],
  };
  let tools;
  let autoRetries = 0;
  execution.onActivity = (_activity, metrics) => {
    if (metrics?.autoRetries) autoRetries += metrics.autoRetries;
  };
  const session = fakeSession();
  let listener;
  session.subscribe = (fn) => {
    listener = fn;
    return () => {};
  };
  session.prompt = async () => {
    listener?.({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      errorMessage: "transient",
    });
    listener?.({ type: "auto_retry_end", success: true, attempt: 1 });
    await writeAndSubmit(tools, "wiki_submit_research", artifact);
  };
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    tools = options.customTools;
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });
  const result = await executor.execute(execution);
  assert.deepEqual(result.result, artifact);
  assert.equal(autoRetries, 1, "layer-1 auto-retry must surface on metrics.autoRetries");
  assert.equal(result.metrics?.salvageAttempts, 0);
  assert.equal(result.metrics?.correctionAttempts, 0);
});

test("every execution creates and disposes a fresh child session", async (t) => {
  const cwd = await workspaceWithSources(t);
  const sessions = [];
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    const session = fakeSession(options.tools);
    session.prompt = async () => {
      await options.customTools.find((tool) => tool.name === "write").execute("write", {
        path: "wiki/domain/page.md",
        content: "# Page\n",
      });
      await options.customTools.find((tool) => tool.name === "wiki_submit_page").execute("submit", {
        page: "domain/page.md",
      });
    };
    sessions.push(session);
    return { session };
  } });
  await executor.execute(request(cwd, "write", "writer"));
  await executor.execute(request(cwd, "write", "writer"));
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0], sessions[1]);
  assert.ok(sessions.every((session) => session.disposed));
  assert.ok(sessions.every((session) => session.resetCalled), "agent.reset runs before dispose");
  for (const session of sessions) {
    // Final drain: waitForIdle (may also run mid-prompt) then reset then dispose.
    const tail = session.lifecycle.slice(-3);
    assert.deepEqual(tail, ["waitForIdle", "reset", "dispose"]);
  }
});

test("dispose still runs when waitForIdle or reset throws", async (t) => {
  const cwd = await workspaceWithSources(t);
  const session = fakeSession();
  let idleCalls = 0;
  // Mid-run waitForIdle (after prompt) succeeds; only the finally drain fails.
  session.waitForIdle = async () => {
    idleCalls += 1;
    session.lifecycle.push("waitForIdle");
    if (idleCalls > 1) throw new Error("idle failed");
  };
  session.agent = {
    reset() {
      session.lifecycle.push("reset");
      throw new Error("reset failed");
    },
  };
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    session.getActiveToolNames = () => options.tools;
    session.prompt = async () => {
      await options.customTools.find((tool) => tool.name === "write").execute("write", {
        path: "wiki/domain/page.md",
        content: "# Page\n",
      });
      await options.customTools.find((tool) => tool.name === "wiki_submit_page").execute("submit", {
        page: "domain/page.md",
      });
    };
    return { session };
  } });
  await executor.execute(request(cwd, "write", "writer"));
  assert.equal(session.disposed, true);
  assert.ok(idleCalls >= 2, "finally drain invokes waitForIdle after the mid-run idle");
  assert.ok(session.lifecycle.includes("reset"));
  assert.equal(session.lifecycle.at(-1), "dispose");
});

test("synthesis parser rejects removed page-contract fields", () => {
  const invalid = finalizedSpec();
  invalid.domains[1].pages[0].sources = ["api/src/index.ts#L1"];
  assert.throws(() => parseSynthesisSubmission({ decision: "finalize", spec: invalid, rationale: "bad" }), /unsupported field: sources/);
});

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for executor state");
}
