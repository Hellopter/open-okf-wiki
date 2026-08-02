import assert from "node:assert/strict";
import test from "node:test";
import type { AttemptTraceEvent } from "@okf-wiki/contract";
import { mergeAttemptTraceEvents } from "./trace-events.ts";

function assistant(ordinal: number, content: string): AttemptTraceEvent {
  return {
    trace: 1,
    ordinal,
    at: "2026-08-01T00:00:00.000Z",
    kind: "assistant",
    content,
  };
}

test("mergeAttemptTraceEvents preserves history while appending a live frame", () => {
  const events = mergeAttemptTraceEvents(
    [assistant(1, "first"), assistant(2, "second")],
    [assistant(3, "live")],
  );

  assert.deepEqual(
    events.map((event) => event.ordinal),
    [1, 2, 3],
  );
});

test("mergeAttemptTraceEvents de-duplicates a replayed EventSource frame", () => {
  const events = mergeAttemptTraceEvents(
    [assistant(1, "old"), assistant(2, "before")],
    [assistant(2, "after")],
  );

  assert.equal(events.length, 2);
  assert.equal(events[1]?.kind, "assistant");
  assert.equal(events[1]?.content, "after");
});
