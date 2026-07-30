import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import {
  buildDefinitionV1Graph,
  isMechanicalAttemptKind,
  isPiAttemptKind,
} from "./definition-v1.js";
import { compileExecutionPlan, ExecutionPlanCompileError } from "./plan-compiler.js";

test("buildDefinitionV1Graph orders leaves before domains and ends at publish", () => {
  const graph = buildDefinitionV1Graph(defaultWikiRunSpec("Demo"));
  const keys = graph.nodes.map((n) => n.key);
  assert.ok(keys.includes("research.leaf.core.1"));
  assert.ok(keys.includes("research.leaf.core.2"));
  assert.ok(keys.includes("research.domain.core"));
  assert.ok(keys.includes("write.root"));
  assert.ok(keys.includes("validate.pre"));
  assert.ok(keys.includes("review.seat.grounding"));
  assert.ok(keys.includes("review.reduce"));
  assert.ok(keys.includes("gate.fix"));
  assert.ok(keys.includes("validate.final"));
  assert.ok(keys.includes("prepare.publication"));
  assert.ok(keys.includes("gate.publication"));
  assert.ok(keys.includes("publish"));

  assert.ok(
    graph.edges.some((e) => e.from === "research.leaf.core.1" && e.to === "research.domain.core"),
  );
  assert.ok(graph.edges.some((e) => e.from === "research.domain.core" && e.to === "write.root"));
  assert.ok(graph.edges.some((e) => e.from === "review.reduce" && e.to === "gate.fix"));
  assert.ok(graph.edges.some((e) => e.from === "gate.fix" && e.to === "validate.final"));
  assert.ok(graph.edges.some((e) => e.from === "gate.publication" && e.to === "publish"));
  assert.equal(isPiAttemptKind("research.leaf"), true);
  assert.equal(isMechanicalAttemptKind("validate.pre"), true);
  assert.equal(isPiAttemptKind("publish"), false);

  const grounding = graph.nodes.find((n) => n.key === "review.seat.grounding");
  assert.equal(grounding?.detail?.seatIndex, 0);
  assert.equal(grounding?.detail?.lens, "grounding");
});

test("reviewRequired=false compiles empty lenses and skips seats", () => {
  const spec = defaultWikiRunSpec("NoReview");
  spec.acceptance.reviewRequired = false;
  const plan = compileExecutionPlan(spec);
  assert.deepEqual(plan.reviewLenses, []);
  const graph = buildDefinitionV1Graph(spec);
  assert.equal(
    graph.nodes.some((n) => n.kind === "review.seat"),
    false,
  );
  assert.ok(graph.edges.some((e) => e.from === "validate.pre" && e.to === "review.reduce"));
});

test("buildDefinitionV1Graph without domains wires plan → write.root", () => {
  const spec = defaultWikiRunSpec("Empty");
  spec.domains = [];
  const graph = buildDefinitionV1Graph(spec);
  assert.ok(graph.edges.some((e) => e.from === "plan" && e.to === "write.root"));
  assert.equal(
    graph.nodes.some((n) => n.kind === "research.domain"),
    false,
  );
});

test("compileExecutionPlan throws when domains exceed maxDomainFanOut", () => {
  const spec = defaultWikiRunSpec("Fanout");
  spec.domains = [
    { id: "a", title: "A", scope: "a", critical: true, questions: ["q1"] },
    { id: "b", title: "B", scope: "b", critical: false, questions: ["q1"] },
    { id: "c", title: "C", scope: "c", critical: false, questions: ["q1"] },
  ];
  // Keep page↔domain refs valid for Spec schema consumers (compiler only reads domains).
  assert.throws(
    () => compileExecutionPlan(spec, { maxDomainFanOut: 2, maxLeafFanOut: 6 }),
    (err: unknown) =>
      err instanceof ExecutionPlanCompileError &&
      /3 domains.*maxDomainFanOut is 2/i.test(err.message),
  );
  assert.throws(
    () => buildDefinitionV1Graph(spec, { maxDomainFanOut: 2, maxLeafFanOut: 6 }),
    ExecutionPlanCompileError,
  );
});

test("compileExecutionPlan throws when questions exceed maxLeafFanOut", () => {
  const spec = defaultWikiRunSpec("LeafCap");
  spec.domains = [
    {
      id: "a",
      title: "A",
      scope: "a",
      critical: true,
      questions: ["q1", "q2", "q3"],
    },
  ];
  assert.throws(
    () => compileExecutionPlan(spec, { maxDomainFanOut: 4, maxLeafFanOut: 1 }),
    (err: unknown) =>
      err instanceof ExecutionPlanCompileError &&
      /Domain "a".*3 questions.*maxLeafFanOut is 1/i.test(err.message),
  );
});

test("compileExecutionPlan within caps builds workUnits and reductions", () => {
  const spec = defaultWikiRunSpec("Ok");
  const plan = compileExecutionPlan(spec, { maxDomainFanOut: 4, maxLeafFanOut: 6 });
  assert.equal(plan.version, 1);
  assert.equal(plan.fanOut.domainCount, 1);
  assert.equal(plan.fanOut.leafCount, 2);
  assert.equal(plan.workUnits.length, 2);
  assert.equal(plan.reductions.length, 1);
  assert.equal(plan.reductions[0]?.domainId, "core");
  assert.equal(plan.reviewLenses.length, 1);
  assert.deepEqual(plan.budgets, {
    maxRepairRounds: 2,
    maxHardValidateRepairRounds: 0,
  });
});

test("buildDefinitionV1Graph omitted options use DEFAULT_ORCHESTRATION (4/6/1)", () => {
  const spec = defaultWikiRunSpec("Defaults");
  // Exactly at default caps — must succeed (not throw, not truncate).
  spec.domains = Array.from({ length: 4 }, (_, i) => ({
    id: `d${i}`,
    title: `D${i}`,
    scope: `d${i}`,
    critical: i === 0,
    questions: Array.from({ length: 6 }, (_, q) => `q${q}`),
  }));
  // Pages must reference domains for Spec validity elsewhere; graph only needs domains.
  const graph = buildDefinitionV1Graph(spec);
  const domains = graph.nodes.filter((n) => n.kind === "research.domain");
  const leaves = graph.nodes.filter((n) => n.kind === "research.leaf");
  const seats = graph.nodes.filter((n) => n.kind === "review.seat");
  assert.equal(domains.length, 4);
  assert.equal(leaves.length, 4 * 6);
  assert.equal(seats.length, 1);
  assert.ok(seats.some((n) => n.key === "review.seat.grounding"));
  assert.equal(
    seats.some((n) => n.key === "review.seat.coverage"),
    false,
  );
  assert.equal(
    seats.some((n) => n.key === "review.seat.consistency"),
    false,
  );
  assert.equal(
    seats.some((n) => n.key === "review.seat.general"),
    false,
  );
});

test("buildDefinitionV1Graph throws (not slice) when Spec exceeds default caps", () => {
  const spec = defaultWikiRunSpec("Over");
  spec.domains = Array.from({ length: 5 }, (_, i) => ({
    id: `d${i}`,
    title: `D${i}`,
    scope: `d${i}`,
    critical: i === 0,
    questions: Array.from({ length: 7 }, (_, q) => `q${q}`),
  }));
  assert.throws(() => buildDefinitionV1Graph(spec), ExecutionPlanCompileError);
});
