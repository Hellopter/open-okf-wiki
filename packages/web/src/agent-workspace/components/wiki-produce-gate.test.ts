/**
 * Live-gate binding: only the pendingGate-matched card is interactive.
 * Pure helper tests (no React DOM) — panel gates on isLiveWikiProduceGate.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLiveWikiProduceGate, type AgentPendingGate } from "@okf-wiki/contract";

describe("wiki_produce gate interactivity", () => {
  const live: AgentPendingGate = {
    toolCallId: "tool-live",
    runId: "run-1",
    gate: "plan",
  };

  it("matching pendingGate is interactive (Approve/Deny would render)", () => {
    assert.equal(
      isLiveWikiProduceGate(live, "tool-live", {
        status: "awaiting_plan",
        runId: "run-1",
      }),
      true,
    );
  });

  it("without pendingGate is not interactive (no agent-gate-approve)", () => {
    assert.equal(
      isLiveWikiProduceGate(null, "tool-live", {
        status: "awaiting_plan",
        runId: "run-1",
      }),
      false,
    );
  });

  it("stale card with same status but different toolCallId is not interactive", () => {
    assert.equal(
      isLiveWikiProduceGate(live, "tool-stale", {
        status: "awaiting_plan",
        runId: "run-1",
      }),
      false,
    );
  });

  it("stale card with different runId is not interactive", () => {
    assert.equal(
      isLiveWikiProduceGate(live, "tool-live", {
        status: "awaiting_plan",
        runId: "run-other",
      }),
      false,
    );
  });

  it("publication gate requires awaiting_publication status", () => {
    const pub: AgentPendingGate = {
      toolCallId: "tool-live",
      runId: "run-1",
      gate: "publication",
    };
    assert.equal(
      isLiveWikiProduceGate(pub, "tool-live", {
        status: "awaiting_plan",
        runId: "run-1",
      }),
      false,
    );
    assert.equal(
      isLiveWikiProduceGate(pub, "tool-live", {
        status: "awaiting_publication",
        runId: "run-1",
      }),
      true,
    );
  });
});
