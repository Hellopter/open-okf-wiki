/**
 * Pure helpers for plan-review headline / counts (hook tested via integration).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WikiRunGate, WikiRunPlanReview } from "@okf-wiki/contract";
import {
  formatDomainPageCounts,
  planReviewHeadline,
  type PlanReviewState,
  shouldLoadPlanReview,
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

const copy = { fallback: "fallback", loading: "loading…" };

describe("planReviewHeadline", () => {
  it("prefers sealed Spec summary over gate detail and fallback", () => {
    const state: PlanReviewState = {
      status: "ready",
      review: {
        runId: "r1",
        payloadDigest: "a".repeat(64),
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
      } as WikiRunPlanReview,
      error: null,
      expectedPayloadDigest: "a".repeat(64),
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
