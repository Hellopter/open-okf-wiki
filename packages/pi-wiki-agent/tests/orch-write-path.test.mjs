import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTaskPool } from "../dist/orch/pool.js";
import { WikiRunStore } from "../dist/orch/store.js";
import { loadAssignmentsFromDisk, runWritePath } from "../dist/orch/write-path.js";
import { runWikiPath } from "../dist/orch/phase-graph.js";

async function tmpWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "okf-write-"));
  const workdir = join(root, ".wiki-agent", "runs", "domain-1", "workdir");
  await mkdir(join(workdir, "analysis", "receipts"), { recursive: true });
  await mkdir(join(workdir, "inputs"), { recursive: true });
  await mkdir(join(workdir, "candidate"), { recursive: true });
  return { root, workdir };
}

function mockCore(overrides = {}) {
  const publishes = [];
  return {
    publishes,
    prepareRun: async () => ({
      status: "ok",
      runId: "domain-1",
      workdir: overrides.workdir,
      workspaceRoot: overrides.root,
      mode: "write",
      startAt: "write-sources",
    }),
    mergeSurveyReceipts: async () => ({ status: "ok" }),
    publishCheckpoint: async (_root, opts) => {
      publishes.push(opts);
      return { status: "ok" };
    },
    validateCandidate: async () => ({
      status: "ok",
      artifactsJsonPath: "analysis/receipts/validate-artifacts.json",
    }),
    getRunPaths: async () => undefined,
    ...overrides,
  };
}

test("loadAssignmentsFromDisk groups page rows into owner shards", async () => {
  const { root, workdir } = await tmpWorkspace();
  try {
    await writeFile(
      join(workdir, "analysis", "page-assignments.json"),
      JSON.stringify([
        { pagePath: "a.md", owner: "api", role: "domain", coverageUnitIds: ["u1"], dependsOn: [] },
        { pagePath: "b.md", owner: "api", role: "domain", coverageUnitIds: ["u2"], dependsOn: [] },
        { pagePath: "overview.md", owner: "integration", role: "integration", coverageUnitIds: ["u1"], dependsOn: [] },
      ]),
    );
    const bundle = loadAssignmentsFromDisk(workdir);
    assert.ok(bundle);
    assert.equal(bundle.shards.length, 2);
    const api = bundle.shards.find((s) => s.owner === "api");
    assert.deepEqual(api.pagePaths.sort(), ["a.md", "b.md"]);
    assert.equal(bundle.shards.find((s) => s.owner === "integration").role, "integration");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runWritePath executes write → review clean → validate", async () => {
  const { root, workdir } = await tmpWorkspace();
  try {
    await writeFile(
      join(workdir, "analysis", "page-assignments.json"),
      JSON.stringify([
        { pagePath: "mod.md", owner: "src", role: "domain", coverageUnitIds: ["u"], dependsOn: [] },
      ]),
    );
    await writeFile(join(workdir, "inputs", "run-policy.json"), JSON.stringify({ limits: { maxRepairRounds: 1 } }));

    const core = mockCore({ root, workdir });
    const store = new WikiRunStore({ workspaceRoot: root, orchRunId: "orch-w1" });
    store.createRun({
      orchRunId: "orch-w1",
      backend: "session",
      mode: "write",
      workspaceRoot: root,
      domainRunId: "domain-1",
      workdir,
    });
    const pool = createTaskPool({ concurrency: 4 });
    const labels = [];
    const controller = new AbortController();

    const result = await runWritePath({
      core,
      workspaceRoot: root,
      runId: "domain-1",
      workdir,
      startAt: "write-sources",
      store,
      pool,
      tools: [],
      cwd: root,
      limits: {
        concurrency: 4,
        maxAgents: 48,
        agentTimeoutMs: 60_000,
        agentRetries: 0,
        maxSurveyLanes: 4,
        targetUnitsPerLane: 3,
        heartbeatMs: 60_000,
        staleWarnMs: 30_000,
      },
      signal: controller.signal,
      runAgent: async (req) => {
        labels.push(req.label);
        if (req.label.startsWith("reduce-review")) {
          return {
            status: "ok",
            summary: "clean",
            clean: true,
            blockingCount: 0,
            majorCount: 0,
            repairTargets: [],
            defectFingerprint: "clean",
          };
        }
        return { status: "ok", summary: "ok" };
      },
    });

    assert.equal(result.status, "completed");
    assert.ok(labels.some((l) => l.startsWith("write-sources:")));
    assert.ok(labels.includes("reduce-write-sources"));
    assert.ok(labels.includes("reduce-write"));
    assert.ok(labels.some((l) => l.startsWith("review:1:")));
    assert.ok(labels.includes("reduce-review:1"));
    assert.ok(core.publishes.some((p) => p.phase === "write-sources"));
    assert.ok(core.publishes.some((p) => p.phase === "write"));
    assert.ok(core.publishes.some((p) => p.phase === "review-1"));
    assert.ok(core.publishes.some((p) => p.phase === "validate"));
    pool.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runWikiPath continues from write-sources after prepare skips gate", async () => {
  const { root, workdir } = await tmpWorkspace();
  try {
    await writeFile(
      join(workdir, "analysis", "page-assignments.json"),
      JSON.stringify([
        { pagePath: "x.md", owner: "o", role: "domain", coverageUnitIds: ["u"], dependsOn: [] },
      ]),
    );
    const core = {
      prepareRun: async () => ({
        status: "ok",
        runId: "domain-1",
        workdir,
        workspaceRoot: root,
        mode: "write",
        startAt: "write-sources",
      }),
      mergeSurveyReceipts: async () => ({ status: "ok" }),
      publishCheckpoint: async () => ({ status: "ok" }),
      validateCandidate: async () => ({
        status: "ok",
        artifactsJsonPath: "analysis/receipts/validate-artifacts.json",
      }),
      getRunPaths: async () => undefined,
    };
    const store = new WikiRunStore({ workspaceRoot: root, orchRunId: "orch-w2" });
    store.createRun({
      orchRunId: "orch-w2",
      backend: "session",
      mode: "write",
      workspaceRoot: root,
    });
    const pool = createTaskPool({ concurrency: 2 });
    const controller = new AbortController();
    const result = await runWikiPath({
      core,
      workspaceRoot: root,
      mode: "write",
      store,
      pool,
      tools: [],
      cwd: root,
      limits: {
        concurrency: 2,
        maxAgents: 48,
        agentTimeoutMs: 60_000,
        agentRetries: 0,
        maxSurveyLanes: 2,
        targetUnitsPerLane: 2,
        heartbeatMs: 60_000,
        staleWarnMs: 30_000,
      },
      signal: controller.signal,
      runAgent: async (req) => {
        if (req.label.startsWith("reduce-review")) {
          return {
            status: "ok",
            summary: "clean",
            clean: true,
            blockingCount: 0,
            majorCount: 0,
            repairTargets: [],
            defectFingerprint: "x",
          };
        }
        return { status: "ok", summary: "ok" };
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.next, "sealed");
    pool.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runWritePath repair loop then clean review", async () => {
  const { root, workdir } = await tmpWorkspace();
  try {
    await writeFile(
      join(workdir, "analysis", "page-assignments.json"),
      JSON.stringify([
        { pagePath: "p.md", owner: "o", role: "domain", coverageUnitIds: ["u"], dependsOn: [] },
      ]),
    );
    const core = mockCore({ root, workdir });
    // Skip write: start at review-1
    const store = new WikiRunStore({ workspaceRoot: root, orchRunId: "orch-w3" });
    store.createRun({
      orchRunId: "orch-w3",
      backend: "session",
      mode: "write",
      workspaceRoot: root,
      domainRunId: "domain-1",
      workdir,
    });
    const pool = createTaskPool({ concurrency: 4 });
    let reviewCalls = 0;
    const result = await runWritePath({
      core,
      workspaceRoot: root,
      runId: "domain-1",
      workdir,
      startAt: "review-1",
      store,
      pool,
      tools: [],
      cwd: root,
      limits: {
        concurrency: 4,
        maxAgents: 48,
        agentTimeoutMs: 60_000,
        agentRetries: 0,
        maxSurveyLanes: 2,
        targetUnitsPerLane: 2,
        heartbeatMs: 60_000,
        staleWarnMs: 30_000,
      },
      signal: new AbortController().signal,
      runAgent: async (req) => {
        if (req.label.startsWith("reduce-review")) {
          reviewCalls++;
          if (reviewCalls === 1) {
            return {
              status: "ok",
              summary: "needs repair",
              clean: false,
              blockingCount: 2,
              majorCount: 1,
              defectFingerprint: "fp-1",
              repairTargets: [{ owner: "o", pagePaths: ["p.md"] }],
            };
          }
          return {
            status: "ok",
            summary: "clean",
            clean: true,
            blockingCount: 0,
            majorCount: 0,
            defectFingerprint: "fp-2",
            repairTargets: [],
          };
        }
        return { status: "ok", summary: "ok" };
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(reviewCalls, 2);
    assert.ok(core.publishes.some((p) => p.phase === "repair-1"));
    assert.ok(core.publishes.some((p) => p.phase === "review-2"));
    pool.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
