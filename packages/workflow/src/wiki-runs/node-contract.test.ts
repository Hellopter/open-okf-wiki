/**
 * NodeContract registry unit tests (Phase 2).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { contractForNode, isResearchRole, metricsRoleForNodeKind, validateBoundInputs, validateNodeOutputs } from "@okf-wiki/contract/wiki-runs";

function inputs(...entries: Array<[string, string]>) {
  return entries.map(([role, kind]) => ({ role, kind }));
}

test("contractForNode: plan requires sources+skill; research optional on write", () => {
  const plan = contractForNode("plan", "plan");
  assert.equal(plan.execution, "pi");
  assert.ok(plan.requiredInputs.some((r) => r.role === "sources" && r.required));
  assert.ok(plan.requiredInputs.some((r) => r.role === "skill" && r.required));
  assert.ok(plan.requiredInputs.some((r) => r.role === "frozen_run_manifest" && r.required));
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

test("contractForNode: repair.N has optional defects (semantic or mechanical)", () => {
  const repair = contractForNode("repair", "repair.1");
  const defects = repair.requiredInputs.find((r) => r.role === "defects");
  assert.ok(defects);
  assert.equal(defects.required, false);
  assert.ok(repair.requiredInputs.some((r) => r.role === "wiki_tree" && r.required));
  assert.ok(repair.requiredInputs.some((r) => r.role === "operator_input"));
  assert.equal(repair.execution, "pi");
});

test("contractForNode rejects unknown kinds and malformed dynamic keys", () => {
  assert.throws(() => contractForNode("unknown", "unknown"), /unknown WikiRuns node kind/);
  assert.throws(
    () => contractForNode("research.leaf", "research.leaf.core"),
    /unknown WikiRuns node key/,
  );
  assert.throws(() => contractForNode("repair", "repair.0"), /unknown WikiRuns node key/);
});

test("validateBoundInputs: fails closed on missing required research for domain", () => {
  const domain = contractForNode("research.domain", "research.domain.core");
  assert.throws(
    () =>
      validateBoundInputs(
        domain,
        inputs(["sources", "snapshot_set"], ["skill", "skill"], ["spec", "spec"]),
      ),
    /research:receipt/,
  );
  // Namespaced leaf research satisfies the research requirement.
  validateBoundInputs(
    domain,
    inputs(
      ["sources", "snapshot_set"],
      ["skill", "skill"],
      ["research.leaf.core.1:research", "receipt"],
      ["execution_plan", "execution_plan"],
      ["frozen_run_manifest", "manifest"],
    ),
  );
  assert.throws(
    () =>
      validateBoundInputs(
        domain,
        inputs(
          ["sources", "snapshot_set"],
          ["skill", "skill"],
          ["research.leaf.core.1:research", "spec"],
          ["execution_plan", "execution_plan"],
          ["frozen_run_manifest", "manifest"],
        ),
      ),
    /research:receipt/,
  );
});

test("validateBoundInputs: review.seat requires wiki_tree + spec", () => {
  const seat = contractForNode("review.seat", "review.seat.grounding");
  assert.throws(
    () => validateBoundInputs(seat, inputs(["sources", "snapshot_set"], ["skill", "skill"])),
    /wiki_tree/,
  );
  validateBoundInputs(
    seat,
    inputs(
      ["sources", "snapshot_set"],
      ["skill", "skill"],
      ["wiki_tree", "wiki_tree"],
      ["spec", "spec"],
      ["frozen_run_manifest", "manifest"],
    ),
  );
});

test("contractForNode: review.reduce treats review_seat as optional (zero-seat clean path)", () => {
  const reduce = contractForNode("review.reduce", "review.reduce");
  const seat = reduce.requiredInputs.find((r) => r.role === "review_seat");
  assert.ok(seat, "review_seat role must be declared");
  assert.equal(seat.required, false, "review_seat optional so claim works with zero seats");
  assert.ok(reduce.requiredInputs.some((r) => r.role === "wiki_tree" && r.required));
  assert.ok(reduce.requiredInputs.some((r) => r.role === "spec" && r.required));
  // Zero-seat envelope (reviewRequired=false): only wiki_tree + ambient spec.
  validateBoundInputs(reduce, inputs(["wiki_tree", "wiki_tree"], ["spec", "spec"]));
  // With seats bound still valid.
  validateBoundInputs(
    reduce,
    inputs(
      ["wiki_tree", "wiki_tree"],
      ["spec", "spec"],
      ["review.seat.grounding:review_seat", "receipt"],
    ),
  );
  assert.throws(() => validateBoundInputs(reduce, inputs(["spec", "spec"])), /wiki_tree/);
});

test("contractForNode: validate.pre/final require Spec", () => {
  for (const key of ["validate.pre", "validate.final"] as const) {
    const c = contractForNode(key, key);
    assert.ok(c.requiredInputs.some((r) => r.role === "spec" && r.required));
    assert.throws(() => validateBoundInputs(c, inputs(["wiki_tree", "wiki_tree"])), /spec/);
    validateBoundInputs(c, inputs(["wiki_tree", "wiki_tree"], ["spec", "spec"]));
  }
});

test("metrics role mapping is shared by all execution adapters", () => {
  assert.equal(metricsRoleForNodeKind("plan.adapt"), "plan_adapt");
  assert.equal(metricsRoleForNodeKind("research.leaf"), "leaf");
  assert.equal(metricsRoleForNodeKind("validate.final"), "mechanical");
});

test("isResearchRole matches exact and namespaced forms", () => {
  assert.equal(isResearchRole("research"), true);
  assert.equal(isResearchRole("research.leaf.core.1:research"), true);
  assert.equal(isResearchRole("research.domain.core:research"), true);
  assert.equal(isResearchRole("transcript"), false);
  assert.equal(isResearchRole("spec"), false);
});

test("validateNodeOutputs rejects missing and undeclared business artifacts", () => {
  const writer = contractForNode("write.root", "write.root");
  assert.throws(() => validateNodeOutputs(writer, []), /missing declared output/);
  assert.throws(
    () => validateNodeOutputs(writer, [{ role: "research", kind: "receipt" }]),
    /missing declared output/,
  );
  assert.throws(
    () =>
      validateNodeOutputs(writer, [
        { role: "wiki_tree", kind: "wiki_tree" },
        { role: "defects", kind: "receipt" },
      ]),
    /undeclared output/,
  );
  assert.throws(
    () =>
      validateNodeOutputs(writer, [
        { role: "wiki_tree", kind: "wiki_tree" },
        { role: "wiki_tree", kind: "wiki_tree" },
      ]),
    /duplicate output role/,
  );
  validateNodeOutputs(writer, [{ role: "wiki_tree", kind: "wiki_tree" }]);
});

test("freeze contract accepts generate outputs and marks prior_wiki optional", () => {
  const freeze = contractForNode("freeze", "freeze");
  assert.equal(freeze.outputs.find((output) => output.role === "prior_wiki")?.required, false);
  assert.equal(
    freeze.outputs.find((output) => output.role === "coverage_inventory")?.required,
    false,
  );
  assert.equal(freeze.outputs.find((output) => output.role === "coverage_plan")?.required, false);
  validateNodeOutputs(freeze, [
    { role: "sources", kind: "snapshot_set" },
    { role: "skill", kind: "skill" },
    { role: "frozen_run_manifest", kind: "manifest" },
    { role: "attempt_output", kind: "manifest" },
  ]);
  validateNodeOutputs(freeze, [
    { role: "sources", kind: "snapshot_set" },
    { role: "skill", kind: "skill" },
    { role: "frozen_run_manifest", kind: "manifest" },
    { role: "coverage_inventory", kind: "receipt" },
    { role: "coverage_plan", kind: "receipt" },
    { role: "boundary_index", kind: "receipt" },
    { role: "attempt_output", kind: "manifest" },
  ]);
  assert.throws(
    () =>
      validateNodeOutputs(freeze, [
        { role: "sources", kind: "snapshot_set" },
        { role: "skill", kind: "skill" },
        { role: "frozen_run_manifest", kind: "manifest" },
      ]),
    /attempt_output:manifest/,
  );
});

test("plan contract accepts optional prior_spec and coverage inputs", () => {
  const plan = contractForNode("plan", "plan");
  assert.equal(plan.requiredInputs.find((r) => r.role === "prior_spec")?.required, false);
  assert.equal(plan.requiredInputs.find((r) => r.role === "coverage_plan")?.required, false);
  validateBoundInputs(
    plan,
    inputs(
      ["sources", "snapshot_set"],
      ["skill", "skill"],
      ["frozen_run_manifest", "manifest"],
      ["prior_spec", "spec"],
      ["coverage_plan", "receipt"],
    ),
  );
});
