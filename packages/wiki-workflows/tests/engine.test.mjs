import assert from "node:assert/strict";
import test from "node:test";
import { WikiWorkflowEngine } from "../dist/engine.js";

const inspection = {
  root: "/workspace",
  wikiRoot: "/workspace/wiki",
  mode: "refresh",
  head: "abc123",
  baseCommit: "base",
  lastWikiCommit: "base",
  changed: [],
  changedPaths: [],
  sourceFingerprint: "source-baseline",
  impactedPages: [],
  wikiDrift: false,
};

const validation = { ok: true, errors: [], pages: ["architecture.md"] };

function createExecutor(options = {}) {
  const calls = [];
  return {
    calls,
    async execute(request) {
      calls.push(request.node.kind);
      request.onActivity?.({ state: "running", message: "fake" }, { inputTokens: 12 });
      if (options.streamOutput) request.onOutput?.(options.streamOutput);
      if (request.node.kind === "plan" || request.node.kind === "replan") {
        return {
          result: {
            pages: [{ path: "architecture.md", title: "Architecture", purpose: "Explain system", sources: ["src/index.ts#L1-L2"] }],
            researchScopes: options.research === false ? [] : [
              { id: "core", task: "Research core" },
              { id: "api", task: "Research API" },
            ],
            rationale: "test",
          },
          output: request.node.kind === "plan" ? options.finalOutput : undefined,
        };
      }
      if (request.node.kind === "research") return { result: { evidence: request.node.input } };
      if (request.node.kind === "write" || request.node.kind === "repair") {
        return { result: { updatedPages: ["architecture.md"], deletedPages: [], notes: [] } };
      }
      if (request.node.kind === "review") return { result: { defects: options.defects ?? [], summary: "ok" } };
      throw new Error(`unexpected node ${request.node.kind}`);
    },
  };
}

function createEngine(executor, inspect = async () => inspection, validate = async () => validation) {
  let id = 0;
  return new WikiWorkflowEngine({
    executor,
    inspect,
    validate,
    createId: () => `id-${++id}`,
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });
}

test("dynamically plans, researches, writes, validates, and reviews", async () => {
  const executor = createExecutor();
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "refresh", language: "zh" });
  const snapshot = await engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded");
  assert.deepEqual(executor.calls, ["plan", "research", "research", "write", "review"]);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "research").length, 2);
  assert.equal(snapshot.nodes.find((node) => node.kind === "write").metrics.inputTokens, 12);
});

test("retry retains upstream work and invalidates only the selected downstream graph", async () => {
  const executor = createExecutor({ research: false });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  await engine.waitForIdle();
  const before = engine.getSnapshot();
  const write = before.nodes.find((node) => node.kind === "write");
  const plan = before.nodes.find((node) => node.kind === "plan");

  await engine.retryNode(write.id);
  await engine.waitForIdle();
  const after = engine.getSnapshot();
  const updatedPlan = after.nodes.find((node) => node.id === plan.id);
  const updatedWrite = after.nodes.find((node) => node.id === write.id);

  assert.equal(updatedPlan.attempt, 1);
  assert.equal(updatedWrite.attempt, 2);
  assert.equal(updatedWrite.attemptHistory.length, 1);
  assert.equal(after.status, "succeeded");
});

test("retrying a plan re-dispatches its invalidated writer instead of reusing it", async () => {
  const executor = createExecutor({ research: false });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  await engine.waitForIdle();
  const plan = engine.getSnapshot().nodes.find((node) => node.kind === "plan");

  await engine.retryNode(plan.id);
  await engine.waitForIdle();
  const snapshot = engine.getSnapshot();
  assert.equal(executor.calls.filter((kind) => kind === "plan").length, 2);
  assert.equal(executor.calls.filter((kind) => kind === "write").length, 2);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "write" && node.status === "succeeded").length, 1);
});

test("malformed structured agent output fails the node instead of publishing success", async () => {
  const engine = createEngine({
    async execute(request) {
      if (request.node.kind === "plan") return { result: { pages: "not-an-array" } };
      throw new Error("unexpected");
    },
  });
  engine.start({ cwd: "/workspace", mode: "generate" });
  await engine.waitForIdle();
  const snapshot = engine.getSnapshot();
  const plan = snapshot.nodes.find((node) => node.kind === "plan");
  assert.equal(snapshot.status, "failed");
  assert.equal(plan.status, "failed");
});

test("validation failure runs a writer repair and repeated validation blocks", async () => {
  const executor = createExecutor({ research: false });
  let validations = 0;
  const engine = createEngine(executor, async () => inspection, async () => {
    validations += 1;
    return validations === 1 ? { ok: false, errors: ["architecture.md: missing citation"], pages: [] } : validation;
  });
  engine.start({ cwd: "/workspace", mode: "generate" });
  await engine.waitForIdle();
  assert.equal(engine.getSnapshot().status, "succeeded");
  assert.equal(executor.calls.filter((kind) => kind === "repair").length, 1);

  const duplicate = createEngine(createExecutor({ research: false }), async () => inspection, async () => ({ ok: false, errors: ["same error"], pages: [] }));
  duplicate.start({ cwd: "/workspace", mode: "generate" });
  await duplicate.waitForIdle();
  assert.equal(duplicate.getSnapshot().status, "blocked");
  assert.match(duplicate.getSnapshot().blockedReason, /same unresolved error set/);
});

test("structural review defects produce a replan and no more than four research nodes", async () => {
  const calls = [];
  let reviewRound = 0;
  const engine = createEngine({
    async execute(request) {
      calls.push(request.node.kind);
      if (request.node.kind === "plan" || request.node.kind === "replan") return {
        result: {
          pages: [{ path: "architecture.md", title: "Architecture", purpose: "Explain", sources: ["src/index.ts#L1-L2"] }],
          researchScopes: ["a", "b", "c", "d", "e"].map((id) => ({ id, task: id })),
          rationale: "test",
        },
      };
      if (request.node.kind === "research") return { result: { ok: true } };
      if (request.node.kind === "write" || request.node.kind === "repair") return { result: { updatedPages: ["architecture.md"], deletedPages: [], notes: [] } };
      if (request.node.kind === "review") return { result: reviewRound++ === 0
        ? { defects: [{ id: "coverage", page: "architecture.md", kind: "coverage", detail: "missing area" }], summary: "missing" }
        : { defects: [], summary: "done" } };
      throw new Error(`unexpected ${request.node.kind}`);
    },
  });
  engine.start({ cwd: "/workspace", mode: "generate" });
  await engine.waitForIdle();
  assert.equal(engine.getSnapshot().status, "succeeded");
  assert.equal(calls.filter((kind) => kind === "replan").length, 1);
  assert.equal(engine.getSnapshot().nodes.filter((node) => node.kind === "research").length, 8);
});

test("structural review blocks after the bounded replan budget despite changing defect text", async () => {
  const calls = [];
  let reviewRound = 0;
  const engine = createEngine({
    async execute(request) {
      calls.push(request.node.kind);
      if (request.node.kind === "plan" || request.node.kind === "replan") return {
        result: {
          pages: [{ path: "architecture.md", title: "Architecture", purpose: "Explain", sources: ["src/index.ts#L1-L2"] }],
          researchScopes: [],
          rationale: "test",
        },
      };
      if (request.node.kind === "write") return { result: { updatedPages: ["architecture.md"], deletedPages: [], notes: [] } };
      if (request.node.kind === "review") return {
        result: {
          defects: [{ id: `coverage-${reviewRound}`, page: "architecture.md", kind: "coverage", detail: `missing area ${reviewRound++}` }],
          summary: "still incomplete",
        },
      };
      throw new Error(`unexpected ${request.node.kind}`);
    },
  });
  engine.start({ cwd: "/workspace", mode: "generate" });
  await engine.waitForIdle();
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.status, "blocked");
  assert.match(snapshot.blockedReason, /2-replan budget/);
  assert.equal(calls.filter((kind) => kind === "replan").length, 2);
});

test("source reconciliation restores the structural-replan budget for its new DAG", async () => {
  const calls = [];
  let reviewRound = 0;
  let inspectionRound = 0;
  const engine = createEngine({
    async execute(request) {
      calls.push(request.node.kind);
      if (request.node.kind === "plan" || request.node.kind === "replan") return {
        result: {
          pages: [{ path: "architecture.md", title: "Architecture", purpose: "Explain", sources: ["src/index.ts#L1-L2"] }],
          researchScopes: [],
          rationale: "test",
        },
      };
      if (request.node.kind === "write") return { result: { updatedPages: ["architecture.md"], deletedPages: [], notes: [] } };
      if (request.node.kind === "review") return {
        result: {
          defects: [{ id: `coverage-${reviewRound}`, page: "architecture.md", kind: "coverage", detail: `missing area ${reviewRound++}` }],
          summary: "still incomplete",
        },
      };
      throw new Error(`unexpected ${request.node.kind}`);
    },
  }, async () => ({ ...inspection, sourceFingerprint: `source-${inspectionRound++}` }));

  engine.start({ cwd: "/workspace", mode: "generate" });
  await engine.waitForIdle();
  const first = engine.getSnapshot();
  assert.equal(first.status, "blocked");
  assert.equal(calls.filter((kind) => kind === "replan").length, 2);

  const completedWrite = first.nodes.filter((node) => node.kind === "write" && node.status === "succeeded").at(-1);
  await engine.retryNode(completedWrite.id);
  await engine.waitForIdle();
  assert.equal(calls.filter((kind) => kind === "replan").length, 4);
  assert.equal(engine.getSnapshot().status, "blocked");
});

test("a source-content fingerprint change restarts retry from Git inspection", async () => {
  const executor = createExecutor({ research: false });
  let inspections = 0;
  const engine = createEngine(executor, async () => ({
    ...inspection,
    changed: [{ status: "M", paths: ["src/a.ts"] }],
    changedPaths: ["src/a.ts"],
    sourceFingerprint: inspections++ === 0 ? "source-one" : "source-two",
  }));
  engine.start({ cwd: "/workspace", mode: "generate" });
  await engine.waitForIdle();
  const write = engine.getSnapshot().nodes.find((node) => node.kind === "write");
  await engine.retryNode(write.id);
  await engine.waitForIdle();
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.nodes.find((node) => node.kind === "inspect").attempt, 2);
  assert.equal(executor.calls.filter((kind) => kind === "plan").length, 2);
});

test("live output is bounded before it reaches the durable run state", async () => {
  const executor = createExecutor({ research: false, streamOutput: "x".repeat(60 * 1024) });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  await engine.waitForIdle();
  const plan = engine.getSnapshot().nodes.find((node) => node.kind === "plan");
  assert.match(plan.output, /^\[\.\.\. \d+ earlier characters omitted \.\.\.\]/);
  assert.ok(plan.output.length <= 48 * 1024);
});

test("final agent output is bounded before it reaches the durable run state", async () => {
  const executor = createExecutor({ research: false, finalOutput: "y".repeat(60 * 1024) });
  const engine = createEngine(executor);
  engine.start({ cwd: "/workspace", mode: "generate" });
  await engine.waitForIdle();
  const plan = engine.getSnapshot().nodes.find((node) => node.kind === "plan");
  assert.match(plan.output, /^\[\.\.\. \d+ earlier characters omitted \.\.\.\]/);
  assert.ok(plan.output.length <= 48 * 1024);
});

test("Wiki-only drift does not invalidate otherwise reusable source work", async () => {
  const executor = createExecutor({ research: false });
  let inspections = 0;
  const engine = createEngine(executor, async () => {
    inspections += 1;
    return inspections === 1 ? inspection : { ...inspection, mode: "generate", wikiDrift: true, impactedPages: ["architecture.md"] };
  });
  engine.start({ cwd: "/workspace", mode: "generate" });
  await engine.waitForIdle();
  const write = engine.getSnapshot().nodes.find((node) => node.kind === "write");
  await engine.retryNode(write.id);
  await engine.waitForIdle();
  assert.equal(engine.getSnapshot().nodes.find((node) => node.kind === "inspect").attempt, 1);
  assert.equal(executor.calls.filter((kind) => kind === "write").length, 2);
});

test("cancelling an active node aborts it and leaves a durable cancelled run", async () => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const engine = createEngine({
    async execute(request) {
      started();
      return await new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  engine.start({ cwd: "/workspace", mode: "generate" });
  await startedPromise;
  await engine.cancel();
  assert.equal(engine.serialize().snapshot.nodes.some((node) => node.status === "running"), false);
  await engine.waitForIdle();
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.status, "cancelled");
  assert.equal(snapshot.nodes.find((node) => node.kind === "plan").status, "cancelled");
});

test("failed runs require targeted retry instead of resume", async () => {
  const engine = createEngine({
    async execute() {
      throw new Error("provider failure");
    },
  });
  engine.start({ cwd: "/workspace", mode: "generate" });
  await engine.waitForIdle();
  await assert.rejects(() => engine.resume(), /requires targeted node retry/);
  assert.equal(engine.getSnapshot().status, "failed");
});

test("restored runs are paused and invalidate from inspect when Git changes", async () => {
  const executor = createExecutor({ research: false });
  const initial = createEngine(executor);
  initial.start({ cwd: "/workspace", mode: "refresh" });
  await initial.waitForIdle();
  const session = initial.serialize();

  const changedInspection = { ...inspection, head: "def456", changedPaths: ["src/changed.ts"] };
  const restored = createEngine(createExecutor({ research: false }), async () => changedInspection);
  const snapshot = restored.restore(session);
  assert.equal(snapshot.status, "succeeded");

  // Completed runs remain terminal; a retry is what creates a new dispatch.
  const write = snapshot.nodes.find((node) => node.kind === "write");
  await restored.retryNode(write.id);
  await restored.waitForIdle();
  const afterRetry = restored.getSnapshot();
  assert.equal(afterRetry.nodes.find((node) => node.kind === "inspect").attempt, 2);
  assert.equal(afterRetry.status, "succeeded");
});
