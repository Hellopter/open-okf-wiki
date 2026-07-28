import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactionSettingsFromBudget,
  resolveContextBudget,
  resolveSeatContextBudget,
} from "./context-budget.js";

describe("context-budget", () => {
  it("defaults to 128k window and 85% target", () => {
    const b = resolveContextBudget({});
    assert.equal(b.contextWindow, 128_000);
    assert.equal(b.contextTarget, Math.floor(128_000 * 0.85));
    assert.equal(b.reserveTokens, b.contextWindow - b.contextTarget);
    assert.ok(b.reserveTokens >= 2048);
  });

  it("uses maxContextTokens from profile", () => {
    const b = resolveContextBudget({ maxContextTokens: 64_000 });
    assert.equal(b.contextWindow, 64_000);
    assert.equal(b.contextTarget, Math.floor(64_000 * 0.85));
  });

  it("honors explicit contextTargetTokens", () => {
    const b = resolveContextBudget({
      maxContextTokens: 100_000,
      contextTargetTokens: 70_000,
    });
    assert.equal(b.contextWindow, 100_000);
    assert.equal(b.contextTarget, 70_000);
    assert.equal(b.reserveTokens, 30_000);
  });

  it("clamps target below window", () => {
    const b = resolveContextBudget({
      maxContextTokens: 10_000,
      contextTargetTokens: 50_000,
    });
    assert.ok(b.contextTarget < b.contextWindow);
    assert.ok(b.reserveTokens >= 2048);
  });

  it("builds compaction settings", () => {
    const b = resolveContextBudget({ maxContextTokens: 80_000 });
    const c = compactionSettingsFromBudget(b);
    assert.equal(c.enabled, true);
    assert.equal(c.reserveTokens, b.reserveTokens);
    assert.equal(c.keepRecentTokens, b.keepRecentTokens);
  });
});

describe("resolveSeatContextBudget", () => {
  it("uses min(profile, model) when both are set", () => {
    const b = resolveSeatContextBudget({
      maxContextTokens: 200_000,
      modelContextWindow: 64_000,
    });
    assert.equal(b.contextWindow, 64_000);
  });

  it("never exceeds model window when model is known", () => {
    const b = resolveSeatContextBudget({
      maxContextTokens: 1_000_000,
      modelContextWindow: 32_000,
      contextTargetTokens: 500_000,
    });
    assert.equal(b.contextWindow, 32_000);
    assert.ok(b.contextTarget < b.contextWindow);
  });

  it("falls back to profile when model window is unknown", () => {
    const b = resolveSeatContextBudget({ maxContextTokens: 48_000 });
    assert.equal(b.contextWindow, 48_000);
  });

  it("falls back to model when profile max is unset", () => {
    const b = resolveSeatContextBudget({ modelContextWindow: 96_000 });
    assert.equal(b.contextWindow, 96_000);
  });

  it("honors defaultWindow when neither profile nor model is set", () => {
    const b = resolveSeatContextBudget({ defaultWindow: 16_000 });
    assert.equal(b.contextWindow, 16_000);
  });
});
