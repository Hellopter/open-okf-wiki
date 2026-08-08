import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildEvidenceTasks, buildSurveyTaskGraph, createMockAgentRunner, createSessionOrchestrator } from "../dist/orch/index.js";

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

function qualityReport(verdict = "PASS") {
  return [
    `Verdict: ${verdict}`,
    "Affected pages: none",
    `Findings: ${verdict === "PASS" ? "none" : "missing source-grounded detail"}`,
    `Required repair: ${verdict === "PASS" ? "none" : "repair the affected page"}`,
    "",
  ].join("\n");
}

function writeArtifact(paths, req, verdictForRole) {
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  };
  if (req.role === "main") write(join(paths.analysisDir, "plan.md"), "# Plan\n\n## Page matrix\n- entry\n");
  if (req.role === "source-researcher") write(join(paths.analysisDir, "discovery", "sources", "workspace.md"), "# Source\n");
  if (req.role === "evidence-researcher") write(join(paths.analysisDir, "evidence", "scope.md"), "# Evidence\n");
  if (req.role === "coverage-critic") {
    write(join(paths.analysisDir, req.phase === "Coverage initial" ? "coverage-review.md" : "reviews", req.phase === "Coverage initial" ? "" : "coverage-rereview.md"), qualityReport(verdictForRole(req.role, req.phase)));
  }
  if (req.role === "reviewer-evidence") write(join(paths.analysisDir, "reviews", "evidence.md"), qualityReport(verdictForRole(req.role, req.phase)));
  if (req.role === "reviewer-workflow") write(join(paths.analysisDir, "reviews", "workflow.md"), qualityReport(verdictForRole(req.role, req.phase)));
  if (req.role === "reviewer-navigation") write(join(paths.analysisDir, "reviews", "navigation.md"), qualityReport(verdictForRole(req.role, req.phase)));
  if (req.role === "qa-question-finder") write(join(paths.analysisDir, "qa", "questions.md"), qualityReport(verdictForRole(req.role, req.phase)));
  if (req.role === "qa-answer-verifier") write(join(paths.analysisDir, "reviews", "reader-qa.md"), qualityReport(verdictForRole(req.role, req.phase)));
}

function passingRunner(paths, seen = [], verdictForRole = () => "PASS") {
  return createMockAgentRunner(async (req) => {
    seen.push({ role: req.role, phase: req.phase, tools: req.tools.map((tool) => tool.name) });
    writeArtifact(paths, req, verdictForRole);
    return { status: "ok", summary: req.phase };
  });
}

test("auto approval keeps one main session through plan, write, review, and validation", async () => {
  const root = tempRoot();
  const fixture = makeCore(root, "auto");
  const { core, calls } = fixture;
  const seen = [];
  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core,
    getTools: (_root, role) => [{ name: role }],
    agentRunner: passingRunner(fixture.paths, seen),
  });
  try {
    const started = await orch.start({ workspaceRoot: root, action: "generate" });
    const result = await orch.waitFor(started.orchRunId);
    assert.equal(result.status, "completed");
    assert.equal(calls.prepare, 1);
    assert.equal(calls.validate, 1);
    assert.ok(seen.some((entry) => entry.phase === "Survey" && entry.role === "source-researcher"));
    assert.ok(seen.some((entry) => entry.phase === "Evidence" && entry.role === "evidence-researcher"));
    assert.ok(seen.some((entry) => entry.phase === "Coverage initial" && entry.role === "coverage-critic"));
    assert.ok(seen.some((entry) => entry.phase === "Coverage verification" && entry.role === "coverage-critic"));
    assert.ok(seen.some((entry) => entry.phase === "Review" && entry.role === "qa-answer-verifier"));
    assert.ok(seen.filter((entry) => entry.role === "main").every((entry) => entry.tools[0] === "main"));
    assert.ok(seen.some((entry) => entry.phase === "Coverage initial" && entry.tools[0] === "coverage-critic"));
    assert.ok(seen.some((entry) => entry.phase === "Review" && entry.tools[0] === "reviewer-evidence"));
    assert.match(orch.getSnapshot(started.orchRunId).agents.find((agent) => agent.agentId === "main")?.prompt ?? "", /source-grounded OKF bundle/);
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
  const fixture = makeCore(root, "propose");
  const { core, calls, state } = fixture;
  const seen = [];
  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core,
    getTools: () => [],
    agentRunner: passingRunner(fixture.paths, seen),
  });
  try {
    const planned = await orch.start({ workspaceRoot: root, action: "generate" });
    assert.equal((await orch.waitFor(planned.orchRunId)).status, "proposed");
    assert.equal(state.status, "proposed");
    const proposal = orch.getSnapshot(planned.orchRunId);
    assert.equal(proposal.overall, "proposed");
    assert.match(proposal.planPreview ?? "", /# Plan/);
    assert.equal(proposal.qualitySummary?.verdict, "passed");
    assert.ok(!seen.some((entry) => entry.phase === "Write"));
    const approved = await orch.start({ workspaceRoot: root, action: "approve", runId: "run-1" });
    assert.equal((await orch.waitFor(approved.orchRunId)).status, "completed");
    assert.equal(calls.approve, 1);
    assert.ok(seen.some((entry) => entry.phase === "Write"));
  } finally { orch.dispose(); }
});

test("large inventories fan out only independent discovery roles", async () => {
  const root = tempRoot();
  const fixture = makeCore(root, "propose");
  writeFileSync(join(fixture.paths.inputsDir, "inventory.json"), JSON.stringify({
    sources: [
      { sourceId: "api", fileCount: 400, surfaces: [{ path: "services/api" }] },
      { sourceId: "web", fileCount: 300, surfaces: [{ path: "apps/web" }] },
    ],
    coverageUnits: Array.from({ length: 13 }, (_, i) => ({ id: `u${i}`, sourceId: i % 2 === 0 ? "api" : "web", path: i % 2 === 0 ? "services/api" : "apps/web" })),
  }));
  const roles = [];
  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core: fixture.core,
    getTools: (_root, role) => [{ name: role }],
    agentRunner: createMockAgentRunner(async (req) => {
      roles.push({ role: req.role, tools: req.tools[0]?.name });
      writeArtifact(fixture.paths, req, () => "PASS");
      return { status: "ok" };
    }),
  });
  try {
    const started = await orch.start({ workspaceRoot: root, action: "generate" });
    await orch.waitFor(started.orchRunId);
    assert.ok(roles.some((entry) => entry.role === "source-researcher" && entry.tools === "source-researcher"));
    assert.ok(roles.some((entry) => entry.role === "integration-researcher" && entry.tools === "integration-researcher"));
    assert.ok(roles.filter((entry) => entry.role === "main").every((entry) => entry.tools === "main"));
  } finally { orch.dispose(); }
});

test("survey source budget is capped and evidence overflow preserves every coverage scope", () => {
  const inventory = {
    sourceRoots: 7,
    sources: Array.from({ length: 7 }, (_, index) => ({ id: `source-${index + 1}`, fileCount: 300, surfaceCount: 1 })),
    units: Array.from({ length: 7 }, (_, index) => ({
      id: `source-${index + 1}::surface`,
      sourceId: `source-${index + 1}`,
      path: `packages/${index + 1}`,
      required: true,
    })),
  };
  const survey = buildSurveyTaskGraph(inventory);
  assert.ok(survey.waveOne.length <= 5);
  assert.equal(survey.integration?.sourceIds.length, 7);
  const surveyed = survey.waveOne.flatMap((task) => task.sourceIds).sort();
  assert.deepEqual(surveyed, inventory.sources.map((source) => source.id).sort());

  const evidence = buildEvidenceTasks(inventory);
  const assignedUnits = evidence.flatMap((task) => task.unitIds).sort();
  assert.deepEqual(assignedUnits, inventory.units.map((unit) => unit.id).sort());
});

test("quality-blocked runs require explicit resume and restart from Write without replanning", async () => {
  const root = tempRoot();
  const fixture = makeCore(root, "auto");
  const seen = [];
  let workflowFails = true;
  const orch = createSessionOrchestrator({
    workspaceRoot: root,
    core: fixture.core,
    getTools: (_root, role) => [{ name: role }],
    agentRunner: createMockAgentRunner(async (req) => {
      seen.push(req.phase);
      writeArtifact(fixture.paths, req, (role) => role === "reviewer-workflow" && workflowFails ? "FAIL" : "PASS");
      return { status: "ok" };
    }),
  });
  try {
    const started = await orch.start({ workspaceRoot: root, action: "generate" });
    assert.equal((await orch.waitFor(started.orchRunId)).status, "quality_blocked");
    assert.equal(orch.getSnapshot(started.orchRunId).overall, "quality_blocked");
    assert.ok(fixture.calls.statuses.includes("quality_blocked"));

    workflowFails = false;
    const beforeResume = seen.length;
    const resumed = await orch.start({ workspaceRoot: root, action: "resume", runId: "run-1" });
    assert.equal((await orch.waitFor(resumed.orchRunId)).status, "completed");
    assert.ok(seen.slice(beforeResume).includes("Write"));
    assert.ok(!seen.slice(beforeResume).includes("Plan"));
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
    agentRunner: createMockAgentRunner(async (req) => { phases.push(req.phase); writeArtifact(fixture.paths, req, () => "PASS"); return { status: "ok" }; }),
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
