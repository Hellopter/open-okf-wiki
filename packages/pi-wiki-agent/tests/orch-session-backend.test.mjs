import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMockAgentRunner, createSessionOrchestrator } from "../dist/orch/index.js";

function makeCore(root, approval = "auto") {
  const runId = "run-1";
  const runRoot = join(root, ".wiki-agent", "runs", runId);
  const paths = {
    root: runRoot,
    runId,
    inputsDir: join(runRoot, "inputs"),
    sourcesDir: join(runRoot, "sources"),
    analysisDir: join(runRoot, "analysis"),
    bundleDir: join(runRoot, "bundle"),
    sessionDir: join(runRoot, "analysis", "session"),
  };
  for (const dir of Object.values(paths).filter((value) => typeof value === "string" && value.startsWith(root))) mkdirSync(dir, { recursive: true });
  writeFileSync(join(paths.inputsDir, "inventory.json"), JSON.stringify({ coverageUnits: [{ id: "entry", sourceId: "project" }] }));
  const state = { runId, status: "prepared", approval };
  const calls = { prepare: 0, approve: 0, resume: 0, validate: 0, statuses: [], claim: [], release: [] };
  return {
    paths, state, calls,
    core: {
      async prepareRun() { calls.prepare += 1; return { status: "ok", runId, root }; },
      async getRunPaths() { return paths; },
      async getRunState() { return { ...state }; },
      async completeRunPlanning(_root, { sessionPath }) {
        state.sessionPath = sessionPath;
        const requiresApproval = approval === "propose";
        state.status = requiresApproval ? "proposed" : "writing";
        return { ok: true, runId, planDigest: "sha256:plan", requiresApproval, status: state.status, state: { ...state } };
      },
      async approveRun() { calls.approve += 1; state.status = "writing"; return { ...state }; },
      async resumeRun() { calls.resume += 1; return { ...state }; },
      async setRunStatus(_root, input) { calls.statuses.push(input.status); Object.assign(state, input); return { ...state }; },
      async validateRunBundle() { calls.validate += 1; state.status = "completed"; return { ...state }; },
      async getWorkspaceStatus() { return { root, initialized: true, activeRunId: runId, sources: [] }; },
      async claimRun(_root, input) { calls.claim.push(input); return { ok: true, claimed: true }; },
      async releaseRun(_root, input) { calls.release.push(input); return { ok: true, released: true }; },
    },
  };
}

function tempRoot() { return mkdtempSync(join(tmpdir(), "okf-wiki-session-")); }

test("auto approval keeps one main session through plan, write, review, and validation", async () => {
  const root = tempRoot();
  const { core, calls } = makeCore(root, "auto");
  const seen = [];
  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core,
    getTools: (_root, role) => [{ name: role }],
    agentRunner: createMockAgentRunner(async (req) => { seen.push({ role: req.role, phase: req.phase, tools: req.tools.map((tool) => tool.name) }); return { status: "ok", summary: req.phase }; }),
  });
  try {
    const started = await orch.start({ workspaceRoot: root, action: "generate" });
    const result = await orch.waitFor(started.orchRunId);
    assert.equal(result.status, "completed");
    assert.equal(calls.prepare, 1);
    assert.equal(calls.validate, 1);
    assert.deepEqual(seen.map((entry) => entry.phase), ["Plan", "Coverage review", "Plan revision", "Write", "Review", "Repair"]);
    assert.ok(seen.filter((entry) => entry.role === "main").every((entry) => entry.tools[0] === "main"));
    assert.ok(seen.some((entry) => entry.phase === "Coverage review" && entry.tools[0] === "coverage-critic"));
    assert.ok(seen.some((entry) => entry.phase === "Review" && entry.tools[0] === "reviewer"));
    assert.equal(orch.getSnapshot(started.orchRunId).overall, "completed");
    assert.equal(calls.claim.length, 1);
    assert.equal(calls.release.length, 1);
    assert.equal(calls.claim[0].runId, "run-1");
    assert.equal(calls.release[0].runId, "run-1");
    assert.equal(calls.claim[0].owner, calls.release[0].owner);
  } finally { orch.dispose(); }
});

test("propose approval stops after the Markdown plan and approve resumes writing", async () => {
  const root = tempRoot();
  const { core, calls, state } = makeCore(root, "propose");
  const phases = [];
  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core,
    getTools: () => [],
    agentRunner: createMockAgentRunner(async (req) => { phases.push(req.phase); return { status: "ok" }; }),
  });
  try {
    const planned = await orch.start({ workspaceRoot: root, action: "generate" });
    assert.equal((await orch.waitFor(planned.orchRunId)).status, "proposed");
    assert.equal(state.status, "proposed");
    assert.ok(!phases.includes("Write"));
    const approved = await orch.start({ workspaceRoot: root, action: "approve", runId: "run-1" });
    assert.equal((await orch.waitFor(approved.orchRunId)).status, "completed");
    assert.equal(calls.approve, 1);
    assert.ok(phases.includes("Write"));
  } finally { orch.dispose(); }
});

test("large inventories fan out only independent discovery roles", async () => {
  const root = tempRoot();
  const fixture = makeCore(root, "propose");
  writeFileSync(join(fixture.paths.inputsDir, "inventory.json"), JSON.stringify({ coverageUnits: Array.from({ length: 13 }, (_, i) => ({ id: `u${i}`, sourceId: "project" })) }));
  const roles = [];
  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core: fixture.core,
    getTools: (_root, role) => [{ name: role }],
    agentRunner: createMockAgentRunner(async (req) => { roles.push({ role: req.role, tools: req.tools[0]?.name }); return { status: "ok" }; }),
  });
  try {
    const started = await orch.start({ workspaceRoot: root, action: "generate" });
    await orch.waitFor(started.orchRunId);
    assert.ok(roles.some((entry) => entry.role === "discover" && entry.tools === "discover"));
    assert.ok(roles.filter((entry) => entry.role === "main").every((entry) => entry.tools === "main"));
  } finally { orch.dispose(); }
});

test("resume honors the core recovery point for a paused write instead of re-planning", async () => {
  const root = tempRoot();
  const fixture = makeCore(root, "auto");
  fixture.state.status = "paused";
  fixture.state.sessionPath = join(fixture.paths.sessionDir, "main.jsonl");
  fixture.core.resumeRun = async () => ({ ...fixture.state, startAt: "writing" });
  const phases = [];
  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core: fixture.core,
    getTools: () => [],
    agentRunner: createMockAgentRunner(async (req) => { phases.push(req.phase); return { status: "ok" }; }),
  });
  try {
    const started = await orch.start({ workspaceRoot: root, action: "resume", runId: "run-1" });
    assert.equal((await orch.waitFor(started.orchRunId)).status, "completed");
    assert.ok(phases.includes("Write"));
    assert.ok(!phases.includes("Plan"));
  } finally { orch.dispose(); }
});

test("releases the core claim and removes local tracking when session setup fails", async () => {
  const root = tempRoot();
  const { core, calls } = makeCore(root, "auto");
  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core,
    getTools: () => { throw new Error("tool setup failed"); },
    agentRunner: createMockAgentRunner(async () => ({ status: "ok" })),
  });
  try {
    await assert.rejects(orch.start({ workspaceRoot: root, action: "generate" }), /tool setup failed/);
    assert.equal(calls.claim.length, 1);
    assert.equal(calls.release.length, 1);
    assert.equal(orch.list().length, 0);
  } finally { orch.dispose(); }
});
