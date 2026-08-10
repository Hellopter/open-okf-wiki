import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CONTROL_ARTIFACT_BYTES,
  MAX_RESEARCH_ARTIFACT_BYTES,
  parseResearchArtifact,
  parseResearchSubmission,
  parseReviewArtifact,
  parseReviewSubmission,
  parseSynthesisSubmission,
} from "../dist/control-submissions.js";

function finalDecision(overrides = {}) {
  return {
    decision: "finalize",
    spec: {
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
            findingIds: [],
          }],
        },
        {
          id: "core",
          title: "Core",
          purpose: "Explain the core.",
          pages: [{
            pageType: "architecture",
            path: "core/architecture.md",
            title: "Core architecture",
            purpose: "Explain boundaries.",
            findingIds: ["finding-core"],
          }],
        },
      ],
      ...overrides,
    },
    rationale: "Evidence is sufficient.",
  };
}

test("normalizes optional WikiSpec coordination arrays", () => {
  const result = parseSynthesisSubmission(finalDecision());
  assert.equal(result.decision, "finalize");
  assert.deepEqual(result.spec.crossLinks, []);
  assert.deepEqual(result.spec.sharedTerms, []);
  assert.deepEqual(result.spec.omissions, []);
  assert.deepEqual(result.spec.domains[1].pages[0].findingIds, ["finding-core"]);
});

test("rejects legacy page and domain evidence contracts", () => {
  const legacyPage = finalDecision();
  legacyPage.spec.domains[1].pages[0].sources = ["api/src/core.ts#L1-L2"];
  assert.throws(() => parseSynthesisSubmission(legacyPage), /unsupported field: sources/);

  const legacyDomain = finalDecision();
  legacyDomain.spec.domains[1].researchScopeIds = ["source-survey:api"];
  assert.throws(() => parseSynthesisSubmission(legacyDomain), /unsupported field: researchScopeIds/);

  const legacyPageScope = finalDecision();
  legacyPageScope.spec.domains[1].pages[0].researchScopeIds = ["source-survey:api"];
  assert.throws(() => parseSynthesisSubmission(legacyPageScope), /unsupported field: researchScopeIds/);
});

test("requires one evidence-scoped content page in addition to Overview", () => {
  const overviewOnly = finalDecision();
  overviewOnly.spec.domains.splice(1);
  assert.throws(() => parseSynthesisSubmission(overviewOnly), /at least one content page/);

  const unscoped = finalDecision();
  unscoped.spec.domains[1].pages[0].findingIds = [];
  assert.throws(() => parseSynthesisSubmission(unscoped), /must select research findings/);
});

test("parses explicit omissions and rejects duplicate finding selections", () => {
  const result = parseSynthesisSubmission(finalDecision({
    omissions: [{ findingId: "finding-secondary", rationale: "Covered by an external guide." }],
  }));
  assert.deepEqual(result.spec.omissions, [
    { findingId: "finding-secondary", rationale: "Covered by an external guide." },
  ]);

  const repeated = finalDecision();
  repeated.spec.domains[1].pages[0].findingIds.push("finding-core");
  assert.throws(() => parseSynthesisSubmission(repeated), /repeats finding/);
});

test("rejects page paths that can inject Markdown or control characters", () => {
  for (const unsafePath of [
    "core/a](javascript:alert(1)).md",
    "core/page\n- [injected](javascript:alert(1)).md",
  ]) {
    const submission = finalDecision();
    submission.spec.domains[1].pages[0].path = unsafePath;
    assert.throws(() => parseSynthesisSubmission(submission), /WikiSpec page path.*is invalid/);
  }
});

test("parses local and structural review defects as a discriminated union", () => {
  const result = parseReviewSubmission({
    defects: [
      { kind: "depth", page: "core/architecture.md", detail: "Explain retry behavior." },
      { kind: "coverage", detail: "Add the missing lifecycle topic." },
    ],
    summary: "Changes required.",
  });
  assert.deepEqual(result.defects, [
    { kind: "depth", page: "core/architecture.md", detail: "Explain retry behavior." },
    { kind: "coverage", detail: "Add the missing lifecycle topic." },
  ]);

  assert.throws(() => parseReviewSubmission({
    defects: [{ id: "old", domainId: "core", kind: "depth", page: "core/architecture.md", detail: "Old shape." }],
    summary: "Invalid.",
  }), /unsupported field/);
  assert.throws(() => parseReviewSubmission({
    defects: [{ kind: "coverage", page: "core/architecture.md", detail: "Wrong routing." }],
    summary: "Invalid.",
  }), /unsupported field: page/);
  assert.throws(() => parseReviewSubmission({
    defects: [{ kind: "format", page: "core/architecture.md", detail: "Removed kind." }],
    summary: "Invalid.",
  }), /invalid defect/);
});

test("parses structured research JSON and enforces the 256 KiB artifact limit", () => {
  const artifact = {
    summary: "Core behavior is source-grounded.",
    findings: [{
      kind: "flow",
      title: "Request flow",
      readerQuestion: "How does a request traverse the system?",
      priority: "critical",
      evidence: ["api/src/index.ts#L1-L8", "web/src/client.ts#L4-L12"],
    }],
    gaps: [{ question: "What happens on timeout?", priority: "normal", sourcePaths: ["api"] }],
  };
  assert.deepEqual(parseResearchArtifact(JSON.stringify(artifact)), artifact);
  assert.deepEqual(parseResearchSubmission(artifact), artifact);
  assert.throws(() => parseResearchArtifact("# Markdown receipt\n"), /valid JSON/);
  assert.throws(
    () => parseResearchArtifact(JSON.stringify({ ...artifact, summary: "x".repeat(MAX_RESEARCH_ARTIFACT_BYTES) })),
    /262144-byte/,
  );
  assert.throws(
    () => parseResearchSubmission({ ...artifact, findings: [{ ...artifact.findings[0], evidence: ["missing-range.ts"] }] }),
    /Research finding evidence is invalid/,
  );
  assert.throws(
    () => parseReviewArtifact(" ".repeat(MAX_CONTROL_ARTIFACT_BYTES + 1)),
    /262144-byte/,
  );
});
