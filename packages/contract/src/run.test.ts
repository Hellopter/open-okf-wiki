import assert from "node:assert/strict";
import test from "node:test";
import { AnalysisReceiptSchema } from "./receipt.js";
import {
  assertSpecWithinFanOutCaps,
  ExecutionPlanSchema,
  MergedDefectReportSchema,
  SpecFanOutCapError,
  WikiRunSpecSchema,
} from "./run.js";

test("ExecutionPlan requires v4 with an explicit adaptation decision", () => {
  const plan = {
    version: 4,
    workUnits: [],
    reviewLenses: [],
    fanOut: { domainCount: 0, leafCount: 0, maxDomainFanOut: 1, maxLeafFanOut: 1 },
    adaptation: { required: false, maxRounds: 0 },
  };
  assert.equal(ExecutionPlanSchema.safeParse(plan).success, true);
  assert.equal(ExecutionPlanSchema.safeParse({ ...plan, version: 3 }).success, false);
  assert.equal(
    ExecutionPlanSchema.safeParse({ ...plan, adaptation: { maxRounds: 2 } }).success,
    false,
  );
  const { version: _version, ...withoutVersion } = plan;
  assert.equal(ExecutionPlanSchema.safeParse(withoutVersion).success, false);
});

test("ExecutionPlanWorkUnit accepts optional coverage bindings", () => {
  const plan = {
    version: 4,
    workUnits: [
      {
        id: "wu-1",
        domainId: "core",
        questions: ["What is the API surface?"],
        scope: "backend API modules",
        sourceIds: ["backend"],
        coverageUnitIds: ["backend", "backend::src/api"],
        surfaceIds: ["backend::src/api"],
      },
    ],
    reviewLenses: ["grounding"],
    fanOut: { domainCount: 1, leafCount: 1, maxDomainFanOut: 4, maxLeafFanOut: 6 },
    adaptation: { required: false, maxRounds: 0 },
  };
  assert.equal(ExecutionPlanSchema.safeParse(plan).success, true);
});

test("assertSpecWithinFanOutCaps rejects over domain and leaf caps", () => {
  assert.throws(
    () =>
      assertSpecWithinFanOutCaps(
        {
          domains: Array.from({ length: 3 }, (_, i) => ({
            id: `d${i}`,
            title: `D${i}`,
            scope: "s",
            critical: true,
            questions: ["q"],
          })),
        },
        { maxDomainFanOut: 2 },
      ),
    SpecFanOutCapError,
  );
  assert.throws(
    () =>
      assertSpecWithinFanOutCaps(
        {
          domains: [
            {
              id: "core",
              title: "Core",
              scope: "s",
              critical: true,
              questions: ["a", "b", "c"],
            },
          ],
        },
        { maxLeafFanOut: 2 },
      ),
    /maxLeafFanOut is 2/,
  );
  assert.doesNotThrow(() =>
    assertSpecWithinFanOutCaps(
      {
        domains: [
          {
            id: "core",
            title: "Core",
            scope: "s",
            critical: true,
            questions: ["a", "b"],
          },
        ],
      },
      { maxDomainFanOut: 4, maxLeafFanOut: 2 },
    ),
  );
});

test("WikiRunSpec bidirectional domain↔page (ok / orphan / empty / unknown)", () => {
  const good = {
    summary: "s",
    domains: [{ id: "core", title: "Core", scope: "x" }],
    pages: [{ path: "a.md", purpose: "p", domainIds: ["core"] }],
  };
  assert.equal(WikiRunSpecSchema.safeParse(good).success, true);

  // Empty domains: pages may omit domainIds (default []).
  assert.equal(
    WikiRunSpecSchema.safeParse({
      summary: "s",
      domains: [],
      pages: [{ path: "a.md", purpose: "p" }],
    }).success,
    true,
  );

  // Unknown domainId on a page.
  assert.equal(
    WikiRunSpecSchema.safeParse({
      summary: "s",
      domains: [{ id: "core", title: "Core", scope: "x" }],
      pages: [{ path: "a.md", purpose: "p", domainIds: ["missing"] }],
    }).success,
    false,
  );

  // Orphan domain: defined but never referenced by any page.
  assert.equal(
    WikiRunSpecSchema.safeParse({
      summary: "s",
      domains: [
        { id: "core", title: "Core", scope: "x" },
        { id: "orphan", title: "Orphan", scope: "y" },
      ],
      pages: [{ path: "a.md", purpose: "p", domainIds: ["core"] }],
    }).success,
    false,
  );

  // Non-empty domains require every page to list at least one domainId.
  assert.equal(
    WikiRunSpecSchema.safeParse({
      summary: "s",
      domains: [{ id: "core", title: "Core", scope: "x" }],
      pages: [{ path: "a.md", purpose: "p", domainIds: [] }],
    }).success,
    false,
  );
});

test("MergedDefectReport enforces clean ↔ defects.length", () => {
  assert.equal(
    MergedDefectReportSchema.safeParse({
      clean: true,
      defects: [{ severity: "blocking", code: "x", issue: "bad" }],
    }).success,
    false,
  );
  assert.equal(
    MergedDefectReportSchema.safeParse({
      clean: false,
      defects: [],
    }).success,
    false,
  );
  assert.equal(
    MergedDefectReportSchema.safeParse({
      clean: true,
      defects: [],
    }).success,
    true,
  );
  assert.equal(
    MergedDefectReportSchema.safeParse({
      clean: false,
      defects: [{ severity: "blocking", code: "x", issue: "bad", reviewerId: "r1" }],
      reviewerIds: ["r1"],
    }).success,
    true,
  );
});

test("MergedDefectReport requires defect reviewerId ∈ reviewerIds when present", () => {
  assert.equal(
    MergedDefectReportSchema.safeParse({
      clean: false,
      defects: [{ severity: "blocking", code: "x", issue: "bad", reviewerId: "r1" }],
      reviewerIds: ["r1"],
    }).success,
    true,
  );
  // reviewerId optional — omit is ok even when reviewerIds is non-empty.
  assert.equal(
    MergedDefectReportSchema.safeParse({
      clean: false,
      defects: [{ severity: "blocking", code: "x", issue: "bad" }],
      reviewerIds: ["r1"],
    }).success,
    true,
  );
  assert.equal(
    MergedDefectReportSchema.safeParse({
      clean: false,
      defects: [{ severity: "blocking", code: "x", issue: "bad", reviewerId: "unknown" }],
      reviewerIds: ["r1"],
    }).success,
    false,
  );
});

test("AnalysisReceipt evidence enforces SHA and line order", () => {
  assert.equal(
    AnalysisReceiptSchema.safeParse({
      runId: "r",
      nodeId: "n",
      parentId: null,
      attempt: 1,
      status: "complete",
      scope: "s",
      evidence: [
        {
          repositoryId: "main",
          path: "a.ts",
          startLine: 10,
          endLine: 5,
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    AnalysisReceiptSchema.safeParse({
      runId: "r",
      nodeId: "n",
      parentId: null,
      attempt: 1,
      status: "complete",
      scope: "s",
      evidence: [
        {
          repositoryId: "main",
          path: "a.ts",
          contentSha256: "not-a-sha",
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    AnalysisReceiptSchema.safeParse({
      runId: "r",
      nodeId: "n",
      parentId: null,
      attempt: 1,
      status: "complete",
      scope: "s",
      sourceRevision: "a".repeat(40),
      evidence: [
        {
          repositoryId: "main",
          path: "a.ts",
          startLine: 1,
          endLine: 2,
          contentSha256: "b".repeat(64),
        },
      ],
    }).success,
    true,
  );
});
