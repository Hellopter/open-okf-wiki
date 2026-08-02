import assert from "node:assert/strict";
import test from "node:test";
import {
  EvaluationPolicySchema,
  evaluationPolicyFromAcceptance,
  MechanicalReportSchema,
  RepairRequestSchema,
  WikiCandidateSchema,
} from "./evaluation.js";
import { WikiRunSpecAcceptanceSchema } from "./run.js";

test("EvaluationPolicySchema applies defaults on empty parse", () => {
  const policy = EvaluationPolicySchema.parse({});
  assert.equal(policy.maxCandidates, 4);
  assert.equal(policy.onExhausted, "operator");
  assert.equal(policy.mechanical.requireCitations, true);
  assert.equal(policy.mechanical.requireCriticalPages, true);
  assert.equal(policy.mechanical.modelRepairBudget, 0);
  assert.equal(policy.mechanical.autoFix.canonicalizeCitations, true);
  assert.equal(policy.mechanical.autoFix.clampCitationLines, true);
  assert.equal(policy.mechanical.autoFix.clampLineSlack, 1);
  assert.equal(policy.mechanical.autoFix.regenerateIndexes, true);
  assert.equal(policy.semantic.reviewRequired, true);
  assert.equal(policy.semantic.modelRepairBudget, 2);
  assert.equal(policy.semantic.blockingSeverities, undefined);
});

test("evaluationPolicyFromAcceptance maps budgets and review knobs", () => {
  const acceptance = WikiRunSpecAcceptanceSchema.parse({
    reviewRequired: false,
    maxRepairRounds: 5,
    maxHardValidateRepairRounds: 3,
    blockingSeverities: ["blocking", "major"],
  });

  const policy = evaluationPolicyFromAcceptance(acceptance);
  assert.equal(policy.semantic.modelRepairBudget, 5);
  assert.equal(policy.mechanical.modelRepairBudget, 3);
  assert.equal(policy.semantic.reviewRequired, false);
  assert.deepEqual(policy.semantic.blockingSeverities, ["blocking", "major"]);
  // Unmapped fields keep defaults.
  assert.equal(policy.maxCandidates, 4);
  assert.equal(policy.mechanical.requireCitations, true);
  assert.equal(policy.onExhausted, "operator");
});

test("evaluationPolicyFromAcceptance honors maxCandidates and nested overrides", () => {
  const acceptance = WikiRunSpecAcceptanceSchema.parse({
    maxRepairRounds: 1,
    maxHardValidateRepairRounds: 0,
    maxCandidates: 8,
    evaluationPolicy: {
      onExhausted: "operator",
      mechanical: {
        requireCitations: false,
        autoFix: { clampLineSlack: 2 },
      },
    },
  });

  const policy = evaluationPolicyFromAcceptance(acceptance);
  assert.equal(policy.maxCandidates, 8);
  assert.equal(policy.onExhausted, "operator");
  assert.equal(policy.semantic.modelRepairBudget, 1);
  assert.equal(policy.mechanical.modelRepairBudget, 0);
  assert.equal(policy.mechanical.requireCitations, false);
  assert.equal(policy.mechanical.autoFix.clampLineSlack, 2);
  // Un-overridden autoFix fields preserved.
  assert.equal(policy.mechanical.autoFix.canonicalizeCitations, true);
});

test("MechanicalReport round-trip preserves issues and compat errors", () => {
  const raw = {
    candidateId: "cand-1",
    ok: false,
    issues: [
      {
        code: "citation_oob",
        path: "overview.md",
        message: "line range out of bounds",
        raw: "L12: citation_oob",
        autoFixable: true,
        fixHint: "clamp_lines",
      },
      {
        code: "missing_critical_page",
        message: "architecture.md missing",
        autoFixable: false,
        fixHint: "none",
      },
    ],
    warnings: ["missing description on overview.md"],
    pageCount: 3,
    fileCount: 5,
    citationCount: 2,
    errors: ["line range out of bounds", "architecture.md missing"],
  };

  const parsed = MechanicalReportSchema.parse(raw);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.issues.length, 2);
  assert.equal(parsed.issues[0]!.code, "citation_oob");
  assert.equal(parsed.issues[0]!.fixHint, "clamp_lines");
  assert.deepEqual(parsed.errors, raw.errors);

  const again = MechanicalReportSchema.parse(JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(again, parsed);
});

test("RepairRequest round-trip with flexible issues and priorBlocking", () => {
  const raw = {
    requestId: "repair-1",
    baselineCandidateId: "cand-1",
    round: 1,
    sources: ["mechanical", "semantic"],
    issues: [
      { kind: "mechanical", code: "citation_oob", path: "overview.md" },
      { kind: "semantic", severity: "blocking", code: "unsupported", issue: "claim" },
      { kind: "operator", note: "fix nav" },
    ],
    scope: {
      pages: ["overview.md", "architecture.md"],
      mode: "patch",
    },
    priorBlocking: [
      { severity: "blocking", code: "unsupported", issue: "claim", reviewerId: "r1" },
    ],
  };

  const parsed = RepairRequestSchema.parse(raw);
  assert.equal(parsed.round, 1);
  assert.deepEqual(parsed.sources, ["mechanical", "semantic"]);
  assert.equal(parsed.issues.length, 3);
  assert.equal(parsed.issues[0]!.kind, "mechanical");
  assert.equal((parsed.issues[0] as { code?: string }).code, "citation_oob");
  assert.equal(parsed.scope.mode, "patch");
  assert.equal(parsed.priorBlocking?.length, 1);

  const again = RepairRequestSchema.parse(JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(again, parsed);
});

test("RepairRequest requires at least one source", () => {
  assert.equal(
    RepairRequestSchema.safeParse({
      requestId: "r",
      baselineCandidateId: "c",
      round: 0,
      sources: [],
      scope: { pages: [], mode: "mechanical_only" },
    }).success,
    false,
  );
});

test("WikiCandidateSchema accepts lineage fields", () => {
  const candidate = WikiCandidateSchema.parse({
    candidateId: "c1",
    digest: "abc",
    artifactId: "art-1",
    producedBy: "write",
    round: 0,
    createdAt: "2026-07-30T12:00:00.000Z",
  });
  assert.equal(candidate.producedBy, "write");
  assert.equal(candidate.parentCandidateId, undefined);

  const repaired = WikiCandidateSchema.parse({
    candidateId: "c2",
    digest: "def",
    artifactId: "art-2",
    parentCandidateId: "c1",
    producedBy: "mechanical_fix",
    round: 1,
  });
  assert.equal(repaired.parentCandidateId, "c1");
});

test("WikiRunSpecAcceptance remains backward compatible without new fields", () => {
  const acceptance = WikiRunSpecAcceptanceSchema.parse({});
  assert.equal(acceptance.reviewRequired, true);
  assert.equal(acceptance.maxRepairRounds, 2);
  assert.equal(acceptance.maxHardValidateRepairRounds, 1);
  assert.equal(acceptance.autoRepair, true);
  assert.deepEqual(acceptance.blockingSeverities, ["blocking"]);
  assert.equal(acceptance.maxCandidates, undefined);
  assert.equal(acceptance.evaluationPolicy, undefined);
});
