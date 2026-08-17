import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "os";
import path from "node:path";
import test from "node:test";
import { createWikiRunLedger, UnsupportedWikiRunVersionError } from "../dist/run-ledger.js";
import { createWikiDelegateContract } from "../dist/delegate-contracts.js";

async function root(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), "wiki-production-run-"));
  t.after(async () => await rm(value, { recursive: true, force: true }));
  return value;
}

function plan(workspace) {
  const digest = "a".repeat(64);
  return {
    sourcePlan: {
      workspaceRoot: workspace, workspaceRealPath: workspace, configPath: path.join(workspace, "workspace.yaml"),
      defaultSourceIgnores: true, excludes: [], fingerprint: digest,
      sources: [{ scopeId: "source", logicalPath: ".", absolutePath: workspace, realPath: workspace, repositoryRoot: workspace,
        repositoryIdentity: "b".repeat(64), origin: { type: "link", localPath: workspace }, head: "", dirtyFingerprint: "c".repeat(64) }],
    },
    candidateWikiRoot: path.join(workspace, ".okf-wiki", "runs", "run-1", "candidate", "wiki"),
    skillRoot: path.join(workspace, ".okf-wiki", "runs", "run-1", "skill"),
    skillTreeDigest: "e".repeat(64), language: "en", generation: {
      audience: [], purpose: "", focus: { include: [], exclude: [] }, granularity: { preferChildPagesFor: [] },
      templates: { requiredSections: [] }, review: { mustCover: [] },
    },
    maxConcurrentAgents: 2,
    budgets: { maxDelegatedTasks: 8, maxDelegateBatches: 4, maxTurnsPerSession: 20, maxToolCallsPerSession: 40 },
    models: {}, runSessionDirectory: path.join(workspace, ".okf-wiki", "runs", "run-1", "sessions"),
    transientRetries: 1, sessionTimeoutMs: 60_000, baseRetryDelayMs: 10, prompt: "Produce Wiki",
  };
}

const owner = { pid: process.pid };
const token = "execution-token-0000000000001";
const authority = { attempt: 1, executionToken: token };
const begin = async (ledger, at = "2026-01-01T00:00:01.000Z") =>
  await ledger.transition("run-1", { kind: "attempt_started", at, executionToken: token, owner });

async function started(ledger, workspace) {
  await ledger.create({ id: "run-1", cwd: workspace, at: "2026-01-01T00:00:00.000Z" });
  await ledger.transition("run-1", { kind: "started", at: "2026-01-01T00:00:00.000Z" });
}

function leadTelemetry(overrides = {}) {
  return {
    target: { kind: "lead" },
    attempt: 1,
    sampledAt: "2026-01-01T02:00:00.000Z",
    activity: "waiting_model",
    activeTools: [],
    lastHeartbeatAt: "2026-01-01T02:00:00.000Z",
    lastActivityAt: "2026-01-01T01:59:00.000Z",
    ...overrides,
  };
}

function toolProcess({ toolCallId = "call-1", completed = false, summary = "wiki/overview.md", sequence = 1 } = {}) {
  return {
    sequence, at: "2026-01-01T02:00:00.000Z", kind: "tool", severity: "info", target: { kind: "lead" },
    message: "", toolCallId, toolName: "read", summary, completed,
  };
}

test("lifecycle writes run.json and plan.json without an event log", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  await begin(ledger);
  await ledger.transition("run-1", { kind: "plan_pinned", at: "2026-01-01T00:00:02.000Z", plan: plan(workspace) });
  await ledger.transition("run-1", { kind: "stage_entered", at: "2026-01-01T00:00:03.000Z", stage: "lead" });
  await ledger.transition("run-1", { kind: "lead_completed", at: "2026-01-01T00:00:04.000Z", summary: "done" });
  await ledger.transition("run-1", { kind: "published", at: "2026-01-01T00:00:05.000Z", pages: ["overview.md"], sourceFingerprint: "a".repeat(64), finalTreeDigest: "d".repeat(64) });

  const snapshot = JSON.parse(await readFile(path.join(workspace, "runs", "run-1", "run.json"), "utf8"));
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.productionPlan, undefined);
  const pinned = JSON.parse(await readFile(path.join(workspace, "runs", "run-1", "plan.json"), "utf8"));
  assert.equal(pinned.sourcePlan.fingerprint, "a".repeat(64));
  await assert.rejects(readdir(path.join(workspace, "runs", "run-1", "events")), { code: "ENOENT" });
  assert.equal((await ledger.read("run-1")).productionPlan.sourcePlan.fingerprint, "a".repeat(64));
});

test("transition table rejects illegal order and terminal snapshots are immutable", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  await assert.rejects(ledger.transition("run-1", { kind: "stage_entered", at: "2026-01-01T00:00:01.000Z", stage: "lead" }), /pinned/);
  await assert.rejects(ledger.transition("run-1", { kind: "resumed", at: "2026-01-01T00:00:01.000Z", executionToken: token, owner }), /paused/);
  await ledger.transition("run-1", { kind: "cancelled", at: "2026-01-01T00:00:02.000Z" });
  await assert.rejects(ledger.transition("run-1", { kind: "attempt_started", at: "2026-01-01T00:00:03.000Z", executionToken: token, owner }), /immutable/);
});

test("legacy process files fail closed", async (t) => {
  const workspace = await root(t);
  const runDir = path.join(workspace, "runs", "old-run");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run-state.json"), `${JSON.stringify({ version: 1, id: "old-run" })}\n`);
  const ledger = createWikiRunLedger(workspace);
  await assert.rejects(ledger.read("old-run"), UnsupportedWikiRunVersionError);
});

test("running and paused runs retain the workspace marker until a terminal transition", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  await begin(ledger);
  await ledger.transition("run-1", { kind: "manual_paused", at: "2026-01-01T00:00:02.000Z" }, authority);
  await assert.rejects(ledger.create({ id: "run-2", cwd: workspace, at: "2026-01-01T00:00:02.000Z" }), /already active/);
  await ledger.transition("run-1", { kind: "cancelled", at: "2026-01-01T00:00:03.000Z" });
  await ledger.create({ id: "run-2", cwd: workspace, at: "2026-01-01T00:00:04.000Z" });
});

test("a completed run id cannot be reused", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  await ledger.transition("run-1", { kind: "cancelled", at: "2026-01-01T00:00:01.000Z" });
  const before = await readFile(path.join(workspace, "runs", "run-1", "run.json"), "utf8");
  await assert.rejects(ledger.create({ id: "run-1", cwd: workspace, at: "2026-01-01T00:00:02.000Z" }), /already exists/);
  assert.equal(await readFile(path.join(workspace, "runs", "run-1", "run.json"), "utf8"), before);
});

test("task_settled projects the receipt into the agent file", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  const task = createWikiDelegateContract(1, { id: "write-1", role: "write", instruction: "write", sourceScopeIds: ["source"], contextRefs: [], writePaths: ["wiki/overview.md"] });
  await begin(ledger);
  const receipt = { id: "write-1", role: "write", status: "complete", summary: "written", outputs: [], coverage: ["wiki/overview.md"], gaps: [], attempts: 1,
    contractId: task.contractId, contractDigest: task.contractDigest };
  const event = await ledger.recordObservation("run-1", {
    kind: "task_settled", batch: 1, taskId: "write-1",
    state: { task, phase: "terminal", attempt: 1, collected: false, sessionFile: "/sessions/write-1.jsonl", receipt },
  }, authority);
  assert.equal(event.type, "delegate");
  assert.equal(event.phase, "settled");
  const record = await ledger.readAgent("run-1", { kind: "task", batch: 1, taskId: "write-1" });
  assert.deepEqual(record.receipt, receipt);
  assert.equal(record.sessionFile, "/sessions/write-1.jsonl");
  assert.equal(record.agent.status, "complete");
});

test("telemetry writes the agent file and does not create events", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  await begin(ledger);
  const event = await ledger.recordObservation("run-1", {
    kind: "telemetry", target: { kind: "lead" },
    telemetry: leadTelemetry({
      activity: "using_tool",
      activeTools: [{ id: "call-1", name: "read", startedAt: "2026-01-01T02:00:00.000Z", summary: "wiki/overview.md" }],
      process: [toolProcess()],
      usage: { turns: 1, toolCalls: 1 },
    }),
  }, authority);
  assert.equal(event, undefined);
  await assert.rejects(readdir(path.join(workspace, "runs", "run-1", "events")), { code: "ENOENT" });
  const record = await ledger.readAgent("run-1", { kind: "lead" });
  assert.equal(record.agent.activity, "using_tool");
  assert.equal(record.process[0].toolCallId, "call-1");
});

test("health updates stay on the agent record", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  await begin(ledger);
  const degraded = await ledger.recordObservation("run-1", {
    kind: "health", target: { kind: "lead" }, status: "degraded", at: "2026-01-01T02:00:02.000Z", message: "queue saturated",
  }, authority);
  assert.equal(degraded, undefined);
  assert.equal((await ledger.readAgent("run-1", { kind: "lead" })).agent.health, "degraded");
  await ledger.recordObservation("run-1", {
    kind: "health", target: { kind: "lead" }, status: "healthy", at: "2026-01-01T02:00:03.000Z",
  }, authority);
  assert.equal((await ledger.readAgent("run-1", { kind: "lead" })).agent.health, "healthy");
});

test("dead pid is a stale execution owner", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  await begin(ledger);
  assert.equal(await ledger.executionOwner("run-1"), "live");
  const snapshot = JSON.parse(await readFile(path.join(workspace, "runs", "run-1", "run.json"), "utf8"));
  snapshot.pid = 2 ** 22;
  await writeFile(path.join(workspace, "runs", "run-1", "run.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  const fresh = createWikiRunLedger(workspace);
  assert.equal(await fresh.executionOwner("run-1"), "stale");
});
