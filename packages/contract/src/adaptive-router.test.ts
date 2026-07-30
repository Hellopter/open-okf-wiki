/**
 * Phase 7: adaptive defaults + light path (contract unit tests).
 * Graph single-cluster tests live in @okf-wiki/workflow.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { planUncertaintyFromSpec, resolveAdaptiveOrchestration } from "./adaptive-router.js";

test("light path default: 0 scouts, 1 review lens", () => {
  const decision = resolveAdaptiveOrchestration({});
  assert.equal(decision.orchestration.planScoutCount, 0);
  assert.equal(decision.orchestration.reviewCouncilSize, 1);
  assert.equal(decision.lightPath, true);
  assert.deepEqual(decision.reasons, []);
});

test("inventory large/multi-source raises scouts", () => {
  const decision = resolveAdaptiveOrchestration({
    inventory: { sourceCount: 2, fileCount: 500, languages: ["ts", "py"], multiEntry: true },
  });
  assert.ok(decision.orchestration.planScoutCount >= 1);
  assert.equal(decision.lightPath, false);
  assert.ok(decision.reasons.length > 0);
});

test("plan uncertainty alone can raise one scout", () => {
  const decision = resolveAdaptiveOrchestration({
    inventory: { sourceCount: 1, fileCount: 50 },
    planUncertainty: 0.7,
  });
  assert.equal(decision.orchestration.planScoutCount, 1);
  assert.ok(decision.reasons.some((r) => r.includes("plan-uncertainty")));
});

test("operator-explicit scouts are not lowered", () => {
  const decision = resolveAdaptiveOrchestration({
    orchestration: { planScoutCount: 3, reviewCouncilSize: 3 },
    inventory: { sourceCount: 1 },
  });
  assert.equal(decision.orchestration.planScoutCount, 3);
  assert.equal(decision.orchestration.reviewCouncilSize, 3);
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
