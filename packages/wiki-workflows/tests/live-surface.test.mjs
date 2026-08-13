import assert from "node:assert/strict";
import test from "node:test";
import { wikiFooterStatus, wikiWidgetLines } from "../dist/ui/live-surface.js";
import { formatLocalDateTime } from "../dist/time-format.js";

const now = Date.parse("2026-08-12T00:01:00.000Z");
function view(overrides = {}) {
  return { id: "run-1", cwd: "/repo", operation: "update", status: "running", createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:01:00.000Z", lastEventSequence: 1, ...overrides };
}
function lead(overrides = {}) {
  return { target: { kind: "lead" }, role: "lead", status: "running", attempt: 1, activity: "synthesizing", activeTools: [], health: "healthy", lastActivityAt: "2026-08-12T00:00:57.000Z", lastHeartbeatAt: "2026-08-12T00:00:59.000Z", usage: { turns: 8, contextPercent: 24 }, ...overrides };
}

test("footer reports leader activity, context, terminal and quota state", () => {
  assert.equal(wikiFooterStatus(view({ progress: { stage: "lead", lead: lead() } }), now), "wiki ◆ lead · synthesizing · activity 3s · ctx 24%");
  assert.equal(wikiFooterStatus(view({ status: "succeeded" })), "wiki ✓ published");
  assert.equal(wikiFooterStatus(view({ status: "failed", progress: { language: "zh" } })), "wiki ✗ 失败");
  assert.equal(wikiFooterStatus(view({ status: "paused", pause: { reason: "quota", summary: "limited", retryAt: "2026-08-12T14:20:00.000Z" } })), `wiki ⏸ quota · retry ${formatLocalDateTime("2026-08-12T14:20:00.000Z")}`);
});

test("widget always exposes leader and caps current batch at six lines", () => {
  assert.deepEqual(wikiWidgetLines(view(), now), ["LEAD  ◆ starting"]);
  const tasks = [
    { id: "bad", role: "review", status: "failed", summary: "validation" },
    { id: "active", role: "write", status: "running", health: "degraded", activeTool: { name: "read", startedAt: "2026-08-12T00:00:50Z" } },
    { id: "queued", role: "research", status: "queued" },
    { id: "done", role: "write", status: "complete" },
    { id: "done-2", role: "review", status: "complete" },
  ];
  const lines = wikiWidgetLines(view({ progress: { stage: "lead", lead: lead(), currentBatch: { batch: 2, status: "running", completed: 2, total: 5, tasks } } }), now);
  assert.equal(lines.length, 6);
  assert.match(lines[0], /^LEAD  ◆ synthesizing · alive 1s · activity 3s · 8t · ctx 24%$/);
  assert.equal(lines[1], "BATCH 2  2/5");
  assert.match(lines[2], /✗ review  bad/);
  assert.match(lines[3], /! write  active · read · observability degraded/);
  assert.equal(lines.at(-1), "  +2 more");
});

test("long wait distinguishes Pi silence from session liveness", () => {
  const footer = wikiFooterStatus(view({ progress: { stage: "lead", lead: lead({ warning: "long_wait", lastActivityAt: "2026-08-11T23:58:00Z" }) } }), now);
  assert.equal(footer, "wiki ! lead · no Pi activity 3m · session alive 1s");
});

test("observability health comes from the agent snapshot, independent of the activity tail", () => {
  const warnings = Array.from({ length: 25 }, (_, index) => ({ sequence: index + 1, at: "2026-08-12T00:00:58Z", kind: "warning", severity: "warning", target: { kind: "lead" }, message: `ordinary warning ${index}` }));
  const failed = view({ progress: { stage: "lead", lead: lead({ health: "degraded" }), recentActivity: warnings } });
  assert.equal(wikiFooterStatus(failed, now), "wiki ! lead · observability degraded");
  assert.match(wikiWidgetLines(failed, now)[0], /!.*observability degraded/);
  const recovered = view({ progress: { stage: "lead", lead: lead({ health: "healthy" }), recentActivity: warnings } });
  assert.equal(wikiFooterStatus(recovered, now), "wiki ◆ lead · synthesizing · activity 3s · ctx 24%");
  assert.doesNotMatch(wikiWidgetLines(recovered, now)[0], /degraded/);
});
