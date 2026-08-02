import assert from "node:assert/strict";
import test from "node:test";
import type {
  AttemptTraceEvent,
  WikiRunAttemptTranscript,
  WikiRunSnapshot,
} from "@okf-wiki/contract";
import {
  createRunObservationState,
  hydrateAttemptTimeline,
  mergeAttemptTraceFrame,
  selectObservationNode,
  setObservationSnapshot,
} from "./observation-state.ts";

function assistant(ordinal: number, content: string): AttemptTraceEvent {
  return { trace: 1, ordinal, at: "2026-08-02T00:00:00.000Z", kind: "assistant", content };
}

function snapshot(
  attempts: Array<{ attemptId: string; nodeKey: string; nodeGeneration: number; runIndex: number }>,
  revision = 0,
): WikiRunSnapshot {
  return {
    revision,
    attempts: attempts.map((attempt) => ({
      ...attempt,
      state: "succeeded",
      inputDigest: "a".repeat(64),
      error: null,
      startedAt: "2026-08-02T00:00:00.000Z",
      endedAt: "2026-08-02T00:01:00.000Z",
    })),
  } as unknown as WikiRunSnapshot;
}

test("an older snapshot cannot overwrite a newer durable revision", () => {
  const newest = snapshot(
    [{ attemptId: "new", nodeKey: "write.root", nodeGeneration: 1, runIndex: 2 }],
    2,
  );
  const stale = snapshot(
    [{ attemptId: "old", nodeKey: "plan", nodeGeneration: 0, runIndex: 1 }],
    1,
  );
  const state = setObservationSnapshot(createRunObservationState(newest), stale);

  assert.equal(state.snapshot?.revision, 2);
  assert.equal(state.snapshot?.attempts[0]?.attemptId, "new");
});

function transcript(
  attemptId: string,
  nodeKey: string,
  events: AttemptTraceEvent[],
): WikiRunAttemptTranscript {
  return {
    attemptId,
    nodeKey,
    state: "succeeded",
    events,
    hasEarlier: false,
    hasMore: false,
    cursor: events.at(-1)?.ordinal ?? 0,
  };
}

test("historical selection remains pinned when a newer snapshot arrives", () => {
  const plan = "plan-attempt";
  let state = createRunObservationState(
    snapshot([{ attemptId: plan, nodeKey: "plan", nodeGeneration: 0, runIndex: 1 }]),
  );
  state = selectObservationNode(state, "plan", plan);
  state = setObservationSnapshot(
    state,
    snapshot([
      { attemptId: plan, nodeKey: "plan", nodeGeneration: 0, runIndex: 1 },
      { attemptId: "writer-live", nodeKey: "write.root", nodeGeneration: 0, runIndex: 2 },
    ]),
  );

  assert.equal(state.selectedAttemptId, plan);
  assert.equal(state.selectedNodeKey, "plan");
  assert.equal(state.followMode, "pinned");
});

test("a live frame for another attempt cannot replace selected history", () => {
  const plan = "plan-attempt";
  let state = createRunObservationState(
    snapshot([
      { attemptId: plan, nodeKey: "plan", nodeGeneration: 0, runIndex: 1 },
      { attemptId: "writer-live", nodeKey: "write.root", nodeGeneration: 0, runIndex: 2 },
    ]),
  );
  state = selectObservationNode(state, "plan", plan);
  state = hydrateAttemptTimeline(state, transcript(plan, "plan", [assistant(1, "sealed plan")]));
  state = mergeAttemptTraceFrame(state, {
    attemptId: "writer-live",
    nodeKey: "write.root",
    state: "running",
    events: [assistant(1, "writer output")],
    cursor: 1,
    live: true,
  });

  assert.equal(state.selectedAttemptId, plan);
  assert.equal(state.timelines[plan]?.events[0]?.kind, "assistant");
  assert.equal(state.timelines[plan]?.events[0]?.content, "sealed plan");
});
