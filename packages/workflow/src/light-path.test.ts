/**
 * Phase 7 light path: inventory + 1 planner; single-cluster direct to Writer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultWikiRunSpec,
  planUncertaintyFromSpec,
  resolveAdaptiveOrchestration,
} from "@okf-wiki/contract";
import { buildDefinitionV1Graph, buildGraphFromExecutionPlan } from "./definition-v1.js";
import { compileExecutionPlan } from "./plan-compiler.js";

test("light path: adaptive defaults feed 0 scouts / 1 lens into compile", () => {
  const decision = resolveAdaptiveOrchestration({
    inventory: { sourceCount: 1, fileCount: 40 },
  });
  assert.equal(decision.lightPath, true);
  const plan = compileExecutionPlan(defaultWikiRunSpec("Light"), {
    reviewCouncilSize: decision.orchestration.reviewCouncilSize,
  });
  assert.equal(plan.reviewLenses.length, 1);
  assert.equal(plan.reviewLenses[0], "grounding");
});

test("single-cluster (one leaf) direct to Writer — no domain reducer", () => {
  const spec = defaultWikiRunSpec("Single");
  spec.domains = [
    {
      id: "core",
      title: "Core",
      scope: "whole",
      critical: true,
      questions: ["What is the entry point?"],
    },
  ];
  const plan = compileExecutionPlan(spec, { reviewCouncilSize: 1 });
  assert.equal(plan.workUnits.length, 1);
  assert.equal(plan.reductions.length, 0);
  const graph = buildGraphFromExecutionPlan(plan, spec);
  assert.equal(
    graph.nodes.some((n) => n.kind === "research.domain"),
    false,
    "single cluster must not force domain reducer",
  );
  assert.ok(
    graph.edges.some((e) => e.from === "research.leaf.core.1" && e.to === "write.root"),
    "leaf must edge directly to write.root",
  );
  assert.equal(graph.nodes.filter((n) => n.kind === "review.seat").length, 1);
});

test("multi-leaf domain still uses domain reducer", () => {
  const graph = buildDefinitionV1Graph(defaultWikiRunSpec("Multi"), {
    reviewCouncilSize: 1,
  });
  assert.ok(graph.nodes.some((n) => n.key === "research.domain.core"));
  assert.ok(
    graph.edges.some((e) => e.from === "research.domain.core" && e.to === "write.root"),
  );
});

test("high uncertainty + multi inventory raises beyond light path", () => {
  const uncertainty = planUncertaintyFromSpec({
    domains: [
      { questions: ["q1", "q2", "q3"] },
      { questions: ["q4"] },
      { questions: ["q5"] },
    ],
    openQuestions: ["a", "b", "c", "d", "e", "f"],
  });
  const decision = resolveAdaptiveOrchestration({
    inventory: {
      sourceCount: 3,
      fileCount: 5_000,
      languages: ["ts", "py", "go"],
      multiEntry: true,
      large: true,
    },
    planUncertainty: uncertainty,
  });
  assert.equal(decision.lightPath, false);
  assert.ok(decision.orchestration.planScoutCount >= 1);
  assert.ok(decision.orchestration.reviewCouncilSize >= 1);
});
