/**
 * Documents shell single-subscription matching for gate/inspector consumers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  selectMatchingProjection,
  type WikiRunProjectionContextValue,
} from "./wiki-run-projection.ts";

function projection(
  partial: Partial<WikiRunProjectionContextValue> &
    Pick<WikiRunProjectionContextValue, "runId" | "subscribed">,
): WikiRunProjectionContextValue {
  return {
    snapshot: null,
    cursor: null,
    ready: false,
    connectionStatus: "offline",
    error: null,
    eventsUrl: null,
    refresh: async () => {},
    ...partial,
  };
}

describe("selectMatchingProjection", () => {
  it("matches only when shell is subscribed to the same runId", () => {
    const shell = projection({
      runId: "run-1",
      subscribed: true,
      ready: true,
      connectionStatus: "live",
      snapshot: {
        schema: "okf.wiki-runs/v2",
        definitionVersion: 2,
        runId: "run-1",
        workspaceId: "ws-1",
        revision: 1,
        state: "running",
        cancelRequested: false,
        intent: { mode: "generate" },
        pinnedInputs: null,
        nodes: [],
        attempts: [],
        gates: [],
        effects: [],
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    });

    const hit = selectMatchingProjection(shell, "run-1");
    assert.equal(hit.matches, true);
    assert.equal(hit.snapshot?.runId, "run-1");
    assert.equal(hit.connectionStatus, "live");

    const miss = selectMatchingProjection(shell, "run-other");
    assert.equal(miss.matches, false);
    assert.equal(miss.snapshot, null);
    assert.equal(miss.connectionStatus, "offline");
  });

  it("does not match idle / unsubscribed shell defaults", () => {
    const idle = projection({ runId: null, subscribed: false });
    const result = selectMatchingProjection(idle, "run-1");
    assert.equal(result.matches, false);
    assert.equal(result.ready, false);
  });

  it("drops cross-run stale ready/error while shell runId already advanced", () => {
    const shell = projection({
      runId: "run-new",
      subscribed: true,
      ready: true,
      connectionStatus: "live",
      error: "stale from previous run",
      snapshot: {
        schema: "okf.wiki-runs/v2",
        definitionVersion: 2,
        runId: "run-old",
        workspaceId: "ws-1",
        revision: 1,
        state: "running",
        cancelRequested: false,
        intent: { mode: "generate" },
        pinnedInputs: null,
        nodes: [],
        attempts: [],
        gates: [],
        effects: [],
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    });

    const hit = selectMatchingProjection(shell, "run-new");
    assert.equal(hit.matches, true);
    assert.equal(hit.snapshot, null);
    assert.equal(hit.ready, false);
    assert.equal(hit.error, null);
  });
});
