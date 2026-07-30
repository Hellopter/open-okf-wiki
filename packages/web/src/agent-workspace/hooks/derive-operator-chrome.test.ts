import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveOperatorChrome, type ActiveRunChrome } from "./derive-operator-chrome.ts";

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

// resolveActiveRunId deleted (Phase 6): URL ?run= is the only active-run authority.