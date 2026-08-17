import assert from "node:assert/strict";
import test from "node:test";
import { PiSessionObserver } from "../dist/pi-session-observer.js";

function createSession() {
  let listener;
  return {
    subscribe(fn) {
      listener = fn;
      return () => { listener = undefined; };
    },
    emit(event) { listener?.(event); },
    getSessionStats() {
      return { assistantMessages: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
    },
  };
}

function latestProcess(reports) {
  for (let index = reports.length - 1; index >= 0; index--) {
    const process = reports[index]?.process;
    if (Array.isArray(process)) return process;
  }
  return [];
}

function latestTelemetry(reports) {
  return [...reports].reverse().find((entry) => Array.isArray(entry?.process)) ?? reports.at(-1);
}

function waitForProcess(reports, match) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const process = latestProcess(reports);
      if (match(process)) {
        resolve({ telemetry: latestTelemetry(reports), process });
        return;
      }
      if (Date.now() - started > 1500) {
        reject(new Error(`timed out waiting for process: ${JSON.stringify(process)}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function observe(run) {
  const reports = [];
  const session = createSession();
  let now = Date.parse("2026-08-12T00:00:00.000Z");
  const observer = new PiSessionObserver(session, {
    target: { kind: "lead" },
    attempt: 1,
    timeoutMs: 60_000,
    workspaceRoot: "/repo",
    report: (telemetry) => { reports.push(telemetry); },
    now: () => now,
  });
  observer.start();
  try {
    return await run({
      session,
      advance(ms) { now += ms; },
      wait(match) { return waitForProcess(reports, match); },
    });
  } finally {
    await observer.stop();
  }
}

test("tool start writes one incomplete process row", async () => {
  await observe(async ({ session, wait }) => {
    session.emit({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "/repo/src/a.ts" },
    });
    const { telemetry, process } = await wait((entries) => entries.some((entry) => entry.toolCallId === "c1"));
    assert.equal(telemetry.activeTools.length, 1);
    assert.equal(telemetry.activeTools[0].id, "c1");
    assert.equal(process.length, 1);
    assert.equal(process[0].completed, false);
    assert.equal(process[0].kind, "tool");
    assert.equal(process[0].toolCallId, "c1");
    assert.equal(process[0].toolName, "read");
    assert.equal(process[0].summary, "src/a.ts");
  });
});

test("tool update changes the same process row summary", async () => {
  await observe(async ({ session, wait }) => {
    session.emit({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "/repo/src/a.ts" },
    });
    await wait((entries) => entries.length === 1 && entries[0].summary === "src/a.ts");
    session.emit({
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "/repo/src/b.ts" },
      partialResult: {},
    });
    const { process } = await wait((entries) => entries.length === 1 && entries[0].summary === "src/b.ts");
    assert.equal(process.length, 1);
    assert.equal(process[0].toolCallId, "c1");
    assert.equal(process[0].completed, false);
    assert.equal(process[0].summary, "src/b.ts");
  });
});

test("tool end converts the same process row in place", async () => {
  await observe(async ({ session, wait, advance }) => {
    session.emit({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "/repo/src/a.ts" },
    });
    const started = await wait((entries) => entries.length === 1 && entries[0].completed === false);
    advance(1_200);
    session.emit({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "read",
      result: { content: [] },
      isError: false,
    });
    const { telemetry, process } = await wait((entries) => entries.length === 1 && entries[0].completed === true);
    assert.equal(telemetry.activeTools.length, 0);
    assert.equal(process.length, 1);
    assert.equal(process[0].completed, true);
    assert.equal(process[0].toolCallId, "c1");
    assert.equal(process[0].toolName, "read");
    assert.equal(process[0].summary, "src/a.ts");
    assert.equal(process[0].severity, "info");
    assert.equal(process[0].sequence, started.process[0].sequence);
    assert.equal(process[0].durationMs, 1_200);
  });
});

test("tool end without a start row appends a completed process row", async () => {
  await observe(async ({ session, wait }) => {
    session.emit({
      type: "tool_execution_end",
      toolCallId: "orphan",
      toolName: "write",
      result: { content: [{ type: "text", text: "Path is not assigned" }] },
      isError: true,
    });
    const { process } = await wait((entries) => entries.some((entry) => entry.toolCallId === "orphan"));
    assert.equal(process.length, 1);
    assert.equal(process[0].completed, true);
    assert.equal(process[0].toolCallId, "orphan");
    assert.equal(process[0].toolName, "write");
    assert.equal(process[0].severity, "error");
    assert.equal(process[0].message, "Path is not assigned");
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function deliverySession() {
  let listener;
  return {
    sessionFile: "/tmp/wiki-session.jsonl",
    emit(event) { listener?.(event); },
    subscribe(next) {
      listener = next;
      return () => { listener = undefined; };
    },
    getSessionStats() {
      return { assistantMessages: 1, toolCalls: 0, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 };
    },
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("heartbeat and message_update coalesce to the latest pending snapshot", async () => {
  const session = deliverySession();
  const gate = deferred();
  const reports = [];
  let tick = 0;
  const subject = new PiSessionObserver(session, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/tmp/wiki",
    heartbeatMs: 10, now: () => 1_700_000_000_000 + (tick += 1),
    async report(telemetry) {
      reports.push(telemetry);
      if (reports.length === 1) await gate.promise;
    },
  });
  subject.start();
  await waitFor(() => reports.length === 1);
  for (let index = 0; index < 12; index += 1) {
    session.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "..." }] } });
  }
  await new Promise((resolve) => setTimeout(resolve, 280));
  gate.resolve();
  await subject.stop();
  const afterStart = reports.slice(1);
  assert.ok(afterStart.length >= 1);
  assert.ok(afterStart.length <= 3, `coalesceable snapshots should not queue 1:1, got ${afterStart.length}`);
});

test("tool start and end are delivered even while later heartbeats coalesce", async () => {
  const session = deliverySession();
  const gate = deferred();
  const reports = [];
  let tick = 0;
  const subject = new PiSessionObserver(session, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/tmp/wiki",
    heartbeatMs: 15, now: () => 1_700_000_000_000 + (tick += 1),
    async report(telemetry) {
      reports.push(telemetry);
      if (reports.length === 1) await gate.promise;
    },
  });
  subject.start();
  await waitFor(() => reports.length === 1);
  session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "wiki/overview.md" } });
  session.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", isError: false, result: { content: [] } });
  for (let index = 0; index < 8; index += 1) {
    session.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "..." }] } });
  }
  await new Promise((resolve) => setTimeout(resolve, 280));
  gate.resolve();
  await subject.stop();
  assert.ok(reports.some((telemetry) => telemetry.activeTools?.some((tool) => tool.id === "call-1")));
  assert.ok(reports.some((telemetry) => telemetry.process?.some((entry) => entry.kind === "tool" && entry.toolCallId === "call-1" && entry.completed)));
});

test("heartbeats omit the process array when nothing process-related changed", async () => {
  const session = deliverySession();
  const reports = [];
  let tick = 0;
  const subject = new PiSessionObserver(session, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/tmp/wiki",
    heartbeatMs: 15, now: () => 1_700_000_000_000 + (tick += 1),
    async report(telemetry) { reports.push(telemetry); },
  });
  subject.start();
  session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "wiki/overview.md" } });
  session.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", isError: false, result: { content: [] } });
  await waitFor(() => reports.some((telemetry) => telemetry.process?.some((entry) => entry.completed)));
  const before = reports.length;
  await waitFor(() => reports.length > before + 1);
  await subject.stop();
  assert.ok(reports.slice(before).some((telemetry) => !Object.hasOwn(telemetry, "process")));
});

test("a full lifecycle queue drops only coalesceable items and then degrades", async () => {
  const session = deliverySession();
  const gate = deferred();
  const reports = [];
  const health = [];
  let tick = 0;
  const subject = new PiSessionObserver(session, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/tmp/wiki",
    heartbeatMs: 1_000, now: () => 1_700_000_000_000 + (tick += 1),
    async report(telemetry) {
      reports.push(telemetry);
      if (reports.length === 1) await gate.promise;
    },
    onHealth(input) { health.push(input); },
  });
  subject.start();
  await waitFor(() => reports.length === 1);
  for (let index = 0; index < 80; index += 1) {
    session.emit({ type: "tool_execution_start", toolCallId: `call-${index}`, toolName: "read", args: { path: "wiki/overview.md" } });
    session.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "..." }] } });
  }
  await waitFor(() => health.some((entry) => entry.status === "degraded" && /saturated/i.test(entry.message ?? "")));
  gate.resolve();
  await subject.stop();
  assert.ok(reports.length <= 50, `delivery must stay bounded, got ${reports.length}`);
  assert.ok(reports.some((telemetry) => telemetry.activeTools?.some((tool) => tool.id === "call-0")));
});

test("an overloaded delivery queue retains the final 80-tool lifecycle and retries a failed final report", async () => {
  const session = deliverySession();
  const gate = deferred();
  const reports = [];
  const health = [];
  let initialStarted = false;
  let finalReportFailures = 0;
  const subject = new PiSessionObserver(session, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/tmp/wiki",
    heartbeatMs: 1_000,
    report: async (telemetry) => {
      if (reports.length === 0) {
        initialStarted = true;
        await gate.promise;
      }
      const final = telemetry.activity === "settled" && telemetry.process?.some((entry) => entry.toolCallId === "call-79" && entry.completed);
      if (final && finalReportFailures === 0) {
        finalReportFailures += 1;
        throw new Error("temporary reporter failure");
      }
      reports.push(telemetry);
    },
    onHealth(input) { health.push(input); },
  });
  subject.start();
  await waitFor(() => initialStarted);
  for (let index = 0; index < 80; index += 1) {
    session.emit({ type: "tool_execution_start", toolCallId: `call-${index}`, toolName: "read", args: { path: "wiki/overview.md" } });
    session.emit({ type: "tool_execution_end", toolCallId: `call-${index}`, toolName: "read", isError: false, result: { content: [] } });
  }
  session.emit({ type: "agent_settled" });
  gate.resolve();
  await subject.stop();
  const final = reports.at(-1);
  assert.equal(final.activity, "settled");
  assert.ok(final.process?.some((entry) => entry.toolCallId === "call-79" && entry.completed));
  assert.equal(finalReportFailures, 1);
  assert.ok(reports.length >= 2, "the final snapshot should be delivered after a temporary report failure");
  assert.equal(health.at(-1)?.status, "healthy");
  assert.ok(reports.length <= 50, `delivery reports should stay bounded, got ${reports.length}`);
});

test("a failed lifecycle snapshot survives later heartbeat coalescing and is retried", async () => {
  const session = deliverySession();
  const reports = [];
  const health = [];
  let failed = false;
  const subject = new PiSessionObserver(session, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/tmp/wiki",
    heartbeatMs: 1_000,
    async report(telemetry) {
      const completed = telemetry.process?.some((entry) => entry.toolCallId === "call-final" && entry.completed);
      if (completed && !failed) {
        failed = true;
        throw new Error("temporary lifecycle failure");
      }
      reports.push(telemetry);
    },
    onHealth(input) { health.push(input); },
  });
  subject.start();
  await waitFor(() => reports.length === 1);
  session.emit({ type: "tool_execution_start", toolCallId: "call-final", toolName: "read", args: { path: "wiki/overview.md" } });
  session.emit({ type: "tool_execution_end", toolCallId: "call-final", toolName: "read", isError: false, result: { content: [] } });
  for (let index = 0; index < 4; index += 1) {
    session.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `frame-${index}` }] } });
  }
  await new Promise((resolve) => setTimeout(resolve, 280));
  await subject.stop();
  assert.equal(failed, true);
  assert.ok(reports.some((telemetry) => telemetry.process?.some((entry) => entry.toolCallId === "call-final" && entry.completed)));
  assert.equal(health.at(-1)?.status, "healthy");
});
