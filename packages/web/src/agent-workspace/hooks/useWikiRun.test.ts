/**
 * Pure WikiRuns SSE projection helpers (no DOM / EventSource).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WikiRunEvent, WikiRunSnapshot } from "@okf-wiki/contract";
import {
  applyWikiRunFrame,
  emptyWikiRunProjection,
  parseWikiRunSseData,
} from "./project-wiki-run.ts";

const timestamp = "2026-07-28T00:00:00.000Z";

function snapshot(revision: number, extras: Partial<WikiRunSnapshot> = {}): WikiRunSnapshot {
  return {
    schema: "okf.wiki-runs/v2",
    definitionVersion: 2,
    runId: "run-1",
    workspaceId: "ws-1",
    revision,
    state: "running",
    cancelRequested: false,
    intent: { mode: "generate" },
    pinnedInputs: null,
    nodes: [],
    attempts: [],
    gates: [],
    effects: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extras,
  };
}

function event(eventId: number, revision: number): WikiRunEvent {
  return {
    runId: "run-1",
    eventId,
    revision,
    type: "run.started",
    occurredAt: timestamp,
    snapshot: snapshot(revision),
  };
}

describe("applyWikiRunFrame", () => {
  it("applies first snapshot and sets projection cursor", () => {
    const next = applyWikiRunFrame(emptyWikiRunProjection(), {
      kind: "snapshot",
      cursor: 3,
      snapshot: snapshot(3),
    });
    assert.equal(next.cursor, 3);
    assert.equal(next.snapshot?.revision, 3);
    assert.equal(next.error, null);
  });

  it("ignores stale snapshot with lower cursor", () => {
    const base = applyWikiRunFrame(emptyWikiRunProjection(), {
      kind: "snapshot",
      cursor: 5,
      snapshot: snapshot(5, { state: "waiting_for_operator" }),
    });
    const next = applyWikiRunFrame(base, {
      kind: "snapshot",
      cursor: 2,
      snapshot: snapshot(2, { state: "queued" }),
    });
    assert.equal(next.snapshot?.state, "waiting_for_operator");
    assert.equal(next.cursor, 5);
  });

  it("replaces projection on newer run.event by eventId", () => {
    let state = applyWikiRunFrame(emptyWikiRunProjection(), {
      kind: "snapshot",
      cursor: 1,
      snapshot: snapshot(1),
    });
    state = applyWikiRunFrame(state, {
      kind: "run.event",
      event: event(2, 2),
    });
    assert.equal(state.cursor, 2);
    assert.equal(state.snapshot?.revision, 2);

    const stale = applyWikiRunFrame(state, {
      kind: "run.event",
      event: event(2, 2),
    });
    assert.equal(stale.cursor, 2);
    assert.equal(stale, state);
  });

  it("records error frames without dropping snapshot", () => {
    const base = applyWikiRunFrame(emptyWikiRunProjection(), {
      kind: "snapshot",
      cursor: 1,
      snapshot: snapshot(1),
    });
    const next = applyWikiRunFrame(base, { kind: "error", message: "boom" });
    assert.equal(next.error, "boom");
    assert.equal(next.snapshot?.runId, "run-1");
  });
});

describe("parseWikiRunSseData", () => {
  it("parses snapshot and run.event payloads", () => {
    const snap = parseWikiRunSseData(
      "snapshot",
      JSON.stringify({ snapshot: snapshot(4), cursor: 4 }),
    );
    assert.equal(snap?.kind, "snapshot");
    if (snap?.kind === "snapshot") {
      assert.equal(snap.cursor, 4);
      assert.equal(snap.snapshot.revision, 4);
    }

    const evt = parseWikiRunSseData("run.event", JSON.stringify(event(5, 5)));
    assert.equal(evt?.kind, "run.event");
    if (evt?.kind === "run.event") {
      assert.equal(evt.event.eventId, 5);
    }
  });

  it("parses snapshot error payloads and ignores unknown events", () => {
    const err = parseWikiRunSseData("snapshot", JSON.stringify({ error: "gone" }));
    assert.deepEqual(err, { kind: "error", message: "gone" });
    assert.equal(parseWikiRunSseData("heartbeat", "{}"), null);
    assert.equal(parseWikiRunSseData("run.event", "not-json"), null);
  });
});
