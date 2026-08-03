import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contextPhaseRingClass,
  contextPhaseTextClass,
  contextPhaseTone,
  isContextNearLimit,
} from "./context-phase.ts";

describe("contextPhaseTone", () => {
  it("maps phases to semantic tones", () => {
    assert.equal(contextPhaseTone("normal"), "neutral");
    assert.equal(contextPhaseTone("unknown"), "neutral");
    assert.equal(contextPhaseTone(undefined), "neutral");
    assert.equal(contextPhaseTone("approaching_target"), "warning");
    assert.equal(contextPhaseTone("at_target"), "destructive");
    assert.equal(contextPhaseTone("compacting"), "info");
  });
});

describe("isContextNearLimit", () => {
  it("is true for approaching and at_target only", () => {
    assert.equal(isContextNearLimit("approaching_target"), true);
    assert.equal(isContextNearLimit("at_target"), true);
    assert.equal(isContextNearLimit("normal"), false);
    assert.equal(isContextNearLimit("compacting"), false);
    assert.equal(isContextNearLimit("unknown"), false);
  });
});

describe("contextPhase classes", () => {
  it("uses warning/destructive stroke tokens near limit", () => {
    assert.match(contextPhaseRingClass("approaching_target"), /warning/);
    assert.match(contextPhaseRingClass("at_target"), /destructive/);
    assert.match(contextPhaseTextClass("approaching_target"), /warning/);
    assert.match(contextPhaseTextClass("normal"), /muted/);
  });
});
