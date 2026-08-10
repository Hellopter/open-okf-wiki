import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CONTROL_ARTIFACT_BYTES,
  MAX_RESEARCH_ARTIFACT_BYTES,
  parseMarkdownArtifact,
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
            researchScopeIds: [],
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
            researchScopeIds: ["source-survey:api"],
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
  assert.deepEqual(result.spec.domains[1].pages[0].researchScopeIds, ["source-survey:api"]);
});

test("rejects legacy page and domain evidence contracts", () => {
  const legacyPage = finalDecision();
  legacyPage.spec.domains[1].pages[0].sources = ["api/src/core.ts#L1-L2"];
  assert.throws(() => parseSynthesisSubmission(legacyPage), /unsupported field: sources/);

  const legacyDomain = finalDecision();
  legacyDomain.spec.domains[1].researchScopeIds = ["source-survey:api"];
  assert.throws(() => parseSynthesisSubmission(legacyDomain), /unsupported field: researchScopeIds/);
});

test("requires one evidence-scoped content page in addition to Overview", () => {
  const overviewOnly = finalDecision();
  overviewOnly.spec.domains.splice(1);
  assert.throws(() => parseSynthesisSubmission(overviewOnly), /at least one content page/);

  const unscoped = finalDecision();
  unscoped.spec.domains[1].pages[0].researchScopeIds = [];
  assert.throws(() => parseSynthesisSubmission(unscoped), /must select research evidence/);
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

test("enforces separate Markdown receipt and JSON control artifact limits", () => {
  assert.equal(parseMarkdownArtifact("x".repeat(MAX_RESEARCH_ARTIFACT_BYTES)), "x".repeat(MAX_RESEARCH_ARTIFACT_BYTES));
  assert.throws(() => parseMarkdownArtifact("x".repeat(MAX_RESEARCH_ARTIFACT_BYTES + 1)), /65536-byte/);
  assert.throws(
    () => parseReviewArtifact(" ".repeat(MAX_CONTROL_ARTIFACT_BYTES + 1)),
    /262144-byte/,
  );
});
