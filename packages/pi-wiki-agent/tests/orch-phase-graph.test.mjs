import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adaptiveLaneCount,
  createTaskPool,
  loadInventory,
  mergeOrchLimits,
  runPlanPath,
  shardUnits,
  WikiRunStore,
} from "../dist/orch/index.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "orch-phase-"));
}

function writeJson(file, value) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeUnits(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `unit-${i + 1}`,
    kind: "source",
    sourceId: `src-${i + 1}`,
    path: ".",
    required: true,
  }));
}

function makeCore(overrides = {}) {
  const calls = {
    prepareRun: [],
    mergeSurveyReceipts: [],
    publishCheckpoint: [],
  };
  const workdir = overrides.workdir;
  const core = {
    async prepareRun(root, opts) {
      calls.prepareRun.push({ root, opts });
      if (overrides.prepareRun) return overrides.prepareRun(root, opts, calls);
      return {
        status: "ok",
        runId: "domain-1",
        workdir: workdir ?? join(root, "runs", "domain-1"),
        workspaceRoot: root,
        mode: opts.mode,
        startAt: overrides.startAt ?? "survey",
      };
    },
    async mergeSurveyReceipts(root, opts) {
      calls.mergeSurveyReceipts.push({ root, opts });
      if (overrides.mergeSurveyReceipts) return overrides.mergeSurveyReceipts(root, opts, calls);
      return {
        status: "ok",
        pass: opts.pass,
        artifactsPath: `analysis/receipts/discovery-artifacts-pass-${opts.pass}.json`,
        missingUnitIds: [],
        retryUnitIds: [],
        needsDomainLabels: false,
      };
    },
    async publishCheckpoint(root, opts) {
      calls.publishCheckpoint.push({ root, opts });
      if (overrides.publishCheckpoint) return overrides.publishCheckpoint(root, opts, calls);
      return { status: "ok", summary: `published ${opts.phase}` };
    },
  };
  return { core, calls };
}

function makeStore(root, orchRunId = "orch-phase-1") {
  const store = new WikiRunStore({ workspaceRoot: root, orchRunId });
  store.createRun({
    orchRunId,
    backend: "session",
    mode: "plan",
    workspaceRoot: root,
  });
  store.setOverall("running");
  return store;
}

function seedInventory(workdir, units, policyLimits = {}) {
  mkdirSync(join(workdir, "inputs"), { recursive: true });
  writeJson(join(workdir, "inputs", "inventory.json"), {
    version: 1,
    coverageUnits: units,
  });
  writeJson(join(workdir, "inputs", "run-policy.json"), {
    limits: { maxCoveragePasses: 2, ...policyLimits },
  });
}

test("shardUnits round-robins into non-empty groups", () => {
  const units = makeUnits(5);
  const groups = shardUnits(units, 3);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups.map((g) => g.map((u) => u.id)),
    [["unit-1", "unit-4"], ["unit-2", "unit-5"], ["unit-3"]],
  );
});

test("adaptiveLaneCount clamps to maxSurveyLanes and scales with units", () => {
  const limits = { maxSurveyLanes: 4, targetUnitsPerLane: 3 };
  assert.equal(adaptiveLaneCount(1, limits), 1);
  assert.equal(adaptiveLaneCount(3, limits), 1);
  assert.equal(adaptiveLaneCount(4, limits), 2);
  assert.equal(adaptiveLaneCount(9, limits), 3);
  assert.equal(adaptiveLaneCount(20, limits), 4); // clamp
  assert.equal(adaptiveLaneCount(0, limits), 1);
});

test("loadInventory reads coverageUnits (not units) and policy limits", () => {
  const root = tempRoot();
  const workdir = join(root, "wd");
  seedInventory(workdir, makeUnits(2), { maxCoveragePasses: 3 });
  const loaded = loadInventory(workdir);
  assert.equal(loaded.units.length, 2);
  assert.equal(loaded.units[0].id, "unit-1");
  assert.equal(loaded.limits.maxCoveragePasses, 3);
});

test("runPlanPath prepare → adaptive survey lanes → merge → plan publish → gate", async () => {
  const root = tempRoot();
  const workdir = join(root, "runs", "domain-1");
  const units = makeUnits(7); // target 3 → ceil(7/3)=3 lanes
  seedInventory(workdir, units);

  const { core, calls } = makeCore({ workdir, startAt: "survey" });
  const store = makeStore(root);
  const pool = createTaskPool({ concurrency: 4 });
  const agentCalls = [];

  const runAgent = async (req) => {
    agentCalls.push({
      agentId: req.agentId,
      label: req.label,
      phase: req.phase,
      role: req.role,
      unitIds: req.unitIds,
    });
    return { status: "ok", summary: `${req.label} ok` };
  };

  try {
    const result = await runPlanPath({
      core,
      workspaceRoot: root,
      mode: "plan",
      store,
      pool,
      runAgent,
      tools: [],
      cwd: root,
      limits: mergeOrchLimits({ maxSurveyLanes: 4, targetUnitsPerLane: 3 }),
      signal: new AbortController().signal,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.domainRunId, "domain-1");
    assert.equal(result.workdir, workdir);
    assert.equal(result.next, "/wiki --write");

    // prepare called once
    assert.equal(calls.prepareRun.length, 1);
    assert.equal(calls.prepareRun[0].opts.mode, "plan");

    // survey lanes adaptive: 3 agents for 7 units
    const surveyAgents = agentCalls.filter((a) => a.role === "survey" && a.label.startsWith("survey:"));
    assert.equal(surveyAgents.length, 3);
    assert.equal(surveyAgents[0].unitIds.length + surveyAgents[1].unitIds.length + surveyAgents[2].unitIds.length, 7);

    // merge + discover publish + plan publish
    assert.equal(calls.mergeSurveyReceipts.length, 1);
    assert.equal(calls.mergeSurveyReceipts[0].opts.pass, 1);
    assert.equal(calls.mergeSurveyReceipts[0].opts.runId, "domain-1");

    assert.ok(calls.publishCheckpoint.some((c) => c.opts.phase === "discover"));
    assert.ok(calls.publishCheckpoint.some((c) => c.opts.phase === "plan"));

    // plan agent
    assert.ok(agentCalls.some((a) => a.label === "plan-spec" && a.role === "plan"));

    const snap = store.getSnapshot();
    assert.equal(snap.domainRunId, "domain-1");
    assert.equal(snap.workdir, workdir);
    assert.equal(snap.currentPhase, "Gate");
    const phaseNames = snap.phases.map((p) => p.name);
    assert.ok(phaseNames.includes("Bootstrap"));
    assert.ok(phaseNames.includes("Survey"));
    assert.ok(phaseNames.includes("Plan"));
    assert.ok(phaseNames.includes("Gate"));
    assert.equal(snap.phases.find((p) => p.name === "Gate")?.status, "done");
    assert.equal(snap.phases.find((p) => p.name === "Survey")?.status, "done");
  } finally {
    pool.dispose();
  }
});

test("runPlanPath continue-and-merge when a survey lane fails", async () => {
  const root = tempRoot();
  const workdir = join(root, "runs", "domain-1");
  seedInventory(workdir, makeUnits(4));

  const { core, calls } = makeCore({ workdir });
  const store = makeStore(root, "orch-lane-fail");
  const pool = createTaskPool({ concurrency: 2 });
  let surveyN = 0;

  const runAgent = async (req) => {
    if (req.role === "survey" && req.label.startsWith("survey:")) {
      surveyN += 1;
      if (surveyN === 1) return { status: "failed", summary: "lane boom" };
      return { status: "ok", summary: "lane ok" };
    }
    return { status: "ok", summary: "ok" };
  };

  try {
    const result = await runPlanPath({
      core,
      workspaceRoot: root,
      mode: "auto",
      store,
      pool,
      runAgent,
      tools: [],
      cwd: root,
      limits: mergeOrchLimits({ maxSurveyLanes: 4, targetUnitsPerLane: 2 }),
      signal: new AbortController().signal,
    });

    assert.equal(result.status, "ok");
    // merge still called despite lane failure
    assert.equal(calls.mergeSurveyReceipts.length, 1);
    assert.ok(calls.publishCheckpoint.some((c) => c.opts.phase === "discover"));
  } finally {
    pool.dispose();
  }
});

test("runPlanPath runs labels agent when merge needsDomainLabels", async () => {
  const root = tempRoot();
  const workdir = join(root, "runs", "domain-1");
  seedInventory(workdir, makeUnits(2));

  let mergeN = 0;
  const { core, calls } = makeCore({
    workdir,
    mergeSurveyReceipts(_root, opts) {
      mergeN += 1;
      if (mergeN === 1) {
        return {
          status: "ok",
          pass: opts.pass,
          artifactsPath: `analysis/receipts/discovery-artifacts-pass-${opts.pass}.json`,
          missingUnitIds: [],
          retryUnitIds: [],
          needsDomainLabels: true,
        };
      }
      return {
        status: "ok",
        pass: opts.pass,
        artifactsPath: `analysis/receipts/discovery-artifacts-pass-${opts.pass}.json`,
        missingUnitIds: [],
        retryUnitIds: [],
        needsDomainLabels: false,
      };
    },
  });
  const store = makeStore(root, "orch-labels");
  const pool = createTaskPool({ concurrency: 2 });
  const labels = [];

  const runAgent = async (req) => {
    if (req.label.startsWith("discovery-labels:")) labels.push(req.label);
    return { status: "ok", summary: "ok" };
  };

  try {
    const result = await runPlanPath({
      core,
      workspaceRoot: root,
      mode: "plan",
      store,
      pool,
      runAgent,
      tools: [],
      cwd: root,
      limits: mergeOrchLimits(),
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(labels, ["discovery-labels:1"]);
    assert.equal(calls.mergeSurveyReceipts.length, 2);
    assert.equal(calls.mergeSurveyReceipts[1].opts.labelsPath, "analysis/receipts/discovery-labels-pass-1.json");
  } finally {
    pool.dispose();
  }
});

test("runPlanPath mode=write blocked when startAt is survey", async () => {
  const root = tempRoot();
  const workdir = join(root, "runs", "domain-1");
  const { core } = makeCore({ workdir, startAt: "survey" });
  const store = makeStore(root, "orch-blocked");
  const pool = createTaskPool({ concurrency: 1 });
  let agents = 0;

  try {
    const result = await runPlanPath({
      core,
      workspaceRoot: root,
      mode: "write",
      store,
      pool,
      runAgent: async () => {
        agents += 1;
        return { status: "ok" };
      },
      tools: [],
      cwd: root,
      limits: mergeOrchLimits(),
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "blocked");
    assert.match(result.summary, /approved plan/i);
    assert.equal(agents, 0);
  } finally {
    pool.dispose();
  }
});

test("runPlanPath mode=plan with startAt past gate returns next write", async () => {
  const root = tempRoot();
  const workdir = join(root, "runs", "domain-1");
  const { core, calls } = makeCore({ workdir, startAt: "write" });
  const store = makeStore(root, "orch-already-planned");
  const pool = createTaskPool({ concurrency: 1 });

  try {
    const result = await runPlanPath({
      core,
      workspaceRoot: root,
      mode: "plan",
      store,
      pool,
      runAgent: async () => ({ status: "ok" }),
      tools: [],
      cwd: root,
      limits: mergeOrchLimits(),
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "ok");
    assert.equal(result.next, "/wiki --write");
    assert.equal(calls.mergeSurveyReceipts.length, 0);
    assert.equal(calls.publishCheckpoint.length, 0);
  } finally {
    pool.dispose();
  }
});

test("runPlanPath fails when prepareRun fails", async () => {
  const root = tempRoot();
  const { core } = makeCore({
    prepareRun: async () => ({ status: "failed", runId: "", workdir: "", workspaceRoot: root, mode: "plan", startAt: "survey", summary: "no sources" }),
  });
  const store = makeStore(root, "orch-prep-fail");
  const pool = createTaskPool({ concurrency: 1 });
  try {
    const result = await runPlanPath({
      core,
      workspaceRoot: root,
      mode: "plan",
      store,
      pool,
      runAgent: async () => ({ status: "ok" }),
      tools: [],
      cwd: root,
      limits: mergeOrchLimits(),
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "failed");
    assert.match(result.summary, /no sources/);
    assert.equal(store.getSnapshot().phases.find((p) => p.name === "Bootstrap")?.status, "failed");
  } finally {
    pool.dispose();
  }
});

test("runPlanPath aborts on signal", async () => {
  const root = tempRoot();
  const workdir = join(root, "runs", "domain-1");
  seedInventory(workdir, makeUnits(2));
  const controller = new AbortController();
  const { core } = makeCore({
    workdir,
    prepareRun: async () => {
      controller.abort(new Error("cancel-me"));
      return {
        status: "ok",
        runId: "domain-1",
        workdir,
        workspaceRoot: root,
        mode: "plan",
        startAt: "survey",
      };
    },
  });
  const store = makeStore(root, "orch-abort");
  const pool = createTaskPool({ concurrency: 1 });
  try {
    const result = await runPlanPath({
      core,
      workspaceRoot: root,
      mode: "plan",
      store,
      pool,
      runAgent: async () => ({ status: "ok" }),
      tools: [],
      cwd: root,
      limits: mergeOrchLimits(),
      signal: controller.signal,
    });
    assert.equal(result.status, "failed");
  } finally {
    pool.dispose();
  }
});

test("runPlanPath startAt=plan skips survey and publishes plan then gate", async () => {
  const root = tempRoot();
  const workdir = join(root, "runs", "domain-1");
  const { core, calls } = makeCore({ workdir, startAt: "plan" });
  const store = makeStore(root, "orch-start-plan");
  const pool = createTaskPool({ concurrency: 1 });
  const labels = [];

  try {
    const result = await runPlanPath({
      core,
      workspaceRoot: root,
      mode: "auto",
      store,
      pool,
      runAgent: async (req) => {
        labels.push(req.label);
        return { status: "ok", summary: "planned" };
      },
      tools: [],
      cwd: root,
      limits: mergeOrchLimits(),
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "ok");
    assert.equal(result.next, "/wiki --write");
    assert.deepEqual(labels, ["plan-spec"]);
    assert.equal(calls.mergeSurveyReceipts.length, 0);
    assert.equal(calls.publishCheckpoint.length, 1);
    assert.equal(calls.publishCheckpoint[0].opts.phase, "plan");
  } finally {
    pool.dispose();
  }
});
