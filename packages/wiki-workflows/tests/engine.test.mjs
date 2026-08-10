import assert from "node:assert/strict";
import test from "node:test";
import { WikiWorkflowEngine } from "../dist/engine.js";

const inspection = {
  root: "/workspace",
  wikiRoot: "/workspace/wiki",
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

function draftPlan(scopes = [
  { id: "core", task: "Research core implementation" },
  { id: "api", task: "Research API flow" },
]) {
  return {
    candidateDomains: [
      { id: "core", title: "Core", purpose: "Explain core architecture" },
      { id: "api", title: "API", purpose: "Explain request processing" },
    ],
    researchScopes: scopes,
    rationale: "The two source areas are independently researchable.",
  };
}

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
        researchScopeIds: options.coreScopes ?? ["core"],
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
        researchScopeIds: options.apiScopes ?? ["api"],
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
      if (request.node.kind === "plan" || request.node.kind === "replan") return { result: options.plan?.(request) ?? draftPlan() };
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

test("draft plan converges through synthesis before parallel domain writers and global review", async () => {
  const executor = createExecutor();
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate", language: "zh" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  assert.equal(executor.calls.filter((kind) => kind === "plan").length, 1);
  assert.equal(executor.calls.filter((kind) => kind === "research").length, 2);
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 1);
  assert.equal(executor.calls.filter((kind) => kind === "write").length, 3);
  assert.equal(executor.calls.filter((kind) => kind === "review").length, 1);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "write").length, 3);
  assert.ok(snapshot.nodes.find((node) => node.kind === "review").dependsOn.every((id) => snapshot.nodes.find((node) => node.id === id)?.kind === "validate"));
  const synthesis = executor.requests.find((request) => request.node.kind === "synthesis");
  assert.match(synthesis.prompt, /core is verified/);
  assert.match(synthesis.prompt, /api is verified/);
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
  assert.match(coreWriter.prompt, /core is verified/);
  assert.doesNotMatch(coreWriter.prompt, /api is verified/);
  assert.match(coreWriter.prompt, /Domain Packet/);
  assert.doesNotMatch(coreWriter.prompt, /wiki\/index\.md/);
  const overviewWriter = executor.requests.find((request) => request.node.kind === "write" && request.node.input.domainId === "overview");
  assert.deepEqual(overviewWriter.writePaths, ["wiki/overview/overview.md"]);
  assert.doesNotMatch(overviewWriter.prompt, /core is verified/);
  assert.doesNotMatch(overviewWriter.prompt, /api is verified/);
});

test("synthesis may expand source research once before finalizing the WikiSpec", async () => {
  const executor = createExecutor({
    synthesis: (_request, index) => index === 0
      ? { decision: "expand", researchScopes: [{ id: "storage", task: "Research persistence boundaries" }], rationale: "Persistence evidence is missing." }
      : finalize(finalizedSpec({ coreScopes: ["core", "storage"] })),
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 2);
  assert.equal(executor.calls.filter((kind) => kind === "research").length, 3);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "research" && node.input.batch === 1).length, 1);
});

test("a second supplemental research request in the same plan round fails closed", async () => {
  const executor = createExecutor({
    synthesis: () => ({ decision: "expand", researchScopes: [{ id: "extra", task: "Research another gap" }], rationale: "More research." }),
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "failed");
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 2);
  assert.equal(executor.calls.filter((kind) => kind === "research").length, 3);
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

test("one global structural replan is allowed, then the run blocks", async () => {
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
  assert.equal(executor.calls.filter((kind) => kind === "replan").length, 1);
  assert.match(snapshot.blockedReason, /1-replan budget/);
});

test("a single structural replan can converge with a fresh final spec", async () => {
  const executor = createExecutor({
    review: (_request, index) => index === 0
      ? {
        defects: [{ id: "coverage", domainId: "core", page: "core/architecture.md", kind: "topology", detail: "Split the lifecycle boundary." }],
        summary: "replan needed",
      }
      : { defects: [], summary: "complete" },
  });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  assert.equal(executor.calls.filter((kind) => kind === "replan").length, 1);
  assert.equal(executor.calls.filter((kind) => kind === "synthesis").length, 2);
});
