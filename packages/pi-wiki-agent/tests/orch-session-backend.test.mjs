import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createMockAgentRunner,
  createSessionOrchestrator,
  WikiRunStore,
} from "../dist/orch/index.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "orch-session-"));
}

function writeJson(file, value) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seedInventory(workdir, n = 4) {
  mkdirSync(join(workdir, "inputs"), { recursive: true });
  const units = Array.from({ length: n }, (_, i) => ({
    id: `unit-${i + 1}`,
    kind: "source",
    sourceId: `s${i + 1}`,
    path: ".",
    required: true,
  }));
  writeJson(join(workdir, "inputs", "inventory.json"), { version: 1, coverageUnits: units });
  writeJson(join(workdir, "inputs", "run-policy.json"), { limits: { maxCoveragePasses: 2 } });
}

function makeCore(workdir, { startAt = "survey", hangPrepare = false } = {}) {
  const calls = { prepare: 0, merge: 0, publish: [] };
  return {
    calls,
    core: {
      async prepareRun(root, opts) {
        calls.prepare += 1;
        if (hangPrepare) {
          await new Promise(() => {});
        }
        return {
          status: "ok",
          runId: "domain-session-1",
          workdir,
          workspaceRoot: root,
          mode: opts.mode,
          startAt,
        };
      },
      async mergeSurveyReceipts(_root, opts) {
        calls.merge += 1;
        return {
          status: "ok",
          pass: opts.pass,
          artifactsPath: `analysis/receipts/discovery-artifacts-pass-${opts.pass}.json`,
          missingUnitIds: [],
          retryUnitIds: [],
          needsDomainLabels: false,
        };
      },
      async publishCheckpoint(_root, opts) {
        calls.publish.push(opts.phase);
        return { status: "ok", summary: `published ${opts.phase}` };
      },
    },
  };
}

test("start returns orchRunId immediately and backend is session", async () => {
  const root = tempRoot();
  const workdir = join(root, "wd");
  seedInventory(workdir);
  const { core } = makeCore(workdir);

  // Slow agent so start can return before completion
  const agentRunner = createMockAgentRunner(async () => {
    await new Promise((r) => setTimeout(r, 30));
    return { status: "ok", summary: "ok" };
  });

  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core,
    getTools: () => [],
    agentRunner,
    limits: { heartbeatMs: 60_000 },
  });

  try {
    const started = await orch.start({ workspaceRoot: root, mode: "plan" });
    assert.ok(started.orchRunId);
    assert.match(started.orchRunId, /^session-/);
    assert.equal(orch.backend, "session");

    const snap = orch.getSnapshot(started.orchRunId);
    assert.ok(snap);
    assert.equal(snap.backend, "session");
    assert.equal(snap.overall, "running");
    assert.equal(snap.mode, "plan");

    await orch.waitFor(started.orchRunId);
    const done = orch.getSnapshot(started.orchRunId);
    assert.equal(done.overall, "completed");
    assert.equal(done.domainRunId, "domain-session-1");
    assert.ok(done.phases.some((p) => p.name === "Gate" && p.status === "done"));
  } finally {
    orch.dispose();
  }
});

test("agents appear in snapshot during/after plan path", async () => {
  const root = tempRoot();
  const workdir = join(root, "wd");
  seedInventory(workdir, 5);
  const { core } = makeCore(workdir);
  const seen = [];

  const agentRunner = createMockAgentRunner(async (req) => {
    seen.push(req.label);
    return { status: "ok", summary: req.label };
  });

  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core,
    getTools: () => [],
    agentRunner,
    limits: { maxSurveyLanes: 4, targetUnitsPerLane: 2, heartbeatMs: 60_000 },
  });

  try {
    const { orchRunId } = await orch.start({ workspaceRoot: root, mode: "auto" });
    await orch.waitFor(orchRunId);

    const snap = orch.getSnapshot(orchRunId);
    assert.ok(snap.agents.length >= 2, `expected agents, got ${snap.agents.length}`);
    // host prepare row + survey lanes + plan
    assert.ok(snap.agents.some((a) => a.agentId === "host:prepare"));
    assert.ok(snap.agents.some((a) => a.role === "survey"));
    assert.ok(snap.agents.some((a) => a.role === "plan" || a.label === "plan-spec"));
    assert.ok(seen.some((l) => l.startsWith("survey:")));
    assert.ok(seen.includes("plan-spec"));

    // Transcript path may be empty (no onHistory from mock), but getTranscript is safe
    const planAgent = snap.agents.find((a) => a.label === "plan-spec");
    assert.ok(planAgent);
    const lines = await orch.getTranscript(planAgent.agentId, {}, orchRunId);
    assert.ok(Array.isArray(lines));
  } finally {
    orch.dispose();
  }
});

test("stop cancels a running session run", async () => {
  const root = tempRoot();
  const workdir = join(root, "wd");
  seedInventory(workdir);
  const { core } = makeCore(workdir);

  let releaseAgent;
  const gate = new Promise((resolve) => {
    releaseAgent = resolve;
  });

  const agentRunner = createMockAgentRunner(async (req) => {
    if (req.role === "survey") {
      await gate;
      if (req.signal.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
    }
    return { status: "ok", summary: "ok" };
  });

  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core,
    getTools: () => [],
    agentRunner,
    limits: { heartbeatMs: 60_000, agentTimeoutMs: 120_000 },
  });

  try {
    const { orchRunId } = await orch.start({ workspaceRoot: root, mode: "plan" });
    // Wait until overall is running and preferably an agent has started
    for (let i = 0; i < 50; i++) {
      const s = orch.getSnapshot(orchRunId);
      if (s?.agents.some((a) => a.role === "survey" && a.status === "running")) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const stopped = await orch.stop(orchRunId);
    assert.equal(stopped, true);
    assert.equal(orch.getSnapshot(orchRunId)?.overall, "cancelled");

    releaseAgent();
    await orch.waitFor(orchRunId);
    // Remains cancelled (not overwritten to completed)
    assert.equal(orch.getSnapshot(orchRunId)?.overall, "cancelled");
  } finally {
    orch.dispose();
  }
});

test("list / subscribe / updateSnapshot work", async () => {
  const root = tempRoot();
  const workdir = join(root, "wd");
  seedInventory(workdir, 1);
  const { core } = makeCore(workdir, { startAt: "gate" });

  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core,
    getTools: () => [],
    agentRunner: createMockAgentRunner(async () => ({ status: "ok" })),
  });

  try {
    const events = [];
    const unsub = orch.subscribe((snap, e) => {
      if (e) events.push(e.type);
    });

    const { orchRunId } = await orch.start({ workspaceRoot: root, mode: "plan", focus: "auth" });
    await orch.waitFor(orchRunId);

    const listed = orch.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].orchRunId, orchRunId);
    assert.equal(listed[0].backend, "session");

    orch.updateSnapshot((s) => {
      s.focus = "updated-focus";
    }, orchRunId);
    assert.equal(orch.getSnapshot(orchRunId)?.focus, "updated-focus");

    assert.ok(events.includes("orch.started"));
    assert.ok(events.includes("orch.completed") || events.includes("phase.completed"));
    unsub();
  } finally {
    orch.dispose();
  }
});

test("resume restarts wiki path from prepare after pause", async () => {
  const root = tempRoot();
  const workdir = join(root, "wd");
  seedInventory(workdir, 1);
  let prepareCalls = 0;
  const base = makeCore(workdir, { startAt: "gate" });
  const core = {
    ...base.core,
    prepareRun: async (...args) => {
      prepareCalls++;
      if (prepareCalls === 1) {
        // Hang the first run so we can pause while running.
        return new Promise(() => {});
      }
      return base.core.prepareRun(...args);
    },
  };
  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core,
    getTools: () => [],
    agentRunner: createMockAgentRunner(async () => ({ status: "ok" })),
  });
  try {
    const { orchRunId } = await orch.start({ workspaceRoot: root, mode: "plan" });
    assert.equal(await orch.pause(orchRunId), true);
    assert.equal(orch.getSnapshot(orchRunId).overall, "paused");
    assert.equal(await orch.resume(orchRunId), true);
    assert.equal(orch.getSnapshot(orchRunId).overall, "running");
    await orch.waitFor(orchRunId);
    assert.ok(["completed", "failed", "cancelled"].includes(orch.getSnapshot(orchRunId).overall));
    assert.ok(prepareCalls >= 2);
  } finally {
    orch.dispose();
  }
});

test("getSnapshot reloads observation via real WikiRunStore paths", async () => {
  const root = tempRoot();
  const workdir = join(root, "wd");
  seedInventory(workdir, 1);
  const { core } = makeCore(workdir, { startAt: "gate" });
  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core,
    getTools: () => [],
    agentRunner: createMockAgentRunner(async () => ({ status: "ok" })),
  });
  try {
    const { orchRunId } = await orch.start({ workspaceRoot: root, mode: "plan" });
    await orch.waitFor(orchRunId);
    const snap = orch.getSnapshot(orchRunId);
    assert.ok(snap.domainRunId);

    // Bound store path after prepare bindDomain
    const reloaded = new WikiRunStore({
      workspaceRoot: root,
      domainRunId: snap.domainRunId,
      orchRunId,
    });
    assert.equal(reloaded.getSnapshot().overall, "completed");
    assert.ok(reloaded.listEvents().some((e) => e.type === "orch.started"));
  } finally {
    orch.dispose();
  }
});
