import assert from "node:assert/strict";
import test from "node:test";
import { WikiTaskExecutionError, WikiTaskPauseError } from "../dist/delegate-contracts.js";
import { WikiTaskRuntime } from "../dist/task-runtime.js";

function store() {
  const writes = [];
  return {
    writes,
    async write(input) {
      writes.push(input);
      return { version: 1, ...input, relativePath: `.okf-wiki/blobs/${input.nodeId}-${input.attempt}.md`, sha256: "a".repeat(64), sizeBytes: input.content.length, mediaType: "text/markdown" };
    },
  };
}

function task(id, values = {}) {
  return { id, role: "research", instruction: `Research ${id}`, sourceScopeIds: ["api"], contextRefs: [], ...values };
}

function runtime(agent, values = {}) {
  return new WikiTaskRuntime({
    runId: "run-1", cwd: "/workspace", sourceScopes: { api: "api" }, contextArtifacts: {},
    artifactStore: store(), agent, sleep: async () => {}, random: () => 0, ...values,
  });
}

test("preflights source scopes, context refs, and overlapping write paths", async () => {
  const r = runtime({ run: async () => ({ summary: "ok", markdown: "ok" }) });
  await assert.rejects(r.delegate([task("bad", { sourceScopeIds: ["secret"] })], new AbortController().signal), /undeclared source scope/);
  await assert.rejects(r.delegate([task("bad-ref", { contextRefs: ["missing"] })], new AbortController().signal), /undeclared context artifact/);
  await assert.rejects(r.delegate([
    task("w1", { role: "write", writePaths: ["wiki/core/page.md"] }),
    task("w2", { role: "write", writePaths: ["wiki/core/page.md"] }),
  ], new AbortController().signal), /overlap/);
});

test("preflights delegated writes with the publication path contract", async () => {
  const r = runtime({ run: async () => ({ summary: "ok", markdown: "ok" }) });
  for (const writePath of [
    "wiki/Architecture.md",
    "wiki/feature map.md",
    "wiki/wiki/architecture.md",
    "wiki/core//page.md",
    "wiki/index.md",
    "wiki/log.md",
  ]) {
    await assert.rejects(
      r.delegate([task("writer", { role: "write", writePaths: [writePath] })], new AbortController().signal),
      /Unsafe Wiki write path/,
      writePath,
    );
  }

  const result = await r.delegate([
    task("root", { role: "write", writePaths: ["wiki/architecture.md"] }),
    task("nested", { role: "write", writePaths: ["wiki/core/page.md"] }),
  ], new AbortController().signal);
  assert.equal(result.status, "complete");
});

test("preserves successful branches when a fanout is partial", async () => {
  const r = runtime({
    async run(value) {
      if (value.id === "bad") throw new WikiTaskExecutionError("invalid", "schema");
      return { summary: "accepted", markdown: "# Accepted", coverage: ["entrypoint"] };
    },
  });
  const result = await r.delegate([task("good"), task("bad")], new AbortController().signal);
  assert.equal(result.status, "partial");
  assert.equal(result.receipts.find((value) => value.id === "good").outputs.length, 1);
  assert.equal(result.receipts.find((value) => value.id === "bad").status, "failed");
});

test("429 honors Retry-After, reduces shared admission to one, and retries once", async () => {
  let now = 0;
  const sleeps = [];
  const attempts = new Map();
  let active = 0;
  let maxActiveAfterPressure = 0;
  let pressureSeen = false;
  const r = runtime({
    async run(value) {
      active += 1;
      try {
        const count = (attempts.get(value.id) ?? 0) + 1;
        attempts.set(value.id, count);
        if (value.id === "limited" && count === 1) {
          pressureSeen = true;
          throw new WikiTaskExecutionError("429", "rate_limit", { retryAfterMs: 250 });
        }
        if (pressureSeen) maxActiveAfterPressure = Math.max(maxActiveAfterPressure, active);
        return { summary: "ok", markdown: "ok" };
      } finally { active -= 1; }
    },
  }, {
    concurrency: 2,
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const result = await r.delegate([task("limited"), task("next")], new AbortController().signal);
  assert.equal(result.status, "complete");
  assert.deepEqual(sleeps, [250]);
  assert.equal(attempts.get("limited"), 2);
  assert.ok(maxActiveAfterPressure <= 1);
});

test("5xx gets exactly one fresh attempt and quota exits through control flow without retry", async () => {
  let serverAttempts = 0;
  const server = runtime({ async run() {
    serverAttempts += 1;
    throw new WikiTaskExecutionError("server unavailable", "server_error");
  } });
  const failed = await server.delegate([task("server")], new AbortController().signal);
  assert.equal(serverAttempts, 2);
  assert.equal(failed.receipts[0].attempts, 2);

  let quotaAttempts = 0;
  const quota = runtime({ async run() {
    quotaAttempts += 1;
    throw new WikiTaskExecutionError("quota exceeded", "quota", { retryAfterMs: 30_000 });
  } });
  await assert.rejects(
    quota.delegate([task("quota")], new AbortController().signal),
    (error) => error instanceof WikiTaskPauseError && error.reason === "quota" && error.retryAfterMs === 30_000,
  );
  assert.equal(quotaAttempts, 1);
});

test("transient retry count is configurable", async () => {
  for (const transientRetries of [0, 1, 2]) {
    let calls = 0;
    const r = runtime({ async run() {
      calls += 1;
      throw new WikiTaskExecutionError("service unavailable", "server_error");
    } }, { transientRetries });
    const result = await r.delegate([task(`retry-${transientRetries}`)], new AbortController().signal);
    assert.equal(result.receipts[0].attempts, transientRetries + 1);
    assert.equal(calls, transientRetries + 1);
  }
});

test("timeout and context exhaustion return incomplete receipts and retain sealed partial Markdown", async () => {
  for (const code of ["timeout", "context_exhausted"]) {
    const artifacts = store();
    let calls = 0;
    const r = runtime({ async run() {
      calls += 1;
      throw new WikiTaskExecutionError(code, code, { partialMarkdown: `# Partial ${code}`, coverage: ["partial"] });
    } }, { artifactStore: artifacts });
    const result = await r.delegate([task(code)], new AbortController().signal);
    assert.equal(result.receipts[0].status, "incomplete");
    assert.equal(result.receipts[0].outputs.length, 2);
    assert.equal(result.receipts[0].attempts, 2);
    assert.equal(calls, 2, `${code} must receive one fresh session after the initial failure`);
    assert.equal(artifacts.writes.length, 2);
  }
});

test("batch of two tasks emits queued then interleaved start/end progress", async () => {
  /** @type {WikiTaskProgressEvent[]} */
  const events = [];
  const r = runtime({
    async run() {
      return { summary: "ok", markdown: "ok" };
    },
  }, {
    onTask(event) {
      events.push(event);
    },
  });
  const result = await r.delegate([task("a"), task("b")], new AbortController().signal);
  assert.equal(result.status, "complete");
  const phases = events.map((event) => event.phase);
  assert.deepEqual(phases.slice(0, 2), ["queued", "queued"]);
  const rest = phases.slice(2);
  assert.equal(rest.filter((phase) => phase === "start").length, 2);
  assert.equal(rest.filter((phase) => phase === "end").length, 2);
  assert.ok(rest.every((phase) => phase === "start" || phase === "end"));
  assert.equal(events.filter((event) => event.phase === "end" && event.receipt).length, 2);
});

test("failed and incomplete tasks still emit end with receipt status", async () => {
  /** @type {WikiTaskProgressEvent[]} */
  const failedEvents = [];
  const failed = runtime({
    async run() {
      throw new WikiTaskExecutionError("invalid", "schema");
    },
  }, {
    onTask(event) {
      failedEvents.push(event);
    },
  });
  const failedResult = await failed.delegate([task("fail")], new AbortController().signal);
  assert.equal(failedResult.receipts[0].status, "failed");
  const failedEnd = failedEvents.find((event) => event.phase === "end");
  assert.ok(failedEnd);
  assert.equal(failedEnd.receipt?.status, "failed");

  /** @type {WikiTaskProgressEvent[]} */
  const incompleteEvents = [];
  const incomplete = runtime({
    async run() {
      throw new WikiTaskExecutionError("timed out", "timeout", { partialMarkdown: "# Partial" });
    },
  }, {
    onTask(event) {
      incompleteEvents.push(event);
    },
  });
  const incompleteResult = await incomplete.delegate([task("slow")], new AbortController().signal);
  assert.equal(incompleteResult.receipts[0].status, "incomplete");
  const incompleteEnd = incompleteEvents.find((event) => event.phase === "end");
  assert.ok(incompleteEnd);
  assert.equal(incompleteEnd.receipt?.status, "incomplete");
});

test("quota and usage_limit emit end before throwing WikiTaskPauseError", async () => {
  for (const code of ["quota", "usage_limit"]) {
    /** @type {WikiTaskProgressEvent[]} */
    const events = [];
    const r = runtime({
      async run() {
        throw new WikiTaskExecutionError(`${code} exceeded`, code);
      },
    }, {
      onTask(event) {
        events.push(event);
      },
    });
    await assert.rejects(
      r.delegate([task(code)], new AbortController().signal),
      (error) => error instanceof WikiTaskPauseError && error.reason === code,
    );
    const endEvent = events.find((event) => event.phase === "end");
    assert.ok(endEvent, `${code} must emit end`);
    assert.equal(endEvent.receipt?.status, "failed");
    assert.equal(endEvent.receipt?.error?.code, code);
    const phases = events.map((event) => event.phase);
    assert.ok(phases.includes("end"));
    assert.deepEqual(phases.slice(0, 2), ["queued", "start"]);
  }
});

test("onTask throwing does not fail delegate of a successful agent", async () => {
  /** @type {WikiTaskProgressEvent[]} */
  const events = [];
  const r = runtime({
    async run() {
      return { summary: "ok", markdown: "ok" };
    },
  }, {
    onTask(event) {
      events.push(event);
      throw new Error("onTask boom");
    },
  });
  const result = await r.delegate([task("ok")], new AbortController().signal);
  assert.equal(result.status, "complete");
  assert.equal(result.receipts[0].status, "complete");
  const phases = events.map((event) => event.phase);
  assert.deepEqual(phases, ["queued", "start", "end"]);
});

test("forwards attempt-aware telemetry serially and flushes the latest checkpoint before end", async () => {
  const events = [];
  let releaseFirst;
  const firstDelivery = new Promise((resolve) => { releaseFirst = resolve; });
  const r = runtime({
    async run(value, context) {
      context.onTelemetry({ sampledAt: "2026-01-01T00:00:01.000Z", activity: "tool", activeTool: { name: "read", startedAt: "2026-01-01T00:00:00.000Z" } });
      context.onTelemetry({ sampledAt: "2026-01-01T00:00:02.000Z", activity: "idle", usage: { turns: 2 }, history: [{ role: "assistant", kind: "text", text: "done" }] });
      return { summary: "ok", markdown: "ok" };
    },
  }, {
    async onTask(event) {
      events.push(event);
      if (event.phase === "update" && event.telemetry.sampledAt.endsWith("01.000Z")) await firstDelivery;
    },
  });
  const delegated = r.delegate([task("live")], new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.phase === "end").length, 0);
  releaseFirst();
  await delegated;

  const updates = events.filter((event) => event.phase === "update");
  assert.ok(updates.length >= 1 && updates.length <= 2);
  assert.ok(updates.every((event) => !("history" in event) && !("usage" in event)));
  assert.equal(updates.at(-1).telemetry.attempt, 1);
  assert.equal(updates.at(-1).telemetry.usage.turns, 2);
  const end = events.find((event) => event.phase === "end");
  assert.equal(end.usage.turns, 2);
  assert.equal(end.history[0].text, "done");
});

test("telemetry delivery failures do not fail or delay task completion", async () => {
  const r = runtime({
    async run(value, context) {
      context.onTelemetry({ sampledAt: new Date().toISOString(), activity: "responding" });
      return { summary: "ok", markdown: "ok" };
    },
  }, {
    onTask(event) {
      if (event.phase === "update") throw new Error("telemetry unavailable");
    },
  });
  const result = await r.delegate([task("observable")], new AbortController().signal);
  assert.equal(result.status, "complete");
});
