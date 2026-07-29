import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composeSessionUsage,
  sessionUsageFromPiEvent,
  sessionUsageFromPiRows,
} from "./session-usage.ts";

describe("composeSessionUsage", () => {
  it("fills window from defaults when tokens present", () => {
    const usage = composeSessionUsage({ contextTokens: 12_400 });
    assert.ok(usage);
    assert.equal(usage.contextTokens, 12_400);
    assert.ok(usage.contextWindow && usage.contextWindow >= 4096);
  });

  it("returns undefined without tokens (no empty-session noise)", () => {
    assert.equal(composeSessionUsage({}), undefined);
  });
});

describe("sessionUsageFromPiRows", () => {
  it("reads last assistant totalTokens", () => {
    const usage = sessionUsageFromPiRows([
      { role: "assistant", usage: { totalTokens: 100 } },
      { role: "assistant", usage: { totalTokens: 2500 } },
    ]);
    assert.equal(usage?.contextTokens, 2500);
  });
});

describe("sessionUsageFromPiEvent", () => {
  it("updates on message_end with usage", () => {
    const next = sessionUsageFromPiEvent(
      {
        type: "message_end",
        message: { role: "assistant", usage: { totalTokens: 333 } },
      },
      undefined,
    );
    assert.equal(next?.contextTokens, 333);
  });

  it("skips identical prior", () => {
    const prior = composeSessionUsage({ contextTokens: 333 });
    const next = sessionUsageFromPiEvent(
      {
        type: "message_end",
        message: { role: "assistant", usage: { totalTokens: 333 } },
      },
      prior,
    );
    assert.equal(next, undefined);
  });

  it("ignores non message_end", () => {
    assert.equal(
      sessionUsageFromPiEvent({ type: "message_update", message: {} }, undefined),
      undefined,
    );
  });
});
