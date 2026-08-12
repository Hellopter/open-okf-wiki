import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { researchFindings } from "../dist/research-receipt.js";
import {
  commitNodeSuccess,
  deterministicGroupId,
  ensureResearchRoundAvailable,
  ensureSynthesisSubmissionFitsRun,
  maybeCompleteVerification,
  previousReviewSignature,
  previousValidationSignature,
  queueInitialSourceSurveys,
  queuePageWriters,
  queueResearch,
  queueVerification,
  researchGroupIdFor,
  validateControlSubmission,
} from "../dist/transitions-queue.js";
import { defectsFingerprint, validationIssuesFingerprint } from "../dist/run-nodes.js";
import { DEFAULT_WIKI_WORKFLOW_POLICY, resolveWikiPolicy } from "../dist/policy.js";
import { EMPTY_NODE_METRICS } from "../dist/workflow-types.js";

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function draftFinding(overrides = {}) {
  return {
    kind: "domain",
    title: "Core domain",
    readerQuestion: "What is the core?",
    priority: "critical",
    evidence: ["src-core/index.ts#L1"],
    ...overrides,
  };
}

function hostWithNodes(nodes, overrides = {}) {
  const run = {
  version: 2,
    id: "run-test",
    cwd: "/tmp/wiki-test",
    requestedMode: "generate",
    effectiveMode: "generate",
    language: "en",
    status: "running",
    round: 0,
    sourceRestartCount: 0,
    maxResearchRounds: DEFAULT_WIKI_WORKFLOW_POLICY.maxResearchRounds,
    policy: resolveWikiPolicy(),
    nodes,
    events: [],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    inspection: {
      root: "/tmp/wiki-test",
      mode: "generate",
      sourceFingerprint: "fp",
      sourcePaths: ["src-core", "src-api"],
      existingPages: [],
      impactedPages: [],
      changedPaths: [],
      changed: false,
    },
    ...overrides,
  };
  let idSeq = 0;
  const emitted = [];
  return {
    requireRun: () => run,
    nodeById: (id) => run.nodes.find((node) => node.id === id),
    now: () => "2026-08-08T00:00:00.000Z",
    newId: () => `rand-${++idSeq}`,
    emit(kind, nodeId, message, data) { emitted.push({ kind, nodeId, message, data }); },
    markTerminalRun() {},
    async materializeIndexes() {},
    wikiRoot: () => "/tmp/wiki-test/wiki",
    emitted,
    run,
  };
}

function receipt(overrides = {}) {
  return {
    scopeId: "source-survey:src-core",
    task: "survey",
    sourceFingerprint: "fp",
    artifact: {
      version: 1,
      runId: "run-test",
      nodeId: "research-1",
      attempt: 1,
      kind: "research",
      relativePath: "artifacts/research.json",
      sha256: "abc",
      sizeBytes: 12,
      mediaType: "application/json",
    },
    findings: [{
      id: "finding-1",
      priority: "critical",
      contentFingerprint: "deadbeef",
    }],
    criticalGaps: [],
    ...overrides,
  };
}

function researchNode(id, result, inputOverrides = {}) {
  return {
    id,
    kind: "research",
    label: `Research ${id}`,
    phaseId: "research",
    phaseTitle: "Research",
    status: "succeeded",
    dependsOn: [],
    attempt: 1,
    inputFingerprint: "",
    input: {
      batch: 0,
      scope: { id: "source-survey:src-core", sourcePaths: ["src-core"], task: "survey" },
      researchGroupId: "research:0:group",
      priorResearchIds: [],
      continuationMode: "initial",
      ...inputOverrides,
    },
    result,
    metrics: { ...EMPTY_NODE_METRICS },
    activity: { state: "idle", updatedAt: "2026-08-08T00:00:00.000Z" },
    attemptHistory: [],
  };
}

function synthesisNode(id, researchIds, result, inputOverrides = {}) {
  return {
    id,
    kind: "synthesis",
    label: "Synthesize",
    phaseId: "plan",
    phaseTitle: "Plan",
    status: "succeeded",
    dependsOn: researchIds,
    attempt: 1,
    inputFingerprint: "",
    input: {
      researchIds,
      mode: "initial",
      round: 1,
      ...inputOverrides,
    },
    result,
    metrics: { ...EMPTY_NODE_METRICS },
    activity: { state: "idle", updatedAt: "2026-08-08T00:00:00.000Z" },
    attemptHistory: [],
  };
}

function finalSpec(findingId = "finding-1") {
  return {
    domains: [
      {
        id: "overview",
        title: "Overview",
        purpose: "Orient readers.",
        pages: [{
          pageType: "overview",
          path: "overview/overview.md",
          title: "Overview",
          purpose: "Orient readers.",
          readerQuestions: ["What are the system's main domains?"],
          requiredFacets: ["domain map"],
          findingIds: [],
        }],
      },
      {
        id: "core",
        title: "Core",
        purpose: "Explain the core.",
        pages: [{
          pageType: "domain",
          path: "core/domain.md",
          title: "Core domain",
          purpose: "Explain the core domain.",
          readerQuestions: ["How do the core models and flows fit together?"],
          requiredFacets: ["models", "flows", "state", "invariants", "boundaries"],
          findingIds: [findingId],
        }],
      },
    ],
    crossLinks: [],
    sharedTerms: [],
    omissions: [],
  };
}

function multiDomainSpec() {
  const spec = finalSpec();
  spec.domains.push({
    id: "api",
    title: "API",
    purpose: "Explain API behavior.",
    pages: [{
      pageType: "domain",
      path: "api/domain.md",
      title: "API domain",
      purpose: "Explain API behavior.",
      readerQuestions: ["How does API behavior fit together?"],
      requiredFacets: ["models", "flows", "state", "invariants", "boundaries"],
      findingIds: ["finding-1"],
    }],
  });
  return spec;
}

function verifyNode(kind, id, synthesisNodeId, result, status = "succeeded") {
  return {
    id,
    kind,
    status,
    input: kind === "review"
      ? {
        synthesisNodeId,
        sourceNodeIds: [],
        verificationGroupId: "verify:g",
        reviewScope: { kind: "global", domainReviewNodeIds: [] },
      }
      : { synthesisNodeId, sourceNodeIds: [], verificationGroupId: "verify:g" },
    result,
  };
}

test("researchFindings ids include scopeId so cross-scope kind+evidence do not collide", () => {
  const artifact = { summary: "s", findings: [draftFinding()], gaps: [] };
  const left = researchFindings("source-survey:src-a", artifact);
  const right = researchFindings("source-survey:src-b", artifact);
  assert.equal(left.length, 1);
  assert.equal(right.length, 1);
  assert.notEqual(left[0].id, right[0].id);
  assert.equal(left[0].scopeId, "source-survey:src-a");
  assert.equal(right[0].scopeId, "source-survey:src-b");

  const expectedLeft = `finding-${createHash("sha256").update(stableStringify({
    scopeId: "source-survey:src-a",
    kind: "domain",
    evidence: ["src-core/index.ts#L1"],
  })).digest("hex").slice(0, 16)}`;
  assert.equal(left[0].id, expectedLeft);

});

test("researchFindings is stable for the same scopeId + kind + sorted evidence", () => {
  const artifact = {
    summary: "s",
    findings: [draftFinding({ evidence: ["b.ts#L2", "a.ts#L1"] })],
    gaps: [],
  };
  const once = researchFindings("scope-x", artifact);
  const twice = researchFindings("scope-x", {
    summary: "s",
    findings: [draftFinding({ evidence: ["a.ts#L1", "b.ts#L2"] })],
    gaps: [],
  });
  assert.equal(once[0].id, twice[0].id);
});

test("previousReviewSignature only matches prior reviews for the same synthesisNodeId", () => {
  const defects = [{ kind: "depth", page: "core/page.md", detail: "Too shallow" }];
  const fingerprint = defectsFingerprint(defects);
  const nodes = [
    verifyNode("review", "review-old-plan", "synthesis-old", { defects, summary: "old" }),
    verifyNode("review", "review-current", "synthesis-new", { defects, summary: "new" }),
  ];
  const host = hostWithNodes(nodes);

  // Different synthesis lineage: ignore old plan defects.
  assert.equal(
    previousReviewSignature(host, "review-current", "synthesis-new"),
    undefined,
  );

  // Same synthesis lineage: surface prior fingerprint.
  const sameLineage = hostWithNodes([
    verifyNode("review", "review-prior-same", "synthesis-new", { defects, summary: "prior" }),
    verifyNode("review", "review-current", "synthesis-new", { defects, summary: "new" }),
    verifyNode("review", "review-old-plan", "synthesis-old", { defects, summary: "old" }),
  ]);
  assert.equal(
    previousReviewSignature(sameLineage, "review-current", "synthesis-new"),
    fingerprint,
  );
});

function validationResult(issues) {
  return { ok: false, issues, pages: [], obsoletePages: [] };
}

test("previousValidationSignature only matches prior validates for the same synthesisNodeId", () => {
  const issues = [{ code: "link", page: "api/flow.md", message: "Broken link" }];
  const fingerprint = validationIssuesFingerprint(issues);
  const hostCrossPlan = hostWithNodes([
    verifyNode("validate", "validate-old", "synthesis-old", validationResult(issues)),
    verifyNode("validate", "validate-current", "synthesis-new", validationResult(issues)),
  ]);
  assert.equal(
    previousValidationSignature(hostCrossPlan, "validate-current", "synthesis-new"),
    undefined,
  );

  const hostSamePlan = hostWithNodes([
    verifyNode("validate", "validate-prior", "synthesis-new", validationResult(issues)),
    verifyNode("validate", "validate-current", "synthesis-new", validationResult(issues)),
    verifyNode("validate", "validate-old", "synthesis-old", validationResult(issues)),
  ]);
  assert.equal(
    previousValidationSignature(hostSamePlan, "validate-current", "synthesis-new"),
    fingerprint,
  );
});

test("targeted research must produce critical evidence or retain a critical gap", () => {
  const gap = { id: "gap-a", question: "How do services hand off requests?", sourcePaths: ["src-core"] };
  const research = researchNode("research-1", undefined, { continuationMode: "targeted", targetGap: gap });
  const host = hostWithNodes([research]);
  assert.throws(
    () => validateControlSubmission(host, research, { summary: "empty", findings: [], gaps: [] }),
    /must produce a critical finding or retain\/refine a critical gap/,
  );
  assert.doesNotThrow(() => validateControlSubmission(host, research, {
    summary: "refined",
    findings: [],
    gaps: [{ question: "Which retry owns the handoff?", priority: "critical", sourcePaths: ["src-core"] }],
  }));
});

test("synthesis success queues writers without a coverage audit", async () => {
  const research = researchNode("research-1", receipt({ criticalGaps: [] }));
  const synthesis = synthesisNode(
    "synthesis-1",
    ["research-1"],
    { spec: finalSpec(), rationale: "ready" },
  );
  synthesis.status = "running";
  const host = hostWithNodes([research, synthesis]);
  await commitNodeSuccess(host, synthesis);
  assert.equal(synthesis.status, "succeeded");
  const kinds = host.run.nodes.map((node) => node.kind);
  assert.ok(kinds.includes("write"), "should queue page writers");
  assert.equal(host.run.nodes.filter((node) => node.kind === "research").length, 1);
});

test("researchGroupId is deterministic for the same batch, scopes, and mode", () => {
  const scopes = [
    { id: "source-survey:src-b", sourcePaths: ["src-b"], task: "b" },
    { id: "source-survey:src-a", sourcePaths: ["src-a"], task: "a" },
  ];
  const once = researchGroupIdFor(0, scopes, "initial");
  const twice = researchGroupIdFor(0, [...scopes].reverse(), "initial");
  assert.equal(once, twice);
  assert.match(once, /^research:0:[0-9a-f]{16}$/);

  const otherBatch = researchGroupIdFor(1, scopes, "initial");
  assert.notEqual(once, otherBatch);
  assert.match(otherBatch, /^research:1:[0-9a-f]{16}$/);

  const otherMode = researchGroupIdFor(0, scopes, "targeted");
  assert.notEqual(once, otherMode);
});

test("queueResearch assigns the same deterministic researchGroupId to all scopes in a batch", () => {
  const host = hostWithNodes([]);
  const scopes = [
    { id: "source-survey:src-core", sourcePaths: ["src-core"], task: "survey core" },
    { id: "source-survey:src-api", sourcePaths: ["src-api"], task: "survey api" },
  ];
  const expected = researchGroupIdFor(0, scopes, "initial");
  const nodes = queueResearch(host, "inspect-1", scopes, 0, "research", "Research");
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].input.researchGroupId, expected);
  assert.equal(nodes[1].input.researchGroupId, expected);
  // Random host.newId must not appear in the group id.
  assert.doesNotMatch(nodes[0].input.researchGroupId, /rand-/);
});

test("commitNodeSuccess publishes a research peer before evaluating fan-in", async () => {
  const first = researchNode("research-1", receipt({ scopeId: "source-survey:src-core" }));
  const second = researchNode(
    "research-2",
    receipt({ scopeId: "source-survey:src-api", artifact: { ...receipt().artifact, nodeId: "research-2" } }),
    { scope: { id: "source-survey:src-api", sourcePaths: ["src-api"], task: "survey" } },
  );
  second.status = "running";
  second.output = "live transcript";
  second.history = [{ type: "assistant", content: "live" }];
  const host = hostWithNodes([first, second]);

  await commitNodeSuccess(host, second);

  assert.equal(second.status, "succeeded");
  assert.equal(second.output, undefined);
  assert.equal(second.history, undefined);
  assert.equal(host.run.nodes.filter((node) => node.kind === "synthesis").length, 1);
  assert.deepEqual(host.emitted.filter((event) => event.kind === "node_succeeded").map((event) => event.nodeId), ["research-2"]);
});

test("an empty critical-gap frontier queues synthesis", async () => {
  const research = researchNode("research-1", receipt({ criticalGaps: [] }));
  research.status = "running";
  const host = hostWithNodes([research]);
  await commitNodeSuccess(host, research);
  assert.equal(host.run.nodes.filter((node) => node.kind === "synthesis").length, 1);
  assert.equal(host.run.nodes.filter((node) => node.kind === "research" && node.input.continuationMode === "targeted").length, 0);
});

test("thirteen critical gaps queue thirteen exact targeted scopes", async () => {
  const criticalGaps = Array.from({ length: 13 }, (_, index) => ({
    id: `gap-${String(index).padStart(2, "0")}`,
    question: `Question ${index}?`,
    sourcePaths: index % 2 === 0 ? ["src-core"] : ["src-api"],
  }));
  const research = researchNode("research-1", receipt({ criticalGaps }));
  research.status = "running";
  const host = hostWithNodes([research]);
  await commitNodeSuccess(host, research);
  const targeted = host.run.nodes.filter((node) => node.kind === "research" && node.input.continuationMode === "targeted");
  assert.equal(targeted.length, 13);
  assert.deepEqual(targeted.map((node) => node.input.targetGap), criticalGaps);
  for (const node of targeted) {
    assert.equal(node.input.scope.id, `critical-gap:${node.input.targetGap.id}:round-1`);
    assert.equal(node.input.scope.task, node.input.targetGap.question);
    assert.deepEqual(node.input.scope.sourcePaths, node.input.targetGap.sourcePaths);
  }
});

test("sibling receipts deduplicate critical gaps by stable id", async () => {
  const gap = { id: "gap-shared", question: "What remains?", sourcePaths: ["src-core"] };
  const first = researchNode("research-1", receipt({ criticalGaps: [gap] }));
  const second = researchNode("research-2", receipt({ criticalGaps: [{ ...gap, question: "Duplicate wording is ignored by identity" }] }), {
    scope: { id: "source-survey:src-api", sourcePaths: ["src-api"], task: "survey" },
  });
  second.status = "running";
  const host = hostWithNodes([first, second]);
  await commitNodeSuccess(host, second);
  const targeted = host.run.nodes.filter((node) => node.kind === "research" && node.input.continuationMode === "targeted");
  assert.equal(targeted.length, 1);
  assert.equal(targeted[0].input.targetGap.id, gap.id);
});

test("only the current targeted batch defines the next frontier", async () => {
  const historicalGap = { id: "old-gap", question: "Old question?", sourcePaths: ["src-core"] };
  const old = researchNode("research-old", receipt({ criticalGaps: [historicalGap] }));
  const current = researchNode("research-current", receipt({ findings: [{ id: "finding-current", priority: "critical" }], criticalGaps: [] }), {
    batch: 1,
    scope: { id: "critical-gap:old-gap:round-1", sourcePaths: ["src-core"], task: historicalGap.question },
    researchGroupId: "research:1:targeted",
    priorResearchIds: [old.id],
    continuationMode: "targeted",
    targetGap: historicalGap,
  });
  current.status = "running";
  const host = hostWithNodes([old, current]);
  await commitNodeSuccess(host, current);
  const synthesis = host.run.nodes.find((node) => node.kind === "synthesis");
  assert.ok(synthesis);
  assert.deepEqual(new Set(synthesis.input.researchIds), new Set([old.id, current.id]));
  assert.equal(host.run.nodes.filter((node) => node.kind === "research" && node.input.batch === 2).length, 0);
});

test("a refined critical gap becomes the next targeted frontier", async () => {
  const targetGap = { id: "gap-old", question: "How does recovery work?", sourcePaths: ["src-core"] };
  const refined = { id: "gap-refined", question: "Who owns retry state?", sourcePaths: ["src-core"] };
  const current = researchNode("research-current", receipt({ criticalGaps: [refined] }), {
    batch: 1,
    researchGroupId: "research:1:targeted",
    continuationMode: "targeted",
    targetGap,
  });
  current.status = "running";
  const host = hostWithNodes([current]);
  await commitNodeSuccess(host, current);
  const next = host.run.nodes.find((node) => node.kind === "research" && node.input.batch === 2);
  assert.deepEqual(next.input.targetGap, refined);
  assert.equal(next.input.scope.task, refined.question);
});

test("research exhaustion reports the complete current frontier", () => {
  const frontier = [
    { id: "gap-a", question: "A?", sourcePaths: ["src-core"] },
    { id: "gap-b", question: "B?", sourcePaths: ["src-api"] },
  ];
  const host = hostWithNodes([], { maxResearchRounds: 2 });
  assert.throws(
    () => ensureResearchRoundAvailable(host, 2, frontier),
    (error) => error?.code === "research_rounds_exhausted"
      && error?.details?.criticalGaps?.length === 2
      && error.details.criticalGaps[1].id === "gap-b",
  );
});

test("structural research with no gaps queues structural synthesis", async () => {
  const prior = synthesisNode("synthesis-prior", [], { spec: finalSpec(), rationale: "prior" });
  const structural = researchNode("research-structural", receipt({ criticalGaps: [] }), {
    batch: 1,
    researchGroupId: "research:1:structural",
    continuationMode: "structural",
    priorSynthesisNodeId: prior.id,
    trigger: { defects: [{ kind: "coverage", detail: "Missing lifecycle" }] },
  });
  structural.status = "running";
  const host = hostWithNodes([prior, structural]);
  await commitNodeSuccess(host, structural);
  const next = host.run.nodes.find((node) => node.kind === "synthesis" && node.id !== prior.id);
  assert.equal(next.input.mode, "structural");
  assert.equal(next.input.priorSynthesisNodeId, prior.id);
});

test("structural research gaps enter the same targeted frontier", async () => {
  const gap = { id: "structural-gap", question: "Which state is missing?", sourcePaths: ["src-core"] };
  const prior = synthesisNode("synthesis-prior", [], { spec: finalSpec(), rationale: "prior" });
  const structural = researchNode("research-structural", receipt({ criticalGaps: [gap] }), {
    batch: 1,
    researchGroupId: "research:1:structural",
    continuationMode: "structural",
    priorSynthesisNodeId: prior.id,
  });
  structural.status = "running";
  const host = hostWithNodes([prior, structural]);
  await commitNodeSuccess(host, structural);
  const targeted = host.run.nodes.find((node) => node.kind === "research" && node.input.continuationMode === "targeted");
  assert.deepEqual(targeted.input.targetGap, gap);
  assert.equal(targeted.input.priorSynthesisNodeId, prior.id);
});

test("commitNodeSuccess rolls back write success and successors when async preparation fails", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-transition-"));
  const wikiRoot = path.join(workspace, "wiki");
  await mkdir(path.join(wikiRoot, "core"), { recursive: true });
  const pageBytes = "# Core\n";
  await writeFile(path.join(wikiRoot, "core/domain.md"), pageBytes);
  const spec = finalSpec();
  const synthesis = synthesisNode("synthesis-1", ["research-1"], { spec, rationale: "ready" });
  const page = spec.domains[1].pages[0];
  const write = {
    id: "write-1", kind: "write", label: "Write core", phaseId: "write", phaseTitle: "Write",
    status: "running", dependsOn: [synthesis.id], attempt: 1, inputFingerprint: "", attemptHistory: [],
    metrics: { ...EMPTY_NODE_METRICS }, activity: { state: "running", updatedAt: "2026-08-08T00:00:00.000Z" },
    input: {
      intent: "draft", synthesisNodeId: synthesis.id, domainId: "core", page,
      researchIds: ["research-1"], writePaths: ["wiki/core/domain.md"], wikiReadPaths: [],
      writeGroupId: "write:one",
    },
    result: { page: page.path, sha256: createHash("sha256").update(pageBytes).digest("hex") },
  };
  const host = hostWithNodes([synthesis, write], { cwd: workspace });
  host.wikiRoot = () => wikiRoot;
  host.materializeIndexes = async () => { throw new Error("index preparation failed"); };

  await assert.rejects(commitNodeSuccess(host, write), /index preparation failed/);

  assert.equal(write.status, "running");
  assert.equal(host.run.nodes.filter((node) => node.kind === "validate").length, 0);
  assert.deepEqual(host.emitted, []);
  await rm(workspace, { recursive: true, force: true });
});

test("async commit preserves sibling executor writes and later fan-in sees both peers", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-transition-merge-"));
  const wikiRoot = path.join(workspace, "wiki");
  await mkdir(path.join(wikiRoot, "core"), { recursive: true });
  const firstBytes = "# First\n";
  const secondBytes = "# Second\n";
  await writeFile(path.join(wikiRoot, "core/first.md"), firstBytes);
  await writeFile(path.join(wikiRoot, "core/second.md"), secondBytes);
  const spec = finalSpec();
  spec.domains[1].pages = [
    { ...spec.domains[1].pages[0], path: "core/first.md", findingIds: [] },
    { ...spec.domains[1].pages[0], path: "core/second.md", title: "Second", findingIds: [] },
  ];
  const synthesis = synthesisNode("synthesis-1", ["research-1"], { spec, rationale: "ready" });
  const makeWrite = (id, page, bytes) => ({
    id, kind: "write", label: id, phaseId: "write", phaseTitle: "Write", status: "running",
    dependsOn: [synthesis.id], attempt: 1, inputFingerprint: "", attemptHistory: [],
    metrics: { ...EMPTY_NODE_METRICS }, activity: { state: "running", updatedAt: "2026-08-08T00:00:00.000Z" },
    input: {
      intent: "draft", synthesisNodeId: synthesis.id, domainId: "core", page,
      researchIds: [], writePaths: [`wiki/${page.path}`], wikiReadPaths: [], writeGroupId: "write:pair",
    },
    result: { page: page.path, sha256: createHash("sha256").update(bytes).digest("hex") },
  });
  const first = makeWrite("write-a", spec.domains[1].pages[0], firstBytes);
  const second = makeWrite("write-b", spec.domains[1].pages[1], secondBytes);
  const host = hostWithNodes([synthesis, first, second], { cwd: workspace });
  host.wikiRoot = () => wikiRoot;
  let releaseMaterialize;
  let materializeStarted;
  const materializeGate = new Promise((resolve) => { releaseMaterialize = resolve; });
  const materializeSignal = new Promise((resolve) => { materializeStarted = resolve; });
  host.materializeIndexes = async () => {
    materializeStarted();
    await materializeGate;
  };

  // Make A the apparent last peer in its shadow so it enters async materialize.
  second.status = "succeeded";
  const firstCommit = commitNodeSuccess(host, first);
  await materializeSignal;
  // Simulate B executor completion writes while A is awaiting preparation.
  second.status = "running";
  second.result = { page: second.input.page.path, sha256: createHash("sha256").update(secondBytes).digest("hex"), live: true };
  second.handoff = { kind: "write", relativePath: "live.json" };
  second.history = [{ type: "assistant", content: "live history" }];
  second.metrics = { ...second.metrics, inputTokens: 77 };
  second.activity = { state: "running", message: "live activity", updatedAt: "2026-08-08T00:00:02.000Z" };
  host.run.updatedAt = "2026-08-08T00:00:03.000Z";
  releaseMaterialize();
  await firstCommit;

  assert.equal(second.result.live, true);
  assert.equal(second.handoff.relativePath, "live.json");
  assert.equal(second.history[0].content, "live history");
  assert.equal(second.metrics.inputTokens, 77);
  assert.equal(second.activity.message, "live activity");
  assert.equal(host.run.updatedAt, "2026-08-08T00:00:03.000Z");

  // Remove A's speculative gate, then commit B against the latest live state.
  host.run.nodes.splice(host.run.nodes.findIndex((node) => node.kind === "validate"), 1);
  await commitNodeSuccess(host, second);
  assert.equal(second.status, "succeeded");
  assert.equal(host.run.nodes.filter((node) => node.kind === "validate").length, 1);
  await rm(workspace, { recursive: true, force: true });
});

test("queueInitialSourceSurveys uses a broad survey that emits targeted depth gaps", () => {
  const host = hostWithNodes([]);
  const nodes = queueInitialSourceSurveys(host, "inspect-1", host.run.inspection);
  assert.equal(nodes.length, 2);
  for (const node of nodes) {
    assert.match(node.input.scope.task, /Keep this pass broad/i);
    assert.match(node.input.scope.task, /models?[, ].*flows?[, ].*state/i);
    assert.match(node.input.scope.task, /critical gaps/i);
    assert.match(node.input.scope.task, /stage findings with wiki_research_put_findings/i);
    assert.match(node.input.scope.task, /submit only the final summary and gaps/i);
    assert.match(node.input.scope.task, /correct.*resubmit/i);
  }
});

test("configured domains fail closed on source typos and constrain the final WikiSpec", () => {
  const policy = resolveWikiPolicy({
    domains: [{ id: "billing", title: "Billing", include: ["src-core/**"], exclude: [] }],
  });
  const host = hostWithNodes([], { policy });
  const scopes = queueInitialSourceSurveys(host, "inspect-1", host.run.inspection);
  assert.ok(scopes.some((node) => node.input.scope.id === "domain:billing"));

  const typoHost = hostWithNodes([], {
    policy: resolveWikiPolicy({
      domains: [{ id: "billing", title: "Billing", include: ["missing/**"], exclude: [] }],
    }),
  });
  assert.throws(
    () => queueInitialSourceSurveys(typoHost, "inspect-1", typoHost.run.inspection),
    /do not match any declared source root/,
  );

  const research = researchNode("research-1", receipt({
    findings: [{ id: "finding-1", priority: "critical", contentFingerprint: "x" }],
  }));
  const synthesisHost = hostWithNodes([research], { policy });
  assert.throws(
    () => ensureSynthesisSubmissionFitsRun(
      synthesisHost,
      { spec: finalSpec(), rationale: "ready" },
      { mode: "initial", researchIds: ["research-1"], round: 1 },
    ),
    /must include configured domain: billing/,
  );
});

test("write group ids are deterministic for a synthesis lineage", () => {
  const research = researchNode("research-1", receipt({
    findings: [{ id: "finding-1", priority: "critical", contentFingerprint: "x" }],
  }));
  const synthesis = synthesisNode(
    "synthesis-1",
    ["research-1"],
    { spec: finalSpec(), rationale: "ready" },
  );
  const host = hostWithNodes([research, synthesis]);
  const first = queuePageWriters(host, "synthesis-1", finalSpec());
  const firstGroup = first[0].input.writeGroupId;
  assert.match(firstGroup, /^write:[0-9a-f]{16}$/);
  assert.doesNotMatch(firstGroup, /rand-/);

  // Same generation inputs → same id shape; second wave increments generation.
  const secondHost = hostWithNodes([...host.run.nodes]);
  const second = queuePageWriters(secondHost, "synthesis-1", finalSpec());
  assert.notEqual(second[0].input.writeGroupId, firstGroup);
  assert.equal(
    second[0].input.writeGroupId,
    deterministicGroupId("write", {
      synthesisNodeId: "synthesis-1",
      intent: "draft",
      generation: 1,
    }),
  );
});

test("queueVerification concurrent callers enqueue one validation gate and defer review", async () => {
  const research = researchNode("research-1", receipt({
    findings: [{ id: "finding-1", priority: "critical", contentFingerprint: "x" }],
  }));
  const synthesis = synthesisNode(
    "synthesis-1",
    ["research-1"],
    { spec: finalSpec(), rationale: "ready" },
  );
  const sourceNodeIds = ["write-a", "write-b"];
  let releaseMaterialize;
  const materializeGate = new Promise((resolve) => {
    releaseMaterialize = resolve;
  });
  let materializeCalls = 0;
  const host = hostWithNodes([research, synthesis]);
  host.materializeIndexes = async () => {
    materializeCalls += 1;
    // Hold both overlapping callers in the await so a TOCTOU race would
    // double-queue if reservation happened after materializeIndexes.
    await materializeGate;
  };

  const first = queueVerification(host, sourceNodeIds, "synthesis-1");
  // Yield so the first call can pass the sync check and queue nodes before
  // the second call starts (and so both can park on materializeIndexes).
  await Promise.resolve();
  const second = queueVerification(host, sourceNodeIds, "synthesis-1");
  // Both should now be awaiting materialize; release them together.
  releaseMaterialize();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(materializeCalls, 2, "both callers still materialize indexes");
  const validates = host.run.nodes.filter((node) => node.kind === "validate");
  const reviews = host.run.nodes.filter((node) => node.kind === "review");
  assert.equal(validates.length, 1, "must not double-queue validate under concurrent join");
  assert.equal(reviews.length, 0, "review starts only after validation succeeds");
  assert.equal(left.length, 1);
  assert.equal(right.length, 1);
  assert.deepEqual(
    left.map((node) => node.id).sort(),
    right.map((node) => node.id).sort(),
  );
  assert.equal(left[0].input.verificationGroupId, right[0].input.verificationGroupId);
});

test("validation fans review out by domain and global review aggregates fragments before finalizing", async () => {
  const research = researchNode("research-1", receipt({
    findings: [{ id: "finding-1", priority: "critical", contentFingerprint: "x" }],
  }));
  const synthesis = synthesisNode(
    "synthesis-1",
    ["research-1"],
    { spec: finalSpec(), rationale: "ready" },
  );
  const groupId = "verify:shared-group";
  const okValidation = { ok: true, issues: [], pages: ["overview/overview.md"], obsoletePages: [] };
  const cleanReview = { defects: [], summary: "Looks good" };

  // Dead generation first in the array so a naive find() would pin to them.
  const deadValidate = {
    ...verifyNode("validate", "validate-old", "synthesis-1", { ok: false, issues: [{ code: "x", message: "stale" }], pages: [], obsoletePages: [] }, "invalidated"),
    label: "Validate Wiki",
    phaseId: "validate",
    phaseTitle: "Validate",
    dependsOn: [],
    attempt: 1,
    inputFingerprint: "",
    metrics: { ...EMPTY_NODE_METRICS },
    activity: { state: "idle", updatedAt: "2026-08-08T00:00:00.000Z" },
    attemptHistory: [],
  };
  deadValidate.input.verificationGroupId = groupId;

  const deadReview = {
    ...verifyNode("review", "review-old", "synthesis-1", { defects: [{ kind: "depth", page: "core/architecture.md", detail: "stale" }], summary: "old" }, "invalidated"),
    label: "Review Wiki",
    phaseId: "validate",
    phaseTitle: "Validate",
    dependsOn: [],
    attempt: 1,
    inputFingerprint: "",
    metrics: { ...EMPTY_NODE_METRICS },
    activity: { state: "idle", updatedAt: "2026-08-08T00:00:00.000Z" },
    attemptHistory: [],
  };
  deadReview.input.verificationGroupId = groupId;

  const liveValidate = {
    ...verifyNode("validate", "validate-live", "synthesis-1", okValidation, "succeeded"),
    label: "Validate Wiki",
    phaseId: "validate",
    phaseTitle: "Validate",
    dependsOn: [],
    attempt: 1,
    inputFingerprint: "",
    metrics: { ...EMPTY_NODE_METRICS },
    activity: { state: "idle", updatedAt: "2026-08-08T00:00:00.000Z" },
    attemptHistory: [],
  };
  liveValidate.input.verificationGroupId = groupId;

  const host = hostWithNodes([research, synthesis, deadValidate, deadReview, liveValidate]);
  await maybeCompleteVerification(host, liveValidate);

  const reviews = host.run.nodes.filter((node) => node.kind === "review" && node.status !== "invalidated");
  assert.equal(reviews.length, 2, "one domain fragment plus one global reviewer");
  const domainReview = reviews.find((node) => node.input.reviewScope.kind === "domain");
  const globalReview = reviews.find((node) => node.input.reviewScope.kind === "global");
  assert.equal(domainReview.input.reviewScope.domainId, "core");
  assert.deepEqual(domainReview.input.reviewScope.pagePaths, ["core/domain.md"]);
  assert.deepEqual(globalReview.dependsOn, [domainReview.id]);
  assert.deepEqual(globalReview.input.reviewScope.domainReviewNodeIds, [domainReview.id]);

  domainReview.status = "succeeded";
  domainReview.result = cleanReview;
  globalReview.status = "succeeded";
  globalReview.result = cleanReview;
  await maybeCompleteVerification(host, globalReview);

  const finalizeNodes = host.run.nodes.filter((node) => node.kind === "finalize");
  assert.equal(finalizeNodes.length, 1, "global clean result advances after every fragment");
  assert.deepEqual(finalizeNodes[0].dependsOn, [globalReview.id]);
  assert.equal(finalizeNodes[0].input.verificationGroupId, groupId);
});

test("validation queues every domain reviewer in parallel and one global fan-in", async () => {
  const research = researchNode("research-1", receipt({
    findings: [{ id: "finding-1", priority: "critical", contentFingerprint: "x" }],
  }));
  const synthesis = synthesisNode("synthesis-1", ["research-1"], { spec: multiDomainSpec(), rationale: "ready" });
  const validation = {
    ...verifyNode("validate", "validate-live", "synthesis-1", { ok: true, issues: [], pages: [], obsoletePages: [] }),
    input: { synthesisNodeId: "synthesis-1", sourceNodeIds: [], verificationGroupId: "verify:multi" },
  };
  const host = hostWithNodes([research, synthesis, validation]);
  await maybeCompleteVerification(host, validation);

  const domainReviews = host.run.nodes.filter((node) => node.kind === "review" && node.input.reviewScope.kind === "domain");
  const globalReview = host.run.nodes.find((node) => node.kind === "review" && node.input.reviewScope.kind === "global");
  assert.deepEqual(domainReviews.map((node) => node.input.reviewScope.domainId).sort(), ["api", "core"]);
  assert.ok(domainReviews.every((node) => node.dependsOn[0] === validation.id));
  assert.deepEqual(globalReview.dependsOn.slice().sort(), domainReviews.map((node) => node.id).sort());
});

test("global review routes domain fragment defects into a fresh repair and full review generation", async () => {
  const research = researchNode("research-1", receipt({
    findings: [{ id: "finding-1", priority: "critical", contentFingerprint: "x" }],
  }));
  const synthesis = synthesisNode("synthesis-1", ["research-1"], { spec: finalSpec(), rationale: "ready" });
  const domainReview = {
    ...verifyNode("review", "review-domain", "synthesis-1", {
      defects: [{ kind: "depth", page: "core/domain.md", detail: "Explain invariants" }],
      summary: "Domain needs depth",
    }),
    input: {
      synthesisNodeId: "synthesis-1", sourceNodeIds: ["validate-1"], verificationGroupId: "verify:g",
      reviewScope: { kind: "domain", domainId: "core", pagePaths: ["core/domain.md"] },
    },
  };
  const globalReview = {
    ...verifyNode("review", "review-global", "synthesis-1", { defects: [], summary: "Global clean" }),
    dependsOn: [domainReview.id],
    input: {
      synthesisNodeId: "synthesis-1", sourceNodeIds: [domainReview.id], verificationGroupId: "verify:g",
      reviewScope: { kind: "global", domainReviewNodeIds: [domainReview.id] },
    },
  };
  const host = hostWithNodes([research, synthesis, domainReview, globalReview]);
  host.wikiRoot = () => "/tmp/wiki-test/wiki";
  await maybeCompleteVerification(host, globalReview);

  const repairs = host.run.nodes.filter((node) => node.kind === "write" && node.input.intent === "repair");
  assert.deepEqual(repairs.map((node) => node.input.page.path).sort(), ["core/domain.md", "overview/overview.md"]);
  assert.equal(repairs.find((node) => node.input.page.path === "core/domain.md").input.feedback.review.defects[0].detail, "Explain invariants");
  assert.equal(host.run.nodes.filter((node) => node.kind === "finalize").length, 0);
});
