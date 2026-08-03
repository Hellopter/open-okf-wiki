import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CoveragePlanSchema,
  defaultWikiRunSpec,
  sourceCoverageUnit,
} from "@okf-wiki/contract";
import { compileExecutionPlan, ExecutionPlanCompileError } from "./plan-compiler.js";
import { failureClassOf } from "./wiki-runs/scheduler.js";

test("compileExecutionPlan throws when domains > maxDomainFanOut", () => {
  const spec = defaultWikiRunSpec("D");
  spec.domains = Array.from({ length: 3 }, (_, i) => ({
    id: `d${i}`,
    title: `D${i}`,
    scope: `s${i}`,
    critical: true,
    questions: ["q"],
  }));
  assert.throws(
    () => compileExecutionPlan(spec, { maxDomainFanOut: 2 }),
    ExecutionPlanCompileError,
  );
});

test("ExecutionPlanCompileError carries failureClass schema for failNode", () => {
  const err = new ExecutionPlanCompileError(
    "WikiRunSpec has 5 domains but maxDomainFanOut is 4; reduce domains",
  );
  assert.equal(err.failureClass, "schema");
  assert.equal(err.code, "EXECUTION_PLAN_COMPILE");
  assert.equal(failureClassOf(err), "schema");

  // Thrown compile path must also surface schema (preparePlanExecutionPlan catch → failNode).
  try {
    const spec = defaultWikiRunSpec("D");
    spec.domains = Array.from({ length: 3 }, (_, i) => ({
      id: `d${i}`,
      title: `D${i}`,
      scope: `s${i}`,
      critical: true,
      questions: ["q"],
    }));
    compileExecutionPlan(spec, { maxDomainFanOut: 2 });
    assert.fail("expected compile to throw");
  } catch (error) {
    assert.ok(error instanceof ExecutionPlanCompileError);
    assert.equal(failureClassOf(error), "schema");
  }
});

test("compileExecutionPlan throws when questions > maxLeafFanOut", () => {
  const spec = defaultWikiRunSpec("L");
  spec.domains = [
    {
      id: "core",
      title: "Core",
      scope: "s",
      critical: true,
      questions: ["a", "b", "c"],
    },
  ];
  assert.throws(() => compileExecutionPlan(spec, { maxLeafFanOut: 2 }), /maxLeafFanOut is 2/);
});

test("single-leaf domain has no reduction entry", () => {
  const spec = defaultWikiRunSpec("One");
  spec.domains = [{ id: "solo", title: "Solo", scope: "s", critical: true, questions: ["only"] }];
  const plan = compileExecutionPlan(spec, { maxDomainFanOut: 4, maxLeafFanOut: 6 });
  assert.equal(plan.workUnits.length, 1);
  assert.equal(plan.fanOut.leafCount, 1);
});

test("zero-question domain still yields one leaf work unit", () => {
  const spec = defaultWikiRunSpec("Z");
  spec.domains = [
    { id: "empty", title: "Empty", scope: "whole repo", critical: true, questions: [] },
  ];
  const plan = compileExecutionPlan(spec);
  assert.equal(plan.workUnits.length, 1);
  assert.equal(plan.workUnits[0]?.scope, "whole repo");
});

test("compileExecutionPlan propagates domain coverage ids onto work units", () => {
  const spec = defaultWikiRunSpec("Cov");
  spec.domains = [
    {
      id: "core",
      title: "Core",
      scope: "api + web",
      critical: true,
      questions: ["q1"],
      sourceIds: ["api", "web"],
      coverageUnitIds: ["api", "web"],
    },
  ];
  spec.pages = [
    {
      path: "overview.md",
      purpose: "overview",
      domainIds: ["core"],
      questions: [],
      critical: true,
      coverageUnitIds: ["api", "web"],
    },
  ];
  const plan = compileExecutionPlan(spec);
  assert.equal(plan.workUnits.length, 1);
  assert.deepEqual(plan.workUnits[0]?.sourceIds, ["api", "web"]);
  assert.deepEqual(plan.workUnits[0]?.coverageUnitIds, ["api", "web"]);
});

test("compileExecutionPlan fails closed when coveragePlan has gaps", () => {
  const spec = defaultWikiRunSpec("Gap");
  spec.domains = [
    {
      id: "core",
      title: "Core",
      scope: "frontend only",
      critical: true,
      questions: ["q"],
      sourceIds: ["frontend"],
    },
  ];
  spec.pages = [
    {
      path: "overview.md",
      purpose: "overview",
      domainIds: ["core"],
      questions: [],
      critical: true,
      sourceIds: ["frontend"],
    },
  ];
  const coveragePlan = CoveragePlanSchema.parse({
    requiredUnits: [sourceCoverageUnit("frontend"), sourceCoverageUnit("backend")],
    cancelled: [],
  });
  assert.throws(
    () => compileExecutionPlan(spec, { coveragePlan }),
    ExecutionPlanCompileError,
  );
  assert.throws(
    () => compileExecutionPlan(spec, { coveragePlan }),
    /coverage gate failed|gap/,
  );
});

test("compileExecutionPlan accepts Spec that covers all required units", () => {
  const spec = defaultWikiRunSpec("Ok");
  spec.domains = [
    {
      id: "core",
      title: "Core",
      scope: "both",
      critical: true,
      questions: ["q"],
      coverageUnitIds: ["frontend", "backend"],
    },
  ];
  spec.pages = [
    {
      path: "overview.md",
      purpose: "overview",
      domainIds: ["core"],
      questions: [],
      critical: true,
      coverageUnitIds: ["frontend", "backend"],
    },
  ];
  const coveragePlan = CoveragePlanSchema.parse({
    requiredUnits: [sourceCoverageUnit("frontend"), sourceCoverageUnit("backend")],
    cancelled: [],
  });
  const plan = compileExecutionPlan(spec, { coveragePlan });
  assert.equal(plan.workUnits.length, 1);
  assert.ok(plan.workUnits[0]?.coverageUnitIds?.includes("frontend"));
});
