import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearErrorFromState, deriveAgentStatus } from "./derive-agent-status.ts";
import { createPiStreamState } from "./project/pi.ts";

describe("deriveAgentStatus", () => {
  it("returns projected error regardless of sending", () => {
    assert.equal(deriveAgentStatus("error", false), "error");
    assert.equal(deriveAgentStatus("error", true), "error");
  });

  it("returns projected streaming over optimistic sending", () => {
    assert.equal(deriveAgentStatus("streaming", false), "streaming");
    assert.equal(deriveAgentStatus("streaming", true), "streaming");
  });

  it("maps between_operations / retrying / compacting to streaming UI", () => {
    assert.equal(deriveAgentStatus("between_operations", false), "streaming");
    assert.equal(deriveAgentStatus("retrying", true), "streaming");
    assert.equal(deriveAgentStatus("compacting", false), "streaming");
  });

  it("keeps optimistic sending over projected idle", () => {
    assert.equal(deriveAgentStatus("idle", true), "sending");
  });

  it("returns idle when neither streaming nor sending nor error", () => {
    assert.equal(deriveAgentStatus("idle", false), "idle");
  });
});

describe("clearErrorFromState", () => {
  it("nulls errorText and resets agentStatus from error to idle", () => {
    const state = {
      ...createPiStreamState(),
      agentStatus: "error" as const,
      errorText: "boom",
      turnActive: true,
    };
    const next = clearErrorFromState(state);
    assert.equal(next.errorText, null);
    assert.equal(next.agentStatus, "idle");
    assert.equal(next.turnActive, true);
    assert.notEqual(next, state);
  });

  it("preserves non-error agentStatus while nulling errorText", () => {
    const state = {
      ...createPiStreamState(),
      agentStatus: "streaming" as const,
      errorText: "stale",
    };
    const next = clearErrorFromState(state);
    assert.equal(next.errorText, null);
    assert.equal(next.agentStatus, "streaming");
  });

  it("still returns a new object when errorText is already null", () => {
    const state = createPiStreamState();
    const next = clearErrorFromState(state);
    assert.equal(next.errorText, null);
    assert.notEqual(next, state);
  });
});
