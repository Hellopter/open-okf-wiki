/**
 * Plan-gate detail + plan-review materials.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract/wiki-runs";
import { runWorkDir } from "@okf-wiki/core";
import { openWikiRuns } from "../wiki-runs.js";
import {
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  waitForRunState,
} from "./__tests__/harness.js";
import {
  discoverySummaryFromMap,
  planGateDetailFromSpec,
  planGatePayloadDigest,
} from "./plan-review.js";

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

test("discoverySummaryFromMap projects compact counts", () => {
  const summary = discoverySummaryFromMap({
    version: 1,
    sources: [
      {
        sourceId: "api",
        entryPoints: [],
        surfaces: [],
        purpose: "",
        evidencePaths: ["sources/api/main.go"],
      },
      {
        sourceId: "web",
        entryPoints: [],
        surfaces: [],
        purpose: "",
        evidencePaths: ["sources/web/src/main.tsx"],
      },
    ],
    domains: [
      {
        id: "auth",
        title: "Auth",
        scope: "Login",
        coverageUnitIds: [],
        evidencePaths: [],
        readerQuestion: "How login?",
      },
    ],
    flows: [
      {
        id: "login",
        title: "Login",
        steps: [],
        crossSource: true,
        coverageUnitIds: [],
        evidencePaths: [],
      },
      {
        id: "local",
        title: "Local",
        steps: [],
        crossSource: false,
        coverageUnitIds: [],
        evidencePaths: [],
      },
    ],
    concepts: [
      {
        id: "jwt",
        term: "JWT",
        definitionHint: "token",
        evidencePaths: [],
      },
    ],
    openQuestions: ["Need OAuth details?"],
    boundaryPaths: [],
    scoutKinds: ["source", "flow", "concept"],
  });
  assert.deepEqual(summary, {
    domainCount: 1,
    flowCount: 2,
    conceptCount: 1,
    sourceCount: 2,
    crossSourceFlowCount: 1,
    openQuestionCount: 1,
    scoutKinds: ["source", "flow", "concept"],
  });
});

test("readPlanReview projects discoverySummary from analysis/discovery-map.json", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "plan-review-discovery", intent: { mode: "generate" } },
    context(workspaceId),
  );

  await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);

  const analysisDir = path.join(runWorkDir(root, receipt.runId), "analysis");
  await mkdir(analysisDir, { recursive: true });
  await writeFile(
    path.join(analysisDir, "discovery-map.json"),
    `${JSON.stringify({
      version: 1,
      sources: [
        {
          sourceId: "main",
          entryPoints: ["README.md"],
          surfaces: ["."],
          purpose: "demo",
          evidencePaths: ["sources/main/README.md"],
        },
      ],
      domains: [
        {
          id: "core",
          title: "Core",
          scope: "Main surface",
          coverageUnitIds: ["main"],
          evidencePaths: ["sources/main/README.md"],
          readerQuestion: "What is this?",
        },
      ],
      flows: [],
      concepts: [
        {
          id: "wiki",
          term: "Wiki",
          definitionHint: "knowledge pages",
          evidencePaths: [],
        },
      ],
      openQuestions: [],
      boundaryPaths: [],
      scoutKinds: ["source", "domain"],
    })}\n`,
    "utf8",
  );

  const review = await runs.readPlanReview({ runId: receipt.runId });
  assert.ok(review.discoverySummary, "discoverySummary projected from analysis map");
  assert.equal(review.discoverySummary.domainCount, 1);
  assert.equal(review.discoverySummary.flowCount, 0);
  assert.equal(review.discoverySummary.conceptCount, 1);
  assert.equal(review.discoverySummary.sourceCount, 1);
  assert.equal(review.discoverySummary.openQuestionCount, 0);
  assert.deepEqual(review.discoverySummary.scoutKinds, ["source", "domain"]);
  assert.ok(review.semanticSufficiency, "soft semanticSufficiency included");
  assert.equal(typeof review.semanticSufficiency.ok, "boolean");
  assert.ok(
    ["complete", "semantic_gap", "not_required"].includes(review.semanticSufficiency.stop_reason),
  );
});
