import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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
      sources: [{ scopeId: ".", logicalPath: ".", absolutePath: workspace, realPath: workspace, repositoryRoot: workspace,
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

const owner = { ownerToken: "owner-token-0000000000000001", pid: process.pid };
const token = "execution-token-0000000000001";
const authority = { attempt: 1, executionToken: token };
const begin = async (ledger, at = "2026-01-01T00:00:01.000Z") =>
  await ledger.transition("run-1", { kind: "attempt_started", at, executionToken: token, owner });

async function started(ledger, workspace) {
  await ledger.create({ id: "run-1", cwd: workspace, at: "2026-01-01T00:00:00.000Z" });
  await ledger.transition("run-1", { kind: "started", at: "2026-01-01T00:00:00.000Z" });
}

test("semantic transitions persist current-format snapshots and same-sequence update projections", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  await begin(ledger);
  await ledger.transition("run-1", { kind: "plan_pinned", at: "2026-01-01T00:00:02.000Z", plan: plan(workspace) });
  await ledger.transition("run-1", { kind: "stage_entered", at: "2026-01-01T00:00:03.000Z", stage: "lead" });
  await ledger.transition("run-1", { kind: "lead_completed", at: "2026-01-01T00:00:04.000Z", summary: "done" });
  await ledger.transition("run-1", { kind: "published", at: "2026-01-01T00:00:05.000Z", pages: ["overview.md"], sourceFingerprint: "a".repeat(64), finalTreeDigest: "d".repeat(64) });

  const snapshot = JSON.parse(await readFile(path.join(workspace, "runs", "run-1", "run-state.json"), "utf8"));
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.operation, undefined);
  const updates = await ledger.updates("run-1");
  assert.deepEqual(updates.map(({ event }) => event.sequence), [1, 2, 3, 4, 5, 6]);
  for (const update of updates) assert.equal(update.state.lastEventSequence, update.event.sequence);
  assert.equal(updates.at(-1).event.type, "completed");
  assert.equal(updates.at(-1).state.status, "succeeded");
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

test("pending transaction recovery is idempotent and restores its exact update", async (t) => {
  const workspace = await root(t);
  const stable = createWikiRunLedger(workspace);
  await started(stable, workspace);
  await begin(stable);
  let crashed = false;
  const crashing = createWikiRunLedger(workspace, { fault(point) {
    if (!crashed && point === "afterState") { crashed = true; throw new Error("crash"); }
  } });
  await assert.rejects(crashing.transition("run-1", { kind: "plan_pinned", at: "2026-01-01T00:00:02.000Z", plan: plan(workspace) }), /crash/);

  const recovered = createWikiRunLedger(workspace);
  const state = await recovered.read("run-1");
  assert.equal(state.productionPlan.sourcePlan.fingerprint, "a".repeat(64));
  const updates = await recovered.updates("run-1");
  assert.equal(updates.filter(({ event }) => event.sequence === 3).length, 1);
  await assert.rejects(readFile(path.join(workspace, "runs", "run-1", "pending-transaction.json"), "utf8"), { code: "ENOENT" });
});

test("terminal pending recovery commits snapshot, event and active-marker release together", async (t) => {
  const workspace = await root(t);
  const stable = createWikiRunLedger(workspace);
  await started(stable, workspace);
  let crashed = false;
  const crashing = createWikiRunLedger(workspace, { fault(point) {
    if (!crashed && point === "afterEvent") { crashed = true; throw new Error("terminal crash"); }
  } });
  await assert.rejects(crashing.transition("run-1", { kind: "cancelled", at: "2026-01-01T00:00:01.000Z" }), /terminal crash/);
  const recovered = createWikiRunLedger(workspace);
  assert.equal((await recovered.read("run-1")).status, "cancelled");
  assert.equal((await recovered.updates("run-1")).at(-1).event.type, "cancelled");
  await recovered.create({ id: "run-2", cwd: workspace, at: "2026-01-01T00:00:02.000Z" });
});

test("unsupported snapshot and legacy active marker fail closed without changing disk", async (t) => {
  const workspace = await root(t);
  const runDir = path.join(workspace, "runs", "old-run");
  await mkdir(runDir, { recursive: true });
  const legacyState = `${JSON.stringify({ version: 2, id: "old-run" })}\n`;
  await writeFile(path.join(runDir, "run-state.json"), legacyState);
  const ledger = createWikiRunLedger(workspace);
  await assert.rejects(ledger.read("old-run"), UnsupportedWikiRunVersionError);
  assert.equal(await readFile(path.join(runDir, "run-state.json"), "utf8"), legacyState);

  const marker = path.join(workspace, "active-run");
  await writeFile(marker, "old-run\n");
  await assert.rejects(ledger.create({ id: "new-run", cwd: workspace, at: "2026-01-01T00:00:00.000Z" }), UnsupportedWikiRunVersionError);
  assert.equal(await readFile(marker, "utf8"), "old-run\n");
});

test("updates after a sequence cursor skip older event files without parsing them", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  await begin(ledger);
  const first = path.join(workspace, "runs", "run-1", "events", "0000000000000001.json");
  const invalid = { ...JSON.parse(await readFile(first, "utf8")), extra: true };
  await writeFile(first, `${JSON.stringify(invalid)}\n`);
  await assert.rejects(ledger.updates("run-1"), /unknown fields/);
  const updates = await ledger.updates("run-1", 1);
  assert.deepEqual(updates.map(({ event }) => event.sequence), [2]);
  assert.equal(updates[0].event.type, "stage");
  assert.equal(updates[0].event.stage, "prepare");
});

test("durable event parser rejects unknown payload fields instead of exposing a data bag", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  const eventsFile = path.join(workspace, "runs", "run-1", "events", "0000000000000001.json");
  const first = JSON.parse((await readFile(eventsFile, "utf8")).trim());
  const invalid = { ...first, event: { ...first.event, data: { stage: "lead" } } };
  await writeFile(eventsFile, `${JSON.stringify(invalid)}\n`);
  await assert.rejects(ledger.updates("run-1"), /unknown fields/);
});

test("an atomic event temp left by a crash is ignored and pending WAL still rolls forward", async (t) => {
  const workspace = await root(t);
  const stable = createWikiRunLedger(workspace);
  await started(stable, workspace);
  await mkdir(path.join(workspace, "runs", "run-1", "events"), { recursive: true });
  await writeFile(path.join(workspace, "runs", "run-1", "events", ".0000000000000002.json.torn"), '{"version":2');
  let crashed = false;
  const subject = createWikiRunLedger(workspace, { fault(point) {
    if (!crashed && point === "afterState") { crashed = true; throw new Error("crash after state"); }
  } });
  await assert.rejects(begin(subject), /crash after state/);
  const recovered = createWikiRunLedger(workspace);
  assert.deepEqual((await recovered.updates("run-1")).map(({ event }) => event.sequence), [1, 2]);
  assert.equal((await recovered.read("run-1")).executionToken, token);
});

test("transaction and update envelopes reject extra fields and cross-field mismatches", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  const runRoot = path.join(workspace, "runs", "run-1");
  const first = JSON.parse(await readFile(path.join(runRoot, "events", "0000000000000001.json"), "utf8"));
  await writeFile(path.join(runRoot, "events", "0000000000000001.json"), `${JSON.stringify({ ...first, extra: true })}\n`);
  await assert.rejects(ledger.updates("run-1"), /unknown fields/);

  await rm(path.join(runRoot, "events"), { recursive: true, force: true });
  const invalid = { version: 2, state: { ...first.state, lastEventSequence: 2 }, event: first.event, active: "retain", extra: true };
  await writeFile(path.join(runRoot, "pending-transaction.json"), `${JSON.stringify(invalid)}\n`);
  await assert.rejects(ledger.read("run-1"), /unknown fields|sequence mismatch/);
});

test("production plan and receipt codecs reject extra or incomplete durable fields", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  await begin(ledger);
  await assert.rejects(ledger.transition("run-1", { kind: "plan_pinned", at: "2026-01-01T00:00:02.000Z", plan: { ...plan(workspace), extra: true } }, authority), /unknown fields/);

  const task = createWikiDelegateContract(1, { id: "write-invalid", role: "write", instruction: "write", sourceScopeIds: ["."], contextRefs: [], writePaths: ["wiki/overview.md"] });
  await assert.rejects(ledger.recordObservation("run-1", { kind: "task_settled", batch: 1, taskId: task.id,
    state: { task, phase: "terminal", attempt: 1, collected: false, receipt: {
      id: task.id, role: "write", status: "complete", summary: "invalid", outputs: [], coverage: [], gaps: [], attempts: 1, extra: true,
    } } }, authority), /unknown fields|contract/i);
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

test("a completed run id cannot be reused and overwrite durable history", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  await ledger.transition("run-1", { kind: "cancelled", at: "2026-01-01T00:00:01.000Z" });
  const before = await readFile(path.join(workspace, "runs", "run-1", "run-state.json"), "utf8");
  await assert.rejects(ledger.create({ id: "run-1", cwd: workspace, at: "2026-01-01T00:00:02.000Z" }), /already exists/);
  assert.equal(await readFile(path.join(workspace, "runs", "run-1", "run-state.json"), "utf8"), before);
});

test("task_settled projects the already-durable receipt, session and execution into agent inspection", async (t) => {
  const workspace = await root(t);
  const ledger = createWikiRunLedger(workspace);
  await started(ledger, workspace);
  const task = createWikiDelegateContract(1, { id: "write-1", role: "write", instruction: "write", sourceScopeIds: ["."], contextRefs: [], writePaths: ["wiki/overview.md"] });
  await begin(ledger);
  const receipt = { id: "write-1", role: "write", status: "complete", summary: "written", outputs: [], coverage: ["wiki/overview.md"], gaps: [], attempts: 1,
    contractId: task.contractId, contractDigest: task.contractDigest };
  await ledger.recordObservation("run-1", {
    kind: "task_settled", batch: 1, taskId: "write-1",
    state: { task, phase: "terminal", attempt: 1, collected: false, sessionFile: "/sessions/write-1.jsonl", receipt },
  }, authority);
  const record = await ledger.readAgent("run-1", { kind: "task", batch: 1, taskId: "write-1" });
  assert.deepEqual(record.receipt, receipt);
  assert.equal(record.sessionFile, "/sessions/write-1.jsonl");
  assert.equal(record.execution.phase, "terminal");
  assert.equal(record.agent.status, "complete");
});
