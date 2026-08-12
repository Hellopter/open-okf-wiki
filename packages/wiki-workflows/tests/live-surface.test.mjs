import assert from "node:assert/strict";
import test from "node:test";
import { wikiFooterStatus, wikiSurfaceCleared, wikiWidgetLines } from "../dist/ui/live-surface.js";

function view(overrides = {}) {
  return {
    id: "run-1",
    cwd: "/repo",
    operation: "update",
    status: "running",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    lastEventSequence: 1,
    ...overrides,
  };
}

test("wikiFooterStatus formats running, published, and paused quota lines", () => {
  assert.equal(
    wikiFooterStatus(view({
      progress: {
        stage: "delegate",
        completed: 1,
        total: 3,
        tasks: [
          { id: "t1", role: "research", status: "complete" },
          { id: "t2", role: "write", status: "running" },
          { id: "t3", role: "review", status: "queued" },
        ],
      },
    })),
    "wiki ◆ delegate 1/3 write",
  );
  assert.equal(wikiFooterStatus(view({ status: "succeeded" })), "wiki ✓ published");
  assert.equal(
    wikiFooterStatus(view({
      status: "paused",
      pause: { reason: "quota", summary: "rate limited", retryAt: "2026-08-12T14:20:00.000Z" },
    })),
    "wiki ⏸ quota · retry 14:20",
  );
  assert.equal(wikiFooterStatus(view()), "wiki ◆ running");
  assert.equal(wikiFooterStatus(view({ status: "failed" })), "wiki ✗ failed");
});

test("wikiWidgetLines is a batch header plus iconed task rows", () => {
  assert.equal(wikiWidgetLines(view()), undefined);
  assert.equal(wikiWidgetLines(view({ progress: { stage: "delegate" } })), undefined);
  assert.deepEqual(
    wikiWidgetLines(view({
      progress: {
        stage: "delegate",
        batch: 1,
        completed: 1,
        total: 3,
        tasks: [
          { id: "pages/auth.md", role: "write", status: "running" },
          { id: "pages/sessions.md", role: "review", status: "queued" },
          { id: "pages/done.md", role: "write", status: "complete" },
          { id: "pages/gap.md", role: "review", status: "incomplete" },
          { id: "pages/bad.md", role: "write", status: "failed" },
        ],
      },
    })),
    [
      "batch 1  1/3",
      "  ◆ write  pages/auth.md",
      "  · review  pages/sessions.md",
      "  ✓ write  pages/done.md",
      "  ◐ review  pages/gap.md",
      "  ✗ write  pages/bad.md",
    ],
  );
});

test("wikiSurfaceCleared drops the widget and keeps terminal footers", () => {
  assert.deepEqual(wikiSurfaceCleared(view({ status: "succeeded" })), {
    footer: "wiki ✓ published",
    widget: undefined,
  });
  assert.deepEqual(wikiSurfaceCleared(view({ status: "failed" })), {
    footer: "wiki ✗ failed",
    widget: undefined,
  });
  assert.deepEqual(
    wikiSurfaceCleared(view({
      status: "paused",
      pause: { reason: "quota", summary: "rate limited", retryAt: "2026-08-12T14:20:00.000Z" },
    })),
    { footer: "wiki ⏸ quota · retry 14:20", widget: undefined },
  );
  assert.equal(wikiSurfaceCleared(view()).widget, undefined);
  assert.equal(wikiSurfaceCleared(view()).footer, undefined);
});
