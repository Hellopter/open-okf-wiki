import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPhaseTransition,
  isPhaseTransitionAllowed,
  phaseAllowsCancel,
  phaseGate,
  recordStatusFromPhase,
  toolStatusFromPhase,
  type WikiRunPhase,
  WikiRunPhaseSchema,
} from "./run-phase.js";

const ALL_PHASES = WikiRunPhaseSchema.options;

test("recordStatusFromPhase folds in-flight sub-phases to running", () => {
  const cases: Array<[WikiRunPhase, string]> = [
    ["freezing", "running"],
    ["planning", "running"],
    ["producing", "running"],
    ["awaiting_plan", "awaiting_plan"],
    ["awaiting_publication", "awaiting_publication"],
    ["published", "published"],
    ["publication_declined", "publication_declined"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ];
  for (const [phase, expected] of cases) {
    assert.equal(recordStatusFromPhase(phase), expected, phase);
  }
});

test("toolStatusFromPhase is identity over all phases", () => {
  for (const phase of ALL_PHASES) {
    assert.equal(toolStatusFromPhase(phase), phase);
  }
});

test("phaseGate only opens on awaiting_* phases", () => {
  assert.equal(phaseGate("awaiting_plan"), "plan");
  assert.equal(phaseGate("awaiting_publication"), "publication");
  for (const phase of ALL_PHASES) {
    if (phase === "awaiting_plan" || phase === "awaiting_publication") continue;
    assert.equal(phaseGate(phase), null, phase);
  }
});

test("phaseAllowsCancel for in-flight and gate phases only", () => {
  const allow = new Set([
    "freezing",
    "planning",
    "producing",
    "awaiting_plan",
    "awaiting_publication",
  ]);
  for (const phase of ALL_PHASES) {
    assert.equal(phaseAllowsCancel(phase), allow.has(phase), phase);
  }
});

test("isPhaseTransitionAllowed covers happy path and rejects terminal exits", () => {
  assert.equal(isPhaseTransitionAllowed("freezing", "planning"), true);
  assert.equal(isPhaseTransitionAllowed("planning", "producing"), true);
  assert.equal(isPhaseTransitionAllowed("planning", "awaiting_plan"), true);
  assert.equal(isPhaseTransitionAllowed("awaiting_plan", "planning"), true);
  assert.equal(isPhaseTransitionAllowed("producing", "awaiting_publication"), true);
  assert.equal(isPhaseTransitionAllowed("published", "producing"), false);
  assert.equal(isPhaseTransitionAllowed("failed", "running" as WikiRunPhase), false);
  assert.equal(isPhaseTransitionAllowed("freezing", "freezing"), true);
});

test("assertPhaseTransition throws on illegal edges", () => {
  assert.doesNotThrow(() => assertPhaseTransition("freezing", "planning"));
  assert.throws(() => assertPhaseTransition("published", "failed"), /Illegal WikiRunPhase/);
});
