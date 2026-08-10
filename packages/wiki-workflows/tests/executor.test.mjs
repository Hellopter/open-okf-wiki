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
import { PiAgentExecutor, WikiAgentProtocolError } from "../dist/executor.js";
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
  return {
    subscribe: () => () => {},
    setAutoCompactionEnabled() {},
    setAutoRetryEnabled() {},
    async abort() {},
    async prompt() {},
    async followUp() {},
    async waitForIdle() {},
    state: {},
    getLastAssistantText: () => "complete",
    getActiveToolNames: () => activeTools ?? ["read", "grep", "find", "ls", "edit", "write", "wiki_write_handoff", "wiki_submit_research", "wiki_submit_synthesis", "wiki_submit_page", "wiki_submit_review"],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    getContextUsage: () => undefined,
    dispose() { disposed = true; },
    get disposed() { return disposed; },
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
  await tools.find((tool) => tool.name === "wiki_write_handoff").execute("write-handoff", { content: JSON.stringify(content) });
  return await tools.find((tool) => tool.name === name).execute("submit", {
    artifactPath: name === "wiki_submit_research"
      ? ".okf-wiki/runs/run/research-node/attempt-1/research.json"
      : name === "wiki_submit_synthesis"
        ? ".okf-wiki/runs/run/synthesis-node/attempt-1/synthesis.json"
        : ".okf-wiki/runs/run/review-node/attempt-1/review.json",
  });
}

function finalizedSpec() {
  return {
    domains: [
      { id: "overview", title: "Overview", purpose: "Orient readers", pages: [{ pageType: "overview", path: "overview/overview.md", title: "Overview", purpose: "Orient readers", findingIds: [] }] },
      { id: "domain", title: "Domain", purpose: "Explain the domain", pages: [{ pageType: "module", path: "domain/page.md", title: "Page", purpose: "Explain the page", findingIds: ["finding-api"] }] },
    ],
    omissions: [],
  };
}

test("synthesis submission accepts the page-level contract and optional coordination arrays", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "synthesis", "synthesizer");
  execution.artifactPaths = [".okf-wiki/runs/run/research-node/attempt-1/research.json"];
  await mkdir(path.dirname(path.join(cwd, execution.artifactPaths[0])), { recursive: true });
  await writeFile(path.join(cwd, execution.artifactPaths[0]), JSON.stringify({ summary: "API", findings: [], gaps: [] }));
  let tools;
  const session = fakeSession();
  session.prompt = async () => {
    await writeAndSubmit(tools, "wiki_submit_synthesis", { decision: "finalize", spec: finalizedSpec(), rationale: "Complete." });
  };
  const executor = new PiAgentExecutor({ createSession: async (options) => {
    tools = options.customTools;
    session.getActiveToolNames = () => options.tools;
    return { session };
  } });

  const result = await executor.execute(execution);
  assert.deepEqual(result.result.spec.crossLinks, []);
  assert.deepEqual(result.result.spec.sharedTerms, []);
  const submit = tools.find((tool) => tool.name === "wiki_submit_synthesis");
  assert.match(submit.promptGuidelines[0], /findingIds/);
  assert.doesNotMatch(submit.promptGuidelines[0], /requiredSections|diagrams|sources/);
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
    await assert.rejects(
      () => submit.execute("invalid", { page: "domain/page.md" }),
      (error) => /citation-footnote/.test(error.message) && /mermaid-syntax/.test(error.message),
    );
    await assert.rejects(() => submit.execute("wrong-page", { page: "domain/other.md" }), /does not match the assigned page/);
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
    await assert.rejects(
      () => tools.find((tool) => tool.name === "wiki_write_handoff").execute("large", { content: "中".repeat(Math.ceil((MAX_RESEARCH_ARTIFACT_BYTES + 1) / 3)) }),
      new RegExp(`${MAX_RESEARCH_ARTIFACT_BYTES}-byte`),
    );
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
    await assert.rejects(() => writeAndSubmit(tools, "wiki_submit_review", {
      defects: [{ kind: "topology", page: "domain/page.md", detail: "bad branch" }], summary: "bad",
    }), /unsupported field: page/);
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
  assert.deepEqual((await executor.execute(execution)).result, { defects: [], summary: "Corrected." });
  assert.equal(followUps, 1);
});

test("missing the required submission fails with a classified protocol error", async (t) => {
  const cwd = await workspaceWithSources(t);
  const execution = request(cwd, "synthesis", "synthesizer");
  execution.artifactPaths = [".okf-wiki/runs/run/research-node/attempt-1/research.json"];
  await mkdir(path.dirname(path.join(cwd, execution.artifactPaths[0])), { recursive: true });
  await writeFile(path.join(cwd, execution.artifactPaths[0]), JSON.stringify({ summary: "Research", findings: [], gaps: [] }));
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
});

test("synthesis parser rejects removed page-contract fields", () => {
  const invalid = finalizedSpec();
  invalid.domains[1].pages[0].sources = ["api/src/index.ts#L1"];
  assert.throws(() => parseSynthesisSubmission({ decision: "finalize", spec: invalid, rationale: "bad" }), /unsupported field: sources/);
});
