import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveOperatorChrome,
  resolveActiveRunId,
  type ActiveRunChrome,
} from "./derive-operator-chrome.ts";

function run(partial: Partial<ActiveRunChrome> & Pick<ActiveRunChrome, "state">): ActiveRunChrome {
  return {
    runId: partial.runId ?? "run-1",
    state: partial.state,
    openGateKinds: partial.openGateKinds,
    hasRunningAttempt: partial.hasRunningAttempt,
  };
}

describe("deriveOperatorChrome", () => {
  it("idle + null run → no stops, send enabled", () => {
    const chrome = deriveOperatorChrome({ sessionStatus: "idle", activeRun: null });
    assert.equal(chrome.sessionPending, false);
    assert.equal(chrome.runBusy, false);
    assert.equal(chrome.runNeedsOperator, false);
    assert.equal(chrome.showStopSession, false);
    assert.equal(chrome.showStopRun, false);
    assert.equal(chrome.sendDisabled, false);
    assert.equal(chrome.runStatusLabel, undefined);
  });

  it("streaming + run running → stop session + stop run, send disabled", () => {
    const chrome = deriveOperatorChrome({
      sessionStatus: "streaming",
      activeRun: run({ state: "running" }),
    });
    assert.equal(chrome.sessionPending, true);
    assert.equal(chrome.runBusy, true);
    assert.equal(chrome.runNeedsOperator, false);
    assert.equal(chrome.showStopSession, true);
    assert.equal(chrome.showStopRun, true);
    assert.equal(chrome.sendDisabled, true);
    assert.equal(chrome.runStatusLabel, "running");
  });

  it("idle + run running → send enabled, showStopRun only", () => {
    const chrome = deriveOperatorChrome({
      sessionStatus: "idle",
      activeRun: run({ state: "running" }),
    });
    assert.equal(chrome.sessionPending, false);
    assert.equal(chrome.runBusy, true);
    assert.equal(chrome.showStopSession, false);
    assert.equal(chrome.showStopRun, true);
    assert.equal(chrome.sendDisabled, false);
    assert.equal(chrome.runStatusLabel, "running");
  });

  it("idle + waiting_for_operator → runNeedsOperator, no stop run, send enabled", () => {
    const chrome = deriveOperatorChrome({
      sessionStatus: "idle",
      activeRun: run({ state: "waiting_for_operator", openGateKinds: ["plan"] }),
    });
    assert.equal(chrome.sessionPending, false);
    assert.equal(chrome.runBusy, false);
    assert.equal(chrome.runNeedsOperator, true);
    assert.equal(chrome.showStopSession, false);
    assert.equal(chrome.showStopRun, false);
    assert.equal(chrome.sendDisabled, false);
    assert.equal(chrome.runStatusLabel, "waiting_for_operator");
  });

  it("sending alone disables send and shows session stop", () => {
    const chrome = deriveOperatorChrome({ sessionStatus: "sending", activeRun: null });
    assert.equal(chrome.sessionPending, true);
    assert.equal(chrome.showStopSession, true);
    assert.equal(chrome.showStopRun, false);
    assert.equal(chrome.sendDisabled, true);
  });

  it("error keeps send enabled (retry)", () => {
    const chrome = deriveOperatorChrome({
      sessionStatus: "error",
      activeRun: run({ state: "queued" }),
    });
    assert.equal(chrome.sessionPending, false);
    assert.equal(chrome.sendDisabled, false);
    assert.equal(chrome.showStopSession, false);
    assert.equal(chrome.showStopRun, true);
    assert.equal(chrome.runBusy, true);
  });

  it("cancelling counts as runBusy / showStopRun", () => {
    const chrome = deriveOperatorChrome({
      sessionStatus: "idle",
      activeRun: run({ state: "cancelling" }),
    });
    assert.equal(chrome.runBusy, true);
    assert.equal(chrome.showStopRun, true);
  });

  it("terminal run states do not show run chrome", () => {
    for (const state of [
      "published",
      "cancelled",
      "failed",
      "completed_unpublished",
      "publication_declined",
    ] as const) {
      const chrome = deriveOperatorChrome({
        sessionStatus: "idle",
        activeRun: run({ state }),
      });
      assert.equal(chrome.runBusy, false, state);
      assert.equal(chrome.runNeedsOperator, false, state);
      assert.equal(chrome.showStopRun, false, state);
    }
  });
});

describe("resolveActiveRunId", () => {
  it("returns null when nothing is active", () => {
    assert.equal(resolveActiveRunId({ messages: [], recentRuns: [] }), null);
  });

  it("prefers latest accepted wiki_produce runId from messages", () => {
    const id = resolveActiveRunId({
      messages: [
        {
          tools: [{ name: "wiki_produce", details: { status: "accepted", runId: "run-old" } }],
        },
        {
          tools: [{ name: "wiki_produce", details: { status: "accepted", runId: "run-new" } }],
        },
      ],
      recentRuns: [],
    });
    assert.equal(id, "run-new");
  });

  it("skips accepted runId that recentRuns marks terminal", () => {
    const id = resolveActiveRunId({
      messages: [
        {
          tools: [{ name: "wiki_produce", details: { status: "accepted", runId: "run-done" } }],
        },
      ],
      recentRuns: [
        {
          runId: "run-done",
          state: "published",
          updatedAt: "2026-07-28T01:00:00.000Z",
        },
        {
          runId: "run-live",
          state: "running",
          updatedAt: "2026-07-28T02:00:00.000Z",
        },
      ],
    });
    assert.equal(id, "run-live");
  });

  it("falls back to newest non-terminal recentRun", () => {
    const id = resolveActiveRunId({
      messages: [],
      recentRuns: [
        {
          runId: "run-a",
          state: "running",
          updatedAt: "2026-07-28T01:00:00.000Z",
        },
        {
          runId: "run-b",
          state: "queued",
          updatedAt: "2026-07-28T03:00:00.000Z",
        },
        {
          runId: "run-c",
          state: "failed",
          updatedAt: "2026-07-28T04:00:00.000Z",
        },
      ],
    });
    assert.equal(id, "run-b");
  });

  it("ignores non-accepted wiki_produce details", () => {
    const id = resolveActiveRunId({
      messages: [
        {
          tools: [{ name: "wiki_produce", details: { status: "failed", runId: "run-x" } }],
        },
      ],
      recentRuns: [],
    });
    assert.equal(id, null);
  });
});
