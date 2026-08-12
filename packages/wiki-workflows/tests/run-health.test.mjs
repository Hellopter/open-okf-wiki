import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiArtifactStore } from "../dist/artifact-store.js";
import { checkRunArtifactHealth } from "../dist/run-health.js";
import { WikiWorkflowEngine } from "../dist/engine.js";
import { resolveWikiPolicy, wikiPolicyHash } from "../dist/policy.js";
import { explainWikiRunSnapshot } from "../dist/snapshot-validation.js";

const EMPTY_METRICS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  cost: 0,
  compactions: 0,
  autoRetries: 0,
};

function activity() {
  return { state: "completed", message: "done", updatedAt: "2026-08-10T00:00:00.000Z" };
}

function baseSnapshot(overrides = {}) {
  const policy = resolveWikiPolicy();
  return {
  version: 2,
    id: "run-health",
    cwd: "/workspace",
    requestedMode: "generate",
    language: "zh",
    status: "paused",
    round: 1,
    sourceRestartCount: 0,
    maxResearchRounds: 6,
    policy,
    policyHash: wikiPolicyHash(policy),
    nodes: [],
    events: [],
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function node(overrides) {
  return {
    id: "node-1",
    kind: "research",
    label: "node",
    status: "succeeded",
    dependsOn: [],
    attempt: 1,
    attemptHistory: [],
    phaseId: "research",
    phaseTitle: "Research",
    input: {},
    inputFingerprint: "fp",
    metrics: { ...EMPTY_METRICS },
    activity: activity(),
    ...overrides,
  };
}

test("checkRunArtifactHealth reports missing succeeded research handoffs", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-health-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const store = createWikiArtifactStore({ workspace });

  const present = await store.write({
    runId: "run-health",
    nodeId: "research-ok",
    attempt: 1,
    kind: "research",
    content: `${JSON.stringify({ summary: "ok", findings: [], gaps: [] })}\n`,
  });
  const missing = {
    ...present,
    nodeId: "research-missing",
    // Content-addressed path for a digest that was never written.
    relativePath: `.okf-wiki/blobs/${"0".repeat(64)}.json`,
    sha256: "0".repeat(64),
  };

  const snapshot = baseSnapshot({
    cwd: workspace,
    nodes: [
      node({ id: "research-ok", label: "ok", handoff: present }),
      node({ id: "research-missing", label: "missing", handoff: missing }),
      node({
        id: "write-1",
        kind: "write",
        label: "write",
        phaseId: "write",
        phaseTitle: "Write",
        // Writers are ignored even without a handoff check path.
      }),
    ],
  });

  const problems = await checkRunArtifactHealth(workspace, snapshot, store);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /research node research-missing/);
});

test("applyRestoredArtifactHealth blocks a paused run with missing handoffs", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-health-engine-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const store = createWikiArtifactStore({ workspace });
  const engine = new WikiWorkflowEngine({
    executor: { execute: async () => ({ result: undefined }) },
    artifactStore: store,
  });

  const missingRef = {
    version: 1,
    runId: "run-health",
    nodeId: "synthesis-1",
    attempt: 1,
    kind: "synthesis",
    relativePath: `.okf-wiki/blobs/${"a".repeat(64)}.json`,
    sha256: "a".repeat(64),
    sizeBytes: 2,
    mediaType: "application/json",
  };

  const snapshot = baseSnapshot({
    id: "run-health",
    cwd: workspace,
    status: "paused",
    nodes: [
      node({
        id: "synthesis-1",
        kind: "synthesis",
        label: "Synthesize",
        phaseId: "plan",
        phaseTitle: "Plan",
        input: {
          researchIds: [],
          mode: "initial",
          round: 1,
        },
        handoff: missingRef,
        result: {
          kind: "synthesis",
          artifact: missingRef,
          domainCount: 1,
          pageCount: 1,
        },
      }),
    ],
  });

  assert.ok(engine.restore(snapshot), explainWikiRunSnapshot(snapshot).join("; "));
  const problems = await engine.applyRestoredArtifactHealth();
  assert.equal(problems.length, 1);
  const blocked = engine.getSnapshot();
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockedDetails?.code, "missing_handoff_artifacts");
  assert.match(blocked.blockedReason, /Missing or unreadable handoff artifacts/);

  await assert.rejects(() => engine.resume(), /cannot resume|requires targeted node retry/);
});
