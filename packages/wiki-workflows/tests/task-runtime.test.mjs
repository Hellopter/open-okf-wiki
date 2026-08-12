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
