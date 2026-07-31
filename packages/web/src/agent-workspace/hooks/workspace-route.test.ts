import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearAgentWorkspaceRun,
  filterRunsForSession,
  focusAgentWorkspaceRun,
  pickRunForSession,
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

  it("clears Run and Attempt selection", () => {
    assert.equal(
      clearAgentWorkspaceRun(search("sessionId=s1&run=r1&attempt=a1&rootPath=%2Ftmp")).toString(),
      "sessionId=s1",
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

describe("pickRunForSession", () => {
  const runs = [
    { runId: "r-live", state: "running", sessionId: "s1" },
    { runId: "r-done", state: "published", sessionId: "s1" },
    { runId: "r-other", state: "running", sessionId: "s2" },
    { runId: "r-orphan", state: "queued", sessionId: null },
  ] as const;

  it("restores the non-terminal linked run after refresh (no preferred)", () => {
    // Bug: page refresh lost ?run=; Session re-entry must rebind from list.
    assert.equal(pickRunForSession(runs, "s1"), "r-live");
  });

  it("falls back to the first linked terminal run when nothing is live", () => {
    // Caller orders newest-first (GET /runs); pick the head of that list.
    assert.equal(
      pickRunForSession(
        [
          { runId: "newest-done", state: "published", sessionId: "s1" },
          { runId: "older-failed", state: "failed", sessionId: "s1" },
        ],
        "s1",
      ),
      "newest-done",
    );
  });

  it("honors boot deep-link preferred run even outside the Session", () => {
    assert.equal(
      pickRunForSession(runs, "s1", {
        preferredRunId: "r-other",
        allowPreferredOutsideSession: true,
      }),
      "r-other",
    );
  });

  it("drops preferred run from another Session on switch", () => {
    assert.equal(
      pickRunForSession(runs, "s1", {
        preferredRunId: "r-other",
        allowPreferredOutsideSession: false,
      }),
      "r-live",
    );
  });

  it("keeps preferred when it belongs to the Session", () => {
    assert.equal(
      pickRunForSession(runs, "s1", {
        preferredRunId: "r-done",
        allowPreferredOutsideSession: false,
      }),
      "r-done",
    );
  });

  it("returns null when the Session has no linked runs", () => {
    assert.equal(pickRunForSession(runs, "s-empty"), null);
  });
});

describe("filterRunsForSession", () => {
  const runs = [
    { runId: "r1", state: "running", sessionId: "s1" },
    { runId: "r2", state: "published", sessionId: "s2" },
  ];

  it("keeps only Session-linked runs plus the current selection", () => {
    assert.deepEqual(
      filterRunsForSession(runs, "s1", "r2").map((r) => r.runId),
      ["r1", "r2"],
    );
    assert.deepEqual(
      filterRunsForSession(runs, "s1").map((r) => r.runId),
      ["r1"],
    );
  });
});
