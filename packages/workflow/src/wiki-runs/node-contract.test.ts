/**
 * NodeContract registry unit tests (Phase 2).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  contractForNode,
  isResearchRole,
  validateBoundInputs,
} from "./node-contract.js";

test("contractForNode: plan requires sources+skill; research optional on write", () => {
  const plan = contractForNode("plan", "plan");
  assert.equal(plan.execution, "pi");
  assert.ok(plan.requiredInputs.some((r) => r.role === "sources" && r.required));
  assert.ok(plan.requiredInputs.some((r) => r.role === "skill" && r.required));
  assert.ok(plan.outputs.some((o) => o.role === "spec"));

  const write = contractForNode("write.root", "write.root");
  const research = write.requiredInputs.find((r) => r.role === "research");
  assert.ok(research);
  assert.equal(research.required, false);
  assert.equal(research.projection, "mounted");
});

test("contractForNode: domain requires research; leaf does not", () => {
  const leaf = contractForNode("research.leaf", "research.leaf.core.1");
  assert.ok(!leaf.requiredInputs.some((r) => r.role === "research" && r.required));

  const domain = contractForNode("research.domain", "research.domain.core");
  assert.ok(domain.requiredInputs.some((r) => r.role === "research" && r.required));
});

test("contractForNode: repair.review requires defects; repair.hv does not force defects", () => {
  const review = contractForNode("repair", "repair.review.1");
  assert.ok(review.requiredInputs.some((r) => r.role === "defects" && r.required));

  const hv = contractForNode("repair", "repair.hv.1");
  const defects = hv.requiredInputs.find((r) => r.role === "defects");
  assert.ok(defects);
  assert.equal(defects.required, false);
});

test("validateBoundInputs: fails closed on missing required research for domain", () => {
  const domain = contractForNode("research.domain", "research.domain.core");
  assert.throws(
    () => validateBoundInputs(domain, ["sources", "skill", "spec"]),
    /missing required sealed input role\(s\): research/,
  );
  // Namespaced leaf research satisfies the research requirement.
  validateBoundInputs(domain, ["sources", "skill", "research.leaf.core.1:research"]);
});

test("validateBoundInputs: review.seat requires wiki_tree + spec", () => {
  const seat = contractForNode("review.seat", "review.seat.grounding");
  assert.throws(
    () => validateBoundInputs(seat, ["sources", "skill"]),
    /wiki_tree/,
  );
  validateBoundInputs(seat, ["sources", "skill", "wiki_tree", "spec"]);
});

test("contractForNode: review.reduce treats review_seat as optional (zero-seat clean path)", () => {
  const reduce = contractForNode("review.reduce", "review.reduce");
  const seat = reduce.requiredInputs.find((r) => r.role === "review_seat");
  assert.ok(seat, "review_seat role must be declared");
  assert.equal(seat.required, false, "review_seat optional so claim works with zero seats");
  assert.ok(reduce.requiredInputs.some((r) => r.role === "wiki_tree" && r.required));
  assert.ok(reduce.requiredInputs.some((r) => r.role === "spec" && r.required));
  // Zero-seat envelope (reviewRequired=false): only wiki_tree + ambient spec.
  validateBoundInputs(reduce, ["wiki_tree", "spec"]);
  // With seats bound still valid.
  validateBoundInputs(reduce, ["wiki_tree", "spec", "review.seat.grounding:review_seat"]);
  assert.throws(
    () => validateBoundInputs(reduce, ["spec"]),
    /wiki_tree/,
  );
});

test("contractForNode: validate.pre/final require Spec", () => {
  for (const key of ["validate.pre", "validate.final"] as const) {
    const c = contractForNode(key, key);
    assert.ok(c.requiredInputs.some((r) => r.role === "spec" && r.required));
    assert.throws(() => validateBoundInputs(c, ["wiki_tree"]), /spec/);
    validateBoundInputs(c, ["wiki_tree", "spec"]);
  }
});

test("isResearchRole matches exact and namespaced forms", () => {
  assert.equal(isResearchRole("research"), true);
  assert.equal(isResearchRole("research.leaf.core.1:research"), true);
  assert.equal(isResearchRole("research.domain.core:research"), true);
  assert.equal(isResearchRole("transcript"), false);
  assert.equal(isResearchRole("spec"), false);
});
