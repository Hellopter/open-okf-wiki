import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { createMockAgentRunner, SessionWikiOrchestrator } from "../dist/index.js";

async function fixture({ approval = "auto", reviewVerdict = "PASS", resumeAt = "write" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "okf-wiki-orch-"));
  const runDir = join(root, ".wiki-agent", "runs", "run-1");
  const paths = {
    root, runId: "run-1", runDir, inputsDir: join(runDir, "inputs"), sourcesDir: join(runDir, "inputs", "sources"), methodDir: join(runDir, "method"), analysisDir: join(runDir, "analysis"), statePath: join(runDir, "analysis", "state.json"), planPath: join(runDir, "analysis", "plan.md"), discoveryDir: join(runDir, "analysis", "discovery"), evidenceDir: join(runDir, "analysis", "evidence"), coverageReviewPath: join(runDir, "analysis", "coverage-review.md"), reviewPath: join(runDir, "analysis", "reviews"), qualityReportsDir: join(runDir, "analysis", "reviews"), qualityReportPaths: { evidence: join(runDir, "analysis", "reviews", "evidence.md"), workflow: join(runDir, "analysis", "reviews", "workflow.md"), navigation: join(runDir, "analysis", "reviews", "navigation.md"), questions: join(runDir, "analysis", "qa", "questions.md"), readerQa: join(runDir, "analysis", "reviews", "reader-qa.md") }, mainSessionDir: join(runDir, "analysis", "session"), bundleDir: join(runDir, "bundle"),
  };
  await Promise.all([mkdir(paths.inputsDir, { recursive: true }), mkdir(paths.mainSessionDir, { recursive: true }), mkdir(paths.bundleDir, { recursive: true })]);
  await writeFile(join(paths.inputsDir, "inventory.json"), JSON.stringify({ sources: [], coverageUnits: [] }));
  const state = { version: 5, runId: "run-1", status: resumeAt === "write" ? "writing" : "planning", resumeAt, approval, planDigest: null, approvedAt: null, mainSessionPath: null, bundle: null, quality: { status: "pending", recoveryCount: 0, reports: [], errors: [] }, createdAt: "", updatedAt: "" };
  const calls = { claims: [], releases: [], sessions: [], planning: [], approvals: 0 };
  let claimedBy;
  const core = {
    async prepareRun() { return { ...paths, state, resumeAt, adaptiveDiscovery: { enabled: false, maxAgents: 0 } }; },
    async recordMainSession(_root, input) { calls.sessions.push(input); state.mainSessionPath = input.mainSessionPath; return state; },
    async completeRunPlanning(_root, input) { calls.planning.push(input); state.status = approval === "propose" ? "proposed" : "writing"; state.resumeAt = "write"; return { ...paths, state, planDigest: "sha256:test", requiresApproval: approval === "propose", resumeAt: "write" }; },
    async approveRun() { calls.approvals += 1; state.status = "writing"; state.resumeAt = "write"; return { ...paths, state, planDigest: "sha256:test", requiresApproval: false, resumeAt: "write" }; },
    async resumeRun() { return { ...paths, state, resumeAt: state.resumeAt, adaptiveDiscovery: { enabled: false, maxAgents: 0 }, qualityRecovery: false }; },
    async reportRunStatus(_root, input) { calls.reports.push(input); Object.assign(state, input); return state; },
    async validateRunBundle() { return { ...paths, ok: true, errors: [], warnings: [], state: { ...state, status: "complete" }, status: "complete" }; },
    async getWorkspaceStatus() { return { root, initialized: true, name: "test", wikiLanguage: "en", approval, runtime: "pi", activeRunId: "run-1", active: { ...paths, status: state.status }, runs: [], sources: [] }; },
    async getRunPaths() { return paths; },
    async getRunState() { return state; },
    async claimRun(_root, input) {
      calls.claims.push(input);
      if (claimedBy && claimedBy !== input.orchestrationId) {
        throw new Error("run is already claimed by " + claimedBy);
      }
      const claimed = claimedBy !== input.orchestrationId;
      claimedBy = input.orchestrationId;
      return { claimed, orchestrationId: input.orchestrationId };
    },
    async releaseRun(_root, input) {
      calls.releases.push(input);
      if (claimedBy !== input.orchestrationId) {
        throw new Error("run is not claimed by " + input.orchestrationId);
      }
      claimedBy = undefined;
      return { released: true };
    },
  };
  const agentRunner = createMockAgentRunner(async (request) => {
    const output = [...request.prompt.matchAll(/(\/[\S`]+\.md)/g)].at(-1)?.[1];
    if (output) {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, `Verdict: ${reviewVerdict}\nAffected pages: none\nFindings: ${reviewVerdict === "PASS" ? "none" : "missing evidence"}\nRequired repair: ${reviewVerdict === "PASS" ? "none" : "repair evidence"}\n`);
    }
    return { status: "ok", summary: "ok" };
  });
  return { root, paths, core, calls, agentRunner, async dispose() { await rm(root, { recursive: true, force: true }); } };
}

test("orchestration uses the core resumeAt and releases its orchestration claim", async () => {
  const f = await fixture();
  try {
    const orch = new SessionWikiOrchestrator({ workspaceRoot: f.root, core: f.core, getTools: () => [], agentRunner: f.agentRunner });
    const started = await orch.start({ workspaceRoot: f.root, action: "generate" });
    const result = await orch.waitFor(started.orchestrationId);
    assert.equal(result.status, "complete");
    assert.equal(orch.getSnapshot(started.orchestrationId).overall, "complete");
    assert.equal(f.calls.claims[0].orchestrationId, started.orchestrationId);
    assert.equal(f.calls.releases[0].orchestrationId, started.orchestrationId);
  } finally { await f.dispose(); }
});

test("quality failures remain observable as quality_blocked", async () => {
  const f = await fixture({ reviewVerdict: "FAIL" });
  try {
    const orch = new SessionWikiOrchestrator({ workspaceRoot: f.root, core: f.core, getTools: () => [], agentRunner: f.agentRunner });
    const started = await orch.start({ workspaceRoot: f.root, action: "generate" });
    assert.equal((await orch.waitFor(started.orchestrationId)).status, "quality_blocked");
    assert.equal(orch.getSnapshot(started.orchestrationId).overall, "quality_blocked");
  } finally { await f.dispose(); }
});

test("proposed plans keep the persisted main session across approval", async () => {
  const f = await fixture({ approval: "propose", resumeAt: "discover" });
  try {
    const orch = new SessionWikiOrchestrator({ workspaceRoot: f.root, core: f.core, getTools: () => [], agentRunner: f.agentRunner });
    const proposed = await orch.start({ workspaceRoot: f.root, action: "generate" });
    assert.equal((await orch.waitFor(proposed.orchestrationId)).status, "proposed");
    const approved = await orch.start({ workspaceRoot: f.root, action: "approve", runId: "run-1" });
    assert.equal((await orch.waitFor(approved.orchestrationId)).status, "complete");
    assert.equal(f.calls.approvals, 1);
    assert.match(f.calls.sessions[0].mainSessionPath, /main\.jsonl$/);
  } finally { await f.dispose(); }
});

test("pause releases its claim before an immediate resume", async () => {
  const f = await fixture();
  let firstRun = true;
  let agentStarted;
  const agentStartedPromise = new Promise((resolve) => {
    agentStarted = resolve;
  });
  let releaseStarted;
  const releaseStartedPromise = new Promise((resolve) => {
    releaseStarted = resolve;
  });
  let releaseGate;
  const releaseGatePromise = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const originalReleaseRun = f.core.releaseRun;
  f.core.releaseRun = async (root, input) => {
    releaseStarted();
    await releaseGatePromise;
    return originalReleaseRun(root, input);
  };
  const blockingRunner = createMockAgentRunner(async (request) => {
    if (!firstRun) return f.agentRunner.run(request);
    firstRun = false;
    agentStarted();
    await new Promise((_resolve, reject) => {
      request.signal.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
    });
  });
  const orch = new SessionWikiOrchestrator({
    workspaceRoot: f.root,
    core: f.core,
    getTools: () => [],
    agentRunner: blockingRunner,
  });

  try {
    const started = await orch.start({ workspaceRoot: f.root, action: "generate" });
    await agentStartedPromise;
    const pausePromise = orch.pause(started.orchestrationId);
    await releaseStartedPromise;

    let pauseFinished = false;
    void pausePromise.then(() => {
      pauseFinished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pauseFinished, false);

    releaseGate();
    assert.equal(await pausePromise, true);
    assert.equal(await orch.resume(), true);
    assert.equal((await orch.waitFor()).status, "complete");
    assert.equal(f.calls.claims.length, 2);
  } finally {
    releaseGate();
    await orch.dispose();
    await f.dispose();
  }
});

test("pausing during discovery preserves the immediately recorded main session", async () => {
  const f = await fixture({ resumeAt: "discover" });
  let blockFirstRequest = true;
  let firstRequestStarted;
  const firstRequestStartedPromise = new Promise((resolve) => {
    firstRequestStarted = resolve;
  });
  const runner = createMockAgentRunner(async (request) => {
    if (blockFirstRequest) {
      blockFirstRequest = false;
      firstRequestStarted();
      await new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    }
    return f.agentRunner.run(request);
  });
  const orch = new SessionWikiOrchestrator({ workspaceRoot: f.root, core: f.core, getTools: () => [], agentRunner: runner });

  try {
    const started = await orch.start({ workspaceRoot: f.root, action: "generate" });
    await firstRequestStartedPromise;
    const mainSessionPath = f.calls.sessions[0].mainSessionPath;
    assert.equal(await orch.pause(started.orchestrationId), true);

    assert.match(mainSessionPath, /analysis[\\/]session[\\/]main\.jsonl$/);
    assert.equal(await orch.resume(), true);
    assert.equal((await orch.waitFor()).status, "complete");
    assert.equal(f.calls.sessions.at(-1).mainSessionPath, mainSessionPath);
  } finally {
    await orch.dispose();
    await f.dispose();
  }
});

test("shutdown before planning resumes the immediately recorded main session", async () => {
  const f = await fixture({ resumeAt: "discover" });
  let firstRequestStarted;
  const firstRequestStartedPromise = new Promise((resolve) => {
    firstRequestStarted = resolve;
  });
  const interruptedRunner = createMockAgentRunner(async (request) => {
    firstRequestStarted();
    await new Promise((_resolve, reject) => {
      request.signal.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
    });
  });
  const initial = new SessionWikiOrchestrator({ workspaceRoot: f.root, core: f.core, getTools: () => [], agentRunner: interruptedRunner });
  let restarted;

  try {
    const started = await initial.start({ workspaceRoot: f.root, action: "generate" });
    const mainSessionPath = f.calls.sessions[0].mainSessionPath;
    await firstRequestStartedPromise;
    await initial.dispose();

    restarted = new SessionWikiOrchestrator({ workspaceRoot: f.root, core: f.core, getTools: () => [], agentRunner: f.agentRunner });
    const resumed = await restarted.start({ workspaceRoot: f.root, action: "resume", runId: started.runId });
    assert.equal((await restarted.waitFor(resumed.orchestrationId)).status, "complete");
    assert.equal(f.calls.sessions.at(-1).mainSessionPath, mainSessionPath);
  } finally {
    await initial.dispose();
    await restarted?.dispose();
    await f.dispose();
  }
});

test("dispose drains agent unwind and release before another orchestrator can claim", async () => {
  const f = await fixture({ resumeAt: "discover" });
  let agentStarted;
  const agentStartedPromise = new Promise((resolve) => {
    agentStarted = resolve;
  });
  let allowUnwind;
  const unwindPromise = new Promise((resolve) => {
    allowUnwind = resolve;
  });
  let releaseStarted;
  const releaseStartedPromise = new Promise((resolve) => {
    releaseStarted = resolve;
  });
  let allowRelease;
  const releasePromise = new Promise((resolve) => {
    allowRelease = resolve;
  });
  const originalReleaseRun = f.core.releaseRun;
  f.core.releaseRun = async (root, input) => {
    releaseStarted();
    await releasePromise;
    return originalReleaseRun(root, input);
  };
  const unwindingRunner = createMockAgentRunner(async () => {
    agentStarted();
    await unwindPromise;
    return { status: "ok", summary: "unwound" };
  });
  const initial = new SessionWikiOrchestrator({ workspaceRoot: f.root, core: f.core, getTools: () => [], agentRunner: unwindingRunner });
  const contender = new SessionWikiOrchestrator({ workspaceRoot: f.root, core: f.core, getTools: () => [], agentRunner: f.agentRunner });

  try {
    const started = await initial.start({ workspaceRoot: f.root, action: "generate" });
    await agentStartedPromise;
    const draining = initial.dispose();
    let disposed = false;
    void draining.then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposed, false);
    await assert.rejects(
      contender.start({ workspaceRoot: f.root, action: "resume", runId: started.runId }),
      /already claimed/,
    );

    allowUnwind();
    await releaseStartedPromise;
    assert.equal(disposed, false);
    allowRelease();
    await draining;
    assert.equal(disposed, true);

    const resumed = await contender.start({ workspaceRoot: f.root, action: "resume", runId: started.runId });
    assert.equal((await contender.waitFor(resumed.orchestrationId)).status, "complete");
  } finally {
    allowUnwind();
    allowRelease();
    await initial.dispose();
    await contender.dispose();
    await f.dispose();
  }
});

test("dispose drains a start that claims after shutdown begins", async () => {
  const f = await fixture({ resumeAt: "discover" });
  let claimStarted;
  const claimStartedPromise = new Promise((resolve) => {
    claimStarted = resolve;
  });
  let allowClaim;
  const claimGate = new Promise((resolve) => {
    allowClaim = resolve;
  });
  const originalClaimRun = f.core.claimRun;
  f.core.claimRun = async (root, input) => {
    claimStarted();
    await claimGate;
    return originalClaimRun(root, input);
  };
  const initial = new SessionWikiOrchestrator({ workspaceRoot: f.root, core: f.core, getTools: () => [], agentRunner: f.agentRunner });
  const recovery = new SessionWikiOrchestrator({ workspaceRoot: f.root, core: f.core, getTools: () => [], agentRunner: f.agentRunner });

  try {
    const starting = initial.start({ workspaceRoot: f.root, action: "generate" });
    await claimStartedPromise;
    const draining = initial.dispose();
    let disposed = false;
    void draining.then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposed, false);

    allowClaim();
    await assert.rejects(starting, /disposed/);
    assert.equal(f.calls.releases.length, 1);
    assert.equal(f.calls.sessions.length, 0);
    await draining;
    assert.equal(disposed, true);

    const resumed = await recovery.start({ workspaceRoot: f.root, action: "resume", runId: "run-1" });
    assert.equal((await recovery.waitFor(resumed.orchestrationId)).status, "complete");
  } finally {
    allowClaim();
    await initial.dispose();
    await recovery.dispose();
    await f.dispose();
  }
});
