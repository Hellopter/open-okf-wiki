import assert from "node:assert/strict";
import test from "node:test";
import { projectWikiRunView } from "../dist/run-view.js";

function metrics() {
  return { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3, cost: 0, compactions: 0, autoRetries: 0 };
}

function node(id, kind, status, extra = {}) {
  return {
    id, kind, label: id, status, dependsOn: ["internal-parent"], attempt: 1,
    inputFingerprint: "private-fingerprint", input: { verificationGroupId: "private-group", prompt: "private" },
    result: { internal: "payload" }, attemptHistory: [], metrics: metrics(),
    activity: { state: status === "running" ? "running" : "completed", message: "working", updatedAt: "2026-08-12T00:00:00.000Z" },
    output: "bounded output", history: [{ at: "2026-08-12T00:00:00.000Z", kind: "message", text: "bounded history" }],
    ...extra,
  };
}

function snapshot(status = "running") {
  return {
    version: 2, id: "run-1", cwd: "/workspace", requestedMode: "generate", language: "zh", focus: "core",
    status, round: 0, sourceRestartCount: 0, maxResearchRounds: 6,
    policy: { secret: "must not leak" }, policyHash: "private-policy-hash",
    nodes: [
      node("inspect", "inspect", "succeeded", { dependsOn: [] }),
      node("research", "research", status === "running" ? "running" : "failed"),
    ],
    events: [{ id: "event", at: "2026-08-12T00:00:00.000Z", kind: "node_started", data: { private: true } }],
    createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:01:00.000Z",
  };
}

test("projectWikiRunView exposes display state without durable DAG or policy internals", () => {
  const source = snapshot();
  const view = projectWikiRunView(source, { activeRunId: "run-1", liveNodeIds: ["research"] });

  assert.deepEqual(view.progress, { total: 2, queued: 0, running: 1, succeeded: 1, failed: 0 });
  assert.deepEqual(view.allowedActions, { pause: true, resume: false, stop: true, cancel: true, retry: false, delete: false });
  assert.equal(view.phases[0].status, "succeeded");
  assert.equal(view.phases[1].agents[0].live, true);
  assert.equal(view.phases[1].agents[0].retainedOutput, "bounded output");
  assert.equal("nodes" in view, false);
  assert.equal("events" in view, false);
  assert.equal("policy" in view, false);
  assert.equal("dependsOn" in view.phases[1].agents[0], false);
  assert.equal("input" in view.phases[1].agents[0], false);
  assert.equal("result" in view.phases[1].agents[0], false);
});

test("projection clones nested display data", () => {
  const source = snapshot();
  const view = projectWikiRunView(source);
  view.phases[1].agents[0].activity.message = "changed";
  view.phases[1].agents[0].retainedHistory[0].text = "changed";
  assert.equal(source.nodes[1].activity.message, "working");
  assert.equal(source.nodes[1].history[0].text, "bounded history");
});

test("allowed actions distinguish the active paused run from terminal history", () => {
  const paused = projectWikiRunView(snapshot("paused"), { activeRunId: "run-1" });
  assert.deepEqual(paused.allowedActions, { pause: false, resume: true, stop: true, cancel: true, retry: true, delete: false });

  const historical = projectWikiRunView(snapshot("failed"), { activeRunId: "another-run" });
  assert.deepEqual(historical.allowedActions, { pause: false, resume: false, stop: false, cancel: false, retry: true, delete: true });
  assert.equal(historical.progress.failed, 1);
});
