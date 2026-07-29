import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSessionUsage,
  contextFillPercent,
  extractContextTokensFromPiHistory,
  extractContextTokensFromPiMessage,
  formatContextFill,
  formatTokenCount,
  SessionUsageSchema,
} from "./session-usage.js";

describe("SessionUsageSchema", () => {
  it("accepts partial usage", () => {
    const parsed = SessionUsageSchema.parse({
      contextTokens: 12_400,
      contextWindow: 128_000,
    });
    assert.equal(parsed.contextTokens, 12_400);
    assert.equal(parsed.contextWindow, 128_000);
  });

  it("rejects negative tokens", () => {
    assert.equal(SessionUsageSchema.safeParse({ contextTokens: -1 }).success, false);
  });
});

describe("extractContextTokensFromPiHistory", () => {
  it("returns last assistant totalTokens", () => {
    const rows = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [],
        usage: { totalTokens: 100 },
      },
      { role: "user", content: "again" },
      {
        role: "assistant",
        content: [],
        usage: { totalTokens: 2500 },
      },
    ];
    assert.equal(extractContextTokensFromPiHistory(rows), 2500);
  });

  it("skips assistants without usage", () => {
    const rows = [
      { role: "assistant", content: [], usage: { totalTokens: 10 } },
      { role: "assistant", content: [] },
    ];
    assert.equal(extractContextTokensFromPiHistory(rows), 10);
  });

  it("returns undefined when none present", () => {
    assert.equal(extractContextTokensFromPiHistory([{ role: "user" }]), undefined);
  });
});

describe("extractContextTokensFromPiMessage", () => {
  it("reads assistant usage", () => {
    assert.equal(
      extractContextTokensFromPiMessage({
        role: "assistant",
        usage: { totalTokens: 42 },
      }),
      42,
    );
  });

  it("ignores non-assistant", () => {
    assert.equal(
      extractContextTokensFromPiMessage({
        role: "user",
        usage: { totalTokens: 42 },
      }),
      undefined,
    );
  });
});

describe("buildSessionUsage", () => {
  it("returns undefined when empty", () => {
    assert.equal(buildSessionUsage({}), undefined);
  });

  it("keeps only valid fields", () => {
    assert.deepEqual(buildSessionUsage({ contextTokens: 1, contextWindow: 128_000 }), {
      contextTokens: 1,
      contextWindow: 128_000,
    });
  });
});

describe("formatTokenCount", () => {
  it("formats k and M", () => {
    assert.equal(formatTokenCount(0), "0");
    assert.equal(formatTokenCount(999), "999");
    assert.equal(formatTokenCount(1_000), "1k");
    assert.equal(formatTokenCount(12_400), "12.4k");
    assert.equal(formatTokenCount(128_000), "128k");
    assert.equal(formatTokenCount(1_500_000), "1.5M");
  });
});

describe("contextFillPercent + formatContextFill", () => {
  it("computes percent against window", () => {
    assert.equal(contextFillPercent({ contextTokens: 64_000, contextWindow: 128_000 }), 50);
  });

  it("formats 12.4k / 128k", () => {
    const view = formatContextFill({
      contextTokens: 12_400,
      contextWindow: 128_000,
      contextTarget: 108_800,
    });
    assert.ok(view);
    assert.equal(view.label, "12.4k / 128k");
    assert.ok(view.percent !== null && view.percent > 0 && view.percent < 20);
    assert.equal(view.denomKind, "window");
  });

  it("hides when no useful data", () => {
    assert.equal(formatContextFill(undefined), null);
    assert.equal(formatContextFill({}), null);
    assert.equal(formatContextFill({ contextWindow: 128_000 }), null);
    assert.equal(formatContextFill({ contextTokens: 0 }), null);
  });

  it("shows 0 / window when tokens are zero but window known", () => {
    const view = formatContextFill({ contextTokens: 0, contextWindow: 128_000 });
    assert.ok(view);
    assert.equal(view.label, "0 / 128k");
    assert.equal(view.percent, 0);
  });

  it("shows tokens-only when window unknown", () => {
    const view = formatContextFill({ contextTokens: 2500 });
    assert.ok(view);
    assert.equal(view.label, "2.5k");
    assert.equal(view.percent, null);
  });
});
