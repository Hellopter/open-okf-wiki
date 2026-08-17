import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "os";
import path from "node:path";
import test from "node:test";
import { createWikiDelegateContract } from "../dist/delegate-contracts.js";
import {
  createWikiRunRecord,
  projectRunView,
  UnsupportedWikiRunVersionError,
  WIKI_RUN_FORMAT,
} from "../dist/run-record.js";

async function root(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), "wiki-run-record-"));
  t.after(async () => await rm(value, { recursive: true, force: true }));
  return value;
}

const owner = { pid: process.pid };
const token = "execution-token-0000000000001";
const authority = { attempt: 1, executionToken: token };

function taskContract() {
  return createWikiDelegateContract(1, {
    id: "write-1", role: "write", instruction: "write", sourceScopeIds: ["source"],
    contextRefs: [], writePaths: ["wiki/overview.md"],
  });
}

function emptyLead(overrides = {}) {
  return {
    candidateRevision: 0,
    specRevision: 0,
    policyDigest: "a".repeat(64),
    compactionObserved: false,
    sourceScopeIds: ["source"],
    reviews: [],
    delegates: { batches: [] },
    ...overrides,
  };
}

function receiptFor(task) {
  return {
    id: task.id, role: task.role, status: "complete", summary: "written",
    outputs: [], coverage: ["wiki/overview.md"], gaps: [], attempts: 1,
    contractId: task.contractId, contractDigest: task.contractDigest,
  };
}

async function running(record, workspace) {
  await record.create({ id: "run-1", cwd: workspace, at: "2026-01-01T00:00:00.000Z" });
  await record.drive("run-1", { kind: "started", at: "2026-01-01T00:00:00.000Z" });
  await record.drive("run-1", { kind: "attempt_started", at: "2026-01-01T00:00:01.000Z", executionToken: token, owner });
}

function runningTask(task) {
  return { task, phase: "running", attempt: 1, collected: false };
}

function terminalTask(task) {
  return { task, phase: "terminal", attempt: 1, collected: false, receipt: receiptFor(task) };
}

test("list, view, and restore agree after a crash following commitLead", async (t) => {
  const workspace = await root(t);
  const task = taskContract();
  const setup = createWikiRunRecord(workspace);
  await running(setup, workspace);
  await setup.commitLead("run-1", emptyLead({
    delegates: { batches: [{ batchId: 1, tasks: [runningTask(task)] }] },
  }), authority);

  const live = createWikiRunRecord(workspace, {
    fault: async (point) => {
      if (point === "afterCommitLead") throw new Error("crash after control-plane commit");
    },
  });
  const settled = emptyLead({
    delegates: { batches: [{ batchId: 1, tasks: [terminalTask(task)] }] },
  });
  await assert.rejects(live.commitLead("run-1", settled, authority), /crash after control-plane commit/);

  const recovered = createWikiRunRecord(workspace);
  const listed = await recovered.list();
  const facts = await recovered.read("run-1");
  const view = projectRunView(facts);
  const resume = facts.lead.delegates.batches[0].tasks[0];

  assert.equal(listed[0].id, "run-1");
  assert.equal(projectRunView(listed[0]).progress.currentBatch.tasks[0].status, "complete");
  assert.equal(view.progress.currentBatch.tasks[0].status, "complete");
  assert.equal(resume.phase, "terminal");
  assert.equal(resume.receipt.summary, "written");
  assert.equal(listed[0].updatedAt, facts.updatedAt);
});

test("a crash before commitLead leaves list, view, and restore running", async (t) => {
  const workspace = await root(t);
  const task = taskContract();
  const setup = createWikiRunRecord(workspace);
  await running(setup, workspace);
  await setup.commitLead("run-1", emptyLead({
    delegates: { batches: [{ batchId: 1, tasks: [runningTask(task)] }] },
  }), authority);

  const live = createWikiRunRecord(workspace, {
    fault: async (point) => {
      if (point === "beforeCommitLead") throw new Error("crash before control-plane commit");
    },
  });

  await assert.rejects(live.commitLead("run-1", emptyLead({
    delegates: { batches: [{ batchId: 1, tasks: [terminalTask(task)] }] },
  }), authority), /crash before control-plane commit/);

  const recovered = createWikiRunRecord(workspace);
  const facts = await recovered.read("run-1");
  const view = projectRunView(facts);
  assert.equal(facts.lead.delegates.batches[0].tasks[0].phase, "running");
  assert.equal(facts.lead.delegates.batches[0].tasks[0].receipt, undefined);
  assert.equal(view.progress.currentBatch.tasks[0].status, "running");
  assert.equal(projectRunView((await recovered.list())[0]).progress.currentBatch.tasks[0].status, "running");
});

test("telemetry does not change a durable task phase", async (t) => {
  const workspace = await root(t);
  const task = taskContract();
  const record = createWikiRunRecord(workspace);
  await running(record, workspace);
  await record.commitLead("run-1", emptyLead({
    delegates: { batches: [{ batchId: 1, tasks: [runningTask(task)] }] },
  }), authority);

  await record.noteLive("run-1", {
    kind: "telemetry",
    target: { kind: "task", batch: 1, taskId: "write-1" },
    telemetry: {
      target: { kind: "task", batch: 1, taskId: "write-1" },
      attempt: 1,
      sampledAt: "2026-01-01T02:00:00.000Z",
      activity: "using_tool",
      activeTools: [{ name: "read", startedAt: "2026-01-01T02:00:00.000Z" }],
      process: [{
        sequence: 1, at: "2026-01-01T02:00:00.000Z", kind: "tool", severity: "info",
        message: "", toolCallId: "call-1", toolName: "read",
      }],
    },
  }, authority);

  const facts = await record.read("run-1");
  assert.equal(facts.lead.delegates.batches[0].tasks[0].phase, "running");
  const disk = JSON.parse(await readFile(path.join(workspace, "runs", "run-1", "run.json"), "utf8"));
  assert.equal(disk.progress, undefined);
  assert.equal(disk.version, WIKI_RUN_FORMAT);
  const tail = await record.readTail("run-1", { kind: "task", batch: 1, taskId: "write-1" });
  assert.equal(tail.agent.activity, "using_tool");
  assert.equal(tail.receipt, undefined);
  assert.equal(tail.execution, undefined);
});

test("format 1 snapshots and leftover lead-state fail closed", async (t) => {
  const workspace = await root(t);
  const record = createWikiRunRecord(workspace);
  await running(record, workspace);

  const runFile = path.join(workspace, "runs", "run-1", "run.json");
  const snapshot = JSON.parse(await readFile(runFile, "utf8"));
  snapshot.version = 1;
  await writeFile(runFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  await assert.rejects(createWikiRunRecord(workspace).read("run-1"), UnsupportedWikiRunVersionError);

  const other = await root(t);
  const runDir = path.join(other, "runs", "old-run");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "lead-state.json"), `${JSON.stringify({ version: 1, runId: "old-run" })}\n`);
  await assert.rejects(createWikiRunRecord(other).read("old-run"), UnsupportedWikiRunVersionError);
});

test("a dead pid is stale and interrupt keeps delegates", async (t) => {
  const workspace = await root(t);
  const task = taskContract();
  const record = createWikiRunRecord(workspace);
  await running(record, workspace);
  await record.commitLead("run-1", emptyLead({
    delegates: { batches: [{ batchId: 1, tasks: [terminalTask(task)] }] },
  }), authority);
  assert.equal(await record.executionOwner("run-1"), "live");

  const runFile = path.join(workspace, "runs", "run-1", "run.json");
  const snapshot = JSON.parse(await readFile(runFile, "utf8"));
  snapshot.pid = 2 ** 22;
  await writeFile(runFile, `${JSON.stringify(snapshot, null, 2)}\n`);

  const fresh = createWikiRunRecord(workspace);
  assert.equal(await fresh.executionOwner("run-1"), "stale");
  await fresh.drive("run-1", { kind: "interrupted", at: "2026-01-01T00:00:09.000Z" });
  const facts = await fresh.read("run-1");
  assert.equal(facts.status, "paused");
  assert.equal(facts.lead.delegates.batches[0].tasks[0].phase, "terminal");
  assert.equal(facts.lead.delegates.batches[0].tasks[0].receipt.summary, "written");
});
