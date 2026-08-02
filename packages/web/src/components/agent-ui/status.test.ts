import assert from "node:assert/strict";
import test from "node:test";
import {
  describeAttemptStatus,
  describeConnectionStatus,
  describeNodeStatus,
  describeRunStatus,
  describeStatus,
  describeToolStatus,
} from "./status.ts";

test("describeToolStatus maps the tool lifecycle", () => {
  assert.equal(describeToolStatus("pending").tone, "neutral");
  assert.equal(describeToolStatus("pending").motion, "none");
  assert.equal(describeToolStatus("running").motion, "spin");
  assert.equal(describeToolStatus("running").badgeVariant, "default");
  assert.equal(describeToolStatus("done").tone, "success");
  assert.equal(describeToolStatus("error").tone, "destructive");
  assert.equal(describeToolStatus("error").badgeVariant, "destructive");
});

test("describeRunStatus covers terminal and waiting states", () => {
  assert.equal(describeRunStatus("queued").tone, "neutral");
  assert.equal(describeRunStatus("running").motion, "spin");
  assert.equal(describeRunStatus("waiting_for_operator").tone, "warning");
  assert.equal(describeRunStatus("waiting_for_operator").motion, "pulse");
  assert.equal(describeRunStatus("failed").tone, "destructive");
  assert.equal(describeRunStatus("published").tone, "success");
  assert.equal(describeRunStatus("cancelling").motion, "spin");
  assert.equal(describeRunStatus("cancelled").tone, "neutral");
  assert.equal(describeRunStatus("completed_unpublished").tone, "success");
  assert.equal(describeRunStatus("publication_declined").tone, "destructive");
});

test("describeNodeStatus maps graph node states with semantic surfaces", () => {
  assert.equal(describeNodeStatus("blocked").tone, "neutral");
  assert.equal(describeNodeStatus("running").motion, "spin");
  assert.match(describeNodeStatus("running").surfaceClass, /primary/);
  assert.equal(describeNodeStatus("waiting").tone, "warning");
  assert.equal(describeNodeStatus("succeeded").tone, "success");
  assert.match(describeNodeStatus("succeeded").surfaceClass, /success/);
  assert.equal(describeNodeStatus("failed").tone, "destructive");
  assert.match(describeNodeStatus("failed").surfaceClass, /destructive/);
  assert.equal(describeNodeStatus("invalidated").tone, "warning");
  assert.equal(describeNodeStatus("cancelled").tone, "neutral");
});

test("describeConnectionStatus maps live channel states", () => {
  assert.equal(describeConnectionStatus("connecting").motion, "spin");
  assert.equal(describeConnectionStatus("live").tone, "success");
  assert.equal(describeConnectionStatus("reconnecting").tone, "warning");
  assert.equal(describeConnectionStatus("offline").tone, "destructive");
});

test("describeAttemptStatus maps attempt generation states", () => {
  assert.equal(describeAttemptStatus("running").motion, "spin");
  assert.equal(describeAttemptStatus("succeeded").tone, "success");
  assert.equal(describeAttemptStatus("failed").tone, "destructive");
  assert.equal(describeAttemptStatus("suspended").motion, "pulse");
  assert.equal(describeAttemptStatus("interrupted").tone, "warning");
  assert.equal(describeAttemptStatus("cancelled").tone, "neutral");
});

test("unknown statuses fall back to neutral outline", () => {
  const unknown = describeToolStatus("not-a-real-status");
  assert.equal(unknown.tone, "neutral");
  assert.equal(unknown.motion, "none");
  assert.equal(unknown.badgeVariant, "outline");
  assert.equal(describeStatus("run", "mystery").badgeVariant, "outline");
  assert.equal(describeStatus("node", "").tone, "neutral");
});

test("surfaces never use raw emerald/amber palette classes", () => {
  const samples = [
    describeToolStatus("done"),
    describeNodeStatus("succeeded"),
    describeNodeStatus("waiting"),
    describeRunStatus("waiting_for_operator"),
  ];
  for (const d of samples) {
    assert.doesNotMatch(d.surfaceClass, /emerald|amber|#[0-9a-fA-F]{3,8}/);
  }
});
