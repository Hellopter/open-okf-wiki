import assert from "node:assert/strict";
import test from "node:test";
import { WikiWorkflowEngine } from "../dist/engine.js";
import { phaseRows } from "../dist/ui/stages.js";

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
          diagrams: [{ kind: "flowchart", applicability: "required", purpose: "Show component boundaries", reason: null }],
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
          diagrams: [{ kind: "sequence", applicability: "required", purpose: "Show request interactions", reason: null }],
        }],
      },
    ],
    crossLinks: [{ fromPath: "core/architecture.md", toPath: "api/request-flow.md", purpose: "Connect boundaries to request flow" }],
    sharedTerms: [{ term: "request", definition: "A single API invocation." }],
  };
}

function finalize(spec = finalizedSpec()) {
  return { decision: "finalize", researchScopes: null, spec, rationale: "The receipts support a bounded final Wiki contract." };
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

function createEngine(executor, inspect = async () => inspection, validate = async () => validation) {
  let id = 0;
  return new WikiWorkflowEngine({
    executor,
    inspect,
    validate,
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
  assert.match(synthesis.prompt, /source-survey:src-core is verified/);
  assert.match(synthesis.prompt, /source-survey:src-api is verified/);
  const surveys = executor.requests.filter((request) => request.node.kind === "research");
  assert.deepEqual(surveys.find((request) => request.node.input.scope.id === "source-survey:src-core").readRoots, ["src-core"]);
  assert.deepEqual(surveys.find((request) => request.node.input.scope.id === "source-survey:src-api").readRoots, ["src-api"]);
  assert.deepEqual(surveys.find((request) => request.node.input.scope.id === "workspace-map").readRoots, ["src-core", "src-api"]);
});

test("synthesis receives raw Markdown receipts inside system-generated delimiters", async () => {
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
      assert.ok(request.prompt.includes(rawReceipt));
      assert.match(request.prompt, /<!-- wiki-research-receipt-[A-Za-z0-9_-]+-1:content-begin -->/);
      assert.match(request.prompt, /<!-- wiki-research-receipt-[A-Za-z0-9_-]+-1:content-end -->/);
      assert.doesNotMatch(request.prompt, /"markdown"\s*:/);
      assert.doesNotMatch(request.prompt, /\\n## Findings/);
      return finalize();
    },
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
});

test("synthesis aggregate receipt budget counts raw UTF-8 Markdown instead of JSON escaping", async () => {
  const newlineHeavyReceipt = `${"x\n".repeat(7_400)}x`;
  const sourcePaths = ["src-core", "src-api", "src-extra"];
  const executor = createExecutor({ research: () => newlineHeavyReceipt });
  const engine = createEngine(executor, async () => ({ ...inspection, sourcePaths }));
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 1);
});

test("synthesis permits exactly 64KiB of raw receipts and rejects one byte over", async () => {
  const receiptAtLimit = "x".repeat(16 * 1024);
  const exactExecutor = createExecutor({ research: () => receiptAtLimit });
  const exactEngine = createEngine(exactExecutor, async () => ({
    ...inspection,
    sourcePaths: ["src-core", "src-api", "src-extra"],
  }));
  exactEngine.start({ cwd: "/workspace", mode: "generate" });
  const exactSnapshot = await exactEngine.waitForIdle();

  assert.equal(exactSnapshot.status, "succeeded");
  assert.equal(exactExecutor.calls.filter((kind) => kind === "synthesis").length, 1);

  const overExecutor = createExecutor({
    research: (request) => request.node.input.scope.id === "workspace-map" ? "x" : receiptAtLimit,
  });
  const overEngine = createEngine(overExecutor, async () => ({
    ...inspection,
    sourcePaths: ["src-core", "src-api", "src-extra", "src-more"],
  }));
  overEngine.start({ cwd: "/workspace", mode: "generate" });
  const overSnapshot = await overEngine.waitForIdle();

  assert.equal(overSnapshot.status, "failed");
  assert.equal(overExecutor.calls.filter((kind) => kind === "synthesis").length, 0);
  assert.match(overSnapshot.nodes.find((node) => node.kind === "synthesis")?.error?.message ?? "", /65537/);
});

test("oversized UTF-8 research receipts fail before synthesis without truncation", async () => {
  const oversizedCjkReceipt = "中".repeat(Math.ceil((16 * 1024) / 3) + 1);
  const executor = createExecutor({ research: () => oversizedCjkReceipt });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "failed");
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 0);
  assert.match(snapshot.nodes.find((node) => node.kind === "research")?.error?.message ?? "", /Research receipt exceeds the 16384-byte budget/);
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
  assert.match(coreWriter.prompt, /source-survey:src-core is verified/);
  assert.doesNotMatch(coreWriter.prompt, /source-survey:src-api is verified/);
  assert.match(coreWriter.prompt, /Domain Packet/);
  assert.doesNotMatch(coreWriter.prompt, /wiki\/index\.md/);
  const overviewWriter = executor.requests.find((request) => request.node.kind === "write" && request.node.input.domainId === "overview");
  assert.deepEqual(overviewWriter.writePaths, ["wiki/overview/overview.md"]);
  assert.doesNotMatch(overviewWriter.prompt, /source-survey:src-core is verified/);
  assert.doesNotMatch(overviewWriter.prompt, /source-survey:src-api is verified/);
});

test("synthesis may expand source research once before finalizing the WikiSpec", async () => {
  const executor = createExecutor({
    synthesis: (_request, index) => index === 0
      ? { decision: "expand", researchScopes: [{ id: "storage", sourcePaths: ["src-core"], task: "Research persistence boundaries" }], spec: null, rationale: "Persistence evidence is missing." }
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
      ? { decision: "expand", researchScopes: [{ id: "storage", sourcePaths: ["src-core"], task: "Research persistence boundaries" }], spec: null, rationale: "Persistence evidence is missing." }
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
    synthesis: () => ({ decision: "expand", researchScopes: [{ id: "extra", sourcePaths: ["src-core"], task: "Research another gap" }], spec: null, rationale: "More research." }),
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
          spec: null,
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

test("synthesis fails before dispatch when more than four oversized source receipts exceed the aggregate budget", async () => {
  const sourcePaths = ["source-1", "source-2", "source-3", "source-4", "source-5"];
  const executor = createExecutor({ research: () => "x".repeat(16 * 1024) });
  const engine = createEngine(executor, async () => ({ ...inspection, sourcePaths }));
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "failed");
  assert.equal(executor.calls.filter((kind) => kind === "research").length, sourcePaths.length + 1);
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 0);
  assert.match(snapshot.nodes.find((node) => node.kind === "synthesis")?.error?.message ?? "", /Synthesis research receipt payload exceeds/);
});

test("all dynamic branch nodes remain visible in the declared navigator stages", async () => {
  const executor = createExecutor({
    synthesis: (_request, index) => {
      if (index === 0) {
        return {
          decision: "expand",
          researchScopes: [{ id: "storage", sourcePaths: ["src-core"], task: "Research persistence boundaries" }],
          spec: null,
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
