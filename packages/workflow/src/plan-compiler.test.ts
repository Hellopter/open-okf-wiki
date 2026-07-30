import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { compileExecutionPlan, ExecutionPlanCompileError } from "./plan-compiler.js";

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
  assert.equal(plan.reductions.length, 0);
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
  assert.equal(plan.reductions.length, 0);
});
