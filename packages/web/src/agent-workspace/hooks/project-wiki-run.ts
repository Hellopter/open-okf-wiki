/**
 * Pure WikiRuns SSE projection helpers (no React / fetch).
 * useWikiRun applies these; unit tests import from here.
 */

import type { WikiRunEvent, WikiRunSnapshot } from "@okf-wiki/contract";
import { WikiRunEventSchema, WikiRunSnapshotSchema } from "@okf-wiki/contract";

export type WikiRunProjection = {
  snapshot: WikiRunSnapshot | null;
  /** Last applied SSE event id / cursor (monotone). */
  cursor: number | null;
  error: string | null;
};

export type WikiRunSseFrame =
  | { kind: "snapshot"; cursor: number; snapshot: WikiRunSnapshot }
  | { kind: "run.event"; event: WikiRunEvent }
  | { kind: "error"; message: string };

export function emptyWikiRunProjection(): WikiRunProjection {
  return { snapshot: null, cursor: null, error: null };
}

/**
 * Pure reducer: replace projection only when the frame's event id is newer
 * than the applied cursor (or state is empty). Stale/duplicate frames are no-ops.
 */
export function applyWikiRunFrame(
  state: WikiRunProjection,
  frame: WikiRunSseFrame,
): WikiRunProjection {
  if (frame.kind === "error") {
    return { ...state, error: frame.message };
  }

  if (frame.kind === "snapshot") {
    const id = frame.cursor;
    if (state.cursor != null && id < state.cursor) return state;
    // Equal cursor with existing snapshot: keep (idempotent reconnect).
    if (state.cursor != null && id === state.cursor && state.snapshot != null) {
      return { ...state, error: null };
    }
    return {
      snapshot: frame.snapshot,
      cursor: id,
      error: null,
    };
  }

  // run.event — full snapshot on the event; apply by eventId only.
  const id = frame.event.eventId;
  if (state.cursor != null && id <= state.cursor) return state;
  return {
    snapshot: frame.event.snapshot,
    cursor: id,
    error: null,
  };
}

/** Parse a named SSE data payload into a projection frame (or null if ignore). */
export function parseWikiRunSseData(eventName: string, raw: string): WikiRunSseFrame | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (eventName === "snapshot") {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const row = data as Record<string, unknown>;
    if (typeof row.error === "string" && row.error.trim()) {
      return { kind: "error", message: row.error.trim() };
    }
    const snap = WikiRunSnapshotSchema.safeParse(row.snapshot);
    if (!snap.success) return null;
    const cursor =
      typeof row.cursor === "number" && Number.isSafeInteger(row.cursor)
        ? row.cursor
        : snap.data.revision;
    return { kind: "snapshot", cursor, snapshot: snap.data };
  }

  if (eventName === "run.event") {
    const parsed = WikiRunEventSchema.safeParse(data);
    if (!parsed.success) return null;
    return { kind: "run.event", event: parsed.data };
  }

  // Heartbeat / unknown — ignore.
  return null;
}
