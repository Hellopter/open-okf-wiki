/**
 * Plan-gate detail + plan-review materials.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { planGateDetailFromSpec, planGatePayloadDigest } from "./plan-review.js";
import {
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  waitForRunState,
} from "./__tests__/harness.js";
import { openWikiRuns } from "../wiki-runs.js";
import { defaultWikiRunSpec } from "@okf-wiki/contract/wiki-runs";

test("planGateDetailFromSpec projects secret-free counts from Spec", () => {
  const spec = defaultWikiRunSpec("Demo");
  const detail = planGateDetailFromSpec(spec);
  assert.equal(detail.source, "plan");
  assert.ok(detail.summary.length > 0);
  assert.equal(detail.domainCount, spec.domains.length);
  assert.equal(detail.pageCount, spec.pages.length);
  assert.equal(detail.openQuestionCount, spec.openQuestions.length);
});

test("plan gate opens with detail summary and readPlanReview matches payloadDigest", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "plan-review-start", intent: { mode: "generate" } },
    context(workspaceId),
  );

  const atPlan = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const planGate = atPlan.snapshot.gates.find((g) => g.kind === "plan" && g.state === "open");
  assert.ok(planGate, "plan gate opens");
  assert.ok(planGate.detail?.summary, "gate detail includes Spec summary");
  assert.equal(typeof planGate.detail?.pageCount, "number");
  assert.ok((planGate.detail?.pageCount ?? 0) >= 1, "at least one page in Spec");
  assert.equal(typeof planGate.detail?.domainCount, "number");

  const review = await runs.readPlanReview({ runId: receipt.runId });
  assert.equal(review.payloadDigest, planGate.payloadDigest);
  assert.equal(
    review.payloadDigest,
    planGatePayloadDigest(review.specDigest, review.planDigest),
  );
  assert.ok(review.spec.pages.length >= 1);
  assert.ok(review.execution.workUnitCount >= 0);
  assert.equal(review.spec.summary, planGate.detail?.summary);
  // Wave 2 additive fields: optional; schema-compatible when present.
  if (review.coverage) {
    assert.equal(typeof review.coverage.ok, "boolean");
    assert.ok(Array.isArray(review.coverage.rows));
    assert.ok(
      review.coverageStopReason === undefined ||
        ["complete", "coverage_gap", "not_required"].includes(review.coverageStopReason),
    );
  }
  if (review.pageSetDiff) {
    assert.ok(Array.isArray(review.pageSetDiff.added));
    assert.ok(Array.isArray(review.pageSetDiff.removed));
  }
  // Single-source fixture: priorSpec only after revise.
  assert.equal(review.priorSpec, undefined);

  const thin = await runs.readPlanSpec({ runId: receipt.runId });
  assert.equal(thin.digest, review.specDigest);
  assert.equal(thin.spec.summary, review.spec.summary);
});

test("readPlanReview not_found when run has no sealed plan", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());

  await assert.rejects(
    () => runs.readPlanReview({ runId: "missing-run-id" }),
    /not found/,
  );
  void workspaceId;
});
