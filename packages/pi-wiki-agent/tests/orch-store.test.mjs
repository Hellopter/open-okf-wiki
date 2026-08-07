import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_ORCH_LIMITS, mergeOrchLimits, safeAgentId, WikiRunStore } from "../dist/orch/index.js";

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "pi-wiki-orch-"));
}

test("mergeOrchLimits applies defaults and partial overrides", () => {
  assert.equal(DEFAULT_ORCH_LIMITS.concurrency, 4);
  assert.equal(DEFAULT_ORCH_LIMITS.maxAgents, 48);
  assert.equal(DEFAULT_ORCH_LIMITS.agentTimeoutMs, 900_000);
  assert.equal(DEFAULT_ORCH_LIMITS.agentRetries, 1);
  assert.equal(DEFAULT_ORCH_LIMITS.maxSurveyLanes, 4);
  assert.equal(DEFAULT_ORCH_LIMITS.targetUnitsPerLane, 3);
  assert.equal(DEFAULT_ORCH_LIMITS.heartbeatMs, 5_000);
  assert.equal(DEFAULT_ORCH_LIMITS.staleWarnMs, 30_000);

  const merged = mergeOrchLimits({ concurrency: 2, heartbeatMs: 1000 });
  assert.equal(merged.concurrency, 2);
  assert.equal(merged.heartbeatMs, 1000);
  assert.equal(merged.maxAgents, 48);
  assert.equal(mergeOrchLimits().concurrency, 4);
});

test("safeAgentId replaces non-alnum with underscore", () => {
  assert.equal(safeAgentId("survey::lane-1"), "survey__lane_1");
  assert.equal(safeAgentId("abc"), "abc");
});

test("createRun writes snapshot under unbound orchestration path", () => {
  const root = tempWorkspace();
  const store = new WikiRunStore({ workspaceRoot: root, orchRunId: "orch-1" });
  const snap = store.createRun({
    orchRunId: "orch-1",
    backend: "session",
    mode: "auto",
    focus: "auth",
    workspaceRoot: root,
  });

  assert.equal(snap.version, 1);
  assert.equal(snap.orchRunId, "orch-1");
  assert.equal(snap.overall, "idle");
  assert.equal(snap.backend, "session");
  assert.equal(snap.mode, "auto");
  assert.equal(snap.focus, "auth");
  assert.equal(snap.agents.length, 0);
  assert.equal(snap.phases.length, 0);
  assert.ok(snap.updatedAt);

  const expectedDir = join(root, ".wiki-agent", "orchestration", "orch-1");
  assert.equal(store.storeDir, expectedDir);
  assert.ok(existsSync(join(expectedDir, "snapshot.json")));
  const disk = JSON.parse(readFileSync(join(expectedDir, "snapshot.json"), "utf8"));
  assert.equal(disk.orchRunId, "orch-1");
});

test("appendEvent bumps seq and listEvents supports tail", () => {
  const root = tempWorkspace();
  const store = new WikiRunStore({ workspaceRoot: root });
  store.createRun({
    orchRunId: "orch-seq",
    backend: "session",
    mode: "plan",
    workspaceRoot: root,
  });

  const e1 = store.appendEvent("orch.started", { detail: { hello: 1 } });
  const e2 = store.appendEvent("phase.started", { phase: "survey" });
  const e3 = store.appendEvent("agent.queued", { agentId: "a1", phase: "survey" });

  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e3.seq, 3);
  assert.equal(e1.type, "orch.started");
  assert.equal(e3.agentId, "a1");

  const all = store.listEvents();
  assert.equal(all.length, 3);
  assert.deepEqual(
    all.map((e) => e.seq),
    [1, 2, 3],
  );

  const tail = store.listEvents({ tail: 2 });
  assert.equal(tail.length, 2);
  assert.equal(tail[0].seq, 2);
  assert.equal(tail[1].seq, 3);
});

test("upsertAgent creates and merges agent rows", () => {
  const root = tempWorkspace();
  const store = new WikiRunStore({ workspaceRoot: root });
  store.createRun({
    orchRunId: "orch-agents",
    backend: "subagents",
    mode: "auto",
    workspaceRoot: root,
  });

  store.upsertAgent({ agentId: "survey-1", role: "survey", label: "Lane 1", status: "queued" });
  store.upsertAgent({
    agentId: "survey-1",
    status: "running",
    startedAt: 1_704_067_200_000,
    lastHeartbeatAt: 1_704_067_205_000,
  });
  store.upsertAgent({ agentId: "survey-2", role: "survey", status: "queued" });

  const snap = store.getSnapshot();
  assert.equal(snap.agents.length, 2);
  const a1 = snap.agents.find((a) => a.agentId === "survey-1");
  assert.ok(a1);
  assert.equal(a1.status, "running");
  assert.equal(a1.label, "Lane 1");
  assert.equal(a1.role, "survey");
  assert.equal(a1.receiptsWritten, 0);
  assert.equal(a1.elapsedMs, 0);
  assert.equal(a1.startedAt, 1_704_067_200_000);
});

test("setPhase / setOverall / setFocus update snapshot", () => {
  const root = tempWorkspace();
  const store = new WikiRunStore({ workspaceRoot: root });
  store.createRun({
    orchRunId: "orch-phase",
    backend: "session",
    mode: "auto",
    workspaceRoot: root,
  });

  store.setPhase("survey", "active", "scanning units");
  store.setOverall("running");
  store.setFocus("agent-x");

  let snap = store.getSnapshot();
  assert.equal(snap.overall, "running");
  assert.equal(snap.currentPhase, "survey");
  assert.equal(snap.focusedAgentId, "agent-x");
  assert.equal(snap.phases[0].status, "active");
  assert.equal(snap.phases[0].summary, "scanning units");
  assert.ok(snap.phases[0].startedAt);

  store.setPhase("survey", "done");
  store.setFocus(undefined);
  snap = store.getSnapshot();
  assert.equal(snap.phases[0].status, "done");
  assert.ok(snap.phases[0].endedAt);
  assert.equal(snap.focusedAgentId, undefined);
});

test("appendTranscript and readTranscript with tail", () => {
  const root = tempWorkspace();
  const store = new WikiRunStore({ workspaceRoot: root });
  store.createRun({
    orchRunId: "orch-tx",
    backend: "session",
    mode: "auto",
    workspaceRoot: root,
  });
  store.upsertAgent({ agentId: "lane::1", role: "survey" });

  store.appendTranscript("lane::1", { role: "user", text: "one" });
  store.appendTranscript("lane::1", { role: "assistant", text: "two" });
  store.appendTranscript("lane::1", { role: "assistant", text: "three" });

  const all = store.readTranscript("lane::1");
  assert.equal(all.length, 3);
  assert.equal(all[0].text, "one");

  const tail = store.readTranscript("lane::1", { tail: 1 });
  assert.equal(tail.length, 1);
  assert.equal(tail[0].text, "three");

  const snap = store.getSnapshot();
  const agent = snap.agents.find((a) => a.agentId === "lane::1");
  assert.ok(agent?.transcriptPath);
  assert.ok(agent.transcriptPath.includes(safeAgentId("lane::1")));
  assert.ok(existsSync(agent.transcriptPath));
});

test("updateSnapshot persists atomically and getSnapshot returns a clone", () => {
  const root = tempWorkspace();
  const store = new WikiRunStore({ workspaceRoot: root });
  store.createRun({
    orchRunId: "orch-atomic",
    backend: "session",
    mode: "write",
    workspaceRoot: root,
  });

  const a = store.getSnapshot();
  a.overall = "failed"; // mutate clone only
  assert.equal(store.getSnapshot().overall, "idle");

  store.updateSnapshot((s) => {
    s.coverage = {
      pass: 1,
      unitsTotal: 2,
      unitsWithReceipt: 1,
      missingUnitIds: ["u2"],
      retryUnitIds: [],
    };
  });

  const path = join(store.storeDir, "snapshot.json");
  const disk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(disk.coverage.unitsTotal, 2);
  assert.equal(disk.coverage.missingUnitIds[0], "u2");

  // No leftover tmp files from atomic write
  const leftovers = readdirSync(store.storeDir).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("bindDomain relocates unbound store under domain run path", () => {
  const root = tempWorkspace();
  const store = new WikiRunStore({ workspaceRoot: root, orchRunId: "orch-bind" });
  store.createRun({
    orchRunId: "orch-bind",
    backend: "session",
    mode: "auto",
    workspaceRoot: root,
  });
  store.appendEvent("orch.started");
  store.upsertAgent({ agentId: "a1", status: "running" });
  store.appendTranscript("a1", { n: 1 });

  const unbound = join(root, ".wiki-agent", "orchestration", "orch-bind");
  assert.ok(existsSync(join(unbound, "snapshot.json")));

  const snap = store.bindDomain("dom-99", "/ws/workdir");
  assert.equal(snap.domainRunId, "dom-99");
  assert.equal(snap.workdir, "/ws/workdir");

  const bound = join(root, ".wiki-agent", "runs", "dom-99", "orchestration");
  assert.equal(store.storeDir, bound);
  assert.ok(existsSync(join(bound, "snapshot.json")));
  assert.ok(existsSync(join(bound, "events.jsonl")));
  assert.equal(store.listEvents().length, 1);
  assert.equal(store.readTranscript("a1").length, 1);
  assert.equal(store.getSnapshot().agents[0].agentId, "a1");
});

test("subscribe receives snapshot updates and events", () => {
  const root = tempWorkspace();
  const store = new WikiRunStore({ workspaceRoot: root });
  store.createRun({
    orchRunId: "orch-sub",
    backend: "session",
    mode: "auto",
    workspaceRoot: root,
  });

  const seen = [];
  const unsub = store.subscribe((snap, event) => {
    seen.push({ overall: snap.overall, type: event?.type });
  });

  store.setOverall("running");
  store.appendEvent("orch.started");
  unsub();
  store.setOverall("completed");

  assert.ok(seen.some((s) => s.overall === "running"));
  assert.ok(seen.some((s) => s.type === "orch.started"));
  assert.ok(!seen.some((s) => s.overall === "completed"));
});

test("reloading store from disk restores snapshot and event seq", () => {
  const root = tempWorkspace();
  const store = new WikiRunStore({ workspaceRoot: root, domainRunId: "dom-reload", orchRunId: "orch-reload" });
  store.createRun({
    orchRunId: "orch-reload",
    backend: "session",
    mode: "auto",
    workspaceRoot: root,
    domainRunId: "dom-reload",
  });
  store.appendEvent("orch.started");
  store.appendEvent("phase.started", { phase: "survey" });
  store.upsertAgent({ agentId: "x", status: "succeeded" });

  const reloaded = new WikiRunStore({
    workspaceRoot: root,
    domainRunId: "dom-reload",
    orchRunId: "orch-reload",
  });
  const snap = reloaded.getSnapshot();
  assert.equal(snap.orchRunId, "orch-reload");
  assert.equal(snap.agents[0].status, "succeeded");
  const e = reloaded.appendEvent("orch.completed");
  assert.equal(e.seq, 3);
});
