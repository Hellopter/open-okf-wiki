/**
 * Pure format helpers for the Composer context-fill chip.
 * (Component render coverage is e2e; unit-test the contract format path here.)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatContextFill } from "@okf-wiki/contract";

describe("Composer context-fill chip data", () => {
  it("formats the MVP label 12.4k / 128k", () => {
    const view = formatContextFill({
      contextTokens: 12_400,
      contextWindow: 128_000,
      contextTarget: 108_800,
    });
    assert.ok(view);
    assert.equal(view.label, "12.4k / 128k");
    assert.ok(view.percent !== null && view.percent > 0);
  });

  it("hides without tokens", () => {
    assert.equal(formatContextFill({ contextWindow: 128_000 }), null);
    assert.equal(formatContextFill(null), null);
  });
});
