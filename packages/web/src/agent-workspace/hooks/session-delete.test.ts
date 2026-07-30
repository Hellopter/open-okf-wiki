import assert from "node:assert/strict";
import test from "node:test";
import { removeSessionSelection } from "./session-delete.ts";

test("deleting B preserves C selected while the delete request was in flight", () => {
  const result = removeSessionSelection(
    [
      { id: "a", title: "A", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "b", title: "B", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "c", title: "C", updatedAt: "2026-01-01T00:00:00Z" },
    ],
    "b",
    "c",
  );

  assert.deepEqual(
    result.sessions.map((session) => session.id),
    ["a", "c"],
  );
  assert.equal(result.activeSessionId, "c");
});
