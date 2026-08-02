import type {
  AttemptTraceEvent,
  WikiRunAttempt,
  WikiRunAttemptTranscript,
  WikiRunAttemptTranscriptTraceFrame,
  WikiRunSnapshot,
} from "@okf-wiki/contract";
import { mergeAttemptTraceEvents } from "./trace-events.ts";

export type FollowMode = "pinned" | "selected-live";

export type AttemptTimeline = {
  attemptId: string;
  nodeKey: string;
  events: AttemptTraceEvent[];
  cursor: number;
  hasEarlier: boolean;
  nextBefore?: number;
  live: boolean;
  loadingEarlier: boolean;
  error: unknown | null;
};

export type RunObservationState = {
  snapshot: WikiRunSnapshot | null;
  selectedNodeKey: string | null;
  selectedAttemptId: string | null;
  followMode: FollowMode;
  timelines: Record<string, AttemptTimeline | undefined>;
};

export function createRunObservationState(
  snapshot: WikiRunSnapshot | null = null,
): RunObservationState {
  return {
    snapshot,
    selectedNodeKey: null,
    selectedAttemptId: null,
    followMode: "pinned",
    timelines: {},
  };
}

function compareAttempts(left: WikiRunAttempt, right: WikiRunAttempt): number {
  return (
    left.nodeGeneration - right.nodeGeneration ||
    left.runIndex - right.runIndex ||
    left.startedAt.localeCompare(right.startedAt)
  );
}

export function latestAttemptForNode(
  snapshot: WikiRunSnapshot,
  nodeKey: string,
): WikiRunAttempt | null {
  return (
    snapshot.attempts
      .filter((attempt) => attempt.nodeKey === nodeKey)
      .sort(compareAttempts)
      .at(-1) ?? null
  );
}

/**
 * Select by durable ids. Snapshot updates deliberately never invoke this
 * transition, so a retry or a live sibling cannot pull an operator away from
 * a historical attempt they are reading.
 */
export function selectObservationNode(
  state: RunObservationState,
  nodeKey: string,
  attemptId?: string | null,
): RunObservationState {
  const snapshot = state.snapshot;
  const attempt =
    attemptId && snapshot?.attempts.some((item) => item.attemptId === attemptId)
      ? (snapshot.attempts.find((item) => item.attemptId === attemptId) ?? null)
      : snapshot
        ? latestAttemptForNode(snapshot, nodeKey)
        : null;
  return {
    ...state,
    selectedNodeKey: nodeKey,
    selectedAttemptId: attempt?.attemptId ?? null,
    followMode: attempt?.state === "running" ? "selected-live" : "pinned",
  };
}

export function setObservationSnapshot(
  state: RunObservationState,
  snapshot: WikiRunSnapshot,
): RunObservationState {
  // GET and SSE race on first load and after reconnect. Run revisions are
  // monotonic durable truth, so an older frame must never replace newer state.
  if (state.snapshot && snapshot.revision < state.snapshot.revision) return state;
  // Do not replace a selected attempt with the newest generation. A URL may
  // point at older history and that history remains a valid observation target.
  const selectedAttemptId =
    state.selectedAttemptId &&
    snapshot.attempts.some((attempt) => attempt.attemptId === state.selectedAttemptId)
      ? state.selectedAttemptId
      : null;
  const selectedNodeKey = selectedAttemptId
    ? (snapshot.attempts.find((attempt) => attempt.attemptId === selectedAttemptId)?.nodeKey ??
      state.selectedNodeKey)
    : state.selectedNodeKey;
  return { ...state, snapshot, selectedAttemptId, selectedNodeKey };
}

function existingTimeline(
  state: RunObservationState,
  attemptId: string,
  nodeKey: string,
): AttemptTimeline {
  return (
    state.timelines[attemptId] ?? {
      attemptId,
      nodeKey,
      events: [],
      cursor: 0,
      hasEarlier: false,
      live: false,
      loadingEarlier: false,
      error: null,
    }
  );
}

export function hydrateAttemptTimeline(
  state: RunObservationState,
  transcript: WikiRunAttemptTranscript,
  direction: "latest" | "earlier" = "latest",
): RunObservationState {
  const previous = existingTimeline(state, transcript.attemptId, transcript.nodeKey);
  const { nextBefore: _previousNextBefore, ...timelineBase } = previous;
  const timeline: AttemptTimeline = {
    ...timelineBase,
    nodeKey: transcript.nodeKey,
    events: mergeAttemptTraceEvents(previous.events, transcript.events),
    cursor: direction === "latest" ? Math.max(previous.cursor, transcript.cursor) : previous.cursor,
    hasEarlier: transcript.hasEarlier,
    ...(transcript.nextBefore !== undefined ? { nextBefore: transcript.nextBefore } : {}),
    live: transcript.state === "running" || transcript.state === "suspended",
    loadingEarlier: false,
    error: null,
  };
  return { ...state, timelines: { ...state.timelines, [transcript.attemptId]: timeline } };
}

export function mergeAttemptTraceFrame(
  state: RunObservationState,
  frame: WikiRunAttemptTranscriptTraceFrame,
): RunObservationState {
  const previous = existingTimeline(state, frame.attemptId, frame.nodeKey);
  const timeline: AttemptTimeline = {
    ...previous,
    nodeKey: frame.nodeKey,
    events: mergeAttemptTraceEvents(previous.events, frame.events),
    cursor: Math.max(previous.cursor, frame.cursor),
    live: frame.live,
    error: null,
  };
  return { ...state, timelines: { ...state.timelines, [frame.attemptId]: timeline } };
}

export function setTimelineLoadingEarlier(
  state: RunObservationState,
  attemptId: string,
  loadingEarlier: boolean,
): RunObservationState {
  const timeline = state.timelines[attemptId];
  if (!timeline) return state;
  return {
    ...state,
    timelines: { ...state.timelines, [attemptId]: { ...timeline, loadingEarlier } },
  };
}

export function setTimelineError(
  state: RunObservationState,
  attemptId: string,
  error: unknown | null,
): RunObservationState {
  const timeline = state.timelines[attemptId];
  if (!timeline) return state;
  return {
    ...state,
    timelines: { ...state.timelines, [attemptId]: { ...timeline, error, loadingEarlier: false } },
  };
}
