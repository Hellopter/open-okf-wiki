import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  focusAgentWorkspaceRun,
  readAgentWorkspaceRoute,
  reconcileAcceptedReceipt,
  selectAgentWorkspaceAttempt,
  selectAgentWorkspaceRun,
  selectAgentWorkspaceSession,
} from "./workspace-route.ts";

function search(value: string): URLSearchParams {
  return new URLSearchParams(value);
}

describe("Agent Workspace route", () => {
  it("reads the only supported route selections", () => {
    assert.deepEqual(readAgentWorkspaceRoute(search("sessionId=s1&run=r1&attempt=a1")), {
      sessionId: "s1",
      runId: "r1",
      attemptId: "a1",
    });
  });

  it("keeps Run selection when selecting a Session and removes legacy rootPath", () => {
    assert.equal(
      selectAgentWorkspaceSession(
        search("rootPath=%2Ftmp%2Fws&run=r1&attempt=a1"),
        "s2",
      ).toString(),
      "run=r1&attempt=a1&sessionId=s2",
    );
  });

  it("selects a Run by clearing its dependent Attempt and legacy rootPath", () => {
    assert.equal(
      selectAgentWorkspaceRun(
        search("sessionId=s1&rootPath=%2Ftmp%2Fws&attempt=a1"),
        "r2",
      ).toString(),
      "sessionId=s1&run=r2",
    );
  });

  it("focuses a Run with an optional Attempt and keeps rootPath out of the URL", () => {
    assert.equal(
      focusAgentWorkspaceRun(search("sessionId=s1&rootPath=%2Ftmp%2Fws"), "r2", "a2").toString(),
      "sessionId=s1&run=r2&attempt=a2",
    );
    assert.equal(
      selectAgentWorkspaceAttempt(
        search("sessionId=s1&run=r2&rootPath=%2Ftmp%2Fws"),
        null,
      ).toString(),
      "sessionId=s1&run=r2",
    );
  });
});

describe("reconcileAcceptedReceipt", () => {
  it("uses the first ready Session snapshot as a baseline", () => {
    assert.deepEqual(reconcileAcceptedReceipt(undefined, "historical-run"), {
      seenRunId: "historical-run",
      focusRunId: null,
    });
  });

  it("focuses only a newly observed accepted receipt", () => {
    assert.deepEqual(reconcileAcceptedReceipt("r1", "r1"), {
      seenRunId: "r1",
      focusRunId: null,
    });
    assert.deepEqual(reconcileAcceptedReceipt("r1", "r2"), {
      seenRunId: "r2",
      focusRunId: "r2",
    });
  });
});
