/**
 * Phase 7 + coverage Phase A: adaptive defaults + light path (contract unit tests).
 * Graph single-cluster tests live in @okf-wiki/workflow.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { planUncertaintyFromSpec, resolveAdaptiveOrchestration } from "./adaptive-router.js";

test("light path default: 0 scouts, 1 review lens", () => {
  const decision = resolveAdaptiveOrchestration({});
  assert.equal(decision.orchestration.planScoutCount, 0);
  assert.equal(decision.orchestration.reviewCouncilSize, 1);
  assert.equal(decision.orchestration.planScoutMode, "auto");
  assert.equal(decision.orchestration.planRescoutMaxRounds, 1);
  assert.equal(decision.orchestration.maxSurfacesRequired, 12);
  assert.equal(decision.orchestration.maxSourcesPerRun, 16);
  assert.equal(decision.lightPath, true);
  assert.deepEqual(decision.reasons, []);
});

test("multi-source selects hybrid mode and source coverage (not multiEntry)", () => {
  const decision = resolveAdaptiveOrchestration({
    inventory: { sourceCount: 2, fileCount: 500, languages: ["ts", "py"] },
  });
  assert.equal(decision.orchestration.planScoutMode, "hybrid");
  assert.equal(decision.orchestration.requireSourceCoverage, true);
  assert.ok((decision.orchestration.planSurveyTaskBudget ?? 0) >= 2);
  assert.ok(decision.orchestration.planScoutCount >= 1);
  assert.equal(decision.lightPath, false);
  // multiEntry must not be implied by multi-source alone (no multiEntry in inventory).
  assert.ok(decision.reasons.every((r) => !r.includes("multi-entry")));
  assert.ok(decision.reasons.some((r) => r.includes("hybrid")));
});

test("multi-source does not invent multiEntry; explicit multiEntry still raises thematic on single-repo", () => {
  const multi = resolveAdaptiveOrchestration({
    inventory: { sourceCount: 3, multiEntry: false },
  });
  assert.equal(multi.orchestration.planScoutMode, "hybrid");

  const singleMultiEntry = resolveAdaptiveOrchestration({
    inventory: { sourceCount: 1, fileCount: 100, multiEntry: true },
  });
  assert.ok(singleMultiEntry.orchestration.planScoutCount >= 1);
  assert.ok(singleMultiEntry.reasons.some((r) => r.includes("multi-entry")));
});

test("large single-repo raises thematic scouts and optional surface coverage", () => {
  const decision = resolveAdaptiveOrchestration({
    inventory: {
      sourceCount: 1,
      fileCount: 5_000,
      languages: ["ts"],
      surfaceCount: 4,
    },
  });
  assert.ok(decision.orchestration.planScoutCount >= 1);
  assert.equal(decision.orchestration.requireSurfaceCoverage, true);
  assert.notEqual(decision.orchestration.planScoutMode, "hybrid");
  assert.ok(decision.reasons.some((r) => r.includes("large-single-repo")));
});

test("small single-repo stays light path without required surfaces", () => {
  const decision = resolveAdaptiveOrchestration({
    inventory: { sourceCount: 1, fileCount: 50 },
  });
  assert.equal(decision.orchestration.planScoutCount, 0);
  assert.equal(decision.orchestration.requireSurfaceCoverage, undefined);
  assert.equal(decision.orchestration.requireSourceCoverage, undefined);
  assert.equal(decision.lightPath, true);
});

test("plan uncertainty alone can raise one scout", () => {
  const decision = resolveAdaptiveOrchestration({
    inventory: { sourceCount: 1, fileCount: 50 },
    planUncertainty: 0.7,
  });
  assert.equal(decision.orchestration.planScoutCount, 1);
  assert.ok(decision.reasons.some((r) => r.includes("plan-uncertainty")));
});

test("operator-explicit scouts and mode are not lowered", () => {
  const decision = resolveAdaptiveOrchestration({
    orchestration: {
      planScoutCount: 3,
      reviewCouncilSize: 3,
      planScoutMode: "thematic",
    },
    inventory: { sourceCount: 2 },
  });
  assert.equal(decision.orchestration.planScoutCount, 3);
  assert.equal(decision.orchestration.reviewCouncilSize, 3);
  assert.equal(decision.orchestration.planScoutMode, "thematic");
});

test("planUncertaintyFromSpec rises with openQuestions and domains", () => {
  const low = planUncertaintyFromSpec({
    domains: [{ questions: ["q1"] }],
    openQuestions: [],
  });
  const high = planUncertaintyFromSpec({
    domains: [
      { questions: ["q1", "q2", "q3"] },
      { questions: ["q4", "q5"] },
      { questions: ["q6"] },
    ],
    openQuestions: ["a", "b", "c", "d", "e", "f"],
  });
  assert.ok(low < 0.2);
  assert.ok(high > 0.5);
});
