import assert from "node:assert/strict";
import test from "node:test";
import { AnalysisReceiptSchema } from "./receipt.js";
import { MergedDefectReportSchema, StoredRunRecordSchema, WikiRunSpecSchema } from "./run.js";

test("Wiki Run Record ignores pre-v2 records instead of accepting legacy shape", () => {
  const legacy = {
    runId: "run-1",
    workspaceId: "workspace-1",
    status: "running",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };

  assert.equal(StoredRunRecordSchema.safeParse(legacy).success, false);
});

test("Wiki Run Record v2 requires every frozen input and outcome field", () => {
  const complete = {
    schema: "okf.wiki-run/v2",
    runId: "run-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    status: "running",
    autoApprove: false,
    error: null,
    skillPath: "/workspace/.okf-wiki/runs/run-1/skill",
    skillDigest: "a".repeat(64),
    sources: [
      {
        id: "main",
        revision: "b".repeat(40),
        effectiveIgnores: ["node_modules/**", "private/**"],
      },
    ],
    spec: null,
    pages: [],
    summary: null,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  } as const;

  assert.deepEqual(StoredRunRecordSchema.parse(complete), complete);
  for (const field of Object.keys(complete)) {
    const missing = { ...complete } as Record<string, unknown>;
    delete missing[field];
    assert.equal(
      StoredRunRecordSchema.safeParse(missing).success,
      false,
      `expected missing ${field} to be rejected`,
    );
  }
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
