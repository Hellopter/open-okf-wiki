/**
 * Pure helpers for plan-review headline / counts / coverage gate (hook via integration).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CoverageResult } from "@okf-wiki/contract/coverage";
import { type WikiRunGate, type WikiRunPlanReview, WikiRunPlanReviewSchema } from "@okf-wiki/contract/wiki-runs";
import {
  coverageBlocksApprove,
  coverageStatusCounts,
  coverageStopReasonOf,
  formatDomainPageCounts,
  hasScoutsSummary,
  pageSetDiffHasChanges,
  planReviewHeadline,
  type PlanReviewState,
  shouldLoadPlanReview,
  sortCoverageRows,
} from "./plan-review-utils.ts";

function gate(partial: Partial<WikiRunGate> = {}): WikiRunGate {
  return {
    gateId: "g1",
    nodeKey: "gate.plan",
    nodeGeneration: 0,
    kind: "plan",
    state: "open",
    payloadDigest: "a".repeat(64),
    decision: null,
    openedAt: new Date().toISOString(),
    detail: { summary: "From gate detail" },
    ...partial,
  };
}

const DIGEST = "a".repeat(64);

function baseReview(
  partial: Partial<WikiRunPlanReview> = {},
): WikiRunPlanReview {
  return WikiRunPlanReviewSchema.parse({
    runId: "r1",
    payloadDigest: DIGEST,
    specDigest: "b".repeat(64),
    planDigest: "c".repeat(64),
    spec: {
      version: 1,
      summary: "Sealed summary",
      audience: "devs",
      domains: [],
      pages: [
        { path: "overview.md", purpose: "p", domainIds: [], questions: [], critical: true },
      ],
      openQuestions: [],
      acceptance: {
        reviewRequired: true,
        maxRepairRounds: 2,
        autoRepair: true,
        maxHardValidateRepairRounds: 1,
        blockingSeverities: ["blocking"],
      },
      changelog: [],
    },
    execution: {
      workUnitCount: 0,
      domainCount: 0,
      leafCount: 0,
      maxDomainFanOut: 4,
      maxLeafFanOut: 6,
      reviewLenses: [],
      workUnits: [],
    },
    artifact: {},
    ...partial,
  });
}

const copy = { fallback: "fallback", loading: "loading…" };

describe("planReviewHeadline", () => {
  it("prefers sealed Spec summary over gate detail and fallback", () => {
    const state: PlanReviewState = {
      status: "ready",
      review: baseReview(),
      error: null,
      expectedPayloadDigest: DIGEST,
    };
    assert.equal(planReviewHeadline(state, gate(), copy), "Sealed summary");
  });

  it("falls back to gate detail, loading copy, then static fallback", () => {
    const empty: PlanReviewState = {
      status: "pending",
      review: null,
      error: null,
      expectedPayloadDigest: null,
    };
    assert.equal(planReviewHeadline(empty, gate(), copy), "From gate detail");
    assert.equal(planReviewHeadline(empty, gate({ detail: undefined }), copy), "fallback");
    assert.equal(
      planReviewHeadline({ ...empty, status: "loading" }, gate({ detail: undefined }), copy),
      "loading…",
    );
  });
});

describe("formatDomainPageCounts", () => {
  it("requires both counts and does not invent zeros", () => {
    const format = (t: string, v: Record<string, string | number>) =>
      t.replace("{domains}", String(v.domains)).replace("{pages}", String(v.pages));
    assert.equal(formatDomainPageCounts(2, 5, "{domains} · {pages}", format), "2 · 5");
    assert.equal(formatDomainPageCounts(2, undefined, "{domains} · {pages}", format), null);
    assert.equal(formatDomainPageCounts(undefined, 5, "{domains} · {pages}", format), null);
  });
});

describe("shouldLoadPlanReview", () => {
  it("loads for open plan gate or plan node activity", () => {
    assert.equal(shouldLoadPlanReview(null), false);
    assert.equal(
      shouldLoadPlanReview({
        gates: [gate()],
        nodes: [{ key: "plan", kind: "plan", state: "succeeded" }],
      }),
      true,
    );
    assert.equal(
      shouldLoadPlanReview({
        gates: [],
        nodes: [{ key: "freeze", kind: "freeze", state: "running" }],
      }),
      false,
    );
    assert.equal(
      shouldLoadPlanReview({
        gates: [],
        nodes: [{ key: "plan", kind: "plan", state: "running" }],
      }),
      true,
    );
  });
});

describe("WikiRunPlanReviewSchema coverage fields", () => {
  it("parses additive coverage / scouts / pageSetDiff without requiring them", () => {
    const light = baseReview();
    assert.equal(light.coverage, undefined);
    assert.equal(light.scoutsSummary, undefined);
    assert.equal(light.pageSetDiff, undefined);

    const full = baseReview({
      coverage: {
        ok: false,
        stop_reason: "coverage_gap",
        gaps: ["backend"],
        rows: [
          {
            unitId: "backend",
            kind: "source",
            status: "gap",
            coveredBy: [],
            reason: "missing",
          },
          {
            unitId: "frontend",
            kind: "source",
            status: "covered",
            coveredBy: ["overview.md"],
          },
        ],
      },
      coverageStopReason: "coverage_gap",
      coverageRounds: 1,
      scoutsSummary: { kinds: ["entry", "layout"], receiptCount: 2, mode: "multi_source" },
      pageSetDiff: {
        added: ["api.md"],
        removed: ["old.md"],
        retained: ["overview.md"],
      },
    });
    assert.equal(full.coverage?.stop_reason, "coverage_gap");
    assert.equal(full.coverage?.rows.length, 2);
    assert.equal(full.scoutsSummary?.receiptCount, 2);
    assert.deepEqual(full.pageSetDiff?.added, ["api.md"]);
  });

  it("accepts not_required empty coverage (light path)", () => {
    const review = baseReview({
      coverage: { ok: true, stop_reason: "not_required", rows: [], gaps: [] },
      coverageStopReason: "not_required",
    });
    assert.equal(review.coverage?.ok, true);
    assert.equal(coverageBlocksApprove(review), false);
  });
});

describe("coverageBlocksApprove", () => {
  it("allows approve when coverage is omitted (light single-repo)", () => {
    assert.equal(coverageBlocksApprove(baseReview()), false);
    assert.equal(coverageBlocksApprove(null), false);
    assert.equal(coverageBlocksApprove(undefined), false);
  });

  it("allows approve when stop_reason is not_required or complete", () => {
    assert.equal(
      coverageBlocksApprove(
        baseReview({
          coverage: { ok: true, stop_reason: "not_required", rows: [], gaps: [] },
        }),
      ),
      false,
    );
    assert.equal(
      coverageBlocksApprove(
        baseReview({
          coverage: {
            ok: true,
            stop_reason: "complete",
            gaps: [],
            rows: [
              {
                unitId: "app",
                kind: "source",
                status: "covered",
                coveredBy: ["overview.md"],
              },
            ],
          },
          coverageStopReason: "complete",
        }),
      ),
      false,
    );
  });

  it("blocks approve on coverage_gap / ok false / gap rows", () => {
    assert.equal(
      coverageBlocksApprove(
        baseReview({
          coverageStopReason: "coverage_gap",
        }),
      ),
      true,
    );
    assert.equal(
      coverageBlocksApprove(
        baseReview({
          coverage: {
            ok: false,
            stop_reason: "coverage_gap",
            gaps: ["backend"],
            rows: [
              { unitId: "backend", kind: "source", status: "gap", coveredBy: [] },
            ],
          },
        }),
      ),
      true,
    );
    // Defensive: ok true but gap row still present
    assert.equal(
      coverageBlocksApprove(
        baseReview({
          coverage: {
            ok: true,
            stop_reason: "complete",
            gaps: [],
            rows: [{ unitId: "x", kind: "source", status: "gap", coveredBy: [] }],
          },
        }),
      ),
      true,
    );
  });
});

describe("coverageStatusCounts / sortCoverageRows", () => {
  it("counts statuses and sorts gaps first with source emphasis", () => {
    const coverage: CoverageResult = {
      ok: false,
      stop_reason: "coverage_gap",
      gaps: ["backend"],
      rows: [
        { unitId: "frontend", kind: "source", status: "covered", coveredBy: ["a.md"] },
        { unitId: "backend", kind: "source", status: "gap", coveredBy: [] },
        {
          unitId: "backend::src",
          kind: "surface",
          status: "cancelled",
          coveredBy: [],
          reason: "out of scope",
        },
      ],
    };
    assert.deepEqual(coverageStatusCounts(coverage), {
      covered: 1,
      gap: 1,
      cancelled: 1,
      total: 3,
    });
    const sorted = sortCoverageRows(coverage.rows);
    assert.equal(sorted[0]!.unitId, "backend");
    assert.equal(sorted[0]!.status, "gap");
    assert.equal(sorted[1]!.status, "covered");
    assert.equal(sorted[2]!.status, "cancelled");
  });

  it("prefers surface units when no source units (large single)", () => {
    const sorted = sortCoverageRows([
      { unitId: "app::pkg/b", kind: "surface", status: "covered", coveredBy: ["b.md"] },
      { unitId: "app::pkg/a", kind: "surface", status: "covered", coveredBy: ["a.md"] },
    ]);
    assert.equal(sorted[0]!.unitId, "app::pkg/a");
  });
});

describe("coverageStopReasonOf / pageSetDiffHasChanges / hasScoutsSummary", () => {
  it("prefers top-level stop reason then nested coverage", () => {
    assert.equal(
      coverageStopReasonOf(
        baseReview({
          coverageStopReason: "complete",
          coverage: { ok: false, stop_reason: "coverage_gap", rows: [], gaps: ["x"] },
        }),
      ),
      "complete",
    );
    assert.equal(
      coverageStopReasonOf(
        baseReview({
          coverage: { ok: true, stop_reason: "not_required", rows: [], gaps: [] },
        }),
      ),
      "not_required",
    );
  });

  it("detects page-set and scouts presence", () => {
    assert.equal(pageSetDiffHasChanges(undefined), false);
    assert.equal(
      pageSetDiffHasChanges({ added: [], removed: [], retained: ["a.md"] }),
      false,
    );
    assert.equal(
      pageSetDiffHasChanges({ added: ["b.md"], removed: [], retained: [] }),
      true,
    );
    assert.equal(hasScoutsSummary(undefined), false);
    assert.equal(hasScoutsSummary({ kinds: [], receiptCount: 0 }), false);
    assert.equal(hasScoutsSummary({ kinds: ["entry"], receiptCount: 0 }), true);
    assert.equal(hasScoutsSummary({ kinds: [], receiptCount: 1 }), true);
  });
});

