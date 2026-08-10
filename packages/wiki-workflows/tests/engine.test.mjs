import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiArtifactStore } from "../dist/artifact-store.js";
import { WikiWorkflowEngine } from "../dist/engine.js";
import { phaseRows } from "../dist/ui/stages.js";

const artifactRoots = [];
let artifactStoreId = 0;

test.after(async () => {
  await Promise.all(artifactRoots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

const inspection = {
  root: "/workspace",
  wikiRoot: "/workspace/wiki",
  sourcePaths: ["src-core", "src-api"],
  mode: "refresh",
  head: "abc123",
  baseCommit: "base",
  lastWikiCommit: "base",
  changed: [],
  changedPaths: [],
  sourceFingerprint: "source-baseline",
  impactedPages: [],
  wikiDrift: false,
};

const validation = { ok: true, errors: [], pages: ["overview/overview.md", "core/architecture.md", "api/request-flow.md"] };

function finalizedSpec(options = {}) {
  return {
    domains: [
      {
        id: "overview",
        title: "Overview",
        purpose: "Summarize the system across domains",
        researchScopeIds: [],
        pages: [{
          pageType: "overview",
          path: "overview/overview.md",
          title: "System Overview",
          purpose: "Orient readers to the documented system",
          sources: ["src/core.ts#L1-L20"],
          requiredSections: ["Scope", "Domain Map"],
          diagrams: [{ kind: "flowchart", applicability: "not_applicable", purpose: "Show system boundaries", reason: "The domain pages provide the verified diagrams." }],
        }],
      },
      {
        id: "core",
        title: "Core",
        purpose: "Explain core architecture",
        researchScopeIds: options.coreScopes ?? ["source-survey:src-core"],
        pages: [{
          pageType: "architecture",
          path: "core/architecture.md",
          title: "Architecture",
          purpose: "Explain runtime boundaries",
          sources: ["src/core.ts#L1-L20"],
          requiredSections: ["Responsibilities", "Boundaries"],
          diagrams: [{ kind: "flowchart", applicability: "required", purpose: "Show component boundaries" }],
        }],
      },
      {
        id: "api",
        title: "API",
        purpose: "Explain request processing",
        researchScopeIds: options.apiScopes ?? ["source-survey:src-api"],
        pages: [{
          pageType: "flow",
          path: "api/request-flow.md",
          title: "Request Flow",
          purpose: "Explain request lifecycle",
          sources: ["src/api.ts#L1-L20"],
          requiredSections: ["Entry Point", "Failure Handling"],
          diagrams: [{ kind: "sequence", applicability: "required", purpose: "Show request interactions" }],
        }],
      },
    ],
    crossLinks: [{ fromPath: "core/architecture.md", toPath: "api/request-flow.md", purpose: "Connect boundaries to request flow" }],
    sharedTerms: [{ term: "request", definition: "A single API invocation." }],
  };
}

function finalize(spec = finalizedSpec()) {
  return { decision: "finalize", spec, rationale: "The receipts support a bounded final Wiki contract." };
}

function receipt(scopeId) {
  return `## Findings\n- ${scopeId} is verified. Source: \`src/${scopeId}.ts#L1-L20\`\n\n## Gaps\n- None.\n\n## Writer Guidance\n- Keep ${scopeId} source-grounded.`;
}

function createExecutor(options = {}) {
  const calls = [];
  const requests = [];
  let synthesisCount = 0;
  let reviewCount = 0;
  return {
    calls,
    requests,
    async execute(request) {
      calls.push(request.node.kind);
      requests.push(request);
      if (request.node.kind === "research") return { result: options.research?.(request) ?? receipt(request.node.input.scope.id) };
      if (request.node.kind === "synthesis") {
        const result = options.synthesis?.(request, synthesisCount++) ?? finalize();
        return { result };
      }
      if (request.node.kind === "write" || request.node.kind === "repair") {
        return { result: { updatedPages: request.writePaths ?? [], deletedPages: [], notes: [] } };
      }
      if (request.node.kind === "review") {
        const result = options.review?.(request, reviewCount++) ?? { defects: [], summary: "complete" };
        return { result };
      }
      throw new Error(`unexpected node ${request.node.kind}`);
    },
  };
}

function createEngine(executor, inspect = async () => inspection, validate = async () => validation, artifactStore) {
  let id = 0;
  const artifactRoot = path.join(os.tmpdir(), `okf-wiki-engine-artifacts-${process.pid}-${++artifactStoreId}`);
  artifactRoots.push(artifactRoot);
  return new WikiWorkflowEngine({
    executor,
    inspect,
    validate,
    artifactStore: artifactStore ?? createWikiArtifactStore({ workspace: "/workspace", rootDir: artifactRoot }),
    createId: () => `id-${++id}`,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
}

test("source surveys converge through synthesis before parallel domain writers and global review", async () => {
  const executor = createExecutor();
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate", language: "zh" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  assert.equal(executor.calls.filter((kind) => kind === "plan").length, 0);
  assert.equal(executor.calls.filter((kind) => kind === "research").length, 3);
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 1);
  assert.equal(executor.calls.filter((kind) => kind === "write").length, 3);
  assert.equal(executor.calls.filter((kind) => kind === "review").length, 1);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "write").length, 3);
  assert.ok(snapshot.nodes.find((node) => node.kind === "review").dependsOn.every((id) => snapshot.nodes.find((node) => node.id === id)?.kind === "validate"));
  const synthesis = executor.requests.find((request) => request.node.kind === "synthesis");
  assert.equal(synthesis.artifactPaths.length, 3);
  assert.ok(synthesis.artifactPaths.every((artifactPath) => artifactPath.startsWith(".okf-wiki/runs/")));
  assert.doesNotMatch(synthesis.prompt, /source-survey:src-core is verified/);
  assert.match(synthesis.prompt, /\.okf-wiki\/runs\//);
  assert.match(synthesis.prompt, /"crossLinks": \[/);
  assert.match(synthesis.prompt, /"sharedTerms": \[/);
  const surveys = executor.requests.filter((request) => request.node.kind === "research");
  assert.deepEqual(surveys.find((request) => request.node.input.scope.id === "source-survey:src-core").readRoots, ["src-core"]);
  assert.deepEqual(surveys.find((request) => request.node.input.scope.id === "source-survey:src-api").readRoots, ["src-api"]);
  assert.deepEqual(surveys.find((request) => request.node.input.scope.id === "workspace-map").readRoots, ["src-core", "src-api"]);
  const review = executor.requests.find((request) => request.node.kind === "review");
  assert.deepEqual(review.readRoots, ["src-core", "src-api"]);
  assert.deepEqual(review.reviewPaths, ["wiki/overview/overview.md", "wiki/core/architecture.md", "wiki/api/request-flow.md"]);
  assert.match(review.prompt, /"domainId": "domain-id"/);
  assert.match(review.prompt, /"summary": "A concise global review conclusion\."/);
});

test("synthesis receives only exact artifact paths for Markdown receipts", async () => {
  const rawReceipt = `\r\n${[
    "## Findings",
    "- CJK evidence: 中文. Source: `src/core.ts#L1-L20`",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[\\\"quoted\\\"] --> B[path\\name]",
    "```",
    "",
    "## Gaps",
    "- Preserve literal newlines and `\\` characters.",
  ].join("\r\n")}\r\n`;
  const executor = createExecutor({
    research: () => rawReceipt,
    synthesis: (request) => {
      assert.equal(request.artifactPaths.length, 3);
      assert.ok(request.artifactPaths.every((artifactPath) => artifactPath.startsWith(".okf-wiki/runs/")));
      assert.ok(request.artifactPaths.every((artifactPath) => request.prompt.includes(artifactPath)));
      assert.doesNotMatch(request.prompt, /CJK evidence: 中文/);
      assert.doesNotMatch(request.prompt, /\\n## Findings/);
      return finalize();
    },
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  assert.ok(snapshot.nodes.filter((node) => node.kind === "research").every((node) => node.handoff?.kind === "research" && node.result?.artifact));
});

test("research handoffs fail at the generic one MiB artifact limit", async () => {
  const executor = createExecutor({ research: () => "中".repeat(Math.ceil((1024 * 1024 + 1) / 3)) });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "failed");
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 0);
  assert.match(snapshot.nodes.find((node) => node.kind === "research")?.error?.message ?? "", /1048576-byte limit/);
});

test("tampered research artifacts fail integrity verification before synthesis dispatch", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-tampered-artifact-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const store = createWikiArtifactStore({ workspace });
  const tamperingStore = {
    ...store,
    async write(input) {
      const ref = await store.write(input);
      if (input.kind === "research") await writeFile(path.join(workspace, ref.relativePath), "tampered\n", "utf8");
      return ref;
    },
  };
  const executor = createExecutor();
  const engine = createEngine(executor, async () => ({ ...inspection, root: workspace, wikiRoot: path.join(workspace, "wiki") }), async () => validation, tamperingStore);
  engine.start({ cwd: workspace, mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "failed");
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 0);
  assert.match(snapshot.nodes.find((node) => node.kind === "synthesis")?.error?.message ?? "", /integrity check failed/);
});

test("a default artifact store is recreated when the engine starts a different workspace", async (t) => {
  const firstWorkspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-engine-first-"));
  const secondWorkspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-engine-second-"));
  t.after(async () => await Promise.all([firstWorkspace, secondWorkspace].map(async (workspace) => await rm(workspace, { recursive: true, force: true }))));
  let id = 0;
  const executor = createExecutor();
  const engine = new WikiWorkflowEngine({
    executor,
    inspect: async (cwd) => ({ ...inspection, root: cwd, wikiRoot: path.join(cwd, "wiki") }),
    validate: async () => validation,
    createId: () => `id-${++id}`,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });

  engine.start({ cwd: firstWorkspace, mode: "generate" });
  assert.equal((await engine.waitForIdle())?.status, "succeeded");
  engine.start({ cwd: secondWorkspace, mode: "generate" });
  assert.equal((await engine.waitForIdle())?.status, "succeeded");
  assert.equal(await readFile(path.join(secondWorkspace, ".gitignore"), "utf8"), ".okf-wiki/\n");
});

test("a domain writer receives only its DomainPacket, selected receipt, and exact write paths", async () => {
  const executor = createExecutor();
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  await engine.waitForIdle();

  const coreWriter = executor.requests.find((request) => request.node.kind === "write" && request.node.input.domainId === "core");
  const apiWriter = executor.requests.find((request) => request.node.kind === "write" && request.node.input.domainId === "api");
  assert.deepEqual(coreWriter.writePaths, ["wiki/core/architecture.md"]);
  assert.deepEqual(apiWriter.writePaths, ["wiki/api/request-flow.md"]);
  assert.ok(coreWriter.artifactPaths.every((artifactPath) => artifactPath.startsWith(".okf-wiki/runs/")));
  assert.equal(coreWriter.artifactPaths.filter((artifactPath) => artifactPath.endsWith("/research.md")).length, 1);
  assert.doesNotMatch(coreWriter.prompt, /source-survey:src-core is verified/);
  assert.doesNotMatch(coreWriter.prompt, /source-survey:src-api is verified/);
  assert.match(coreWriter.prompt, /Domain Packet/);
  assert.doesNotMatch(coreWriter.prompt, /wiki\/index\.md/);
  const overviewWriter = executor.requests.find((request) => request.node.kind === "write" && request.node.input.domainId === "overview");
  assert.deepEqual(overviewWriter.writePaths, ["wiki/overview/overview.md"]);
  assert.equal(overviewWriter.artifactPaths.filter((artifactPath) => artifactPath.endsWith("/research.md")).length, 0);
});

test("writers and repairs receive artifact paths instead of raw Markdown receipts", async () => {
  const rawReceipt = `\r\n${[
    "## Findings",
    "- CJK evidence: 中文. Source: `src/core.ts#L1-L20`",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[\\\"quoted\\\"] --> B[backtick: `value`]",
    "```",
    "",
    "## Gaps",
    "- Preserve literal CRLF and `\\` characters.",
  ].join("\r\n")}\r\n`;
  const executor = createExecutor({
    research: () => rawReceipt,
    review: (_request, index) => index === 0
      ? {
        defects: [{ id: "core-detail", domainId: "core", page: "core/architecture.md", kind: "depth", detail: "Explain the verified boundary." }],
        summary: "Core needs one repair.",
      }
      : { defects: [], summary: "complete" },
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  for (const kind of ["write", "repair"]) {
    const request = executor.requests.find((candidate) => candidate.node.kind === kind && candidate.node.input.domainId === "core");
    assert.ok(request.artifactPaths.every((artifactPath) => artifactPath.startsWith(".okf-wiki/runs/")));
    assert.equal(request.artifactPaths.filter((artifactPath) => artifactPath.endsWith("/research.md")).length, 1);
    assert.ok(request.artifactPaths.every((artifactPath) => request.prompt.includes(artifactPath)));
    assert.doesNotMatch(request.prompt, /CJK evidence: 中文/);
    assert.doesNotMatch(request.prompt, /```mermaid/);
  }
  assert.ok(snapshot.nodes.filter((node) => node.kind === "write" || node.kind === "repair").every((node) => node.handoff?.kind === "write_report"));
});

test("synthesis may expand source research once before finalizing the WikiSpec", async () => {
  const executor = createExecutor({
    synthesis: (_request, index) => index === 0
      ? { decision: "expand", researchScopes: [{ id: "storage", sourcePaths: ["src-core"], task: "Research persistence boundaries" }], rationale: "Persistence evidence is missing." }
      : finalize(finalizedSpec({ coreScopes: ["source-survey:src-core", "storage"] })),
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 2);
  assert.equal(executor.calls.filter((kind) => kind === "research").length, 4);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "research" && node.input.batch === 1).length, 1);
});

test("phase retry after supplemental research reruns only the latest synthesis iteration", async () => {
  const executor = createExecutor({
    synthesis: (_request, index) => index === 0
      ? { decision: "expand", researchScopes: [{ id: "storage", sourcePaths: ["src-core"], task: "Research persistence boundaries" }], rationale: "Persistence evidence is missing." }
      : finalize(finalizedSpec({ coreScopes: ["source-survey:src-core", "storage"] })),
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const completed = await engine.waitForIdle();
  const synthesisIds = completed.nodes.filter((node) => node.phaseId === "synthesis").map((node) => node.id);
  assert.equal(synthesisIds.length, 2);

  await engine.retryPhase("synthesis");
  const retried = await engine.waitForIdle();
  const attempts = synthesisIds.map((id) => retried.nodes.find((node) => node.id === id)?.attempt);
  assert.deepEqual(attempts, [1, 2]);
});

test("a second supplemental research request in the same run fails closed", async () => {
  const executor = createExecutor({
    synthesis: () => ({ decision: "expand", researchScopes: [{ id: "extra", sourcePaths: ["src-core"], task: "Research another gap" }], rationale: "More research." }),
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "failed");
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 2);
  assert.equal(executor.calls.filter((kind) => kind === "research").length, 4);
  assert.match(snapshot.nodes.filter((node) => node.kind === "synthesis").at(-1).error.message, /at most 1 supplemental/);
});

test("final WikiSpec rejects pages outside their domain directory and unknown research receipts", async () => {
  const wrongPath = finalizedSpec();
  wrongPath.domains.find((domain) => domain.id === "core").pages[0].path = "architecture.md";
  const malformed = createEngine(createExecutor({ synthesis: () => finalize(wrongPath) }));
  malformed.start({ cwd: "/workspace", mode: "generate" });
  await malformed.waitForIdle();
  assert.equal(malformed.getSnapshot().status, "failed");

  const indexPage = finalizedSpec();
  indexPage.domains.find((domain) => domain.id === "core").pages[0].path = "core/index.md";
  const rejectedIndex = createEngine(createExecutor({ synthesis: () => finalize(indexPage) }));
  rejectedIndex.start({ cwd: "/workspace", mode: "generate" });
  await rejectedIndex.waitForIdle();
  assert.equal(rejectedIndex.getSnapshot().status, "failed");

  const overviewReceipt = finalizedSpec();
  overviewReceipt.domains.find((domain) => domain.id === "overview").researchScopeIds = ["core"];
  const rejectedOverviewReceipt = createEngine(createExecutor({ synthesis: () => finalize(overviewReceipt) }));
  rejectedOverviewReceipt.start({ cwd: "/workspace", mode: "generate" });
  await rejectedOverviewReceipt.waitForIdle();
  assert.equal(rejectedOverviewReceipt.getSnapshot().status, "failed");

  const wrongReceipt = finalizedSpec({ coreScopes: ["missing"] });
  const unknownReceipt = createEngine(createExecutor({ synthesis: () => finalize(wrongReceipt) }));
  unknownReceipt.start({ cwd: "/workspace", mode: "generate" });
  await unknownReceipt.waitForIdle();
  assert.equal(unknownReceipt.getSnapshot().status, "failed");
  assert.match(unknownReceipt.getSnapshot().nodes.find((node) => node.kind === "synthesis").error.message, /unknown research scope/);
});

test("a restored malformed final synthesis result is not treated as a usable WikiSpec", async () => {
  const artifactRoot = path.join(os.tmpdir(), `okf-wiki-restored-malformed-spec-${process.pid}-${++artifactStoreId}`);
  artifactRoots.push(artifactRoot);
  const artifactStore = createWikiArtifactStore({ workspace: "/workspace", rootDir: artifactRoot });
  const completed = createEngine(createExecutor(), undefined, undefined, artifactStore);
  completed.start({ cwd: "/workspace", mode: "generate" });
  await completed.waitForIdle();
  const serialized = completed.serialize();
  const synthesis = serialized.snapshot.nodes.find((node) => node.kind === "synthesis");
  delete synthesis.result.spec.sharedTerms;
  const writer = serialized.snapshot.nodes.find((node) => node.kind === "write");

  const restored = createEngine(createExecutor(), undefined, undefined, artifactStore);
  assert.ok(restored.restore(serialized));
  await restored.retryNode(writer.id);
  const snapshot = await restored.waitForIdle();

  assert.equal(snapshot.status, "failed");
  assert.match(snapshot.nodes.find((node) => node.id === writer.id).error.message, /No finalized WikiSpec exists/);
});

test("engine supplies run-scoped control validation before synthesis and review submission", async () => {
  let synthesisValidated = false;
  let reviewValidated = false;
  const executor = createExecutor({
    synthesis: (request) => {
      assert.throws(
        () => request.validateControlSubmission({
          decision: "expand",
          researchScopes: [{ id: "source-survey:src-core", sourcePaths: ["src-core"], task: "Duplicate an existing survey." }],
          rationale: "This should be rejected before submission.",
        }),
        /Supplemental research scope repeats existing scope: source-survey:src-core/,
      );
      assert.throws(
        () => request.validateControlSubmission({
          decision: "expand",
          researchScopes: [{ id: "undeclared", sourcePaths: ["not-a-source"], task: "Inspect an undeclared source." }],
          rationale: "This should be rejected before submission.",
        }),
        /Supplemental research scope undeclared targets undeclared source: not-a-source/,
      );
      const unavailableReceipt = finalizedSpec({ coreScopes: ["not-in-this-synthesis"] });
      assert.throws(
        () => request.validateControlSubmission(finalize(unavailableReceipt)),
        /WikiSpec domain core references unknown research scope: not-in-this-synthesis/,
      );
      const result = finalize();
      request.validateControlSubmission(result);
      synthesisValidated = true;
      return result;
    },
    review: (request) => {
      const invalidTarget = {
        defects: [{ id: "wrong-page", domainId: "core", page: "core/missing.md", kind: "coverage", detail: "Add the missing page." }],
        summary: "The target needs correction.",
      };
      assert.throws(
        () => request.validateControlSubmission(invalidTarget),
        /Review defect wrong-page page core\/missing\.md does not belong to domain core/,
      );
      const result = { defects: [], summary: "complete" };
      request.validateControlSubmission(result);
      reviewValidated = true;
      return result;
    },
  });
  const engine = createEngine(executor);

  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  assert.equal(synthesisValidated, true);
  assert.equal(reviewValidated, true);
});

test("global review routes depth and diagram defects only to their target domain writer", async () => {
  const executor = createExecutor({
    review: (_request, index) => index === 0
      ? {
        defects: [
          { id: "depth-api", domainId: "api", page: "api/request-flow.md", kind: "depth", detail: "Explain the retry branch." },
          { id: "diagram-api", domainId: "api", page: "api/request-flow.md", kind: "diagram", detail: "Add the timeout interaction." },
        ],
        summary: "API page needs depth and diagram repairs.",
      }
      : { defects: [], summary: "complete" },
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  const repairs = executor.requests.filter((request) => request.node.kind === "repair");
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].node.input.domainId, "api");
  assert.deepEqual(repairs[0].writePaths, ["wiki/api/request-flow.md"]);
  assert.equal(executor.calls.filter((kind) => kind === "write").length, 3);
  assert.equal(executor.calls.filter((kind) => kind === "review").length, 2);
});

test("review defects must name a declared domain page", async () => {
  const executor = createExecutor({
    review: () => ({
      defects: [{ id: "bad", domainId: "core", page: "api/request-flow.md", kind: "link", detail: "Bad target." }],
      summary: "bad reviewer target",
    }),
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();
  assert.equal(snapshot.status, "failed");
  assert.match(snapshot.nodes.find((node) => node.kind === "review").error.message, /does not belong to domain/);
});

test("one global structural re-synthesis is allowed, then the run blocks", async () => {
  let reviews = 0;
  const executor = createExecutor({
    review: () => ({
      defects: [{
        id: `coverage-${reviews}`,
        domainId: "core",
        page: "core/architecture.md",
        kind: "coverage",
        detail: `Missing lifecycle segment ${reviews++}.`,
      }],
      summary: "coverage incomplete",
    }),
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "blocked");
  assert.equal(snapshot.nodes.filter((node) => node.phaseId === "structural-resynthesis").length, 1);
  assert.match(snapshot.blockedReason, /1-resynthesis budget/);
});

test("a single structural re-synthesis can converge with a fresh final spec", async () => {
  const executor = createExecutor({
    review: (_request, index) => index === 0
      ? {
        defects: [{ id: "coverage", domainId: "core", page: "core/architecture.md", kind: "topology", detail: "Split the lifecycle boundary." }],
        summary: "structural re-synthesis needed",
      }
      : { defects: [], summary: "complete" },
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.nodes.filter((node) => node.phaseId === "structural-resynthesis").length, 1);
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 2);
});

test("structural synthesis retains the prior WikiSpec and review trigger after supplemental research", async () => {
  const executor = createExecutor({
    synthesis: (request, index) => {
      if (index === 0) return finalize();
      if (index === 1) {
        assert.match(request.prompt, /Prior Final WikiSpec/);
        assert.match(request.prompt, /core\/architecture\.md/);
        assert.match(request.prompt, /Structural Validation And Review Trigger/);
        assert.match(request.prompt, /"ok": true/);
        assert.match(request.prompt, /coverage/);
        return {
          decision: "expand",
          researchScopes: [{ id: "lifecycle", sourcePaths: ["src-core"], task: "Verify the lifecycle boundary." }],
          rationale: "The structural defect needs one source-backed lifecycle check.",
        };
      }
      assert.match(request.prompt, /Prior Final WikiSpec/);
      assert.match(request.prompt, /core\/architecture\.md/);
      assert.match(request.prompt, /coverage/);
      return finalize(finalizedSpec({ coreScopes: ["source-survey:src-core", "lifecycle"] }));
    },
    review: (_request, index) => index === 0
      ? {
        defects: [{ id: "coverage", domainId: "core", page: "core/architecture.md", kind: "coverage", detail: "Missing lifecycle coverage." }],
        summary: "Structural coverage is incomplete.",
      }
      : { defects: [], summary: "complete" },
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 3);
  const structuralIds = snapshot.nodes.filter((node) => node.phaseId === "structural-resynthesis").map((node) => node.id);
  assert.equal(structuralIds.length, 2);

  await engine.retryPhase("structural-resynthesis");
  const retried = await engine.waitForIdle();
  const attempts = structuralIds.map((id) => retried.nodes.find((node) => node.id === id)?.attempt);
  assert.deepEqual(attempts, [1, 2]);
});

test("all dynamic branch nodes remain visible in the declared navigator stages", async () => {
  const executor = createExecutor({
    synthesis: (_request, index) => {
      if (index === 0) {
        return {
          decision: "expand",
          researchScopes: [{ id: "storage", sourcePaths: ["src-core"], task: "Research persistence boundaries" }],
          rationale: "Persistence evidence is needed before the Wiki contract can be finalized.",
        };
      }
      return finalize(finalizedSpec({ coreScopes: ["source-survey:src-core", "storage"] }));
    },
    review: (_request, index) => {
      if (index === 0) {
        return {
          defects: [{ id: "depth", domainId: "api", page: "api/request-flow.md", kind: "depth", detail: "Explain retry handling." }],
          summary: "Targeted domain repair is required.",
        };
      }
      if (index === 1) {
        return {
          defects: [{ id: "coverage", domainId: "core", page: "core/architecture.md", kind: "coverage", detail: "Restructure lifecycle coverage." }],
          summary: "A structural re-synthesis is required.",
        };
      }
      return { defects: [], summary: "complete" };
    },
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  const phases = phaseRows(snapshot);
  const represented = new Set(phases.flatMap((phase) => phase.nodeIds));
  assert.deepEqual(new Set(phases.map((phase) => phase.id)), new Set([
    "inspect", "source-survey", "synthesis", "targeted-research", "domain-writing",
    "validation", "global-review", "domain-repair", "structural-resynthesis",
  ]));
  for (const node of snapshot.nodes) assert.ok(represented.has(node.id), `${node.id} is missing from the navigator`);
  for (const phaseId of ["targeted-research", "domain-repair", "structural-resynthesis"]) {
    assert.ok(phases.find((phase) => phase.id === phaseId)?.nodeIds.length, `${phaseId} should have a runtime node`);
  }
});
