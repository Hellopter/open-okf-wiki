import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  findingContentFingerprint,
  researchFindings,
} from "../dist/research-receipt.js";
import {
  afterSuccess,
  deterministicGroupId,
  ensureSynthesisSubmissionFitsRun,
  maybeCompleteVerification,
  previousReviewSignature,
  previousValidationSignature,
  queueInitialSourceSurveys,
  queuePageWriters,
  queueResearch,
  queueVerification,
  researchGroupIdFor,
  researchIdsHaveUnresolvedCriticalGaps,
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
    version: 10,
    id: "run-test",
    cwd: "/tmp/wiki-test",
    requestedMode: "generate",
    effectiveMode: "generate",
    language: "en",
    status: "running",
    round: 0,
    sourceRestartCount: 0,
    maxResearchRounds: DEFAULT_WIKI_WORKFLOW_POLICY.research.maxResearchRounds,
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
  return {
    requireRun: () => run,
    nodeById: (id) => run.nodes.find((node) => node.id === id),
    now: () => "2026-08-08T00:00:00.000Z",
    newId: () => `rand-${++idSeq}`,
    emit() {},
    markTerminalRun() {},
    async materializeIndexes() {},
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
    criticalGapSignatures: [],
    criticalGapQuestions: [],
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
      dryAuditPasses: 0,
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
      supplementalBatch: 0,
      mode: "initial",
      dryAuditPasses: 0,
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

function verifyNode(kind, id, synthesisNodeId, result, status = "succeeded") {
  return {
    id,
    kind,
    status,
    input: { synthesisNodeId, sourceNodeIds: [], verificationGroupId: "verify:g" },
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

  // Content fingerprint stays scope-agnostic for dry-audit matching.
  assert.equal(
    findingContentFingerprint(left[0]),
    findingContentFingerprint(right[0]),
  );
  // Path-normalized fingerprint: strip #L anchors; include kind + title.
  assert.equal(
    findingContentFingerprint(left[0]),
    createHash("sha256").update(stableStringify({
      kind: "domain",
      title: (left[0].title ?? "").trim().replace(/\s+/g, " ").toLowerCase(),
      paths: ["src-core/index.ts"],
    })).digest("hex").slice(0, 16),
  );
  // Line-number jitter must not change the fingerprint.
  assert.equal(
    findingContentFingerprint(left[0]),
    findingContentFingerprint({ ...left[0], evidence: ["src-core/index.ts#L99-L120"] }),
  );
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

test("expand is rejected when research receipts have no unresolved critical gaps", () => {
  const research = researchNode("research-1", receipt({ criticalGapSignatures: [] }));
  const host = hostWithNodes([research]);
  const input = {
    researchIds: ["research-1"],
    supplementalBatch: 0,
    mode: "initial",
    dryAuditPasses: 0,
    round: 1,
  };
  assert.equal(researchIdsHaveUnresolvedCriticalGaps(host, ["research-1"]), false);
  assert.throws(
    () => ensureSynthesisSubmissionFitsRun(host, {
      decision: "expand",
      researchScopes: [{
        id: "follow-up-flow",
        sourcePaths: ["src-core"],
        task: "Check flow",
      }],
      rationale: "Want more research",
    }, input),
    /Expand is rejected when research receipts report no unresolved critical gaps/,
  );
});

test("expand is allowed when a research receipt still has critical gap signatures", () => {
  const research = researchNode("research-1", receipt({
    criticalGapSignatures: ["gap-sig-1"],
    criticalGapQuestions: ["How do services hand off requests?"],
  }));
  const host = hostWithNodes([research], {
    inspection: {
      root: "/tmp/wiki-test",
      mode: "generate",
      sourceFingerprint: "fp",
      sourcePaths: ["src-core"],
      existingPages: [],
      impactedPages: [],
      changedPaths: [],
      changed: false,
    },
  });
  const input = {
    researchIds: ["research-1"],
    supplementalBatch: 0,
    mode: "initial",
    dryAuditPasses: 0,
    round: 1,
  };
  assert.equal(researchIdsHaveUnresolvedCriticalGaps(host, ["research-1"]), true);
  assert.doesNotThrow(() => ensureSynthesisSubmissionFitsRun(host, {
    decision: "expand",
    researchScopes: [{
      id: "follow-up-flow",
      sourcePaths: ["src-core"],
      task: "How do services hand off requests?",
    }],
    rationale: "Critical gap remains",
  }, input));
});

test("expand is rejected when scopes do not reference critical gap questions", () => {
  const research = researchNode("research-1", receipt({
    criticalGapSignatures: ["gap-sig-1"],
    criticalGapQuestions: ["How do services hand off requests?"],
  }));
  const host = hostWithNodes([research], {
    inspection: {
      root: "/tmp/wiki-test",
      mode: "generate",
      sourceFingerprint: "fp",
      sourcePaths: ["src-core"],
      existingPages: [],
      impactedPages: [],
      changedPaths: [],
      changed: false,
    },
  });
  const input = {
    researchIds: ["research-1"],
    supplementalBatch: 0,
    mode: "initial",
    dryAuditPasses: 0,
    round: 1,
  };
  assert.throws(
    () => ensureSynthesisSubmissionFitsRun(host, {
      decision: "expand",
      researchScopes: [{
        id: "unrelated-scope",
        sourcePaths: ["src-core"],
        task: "Survey unrelated modules only",
      }],
      rationale: "Unrelated expand",
    }, input),
    /must reference an unresolved critical gap/,
  );
});

test("finalize without critical gaps skips coverage audit and queues writers", async () => {
  const research = researchNode("research-1", receipt({ criticalGapSignatures: [] }));
  const synthesis = synthesisNode(
    "synthesis-1",
    ["research-1"],
    { decision: "finalize", spec: finalSpec(), rationale: "ready" },
    { dryAuditPasses: 0 },
  );
  const host = hostWithNodes([research, synthesis]);
  await afterSuccess(host, synthesis);
  const kinds = host.run.nodes.map((node) => node.kind);
  assert.ok(kinds.includes("write"), "should queue page writers");
  assert.equal(
    host.run.nodes.filter((node) => node.kind === "research" && node.input?.continuationMode === "audit").length,
    0,
    "must not queue coverage audit when there are no critical gaps",
  );
});

test("finalize with critical gaps and insufficient dry audits queues coverage audit", async () => {
  const research = researchNode("research-1", receipt({
    criticalGapSignatures: ["gap-a"],
    criticalGapQuestions: ["What remains unverified?"],
  }));
  // Finalize result is already on the node (submit-time would normally block),
  // but afterSuccess still gates the audit path on unresolved critical gaps.
  const synthesis = synthesisNode(
    "synthesis-1",
    ["research-1"],
    { decision: "finalize", spec: finalSpec(), rationale: "force path" },
    { dryAuditPasses: 0 },
  );
  const host = hostWithNodes([research, synthesis]);
  await afterSuccess(host, synthesis);
  const audits = host.run.nodes.filter((node) => node.kind === "research" && node.input?.continuationMode === "audit");
  assert.equal(audits.length, 1);
  assert.match(audits[0].input.scope.task, /critical-gap audit|missing critical gaps/i);
  assert.equal(host.run.nodes.filter((node) => node.kind === "write").length, 0);
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

  const otherMode = researchGroupIdFor(0, scopes, "audit");
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

test("queueInitialSourceSurveys uses a broad survey that emits targeted depth gaps", () => {
  const host = hostWithNodes([]);
  const nodes = queueInitialSourceSurveys(host, "inspect-1", host.run.inspection);
  assert.equal(nodes.length, 2);
  for (const node of nodes) {
    assert.match(node.input.scope.task, /Keep this pass broad/i);
    assert.match(node.input.scope.task, /models?[, ].*flows?[, ].*state/i);
    assert.match(node.input.scope.task, /critical gaps/i);
    assert.match(node.input.scope.task, /submit the complete typed research result directly/i);
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
      { decision: "finalize", spec: finalSpec(), rationale: "ready" },
      { mode: "initial", researchIds: ["research-1"], supplementalBatch: 0, dryAuditPasses: 0 },
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
    { decision: "finalize", spec: finalSpec(), rationale: "ready" },
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
    { decision: "finalize", spec: finalSpec(), rationale: "ready" },
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

test("maybeCompleteVerification ignores invalidated peers and completes live pair", async () => {
  const research = researchNode("research-1", receipt({
    findings: [{ id: "finding-1", priority: "critical", contentFingerprint: "x" }],
  }));
  const synthesis = synthesisNode(
    "synthesis-1",
    ["research-1"],
    { decision: "finalize", spec: finalSpec(), rationale: "ready" },
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

  const liveReview = {
    ...verifyNode("review", "review-live", "synthesis-1", cleanReview, "succeeded"),
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
  liveReview.input.verificationGroupId = groupId;

  const host = hostWithNodes([research, synthesis, deadValidate, deadReview, liveValidate, liveReview]);
  await maybeCompleteVerification(host, liveReview);

  const finalizeNodes = host.run.nodes.filter((node) => node.kind === "finalize");
  assert.equal(finalizeNodes.length, 1, "live pair should advance to finalize despite invalidated peers");
  assert.deepEqual(finalizeNodes[0].dependsOn, ["review-live"]);
  assert.equal(finalizeNodes[0].input.verificationGroupId, groupId);
});
