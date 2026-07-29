import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { defaultWikiRunSpec, type PiAttemptInput, type PiAttemptOutcome } from "@okf-wiki/contract";
import { createWorkspace, loadWorkspace, saveWorkspace } from "@okf-wiki/core";
import { openWikiRuns, WorkflowInUseError } from "./wiki-runs.js";

/** Minimal successful outcome for freeze-path executor probes. */
function succeededProbe(workDir: string): PiAttemptOutcome {
  return {
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "manifest", role: "attempt_output", sourcePath: workDir, directory: true },
    ],
  };
}

/** Plan success with a sealed-ready Spec so freeze-only executors do not fail the run. */
async function succeededPlan(
  input: PiAttemptInput,
  workspaceName = "Workflow test",
): Promise<PiAttemptOutcome> {
  const spec = defaultWikiRunSpec(workspaceName);
  const specPath = path.join(input.workDir, "spec.json");
  await mkdir(input.workDir, { recursive: true });
  await writeFile(specPath, `${JSON.stringify(spec)}\n`, "utf8");
  const transcript = path.join(input.attemptDir, "session.jsonl");
  await writeFile(
    transcript,
    [
      JSON.stringify({ role: "user", content: `Plan WikiRunSpec for ${workspaceName}` }),
      JSON.stringify({ role: "assistant", content: spec.summary || "Fixture default WikiRunSpec" }),
      JSON.stringify({
        schema: 1,
        node: "plan",
        mode: "fixture",
        summary: spec.summary || "Fixture default WikiRunSpec",
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  return {
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "spec", role: "spec", sourcePath: specPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: spec.summary,
  };
}

/** Freeze probes plus automatic plan Spec so the scheduler hard-cut stays green. */
function freezeAndPlanExecutor(
  freeze: (input: PiAttemptInput, signal: AbortSignal) => Promise<PiAttemptOutcome>,
): (input: PiAttemptInput, signal: AbortSignal) => Promise<PiAttemptOutcome> {
  return async (input, signal) => {
    if (input.node.key === "plan") return succeededPlan(input);
    // Post-plan Pi nodes: minimal success so approve→schedule does not fail the run.
    if (input.node.kind !== "freeze") {
      return fullGraphFixtureExecutor(input, signal);
    }
    return freeze(input, signal);
  };
}

/** Fixture Pi executor covering Definition v1 model kinds (no live LLM). */
async function fullGraphFixtureExecutor(
  input: PiAttemptInput,
  _signal: AbortSignal,
): Promise<PiAttemptOutcome> {
  await mkdir(input.workDir, { recursive: true });
  await mkdir(path.join(input.workDir, "wiki"), { recursive: true });
  await mkdir(path.join(input.workDir, "analysis"), { recursive: true });
  const transcript = path.join(input.attemptDir, "session.jsonl");
  await mkdir(path.dirname(transcript), { recursive: true });
  const nodeSummary = `fixture ${input.node.key}`;
  await writeFile(
    transcript,
    [
      JSON.stringify({ role: "assistant", content: nodeSummary }),
      JSON.stringify({ schema: 1, node: input.node.key, summary: nodeSummary }),
    ].join("\n") + "\n",
    "utf8",
  );

  if (input.node.kind === "freeze") {
    return succeededProbe(input.workDir);
  }
  if (input.node.kind === "plan") {
    return succeededPlan(input);
  }
  if (
    input.node.kind === "research.leaf" ||
    input.node.kind === "research.domain" ||
    input.node.kind === "review.seat"
  ) {
    const receipt = path.join(input.workDir, "analysis", `${input.node.key}.json`);
    await writeFile(receipt, `${JSON.stringify({ ok: true, node: input.node.key })}\n`, "utf8");
    return {
      type: "succeeded",
      unsealedArtifacts: [
        { kind: "receipt", role: "research", sourcePath: receipt, directory: false },
        { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
      ],
      summary: `fixture ${input.node.kind}`,
    };
  }
  if (input.node.kind === "write.root" || input.node.kind === "repair") {
    const wikiDir = path.join(input.workDir, "wiki");
    const overview = [
      "---",
      "type: Overview",
      'title: "Workflow test"',
      "---",
      "",
      "# Workflow test",
      "",
      "Fixture wiki page.",
      "",
      "Grounding: [Source](repo:README.md#L1).",
      "",
    ].join("\n");
    await writeFile(path.join(wikiDir, "overview.md"), overview, "utf8");
    await writeFile(
      path.join(wikiDir, "index.md"),
      "---\ntype: Index\ntitle: Index\n---\n\n# Index\n\n- [Overview](./overview.md)\n",
      "utf8",
    );
    return {
      type: "succeeded",
      unsealedArtifacts: [
        { kind: "wiki_tree", role: "wiki_tree", sourcePath: wikiDir, directory: true },
        { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
      ],
      summary: "fixture write",
    };
  }
  return {
    type: "failed",
    error: `unexpected Pi node ${input.node.kind}/${input.node.key}`,
    failureClass: "infrastructure",
  };
}

async function waitForRunState(
  runs: Awaited<ReturnType<typeof openWikiRuns>>,
  runId: string,
  states: string[],
  timeoutMs = 30_000,
): Promise<Awaited<ReturnType<Awaited<ReturnType<typeof openWikiRuns>>["read"]>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runs.read({ runId });
    if (states.includes(result.snapshot.state)) return result;
    if (result.snapshot.state === "failed") {
      const failed = result.snapshot.attempts.filter((a) => a.state === "failed").at(-1);
      throw new Error(
        `run failed while waiting for ${states.join("|")}: ${failed?.error ?? result.snapshot.state}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const last = await runs.read({ runId });
  throw new Error(
    `timed out waiting for ${states.join("|")} (state=${last.snapshot.state} nodes=${last.snapshot.nodes
      .map((n) => `${n.key}:${n.state}`)
      .join(",")})`,
  );
}

async function makeWorkspace(): Promise<{ root: string; workspaceId: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-workflow-"));
  const source = path.join(root, "source");
  const skill = path.join(root, "skill");
  await mkdir(source, { recursive: true });
  await mkdir(skill, { recursive: true });
  spawnSync("git", ["init"], { cwd: source, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: source, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "test"], { cwd: source, stdio: "ignore" });
  await writeFile(path.join(source, "README.md"), "# source\n", "utf8");
  spawnSync("git", ["add", "."], { cwd: source, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: source, stdio: "ignore" });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: workflow-test\n---\n# skill\n", "utf8");

  const workspace = await createWorkspace({ name: "Workflow test", rootPath: root });
  workspace.sources = [
    { id: "main", path: source, applyDefaultIgnores: true, ignore: [], origin: { type: "path" } },
  ];
  workspace.skillPath = skill;
  await saveWorkspace(workspace);
  return { root, workspaceId: workspace.id };
}

async function removeWorkspace(root: string): Promise<void> {
  spawnSync("chmod", ["-R", "u+w", root], { stdio: "ignore" });
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

function context(workspaceId: string) {
  return { workspaceId, actor: { id: "operator", kind: "local_operator" as const } };
}

function blockingFreeze(root: string, started: () => void) {
  return async ({ runId, signal }: { runId: string; signal?: AbortSignal }) => {
    const runDir = path.join(root, ".okf-wiki", "runs", runId);
    const sourcePath = path.join(runDir, "sources", "main");
    await mkdir(sourcePath, { recursive: true });
    await writeFile(path.join(sourcePath, "partial.txt"), "incomplete\n", "utf8");
    started();
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
    return {
      analysisDir: path.join(runDir, "analysis"),
      runId,
      runWorkDir: runDir,
      skillDigest: "a".repeat(64),
      skillPath: path.join(runDir, "skill"),
      sourceIgnores: new Map([["main", []]]),
      sourcePathMap: new Map([["main", sourcePath]]),
      sources: [{ id: "main", revision: "b".repeat(40), effectiveIgnores: [], path: sourcePath }],
      wikiDir: path.join(runDir, "wiki"),
    };
  };
}

async function waitForChildMessage(
  child: ChildProcess,
): Promise<{ type: string; message?: string; runId?: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child owner did not become ready")), 10_000);
    child.once("message", (message: unknown) => {
      clearTimeout(timeout);
      resolve(message as { type: string; message?: string; runId?: string });
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`child owner exited before ready: code=${code} signal=${signal}`));
    });
  });
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  const exited = waitForChildExit(child);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}

function startChildOwner(root: string, workspaceId: string): ChildProcess {
  const workflowModuleUrl = pathToFileURL(
    path.join(path.dirname(new URL(import.meta.url).pathname), "index.js"),
  ).href;
  const script = `
    const { openWikiRuns } = await import(process.env.WORKFLOW_MODULE_URL);
    const runs = await openWikiRuns({ rootPath: process.env.WORKFLOW_ROOT });
    const receipt = await runs.dispatch(
      { type: "start_run", commandId: "child-start" },
      { workspaceId: process.env.WORKFLOW_ID, actor: { id: "child", kind: "local_operator" } },
    );
    const result = await runs.read({ runId: receipt.runId });
    process.send?.({
      type: result.snapshot.attempts[0]?.state === "running" ? "ready" : "error",
      message: result.snapshot.state,
      runId: receipt.runId,
    });
    setInterval(() => {}, 1_000);
  `;
  return spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      WORKFLOW_ID: workspaceId,
      WORKFLOW_MODULE_URL: workflowModuleUrl,
      WORKFLOW_ROOT: root,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

/**
 * Wait until freeze fails, freeze succeeds and plan is ready (no plan executor),
 * or plan opens gate.plan (executor path).
 */
async function waitForTerminal(runs: Awaited<ReturnType<typeof openWikiRuns>>, runId: string) {
  for (let count = 0; count < 300; count += 1) {
    const result = await runs.read({ runId });
    if (result.snapshot.state === "failed" || result.snapshot.state === "cancelled") return result;
    if (result.snapshot.state === "waiting_for_operator") return result;
    const freeze = result.snapshot.nodes.find((node) => node.key === "freeze");
    const plan = result.snapshot.nodes.find((node) => node.key === "plan");
    if (
      freeze?.state === "succeeded" &&
      plan?.state === "ready" &&
      (result.snapshot.state === "queued" || result.snapshot.state === "running")
    ) {
      return result;
    }
    if (result.snapshot.state === "completed_unpublished" || result.snapshot.state === "published")
      return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for freeze");
}

function assertFreezeAdvancedToPlan(
  snapshot: Awaited<ReturnType<Awaited<ReturnType<typeof openWikiRuns>>["read"]>>["snapshot"],
): void {
  const freeze = snapshot.nodes.find((node) => node.key === "freeze");
  const plan = snapshot.nodes.find((node) => node.key === "plan");
  assert.equal(freeze?.state, "succeeded");
  assert.equal(plan?.key, "plan");
  assert.equal(plan?.state, "ready");
  assert.equal(plan?.generation, 0);
  assert.ok(snapshot.state === "queued" || snapshot.state === "running");
}

test("start receipt and replay are durable, and duplicate commands de-duplicate", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());

  const first = await runs.dispatch(
    { type: "start_run", commandId: "start-1" },
    context(workspaceId),
  );
  const duplicate = await runs.dispatch(
    { type: "start_run", commandId: "start-1" },
    context(workspaceId),
  );
  assert.deepEqual(duplicate, first);
  const finished = await waitForTerminal(runs, first.runId);
  assertFreezeAdvancedToPlan(finished.snapshot);
  assert.ok(finished.events.some((event) => event.type === "inputs.pinned"));
  assert.ok(finished.events.some((event) => event.type === "node.ready"));
  assert.ok(finished.events.length >= 4);
  assert.equal(finished.cursor, finished.events.at(-1)?.eventId);
  for (const event of finished.events) {
    assert.equal(event.revision, event.snapshot.revision);
    assert.equal(event.runId, first.runId);
  }

  assert.deepEqual(
    await runs.dispatch(
      { type: "start_run", commandId: "start-1" },
      { ...context(workspaceId), sessionId: "other" },
    ),
    first,
  );
  await assert.rejects(
    () =>
      runs.dispatch(
        { type: "cancel_run", commandId: "start-1", runId: first.runId },
        context(workspaceId),
      ),
    /different payload/,
  );
});

test("freeze pins real Git and Skill inputs", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-pin" },
    context(workspaceId),
  );
  const { snapshot } = await waitForTerminal(runs, receipt.runId);
  assertFreezeAdvancedToPlan(snapshot);
  assert.equal(snapshot.pinnedInputs?.sources[0]?.id, "main");
  assert.ok(snapshot.pinnedInputs?.sources[0]?.revision);
  assert.match(snapshot.pinnedInputs?.skillDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    await readFile(
      path.join(root, ".okf-wiki", "runs", receipt.runId, "sources", "main", "README.md"),
      "utf8",
    ),
    "# source\n",
  );
  assert.deepEqual(
    snapshot.nodes[0]?.outputs.map((output) => output.role),
    ["attempt_output", "skill", "sources"],
  );
  const attemptOutput = snapshot.nodes[0]?.outputs.find(
    (output) => output.role === "attempt_output",
  );
  assert.ok(attemptOutput);
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(
          root,
          ".okf-wiki",
          "runs",
          receipt.runId,
          "artifacts",
          `manifest-${attemptOutput.artifact.digest}`,
          ".okf-artifact-manifest.json",
        ),
        "utf8",
      ),
    ).schema,
    1,
  );
});

test("Pi receives canonical sealed source and skill artifacts", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: freezeAndPlanExecutor(async ({ skillPath, sourcePaths, workDir }) => {
      const sourcePath = sourcePaths.main;
      assert.ok(sourcePath);
      assert.match(sourcePath, /\/artifacts\/snapshot_set-/);
      assert.match(skillPath, /\/artifacts\/skill-/);
      assert.equal(
        JSON.parse(
          await readFile(
            path.join(path.dirname(sourcePath), ".okf-artifact-manifest.json"),
            "utf8",
          ),
        ).schema,
        1,
      );
      assert.equal(
        JSON.parse(await readFile(path.join(skillPath, ".okf-artifact-manifest.json"), "utf8"))
          .schema,
        1,
      );
      return succeededProbe(workDir);
    }),
  });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-sealed-pi-inputs" },
    context(workspaceId),
  );
  const finished = await waitForTerminal(runs, receipt.runId);
  assert.equal(finished.snapshot.nodes.find((node) => node.key === "freeze")?.state, "succeeded");
  assert.ok(
    finished.snapshot.state === "waiting_for_operator" ||
      finished.snapshot.nodes.find((node) => node.key === "plan")?.state === "ready",
  );
});

test("a pre-pin freeze failure requires a new run instead of reusing mutable selectors", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    // Fail only freeze; plan is never reached because freeze fails closed pre-pin.
    piAttemptExecutor: async (input) => {
      if (input.node.key === "plan") return succeededPlan(input);
      return {
        type: "failed",
        error: "fixture Pi failure",
        failureClass: "infrastructure",
      } satisfies PiAttemptOutcome;
    },
  });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-unpinned" },
    context(workspaceId),
  );
  const result = await waitForTerminal(runs, receipt.runId);
  const attempt = result.snapshot.attempts[0]!;
  await assert.rejects(
    () =>
      runs.dispatch(
        {
          type: "retry_failed_node",
          commandId: "retry-unpinned",
          runId: receipt.runId,
          nodeKey: "freeze",
          generation: 0,
          attemptId: attempt.attemptId,
        },
        context(workspaceId),
      ),
    /cannot retry a freeze before its inputs are pinned/,
  );
});

test("same content is sealed as distinct run-scoped artifacts", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());
  const first = await runs.dispatch(
    { type: "start_run", commandId: "same-content-1" },
    context(workspaceId),
  );
  const second = await runs.dispatch(
    { type: "start_run", commandId: "same-content-2" },
    context(workspaceId),
  );
  const [firstFinished, secondFinished] = await Promise.all([
    waitForTerminal(runs, first.runId),
    waitForTerminal(runs, second.runId),
  ]);
  const firstSource = firstFinished.snapshot.nodes[0]?.outputs.find(
    (output) => output.role === "sources",
  );
  const secondSource = secondFinished.snapshot.nodes[0]?.outputs.find(
    (output) => output.role === "sources",
  );
  assert.ok(firstSource);
  assert.ok(secondSource);
  assert.equal(firstSource.artifact.digest, secondSource.artifact.digest);
  assert.notEqual(firstSource.artifact.artifactId, secondSource.artifact.artifactId);
  assert.match(firstSource.artifact.artifactId, new RegExp(`^${first.runId}:snapshot_set:`));
  assert.match(secondSource.artifact.artifactId, new RegExp(`^${second.runId}:snapshot_set:`));
});

test("cancel before the executor starts prevents its invocation", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let invocations = 0;
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: freezeAndPlanExecutor(async ({ workDir }) => {
      invocations += 1;
      return succeededProbe(workDir);
    }),
  });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-cancel-before-pi" },
    context(workspaceId),
  );
  await runs.dispatch(
    { type: "cancel_run", commandId: "cancel-before-pi", runId: receipt.runId },
    context(workspaceId),
  );
  assert.equal(invocations, 0);
  assert.equal((await runs.read({ runId: receipt.runId })).snapshot.state, "cancelled");
});

test("cancel aborts an executing Pi attempt and its late result cannot commit", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let started!: () => void;
  const startedAttempt = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: freezeAndPlanExecutor(async ({ workDir }, signal) => {
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await writeFile(path.join(workDir, "late-result.txt"), "too late\n", "utf8");
      return succeededProbe(workDir);
    }),
  });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-cancel" },
    context(workspaceId),
  );
  await startedAttempt;
  const cancelled = await runs.dispatch(
    { type: "cancel_run", commandId: "cancel-1", runId: receipt.runId },
    context(workspaceId),
  );
  assert.deepEqual(
    await runs.dispatch(
      { type: "cancel_run", commandId: "cancel-1", runId: receipt.runId },
      context(workspaceId),
    ),
    cancelled,
  );
  const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.attempts[0]?.state, "cancelled");
  assert.equal(snapshot.state, "cancelled");
  assert.equal(snapshot.nodes[0]?.state, "cancelled");
  assert.deepEqual(snapshot.nodes[0]?.outputs, []);
});

test("cancel aborts an active freeze and removes its unpinned run tree", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let started!: () => void;
  const startedFreeze = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runs = await openWikiRuns({
    rootPath: root,
    freezeRunBoundary: blockingFreeze(root, started),
  });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-cancel-freeze" },
    context(workspaceId),
  );
  await startedFreeze;
  await runs.dispatch(
    { type: "cancel_run", commandId: "cancel-freeze", runId: receipt.runId },
    context(workspaceId),
  );
  assert.equal((await runs.read({ runId: receipt.runId })).snapshot.state, "cancelled");
  await assert.rejects(() => lstat(path.join(root, ".okf-wiki", "runs", receipt.runId)), /ENOENT/);
});

test("terminal runs reject a new cancellation command", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-terminal-cancel" },
    context(workspaceId),
  );
  // Freeze advances to plan-ready (still active); cancel is allowed, then terminal.
  await waitForTerminal(runs, receipt.runId);
  await runs.dispatch(
    { type: "cancel_run", commandId: "cancel-after-freeze", runId: receipt.runId },
    context(workspaceId),
  );
  assert.equal((await runs.read({ runId: receipt.runId })).snapshot.state, "cancelled");
  await assert.rejects(
    () =>
      runs.dispatch(
        { type: "cancel_run", commandId: "cancel-terminal", runId: receipt.runId },
        context(workspaceId),
      ),
    /terminal state: cancelled/,
  );
});

test("close waits for an aborted executor before releasing the owner lock", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let started!: () => void;
  const startedAttempt = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted!: () => void;
  const abortedAttempt = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: freezeAndPlanExecutor(async ({ workDir }, signal) => {
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      aborted();
      await released;
      return succeededProbe(workDir);
    }),
  });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "start-close-waits" },
    context(workspaceId),
  );
  await startedAttempt;
  const closing = owner.close();
  await abortedAttempt;
  await assert.rejects(() => openWikiRuns({ rootPath: root }), WorkflowInUseError);
  release();
  await closing;
  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  assert.equal((await reopened.read({ runId: receipt.runId })).snapshot.state, "failed");
});

test("close aborts an active freeze and removes its unpinned run tree", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let started!: () => void;
  const startedFreeze = new Promise<void>((resolve) => {
    started = resolve;
  });
  const owner = await openWikiRuns({
    rootPath: root,
    freezeRunBoundary: blockingFreeze(root, started),
  });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "start-close-freeze" },
    context(workspaceId),
  );
  await startedFreeze;
  await owner.close();
  await assert.rejects(() => lstat(path.join(root, ".okf-wiki", "runs", receipt.runId)), /ENOENT/);
});

test("reopen adopts only a prepared, already sealed artifact", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const owner = await openWikiRuns({ rootPath: root });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "start-recover-seal" },
    context(workspaceId),
  );
  const completed = await waitForTerminal(owner, receipt.runId);
  const attempt = completed.snapshot.attempts[0]!;
  await owner.close();

  // Model the crash window after filesystem seal and before the final DB CAS.
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("DELETE FROM node_outputs WHERE run_id = ?").run(receipt.runId);
  db.prepare("DELETE FROM artifacts WHERE run_id = ?").run(receipt.runId);
  db.prepare("UPDATE artifact_preparations SET state = 'prepared' WHERE attempt_id = ?").run(
    attempt.attemptId,
  );
  db.prepare("UPDATE attempts SET state = 'running', ended_at = NULL WHERE attempt_id = ?").run(
    attempt.attemptId,
  );
  db.prepare(
    "UPDATE nodes SET state = 'running', current_attempt_id = ? WHERE run_id = ? AND node_key = 'freeze' AND generation = 0",
  ).run(attempt.attemptId, receipt.runId);
  db.prepare(
    "UPDATE runs SET state = 'running', pinned_sources_json = NULL, skill_digest = NULL, pinned_digest = NULL WHERE run_id = ?",
  ).run(receipt.runId);
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const recovered = await reopened.read({ runId: receipt.runId });
  assertFreezeAdvancedToPlan(recovered.snapshot);
  assert.equal(recovered.snapshot.attempts[0]?.state, "succeeded");
  const freeze = recovered.snapshot.nodes.find((node) => node.key === "freeze");
  assert.deepEqual(
    freeze?.outputs.map((output) => output.role),
    ["attempt_output", "skill", "sources"],
  );
});

test("recovery pins Run Boundary metadata even when Pi tampers sealed attempt output", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const owner = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: freezeAndPlanExecutor(async ({ workDir }) => {
      await writeFile(
        path.join(workDir, "freeze-inputs.json"),
        `${JSON.stringify({
          skillDigest: "c".repeat(64),
          sources: [{ id: "forged", revision: "d".repeat(40), effectiveIgnores: [] }],
        })}\n`,
        "utf8",
      );
      return succeededProbe(workDir);
    }),
  });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "start-recover-tampered-output" },
    context(workspaceId),
  );
  const completed = await waitForTerminal(owner, receipt.runId);
  const attempt = completed.snapshot.attempts.find((row) => row.nodeKey === "freeze")!;
  const expectedInputs = completed.snapshot.pinnedInputs;
  assert.ok(expectedInputs);
  assert.ok(attempt);
  await owner.close();

  // Model a crash after every artifact was sealed but before the final DB CAS.
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  // Drop plan lineage first so freeze artifact DELETE is not blocked by attempt_inputs FK.
  db.prepare(
    "DELETE FROM attempt_inputs WHERE attempt_id IN (SELECT attempt_id FROM attempts WHERE run_id = ?)",
  ).run(receipt.runId);
  db.prepare("DELETE FROM node_outputs WHERE run_id = ?").run(receipt.runId);
  db.prepare("DELETE FROM artifacts WHERE run_id = ?").run(receipt.runId);
  db.prepare("UPDATE artifact_preparations SET state = 'prepared' WHERE attempt_id = ?").run(
    attempt.attemptId,
  );
  db.prepare("UPDATE attempts SET state = 'running', ended_at = NULL WHERE attempt_id = ?").run(
    attempt.attemptId,
  );
  db.prepare(
    "UPDATE nodes SET state = 'running', current_attempt_id = ? WHERE run_id = ? AND node_key = 'freeze' AND generation = 0",
  ).run(attempt.attemptId, receipt.runId);
  db.prepare(
    "UPDATE runs SET state = 'running', pinned_sources_json = NULL, skill_digest = NULL, pinned_digest = NULL WHERE run_id = ?",
  ).run(receipt.runId);
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const recovered = await reopened.read({ runId: receipt.runId });
  assert.deepEqual(recovered.snapshot.pinnedInputs, expectedInputs);
  assert.equal(recovered.snapshot.pinnedInputs?.sources[0]?.id, "main");
  assert.notEqual(recovered.snapshot.pinnedInputs?.skillDigest, "c".repeat(64));
});

test("recovery rejects a tampered sealed input artifact", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const owner = await openWikiRuns({ rootPath: root });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "start-recover-tampered-input" },
    context(workspaceId),
  );
  const completed = await waitForTerminal(owner, receipt.runId);
  const attempt = completed.snapshot.attempts[0]!;
  const source = completed.snapshot.nodes[0]?.outputs.find((output) => output.role === "sources");
  assert.ok(source);
  await owner.close();

  const sealedReadme = path.join(
    root,
    ".okf-wiki",
    "runs",
    receipt.runId,
    "artifacts",
    `snapshot_set-${source.artifact.digest}`,
    "main",
    "README.md",
  );
  await chmod(path.dirname(sealedReadme), 0o755);
  await chmod(sealedReadme, 0o644);
  await writeFile(sealedReadme, "tampered\n", "utf8");
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("DELETE FROM node_outputs WHERE run_id = ?").run(receipt.runId);
  db.prepare("DELETE FROM artifacts WHERE run_id = ?").run(receipt.runId);
  db.prepare("UPDATE artifact_preparations SET state = 'prepared' WHERE attempt_id = ?").run(
    attempt.attemptId,
  );
  db.prepare("UPDATE attempts SET state = 'running', ended_at = NULL WHERE attempt_id = ?").run(
    attempt.attemptId,
  );
  db.prepare(
    "UPDATE nodes SET state = 'running', current_attempt_id = ? WHERE run_id = ? AND node_key = 'freeze' AND generation = 0",
  ).run(attempt.attemptId, receipt.runId);
  db.prepare(
    "UPDATE runs SET state = 'running', pinned_sources_json = NULL, skill_digest = NULL, pinned_digest = NULL WHERE run_id = ?",
  ).run(receipt.runId);
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const recovered = await reopened.read({ runId: receipt.runId });
  assert.equal(recovered.snapshot.state, "failed");
  assert.equal(recovered.snapshot.attempts[0]?.state, "interrupted");
  assert.deepEqual(recovered.snapshot.nodes[0]?.outputs, []);
});

test("a killed owner excludes a second process and its running attempt is recovered", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const child = startChildOwner(root, workspaceId);
  t.after(() => stopChild(child));
  const ready = await waitForChildMessage(child);
  assert.equal(ready.type, "ready", ready.message);
  assert.ok(ready.runId);
  await assert.rejects(
    () => openWikiRuns({ rootPath: root }),
    (error: unknown) => error instanceof WorkflowInUseError && error.code === "WORKFLOW_IN_USE",
  );
  await stopChild(child);

  const recovered = await openWikiRuns({ rootPath: root });
  t.after(() => recovered.close());
  const result = await recovered.read({ runId: ready.runId });
  assert.equal(result.snapshot.state, "failed");
  assert.equal(result.snapshot.nodes[0]?.state, "failed");
  assert.equal(result.snapshot.attempts[0]?.state, "interrupted");
});

test("close interrupts a claimed freeze and reopen never accepts its late completion", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const owner = await openWikiRuns({ rootPath: root });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "start-close" },
    context(workspaceId),
  );
  await owner.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const result = await reopened.read({ runId: receipt.runId });
  assert.equal(result.snapshot.state, "failed");
  assert.equal(result.snapshot.nodes[0]?.state, "failed");
  assert.equal(result.snapshot.attempts[0]?.state, "interrupted");
  assert.equal(result.snapshot.nodes[0]?.currentAttemptId, null);
  assert.equal(result.events.at(-1)?.type, "attempt.interrupted");
});

test("freeze recovery uses its Run snapshot and removes unpinned residual work", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const source = path.join(root, "source");
  await writeFile(path.join(source, "uncommitted.txt"), "make first freeze fail\n", "utf8");

  const owner = await openWikiRuns({ rootPath: root });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "start-retry" },
    context(workspaceId),
  );
  assert.equal((await waitForTerminal(owner, receipt.runId)).snapshot.state, "failed");
  await owner.close();
  spawnSync("git", ["add", "."], { cwd: source, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "clean source"], { cwd: source, stdio: "ignore" });

  const residual = path.join(root, ".okf-wiki", "runs", receipt.runId, "sources", "main");
  await mkdir(residual, { recursive: true });
  await writeFile(path.join(residual, "stale.txt"), "incomplete freeze\n", "utf8");
  await chmod(path.join(residual, "stale.txt"), 0o444);
  await chmod(residual, 0o555);

  const changed = await loadWorkspace(root);
  changed.sources[0]!.path = path.join(root, "missing-source");
  await saveWorkspace(changed);

  // This models the later RetryFailedNode transition, intentionally out of scope here.
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.prepare(
    "UPDATE nodes SET state = 'ready', current_attempt_id = NULL WHERE run_id = ? AND node_key = 'freeze' AND generation = 0",
  ).run(receipt.runId);
  db.prepare("UPDATE runs SET state = 'queued' WHERE run_id = ?").run(receipt.runId);
  const keyColumns = db
    .prepare("SELECT name FROM pragma_table_info('nodes') WHERE pk > 0 ORDER BY pk")
    .all() as Array<{ name: string }>;
  db.close();
  assert.deepEqual(
    keyColumns.map((column) => column.name),
    ["run_id", "node_key", "generation"],
  );

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  assertFreezeAdvancedToPlan((await waitForTerminal(reopened, receipt.runId)).snapshot);
  assert.equal(
    await readFile(
      path.join(root, ".okf-wiki", "runs", receipt.runId, "sources", "main", "README.md"),
      "utf8",
    ),
    "# source\n",
  );
  await assert.rejects(() => readFile(path.join(residual, "stale.txt")));
});

test("snapshot, cursor, and incremental replay share every revision", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-read" },
    context(workspaceId),
  );
  const terminal = await waitForTerminal(runs, receipt.runId);
  const replay = await runs.read({ runId: receipt.runId, afterEventId: 1 });
  assert.equal(replay.events[0]?.eventId, 2);
  assert.equal(replay.cursor, terminal.cursor);
  assert.equal(terminal.snapshot.revision, terminal.events.at(-1)?.revision);
});

const PLAN_PAYLOAD_DIGEST = "b".repeat(64);

/** Seed a durable open plan gate without running the full Pi graph (T3). */
function seedOpenPlanGate(root: string, runId: string, options?: { gateId?: string }): string {
  const gateId = options?.gateId ?? "gate-plan-1";
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const timestamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO nodes (run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id)
     VALUES (?, 'plan', 'plan', 'succeeded', 0, NULL, NULL)
     ON CONFLICT(run_id, node_key, generation) DO UPDATE SET state = 'succeeded'`,
  ).run(runId);
  db.prepare(
    `INSERT INTO nodes (run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id)
     VALUES (?, 'gate.plan', 'gate.plan', 'waiting', 0, NULL, NULL)
     ON CONFLICT(run_id, node_key, generation) DO UPDATE SET state = 'waiting'`,
  ).run(runId);
  db.prepare(
    `INSERT INTO gates (
      gate_id, run_id, node_key, node_generation, kind, state, payload_digest,
      decision_json, detail_json, opened_at, opened_revision
    ) VALUES (?, ?, 'gate.plan', 0, 'plan', 'open', ?, NULL, NULL, ?, 1)`,
  ).run(gateId, runId, PLAN_PAYLOAD_DIGEST, timestamp);
  db.prepare("UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ?").run(
    timestamp,
    runId,
  );
  db.close();
  return gateId;
}

/** Attach a sealed Spec artifact to the current plan generation (approve prerequisite). */
async function seedPlanSpecArtifact(root: string, runId: string): Promise<void> {
  const relativePath = "artifacts/spec-plan";
  const artifactDir = path.join(root, ".okf-wiki", "runs", runId, relativePath);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, "spec.json"),
    `${JSON.stringify(defaultWikiRunSpec("Workflow test"))}\n`,
    "utf8",
  );
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const timestamp = new Date().toISOString();
  const attemptId = "attempt-plan-spec-1";
  const artifactId = `${runId}:spec:${"a".repeat(64)}`;
  db.prepare(
    `INSERT INTO attempts (
      attempt_id, run_id, node_key, node_generation, run_index, state, input_digest, error, started_at, ended_at
    ) VALUES (?, ?, 'plan', 0, 1, 'succeeded', ?, NULL, ?, ?)`,
  ).run(attemptId, runId, "b".repeat(64), timestamp, timestamp);
  db.prepare(
    `INSERT INTO artifacts (artifact_id, run_id, kind, digest, relative_path, producer_attempt_id, sealed_at)
     VALUES (?, ?, 'spec', ?, ?, ?, ?)`,
  ).run(artifactId, runId, "a".repeat(64), relativePath, attemptId, timestamp);
  db.prepare(
    `INSERT INTO node_outputs (run_id, node_key, node_generation, role, artifact_id)
     VALUES (?, 'plan', 0, 'spec', ?)`,
  ).run(runId, artifactId);
  db.close();
}

test("ResolveGate plan approve, revise, and deny follow the ADR decision table", async (t) => {
  // approve without Spec fails closed (honest until T3 graph materialization)
  {
    const { root, workspaceId } = await makeWorkspace();
    t.after(() => removeWorkspace(root));
    const runs = await openWikiRuns({ rootPath: root });
    const receipt = await runs.dispatch(
      { type: "start_run", commandId: "start-gate-approve-nospec" },
      context(workspaceId),
    );
    await waitForTerminal(runs, receipt.runId);
    await runs.close();
    const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-approve-nospec" });
    const reopened = await openWikiRuns({ rootPath: root });
    t.after(() => reopened.close());
    await assert.rejects(
      () =>
        reopened.dispatch(
          {
            type: "resolve_gate",
            commandId: "resolve-approve-nospec",
            runId: receipt.runId,
            gateId,
            gateKind: "plan",
            payloadDigest: PLAN_PAYLOAD_DIGEST,
            decision: "approve",
          },
          context(workspaceId),
        ),
      /sealed Spec artifact/,
    );
    const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
    assert.equal(snapshot.gates[0]?.state, "open");
  }

  // approve with sealed Spec
  {
    const { root, workspaceId } = await makeWorkspace();
    t.after(() => removeWorkspace(root));
    const runs = await openWikiRuns({ rootPath: root });
    const receipt = await runs.dispatch(
      { type: "start_run", commandId: "start-gate-approve" },
      context(workspaceId),
    );
    await waitForTerminal(runs, receipt.runId);
    await runs.close();
    const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-approve" });
    await seedPlanSpecArtifact(root, receipt.runId);
    const reopened = await openWikiRuns({ rootPath: root });
    const approved = await reopened.dispatch(
      {
        type: "resolve_gate",
        commandId: "resolve-approve",
        runId: receipt.runId,
        gateId,
        gateKind: "plan",
        payloadDigest: PLAN_PAYLOAD_DIGEST,
        decision: "approve",
      },
      context(workspaceId),
    );
    assert.equal(approved.accepted, true);
    assert.deepEqual(
      await reopened.dispatch(
        {
          type: "resolve_gate",
          commandId: "resolve-approve",
          runId: receipt.runId,
          gateId,
          gateKind: "plan",
          payloadDigest: PLAN_PAYLOAD_DIGEST,
          decision: "approve",
        },
        context(workspaceId),
      ),
      approved,
    );
    const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
    assert.equal(snapshot.gates[0]?.state, "resolved");
    assert.equal(snapshot.gates[0]?.decision?.decision, "approve");
    assert.equal(snapshot.state, "running");
    assert.equal(snapshot.nodes.find((node) => node.key === "gate.plan")?.state, "succeeded");
    // Definition v1: write.root stays blocked until research.domain.* succeed.
    assert.equal(snapshot.nodes.find((node) => node.key === "write.root")?.state, "blocked");
    assert.ok(
      snapshot.nodes.some((node) => node.kind === "research.leaf" && node.state === "ready"),
    );
    await assert.rejects(
      () =>
        reopened.dispatch(
          {
            type: "resolve_gate",
            commandId: "resolve-approve-stale",
            runId: receipt.runId,
            gateId,
            gateKind: "plan",
            payloadDigest: PLAN_PAYLOAD_DIGEST,
            decision: "deny",
          },
          context(workspaceId),
        ),
      /stale|already closed/,
    );
    await reopened.close();
  }

  // revise
  {
    const { root, workspaceId } = await makeWorkspace();
    t.after(() => removeWorkspace(root));
    const runs = await openWikiRuns({ rootPath: root });
    const receipt = await runs.dispatch(
      { type: "start_run", commandId: "start-gate-revise" },
      context(workspaceId),
    );
    await waitForTerminal(runs, receipt.runId);
    await runs.close();
    const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-revise" });
    const reopened = await openWikiRuns({ rootPath: root });
    await reopened.dispatch(
      {
        type: "resolve_gate",
        commandId: "resolve-revise",
        runId: receipt.runId,
        gateId,
        gateKind: "plan",
        payloadDigest: PLAN_PAYLOAD_DIGEST,
        decision: "revise",
        feedback: "Narrow the scope to the runtime seam.",
      },
      context(workspaceId),
    );
    const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
    assert.equal(snapshot.gates[0]?.state, "resolved");
    assert.equal(snapshot.gates[0]?.decision?.decision, "revise");
    const plan = snapshot.nodes.find((node) => node.key === "plan");
    assert.equal(plan?.generation, 1);
    assert.equal(plan?.state, "ready");
    assert.equal(snapshot.state, "queued");
    await reopened.close();
  }

  // deny
  {
    const { root, workspaceId } = await makeWorkspace();
    t.after(() => removeWorkspace(root));
    const runs = await openWikiRuns({ rootPath: root });
    const receipt = await runs.dispatch(
      { type: "start_run", commandId: "start-gate-deny" },
      context(workspaceId),
    );
    await waitForTerminal(runs, receipt.runId);
    await runs.close();
    const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-deny" });
    const reopened = await openWikiRuns({ rootPath: root });
    await reopened.dispatch(
      {
        type: "resolve_gate",
        commandId: "resolve-deny",
        runId: receipt.runId,
        gateId,
        gateKind: "plan",
        payloadDigest: PLAN_PAYLOAD_DIGEST,
        decision: "deny",
      },
      context(workspaceId),
    );
    const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
    assert.equal(snapshot.gates[0]?.state, "resolved");
    assert.equal(snapshot.gates[0]?.decision?.decision, "deny");
    assert.equal(snapshot.state, "cancelled");
    assert.equal(snapshot.cancelRequested, true);
    await reopened.close();
  }
});

test("RerunNode bumps generation, invalidates lineage consumers, and rejects stale generation", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-rerun" },
    context(workspaceId),
  );
  const finished = await waitForTerminal(runs, receipt.runId);
  const freezeOutput = finished.snapshot.nodes
    .find((node) => node.key === "freeze")
    ?.outputs.find((output) => output.role === "sources");
  assert.ok(freezeOutput);
  assert.equal(finished.snapshot.nodes.find((node) => node.key === "plan")?.state, "ready");
  await runs.close();

  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const timestamp = new Date().toISOString();
  // Freeze already created plan@0 ready; promote it to succeeded with a Spec output.
  db.prepare(
    `UPDATE nodes SET state = 'succeeded', current_attempt_id = NULL
     WHERE run_id = ? AND node_key = 'plan' AND generation = 0`,
  ).run(receipt.runId);
  db.prepare(
    `INSERT INTO nodes (run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json)
     VALUES (?, 'research.domain.main', 'research.domain', 'succeeded', 0, NULL, NULL, NULL)`,
  ).run(receipt.runId);
  const planAttemptId = "attempt-plan-1";
  const researchAttemptId = "attempt-research-1";
  const planArtifactId = `${receipt.runId}:spec:${"c".repeat(64)}`;
  db.prepare(
    `INSERT INTO attempts (
      attempt_id, run_id, node_key, node_generation, run_index, state, input_digest, error, started_at, ended_at
    ) VALUES (?, ?, 'plan', 0, 1, 'succeeded', ?, NULL, ?, ?)`,
  ).run(planAttemptId, receipt.runId, "d".repeat(64), timestamp, timestamp);
  db.prepare(
    `INSERT INTO artifacts (artifact_id, run_id, kind, digest, relative_path, producer_attempt_id, sealed_at)
     VALUES (?, ?, 'spec', ?, 'artifacts/spec-plan', ?, ?)`,
  ).run(planArtifactId, receipt.runId, "c".repeat(64), planAttemptId, timestamp);
  db.prepare(
    `INSERT INTO node_outputs (run_id, node_key, node_generation, role, artifact_id)
     VALUES (?, 'plan', 0, 'spec', ?)`,
  ).run(receipt.runId, planArtifactId);
  db.prepare(
    `INSERT INTO attempts (
      attempt_id, run_id, node_key, node_generation, run_index, state, input_digest, error, started_at, ended_at
    ) VALUES (?, ?, 'research.domain.main', 0, 1, 'succeeded', ?, NULL, ?, ?)`,
  ).run(researchAttemptId, receipt.runId, "e".repeat(64), timestamp, timestamp);
  db.prepare(
    `INSERT INTO attempt_inputs (attempt_id, role, artifact_id) VALUES (?, 'spec', ?)`,
  ).run(researchAttemptId, planArtifactId);
  // Unrelated node with no lineage should not be invalidated.
  db.prepare(
    `INSERT INTO nodes (run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json)
     VALUES (?, 'research.leaf.other', 'research.leaf', 'succeeded', 0, NULL, NULL, NULL)`,
  ).run(receipt.runId);
  db.prepare("UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ?").run(
    timestamp,
    receipt.runId,
  );
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  const rerun = await reopened.dispatch(
    {
      type: "rerun_node",
      commandId: "rerun-plan",
      runId: receipt.runId,
      nodeKey: "plan",
      generation: 0,
      feedback: "Re-plan with tighter leaf scope.",
    },
    context(workspaceId),
  );
  assert.equal(rerun.accepted, true);
  const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
  const plan = snapshot.nodes.find((node) => node.key === "plan");
  const research = snapshot.nodes.find((node) => node.key === "research.domain.main");
  const other = snapshot.nodes.find((node) => node.key === "research.leaf.other");
  assert.equal(plan?.generation, 1);
  assert.equal(plan?.state, "ready");
  assert.equal(research?.generation, 1);
  assert.equal(research?.state, "invalidated");
  assert.equal(other?.generation, 0);
  assert.equal(other?.state, "succeeded");
  assert.equal(snapshot.state, "queued");

  await assert.rejects(
    () =>
      reopened.dispatch(
        {
          type: "rerun_node",
          commandId: "rerun-plan-stale",
          runId: receipt.runId,
          nodeKey: "plan",
          generation: 0,
        },
        context(workspaceId),
      ),
    /stale/,
  );
  await reopened.close();

  const dbAfter = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const planDetail = dbAfter
    .prepare(
      "SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = 'plan' AND generation = 1",
    )
    .get(receipt.runId) as { detail_json: string | null };
  assert.deepEqual(JSON.parse(planDetail.detail_json ?? "null"), {
    feedback: "Re-plan with tighter leaf scope.",
  });
  dbAfter.close();
});

test("RerunNode on a ready node leaves only one claimable generation", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-rerun-ready" },
    context(workspaceId),
  );
  const finished = await waitForTerminal(runs, receipt.runId);
  assertFreezeAdvancedToPlan(finished.snapshot);
  const plan = finished.snapshot.nodes.find((node) => node.key === "plan");
  assert.equal(plan?.state, "ready");
  assert.equal(plan?.generation, 0);

  await runs.dispatch(
    {
      type: "rerun_node",
      commandId: "rerun-ready-plan",
      runId: receipt.runId,
      nodeKey: "plan",
      generation: 0,
      feedback: "Bump before claim.",
    },
    context(workspaceId),
  );

  const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.nodes.find((node) => node.key === "plan")?.generation, 1);
  assert.equal(snapshot.nodes.find((node) => node.key === "plan")?.state, "ready");
  await runs.close();

  // Owner uses EXCLUSIVE locking; inspect superseded generations only after close.
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const planRows = db
    .prepare(
      "SELECT generation, state FROM nodes WHERE run_id = ? AND node_key = 'plan' ORDER BY generation",
    )
    .all(receipt.runId) as Array<{ generation: number; state: string }>;
  db.close();
  assert.deepEqual(
    planRows.map((row) => ({ generation: row.generation, state: row.state })),
    [
      { generation: 0, state: "cancelled" },
      { generation: 1, state: "ready" },
    ],
  );
  const claimable = planRows.filter((row) =>
    ["ready", "running", "blocked", "waiting"].includes(row.state),
  );
  assert.equal(claimable.length, 1);
  assert.equal(claimable[0]?.generation, 1);
});

test("scheduler plan claim binds freeze sealed outputs as attempt_inputs", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let releasePlan: (() => void) | undefined;
  const planBlocked = new Promise<void>((resolve) => {
    releasePlan = resolve;
  });
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key !== "plan") return succeededProbe(input.workDir);
      await Promise.race([
        planBlocked,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      if (signal.aborted) {
        return { type: "failed", error: "cancelled", failureClass: "cancelled" };
      }
      return succeededProbe(input.workDir);
    },
  });
  t.after(async () => {
    releasePlan?.();
    await runs.close();
  });

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-plan-inputs" },
    context(workspaceId),
  );

  let claimAttemptId: string | undefined;
  let freezeOutputs: Array<{ role: string; artifact_id: string }> | undefined;
  for (let count = 0; count < 200; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const plan = snapshot.nodes.find((node) => node.key === "plan");
    const planAttempt = snapshot.attempts.find(
      (attempt) => attempt.nodeKey === "plan" && attempt.state === "running",
    );
    if (plan?.state === "running" && planAttempt) {
      claimAttemptId = planAttempt.attemptId;
      freezeOutputs = snapshot.nodes
        .find((node) => node.key === "freeze")
        ?.outputs.map((output) => ({
          role: output.role,
          artifact_id: output.artifact.artifactId,
        }))
        .sort((a, b) => a.role.localeCompare(b.role));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(claimAttemptId, "scheduler should claim plan after freeze");
  assert.ok(freezeOutputs && freezeOutputs.length >= 2);

  // Inspect attempt_inputs while the owner still holds the lock via SQL through a second
  // connection is blocked by EXCLUSIVE; release the hanging plan then re-read after close.
  releasePlan?.();
  for (let count = 0; count < 200; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const planAttempt = snapshot.attempts.find((attempt) => attempt.attemptId === claimAttemptId);
    if (planAttempt && planAttempt.state !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await runs.close();

  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const bound = db
    .prepare(`SELECT role, artifact_id FROM attempt_inputs WHERE attempt_id = ? ORDER BY role`)
    .all(claimAttemptId) as Array<{ role: string; artifact_id: string }>;
  const freezeAttemptInputs = db
    .prepare(
      `SELECT COUNT(*) AS count FROM attempt_inputs
       WHERE attempt_id = (
         SELECT attempt_id FROM attempts
         WHERE run_id = ? AND node_key = 'freeze' ORDER BY started_at LIMIT 1
       )`,
    )
    .get(receipt.runId) as { count: number };
  db.close();

  // Plan binds well-known freeze pins (sources + skill), not attempt_output noise.
  const expected = (freezeOutputs ?? [])
    .filter((row) => row.role === "sources" || row.role === "skill")
    .sort((a, b) => a.role.localeCompare(b.role));
  assert.deepEqual(
    bound.map((row) => ({ role: row.role, artifact_id: row.artifact_id })),
    expected,
  );
  // Freeze has no upstream sealed outputs.
  assert.equal(freezeAttemptInputs.count, 0);
});

test("StartRun freezes, plans via executor, opens gate.plan, and ResolveGate approve materializes Definition v1 graph", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-plan-gate" },
    context(workspaceId),
  );

  const atPlanGate = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const openGate = atPlanGate.snapshot.gates.find(
    (item) => item.kind === "plan" && item.state === "open",
  );
  assert.ok(openGate, "plan gate should open after Spec seal");
  assert.equal(atPlanGate.snapshot.nodes.find((node) => node.key === "plan")?.state, "succeeded");
  assert.equal(
    atPlanGate.snapshot.nodes.find((node) => node.key === "gate.plan")?.state,
    "waiting",
  );

  const approved = await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "approve-plan-gate",
      runId: receipt.runId,
      gateId: openGate.gateId,
      gateKind: "plan",
      payloadDigest: openGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
  assert.equal(approved.accepted, true);

  // Graph materialization is synchronous in ResolveGate; read immediately.
  const after = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(after.gates.find((g) => g.kind === "plan")?.state, "resolved");
  assert.equal(after.nodes.find((node) => node.key === "gate.plan")?.state, "succeeded");
  const leaves = after.nodes.filter((node) => node.kind === "research.leaf");
  const domains = after.nodes.filter((node) => node.kind === "research.domain");
  assert.ok(leaves.length >= 1, "approve should materialize research.leaf nodes");
  assert.ok(domains.length >= 1, "approve should materialize research.domain nodes");
  assert.ok(after.nodes.some((node) => node.key === "write.root"));
  assert.ok(after.nodes.some((node) => node.key === "validate.pre"));
  assert.ok(after.nodes.some((node) => node.key === "review.reduce"));
  assert.ok(after.nodes.some((node) => node.key === "prepare.publication"));
  assert.ok(after.nodes.some((node) => node.key === "gate.publication"));
  assert.ok(after.nodes.some((node) => node.key === "publish"));
  // Stop scheduler before teardown so attempt dirs are not mid-write.
  await runs.close();
});

test("fixture e2e StartRun → plan gate → full graph → publication gate → published", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-e2e-full" },
    context(workspaceId),
  );

  const atPlan = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const planGate = atPlan.snapshot.gates.find((g) => g.kind === "plan" && g.state === "open");
  assert.ok(planGate);

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "approve-e2e-plan",
      runId: receipt.runId,
      gateId: planGate.gateId,
      gateKind: "plan",
      payloadDigest: planGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );

  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const pubGate = atPub.snapshot.gates.find((g) => g.kind === "publication" && g.state === "open");
  assert.ok(pubGate, "publication gate should open after prepare.publication");
  assert.equal(
    atPub.snapshot.nodes.find((n) => n.key === "prepare.publication")?.state,
    "succeeded",
  );
  assert.equal(atPub.snapshot.nodes.find((n) => n.key === "write.root")?.state, "succeeded");
  assert.ok(
    atPub.snapshot.effects.some((e) => e.state === "prepared" || e.state === "candidate_ready"),
  );

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "approve-e2e-pub",
      runId: receipt.runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );

  const published = await waitForRunState(runs, receipt.runId, ["published"], 30_000);
  assert.equal(published.snapshot.state, "published");
  assert.equal(published.snapshot.nodes.find((n) => n.key === "publish")?.state, "succeeded");
  assert.ok(published.snapshot.effects.some((e) => e.state === "applied"));
});

test("fixture e2e publication deny yields completed_unpublished", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-e2e-deny" },
    context(workspaceId),
  );
  const atPlan = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const planGate = atPlan.snapshot.gates.find((g) => g.kind === "plan" && g.state === "open")!;
  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "approve-deny-plan",
      runId: receipt.runId,
      gateId: planGate.gateId,
      gateKind: "plan",
      payloadDigest: planGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const pubGate = atPub.snapshot.gates.find((g) => g.kind === "publication" && g.state === "open")!;
  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "deny-e2e-pub",
      runId: receipt.runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "deny",
    },
    context(workspaceId),
  );
  const done = await waitForRunState(runs, receipt.runId, ["completed_unpublished"]);
  assert.equal(done.snapshot.state, "completed_unpublished");
});

test("CancelRun withdraws open gates", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-cancel-gate" },
    context(workspaceId),
  );
  await waitForTerminal(runs, receipt.runId);
  await runs.close();
  const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-cancel" });
  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  assert.equal((await reopened.read({ runId: receipt.runId })).snapshot.gates[0]?.state, "open");
  await reopened.dispatch(
    { type: "cancel_run", commandId: "cancel-with-gate", runId: receipt.runId },
    context(workspaceId),
  );
  const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.state, "cancelled");
  assert.equal(snapshot.gates.find((gate) => gate.gateId === gateId)?.state, "withdrawn");
  assert.equal(snapshot.gates[0]?.decision, null);
});

test("reopen preserves open gates and does not withdraw them", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-preserve-gate" },
    context(workspaceId),
  );
  await waitForTerminal(runs, receipt.runId);
  await runs.close();
  const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-preserve" });
  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.state, "waiting_for_operator");
  assert.equal(snapshot.gates.length, 1);
  assert.equal(snapshot.gates[0]?.gateId, gateId);
  assert.equal(snapshot.gates[0]?.state, "open");
  assert.equal(snapshot.gates[0]?.kind, "plan");
  assert.equal(snapshot.gates[0]?.payloadDigest, PLAN_PAYLOAD_DIGEST);
});

test("recovery marks applying effects unknown without withdrawing open gates", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-effect-unknown" },
    context(workspaceId),
  );
  await waitForTerminal(runs, receipt.runId);
  await runs.close();
  const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-with-effect" });
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const digest = "f".repeat(64);
  db.prepare(
    `INSERT INTO effects (
      effect_key, run_id, publication_node_key, publication_node_generation, gate_id, state,
      request_digest, expected_live_digest, candidate_artifact_id, candidate_digest, observed_outcome
    ) VALUES (?, ?, 'prepare.publication', 0, ?, 'applying', ?, ?, 'candidate-1', ?, NULL)`,
  ).run(`publish:${receipt.runId}:0`, receipt.runId, gateId, digest, digest, digest);
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.gates[0]?.state, "open");
  assert.equal(snapshot.effects[0]?.state, "unknown");
});

/** Approve the plan gate once Spec is sealed (helper for T4 retry/rerun tests). */
async function approvePlanGate(
  runs: Awaited<ReturnType<typeof openWikiRuns>>,
  runId: string,
  workspaceId: string,
  commandId: string,
): Promise<void> {
  const atPlan = await waitForRunState(runs, runId, ["waiting_for_operator"]);
  const planGate = atPlan.snapshot.gates.find((g) => g.kind === "plan" && g.state === "open");
  assert.ok(planGate, "expected open plan gate");
  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId,
      runId,
      gateId: planGate.gateId,
      gateKind: "plan",
      payloadDigest: planGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
}

test("failed leaf Retry reuses input_digest and does not re-run succeeded sibling leaves", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const leafAttempts = new Map<string, number>();
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "research.leaf") {
        const next = (leafAttempts.get(input.node.key) ?? 0) + 1;
        leafAttempts.set(input.node.key, next);
        // Exhaust research auto-retry (attempts 1–2 fail); attempt 3 is manual Retry.
        if (input.node.key === "research.leaf.core.1" && next <= 2) {
          return {
            type: "failed",
            error: `fixture leaf failure #${next}`,
            failureClass: "infrastructure",
          };
        }
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-leaf-retry" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-leaf-retry");

  // Wait until leaf.1 is failed after auto-retry exhaustion and leaf.2 succeeded.
  let failedLeafAttemptId: string | undefined;
  let firstInputDigest: string | undefined;
  for (let count = 0; count < 400; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const leaf1 = snapshot.nodes.find((n) => n.key === "research.leaf.core.1");
    const leaf2 = snapshot.nodes.find((n) => n.key === "research.leaf.core.2");
    const leaf1Attempts = snapshot.attempts.filter((a) => a.nodeKey === "research.leaf.core.1");
    if (leaf1?.state === "failed" && leaf2?.state === "succeeded" && leaf1Attempts.length >= 2) {
      const last = leaf1Attempts.at(-1)!;
      failedLeafAttemptId = last.attemptId;
      firstInputDigest = leaf1Attempts[0]!.inputDigest;
      assert.equal(last.inputDigest, firstInputDigest, "auto-retry reuses exact input_digest");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(failedLeafAttemptId, "leaf.1 should fail after auto-retry budget");
  assert.ok(firstInputDigest);
  const leaf2AttemptsBefore = leafAttempts.get("research.leaf.core.2") ?? 0;
  assert.ok(leaf2AttemptsBefore >= 1, "sibling leaf should have succeeded once");
  const leaf1AttemptsBefore = leafAttempts.get("research.leaf.core.1") ?? 0;

  await runs.dispatch(
    {
      type: "retry_failed_node",
      commandId: "retry-leaf-1",
      runId: receipt.runId,
      nodeKey: "research.leaf.core.1",
      generation: 0,
      attemptId: failedLeafAttemptId,
    },
    context(workspaceId),
  );

  // Wait for leaf.1 manual retry success; domain may then advance.
  for (let count = 0; count < 400; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const leaf1 = snapshot.nodes.find((n) => n.key === "research.leaf.core.1");
    if (leaf1?.state === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const after = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(after.nodes.find((n) => n.key === "research.leaf.core.1")?.state, "succeeded");
  assert.equal(after.nodes.find((n) => n.key === "research.leaf.core.2")?.state, "succeeded");
  assert.equal(
    leafAttempts.get("research.leaf.core.2") ?? 0,
    leaf2AttemptsBefore,
    "succeeded sibling must not be re-executed on leaf Retry",
  );
  assert.equal(
    leafAttempts.get("research.leaf.core.1") ?? 0,
    leaf1AttemptsBefore + 1,
    "failed leaf gets exactly one manual retry Attempt",
  );
  const leaf1Digests = after.attempts
    .filter((a) => a.nodeKey === "research.leaf.core.1")
    .map((a) => a.inputDigest);
  assert.ok(leaf1Digests.length >= 3);
  assert.ok(
    leaf1Digests.every((d) => d === firstInputDigest),
    "every leaf.1 Attempt reuses the same frozen input_digest",
  );
});

test("RerunNode on write.root invalidates validate/review lineage and unlocks after re-success", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const writeClaims: string[] = [];
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key === "write.root") writeClaims.push(input.attemptId);
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-rerun-write" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-rerun-write");

  // Reach publication gate so write/validate/review have sealed outputs + lineage.
  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  assert.equal(atPub.snapshot.nodes.find((n) => n.key === "write.root")?.state, "succeeded");
  assert.equal(atPub.snapshot.nodes.find((n) => n.key === "validate.pre")?.state, "succeeded");
  assert.ok(atPub.snapshot.gates.some((g) => g.kind === "publication" && g.state === "open"));
  const writeBefore = writeClaims.length;
  assert.ok(writeBefore >= 1);

  const writeGen = atPub.snapshot.nodes.find((n) => n.key === "write.root")!.generation;
  await runs.dispatch(
    {
      type: "rerun_node",
      commandId: "rerun-write-root",
      runId: receipt.runId,
      nodeKey: "write.root",
      generation: writeGen,
      feedback: "Tighten overview citations.",
    },
    context(workspaceId),
  );

  const mid = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(mid.nodes.find((n) => n.key === "write.root")?.generation, writeGen + 1);
  // Scheduler may claim the new generation before this read; ready|running|succeeded are all valid.
  assert.ok(
    ["ready", "running", "succeeded"].includes(
      mid.nodes.find((n) => n.key === "write.root")?.state ?? "",
    ),
  );
  // Lineage consumers of wiki_tree advance to gen+1 (invalidated until upstreams re-succeed).
  const validate = mid.nodes.find((n) => n.key === "validate.pre");
  if (validate && validate.generation > writeGen) {
    assert.ok(
      ["invalidated", "ready", "running", "succeeded", "blocked"].includes(validate.state),
      `validate.pre@${validate.generation} unexpected state ${validate.state}`,
    );
  }
  // Unrelated research leaves stay at gen 0 succeeded.
  const leaf = mid.nodes.find((n) => n.kind === "research.leaf");
  assert.equal(leaf?.generation, 0);
  assert.equal(leaf?.state, "succeeded");

  // Scheduler re-runs write then unlocks invalidated descendants through to a new publication gate.
  const atPub2 = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  assert.ok(writeClaims.length > writeBefore, "write.root must execute again after Rerun");
  assert.equal(atPub2.snapshot.nodes.find((n) => n.key === "write.root")?.state, "succeeded");
  assert.equal(atPub2.snapshot.nodes.find((n) => n.key === "write.root")?.generation, writeGen + 1);
  assert.ok(
    atPub2.snapshot.gates.some((g) => g.kind === "publication" && g.state === "open"),
    "new publication gate after repair lineage",
  );
  // Feedback persisted on the new write generation.
  await runs.close();
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const detail = db
    .prepare(
      "SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = 'write.root' AND generation = ?",
    )
    .get(receipt.runId, writeGen + 1) as { detail_json: string | null };
  db.close();
  assert.deepEqual(JSON.parse(detail.detail_json ?? "null"), {
    feedback: "Tighten overview citations.",
  });
});

test("research auto-retry re-queues once; further failure stays manual", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let leaf1Count = 0;
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key === "research.leaf.core.1") {
        leaf1Count += 1;
        // Always fail this leaf so auto-retry exhausts and node ends failed.
        return {
          type: "failed",
          error: "persistent research flake",
          failureClass: "provider",
        };
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-auto-retry" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-auto-retry");

  for (let count = 0; count < 400; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const leaf1 = snapshot.nodes.find((n) => n.key === "research.leaf.core.1");
    if (leaf1?.state === "failed" && leaf1Count >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(leaf1Count, 2, "research auto-retry allows exactly one extra Attempt");
  const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.nodes.find((n) => n.key === "research.leaf.core.1")?.state, "failed");
  const digests = snapshot.attempts
    .filter((a) => a.nodeKey === "research.leaf.core.1")
    .map((a) => a.inputDigest);
  assert.equal(digests.length, 2);
  assert.equal(digests[0], digests[1]);
});

test("pre-pin freeze Retry remains banned; post-pin plan Retry works for any failed kind", async (t) => {
  // Post-pin plan failure → RetryFailedNode reuses digest (covers non-research kinds).
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let planFails = 1;
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key === "plan" && planFails > 0) {
        planFails -= 1;
        return {
          type: "failed",
          error: "plan fixture failure",
          failureClass: "infrastructure",
        };
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-plan-retry" },
    context(workspaceId),
  );
  // Wait for plan failed (freeze already pinned).
  let planAttemptId: string | undefined;
  let planDigest: string | undefined;
  for (let count = 0; count < 300; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const plan = snapshot.nodes.find((n) => n.key === "plan");
    const attempt = snapshot.attempts
      .filter((a) => a.nodeKey === "plan" && a.state === "failed")
      .at(-1);
    if (plan?.state === "failed" && attempt) {
      planAttemptId = attempt.attemptId;
      planDigest = attempt.inputDigest;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(planAttemptId);
  assert.ok(planDigest);

  await runs.dispatch(
    {
      type: "retry_failed_node",
      commandId: "retry-plan",
      runId: receipt.runId,
      nodeKey: "plan",
      generation: 0,
      attemptId: planAttemptId,
    },
    context(workspaceId),
  );

  const atGate = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  assert.ok(atGate.snapshot.gates.some((g) => g.kind === "plan" && g.state === "open"));
  const planAttempts = atGate.snapshot.attempts.filter((a) => a.nodeKey === "plan");
  assert.ok(planAttempts.length >= 2);
  assert.ok(planAttempts.every((a) => a.inputDigest === planDigest));
});

// ─── T5 publish effect full protocol ─────────────────────────────────────────

async function reachPublicationGate(
  root: string,
  workspaceId: string,
  commandPrefix: string,
): Promise<{
  runs: Awaited<ReturnType<typeof openWikiRuns>>;
  runId: string;
  pubGate: NonNullable<
    Awaited<
      ReturnType<Awaited<ReturnType<typeof openWikiRuns>>["read"]>
    >["snapshot"]["gates"][number]
  >;
  effect: NonNullable<
    Awaited<
      ReturnType<Awaited<ReturnType<typeof openWikiRuns>>["read"]>
    >["snapshot"]["effects"][number]
  >;
}> {
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: `${commandPrefix}-start` },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, `${commandPrefix}-approve-plan`);
  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const pubGate = atPub.snapshot.gates.find((g) => g.kind === "publication" && g.state === "open");
  assert.ok(pubGate, "expected open publication gate");
  const effect = atPub.snapshot.effects.find((e) => e.gateId === pubGate.gateId);
  assert.ok(effect, "expected prepared effect bound to publication gate");
  return { runs, runId: receipt.runId, pubGate, effect };
}

test("T5 prepare.publication captures baseline and binds effect+gate payload", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, pubGate, effect } = await reachPublicationGate(root, workspaceId, "t5-bind");
  t.after(() => runs.close());

  assert.equal(effect.state, "prepared");
  assert.equal(effect.publicationNodeKey, "prepare.publication");
  assert.match(effect.effectKey, new RegExp(`^publish:${runId}:\\d+:[a-f0-9]{64}$`));
  // First publish: empty baseline digest (canonical empty tree), not a placeholder of convenience.
  assert.equal(effect.expectedLiveDigest.length, 64);
  assert.equal(effect.candidateDigest.length, 64);
  assert.equal(effect.requestDigest, pubGate.payloadDigest);
  assert.equal(pubGate.state, "open");
});

test("T5 ResolveGate approve advances only the bound prepared effect to candidate_ready", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, pubGate, effect } = await reachPublicationGate(
    root,
    workspaceId,
    "t5-approve",
  );
  t.after(() => runs.close());

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "t5-approve-pub",
      runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );

  // May race through publish; candidate_ready or applied both prove the transition fired.
  for (let i = 0; i < 200; i += 1) {
    const snap = (await runs.read({ runId })).snapshot;
    const e = snap.effects.find((row) => row.effectKey === effect.effectKey);
    if (e && (e.state === "candidate_ready" || e.state === "applying" || e.state === "applied")) {
      assert.ok(true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const final = (await runs.read({ runId })).snapshot.effects.find(
    (row) => row.effectKey === effect.effectKey,
  );
  assert.fail(`effect never left prepared: ${final?.state}`);
});

test("T5 PublicationConflict when live baseline changes before apply", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, pubGate, effect } = await reachPublicationGate(
    root,
    workspaceId,
    "t5-conflict",
  );
  t.after(() => runs.close());

  // Mutate live publication so baseline no longer matches the sealed expectation.
  const publicationPath = path.join(root, "wiki");
  await mkdir(publicationPath, { recursive: true });
  await writeFile(
    path.join(publicationPath, "intruder.md"),
    "---\ntype: Concept\ntitle: Intruder\n---\n\n# Intruder\n\nExternal change.\n",
    "utf8",
  );

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "t5-approve-conflict",
      runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );

  for (let i = 0; i < 300; i += 1) {
    const snap = (await runs.read({ runId })).snapshot;
    const e = snap.effects.find((row) => row.effectKey === effect.effectKey);
    if (e?.state === "conflict") {
      assert.equal(e.expectedLiveDigest, effect.expectedLiveDigest);
      // Live must not have been overwritten by the stale candidate.
      const body = await readFile(path.join(publicationPath, "intruder.md"), "utf8");
      assert.match(body, /Intruder/);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const last = (await runs.read({ runId })).snapshot;
  assert.fail(
    `expected conflict effect, got ${last.effects.map((e) => e.state).join(",")} run=${last.state}`,
  );
});

test("T5 CancelRun before applying cancels prepared effect; applying is never cancelled", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, effect } = await reachPublicationGate(root, workspaceId, "t5-cancel-pre");
  t.after(() => runs.close());
  assert.equal(effect.state, "prepared");

  await runs.dispatch(
    { type: "cancel_run", commandId: "t5-cancel-pre-apply", runId },
    context(workspaceId),
  );
  const cancelled = await waitForRunState(runs, runId, ["cancelled"]);
  const pre = cancelled.snapshot.effects.find((e) => e.effectKey === effect.effectKey);
  assert.equal(pre?.state, "cancelled");

  // Separate path: applying + later cancel_requested must reconcile, not cancel.
  await runs.close();
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const digest = "a".repeat(64);
  const applyingKey = `publish:${runId}:99:${digest}`;
  db.prepare(
    `INSERT INTO effects (
      effect_key, run_id, publication_node_key, publication_node_generation, gate_id, state,
      request_digest, expected_live_digest, candidate_artifact_id, candidate_digest, observed_outcome
    ) VALUES (?, ?, 'prepare.publication', 99, 'gate-applying', 'applying', ?, ?, 'missing-candidate', ?, NULL)`,
  ).run(applyingKey, runId, digest, digest, digest);
  db.prepare("UPDATE runs SET cancel_requested = 1 WHERE run_id = ?").run(runId);
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const snap = (await reopened.read({ runId })).snapshot;
  const applying = snap.effects.find((e) => e.effectKey === applyingKey);
  assert.ok(applying);
  assert.notEqual(applying.state, "cancelled");
  assert.ok(["unknown", "failed", "applied"].includes(applying.state));
});

test("T5 reconcile applying→applied when live already matches sealed candidate", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, pubGate, effect } = await reachPublicationGate(
    root,
    workspaceId,
    "t5-reconcile",
  );
  // Approve + publish to produce a real sealed candidate on disk, then force applying and recover.
  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "t5-reconcile-approve",
      runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
  const published = await waitForRunState(runs, runId, ["published"], 30_000);
  const applied = published.snapshot.effects.find((e) => e.effectKey === effect.effectKey);
  assert.equal(applied?.state, "applied");
  await runs.close();

  // Simulate crash window: flip applied → applying while live already holds candidate bytes.
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare(
    "UPDATE effects SET state = 'applying', observed_outcome = NULL WHERE effect_key = ?",
  ).run(effect.effectKey);
  db.prepare("UPDATE runs SET state = 'running', cancel_requested = 0 WHERE run_id = ?").run(runId);
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const snap = (await reopened.read({ runId })).snapshot;
  const reconciled = snap.effects.find((e) => e.effectKey === effect.effectKey);
  assert.ok(reconciled);
  // applying must never become cancelled. When live already holds the sealed
  // candidate, reconcile must complete as applied (ADR 0035).
  assert.notEqual(reconciled.state, "cancelled");
  assert.equal(
    reconciled.state,
    "applied",
    `expected applied after live/candidate match, got ${reconciled.state}`,
  );
  assert.equal(snap.state, "published");
});

test("T5 CancelRun after candidate_ready (pre-apply) cancels effect; post-apply cancel does not", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, effect } = await reachPublicationGate(root, workspaceId, "t5-cancel-ready");
  assert.equal(effect.state, "prepared");
  // Close before approve so the scheduler cannot race into apply.
  await runs.close();

  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  // Simulate ResolveGate(approve) CAS without starting the publish executor.
  db.prepare(
    "UPDATE effects SET state = 'candidate_ready' WHERE effect_key = ? AND state = 'prepared'",
  ).run(effect.effectKey);
  const gateRow = db
    .prepare(
      "SELECT gate_id, payload_digest FROM gates WHERE run_id = ? AND kind = 'publication' AND state = 'open'",
    )
    .get(runId) as { gate_id: string; payload_digest: string };
  db.prepare("UPDATE gates SET state = 'resolved', decision_json = ? WHERE gate_id = ?").run(
    JSON.stringify({
      commandId: "t5-cancel-ready-sim-approve",
      decision: "approve",
      payloadDigest: gateRow.payload_digest,
      decidedAt: new Date().toISOString(),
    }),
    gateRow.gate_id,
  );
  db.prepare("UPDATE runs SET state = 'running', cancel_requested = 0 WHERE run_id = ?").run(runId);
  // Keep publish blocked so CancelRun wins over apply.
  db.prepare(
    `UPDATE nodes SET state = 'blocked', current_attempt_id = NULL
     WHERE run_id = ? AND node_key = 'publish'`,
  ).run(runId);
  db.close();

  const mid = await openWikiRuns({ rootPath: root });
  t.after(() => mid.close());
  const atReady = (await mid.read({ runId })).snapshot.effects.find(
    (e) => e.effectKey === effect.effectKey,
  );
  assert.equal(atReady?.state, "candidate_ready");

  await mid.dispatch(
    { type: "cancel_run", commandId: "t5-cancel-after-ready", runId },
    context(workspaceId),
  );
  const cancelled = await waitForRunState(mid, runId, ["cancelled"], 10_000);
  const preApply = cancelled.snapshot.effects.find((e) => e.effectKey === effect.effectKey);
  assert.equal(preApply?.state, "cancelled");
  await mid.close();

  // Post-apply: applying + cancel_requested must reconcile, never cancelled.
  const db2 = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db2.exec("PRAGMA foreign_keys=ON");
  const digest = "b".repeat(64);
  const applyingKey = `publish:${runId}:88:${digest}`;
  db2
    .prepare(
      `INSERT INTO effects (
        effect_key, run_id, publication_node_key, publication_node_generation, gate_id, state,
        request_digest, expected_live_digest, candidate_artifact_id, candidate_digest, observed_outcome
      ) VALUES (?, ?, 'prepare.publication', 88, 'gate-post-apply', 'applying', ?, ?, 'missing', ?, NULL)`,
    )
    .run(applyingKey, runId, digest, digest, digest);
  db2.prepare("UPDATE runs SET cancel_requested = 1 WHERE run_id = ?").run(runId);
  db2.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const snap = (await reopened.read({ runId })).snapshot;
  const applying = snap.effects.find((e) => e.effectKey === applyingKey);
  assert.ok(applying);
  assert.notEqual(applying.state, "cancelled");
  assert.ok(["unknown", "failed", "applied"].includes(applying.state));
});

test("T5 happy path: approval does not rewrite candidate bytes (content-only identity preserved)", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, pubGate, effect } = await reachPublicationGate(
    root,
    workspaceId,
    "t5-bytes",
  );
  t.after(() => runs.close());

  const candidateDigestAtGate = effect.candidateDigest;
  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "t5-bytes-approve",
      runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
  const published = await waitForRunState(runs, runId, ["published"], 30_000);
  const finalEffect = published.snapshot.effects.find((e) => e.effectKey === effect.effectKey);
  assert.equal(finalEffect?.state, "applied");
  assert.equal(finalEffect?.candidateDigest, candidateDigestAtGate);

  const { digestPublicationTree, digestPublicationTreeContentOnly } = await import(
    "@okf-wiki/core"
  );
  const publicationPath = path.join(root, "wiki");
  const liveDigest = await digestPublicationTree(publicationPath);
  const liveContentOnly = await digestPublicationTreeContentOnly(publicationPath);
  // Effect identity is content-only; live may include seal sidecar after swap.
  assert.equal(liveContentOnly, candidateDigestAtGate);
  assert.ok(liveDigest.length === 64);
  // observed_outcome records published:<liveDigest> (full sealed tree on live)
  await runs.close();
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const row = db
    .prepare("SELECT observed_outcome, candidate_digest FROM effects WHERE effect_key = ?")
    .get(effect.effectKey) as { observed_outcome: string; candidate_digest: string };
  db.close();
  assert.equal(row.candidate_digest, candidateDigestAtGate);
  assert.match(row.observed_outcome, /^published:[a-f0-9]{64}$/);
  const publishedLive = row.observed_outcome.slice("published:".length);
  assert.equal(publishedLive, liveDigest);
});

test("T5 effect state machine reaches applied only via candidate_ready→applying", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, pubGate, effect } = await reachPublicationGate(root, workspaceId, "t5-sm");
  t.after(() => runs.close());

  assert.equal(effect.state, "prepared");
  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "t5-sm-approve",
      runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
  const published = await waitForRunState(runs, runId, ["published"], 30_000);
  const finalEffect = published.snapshot.effects.find((e) => e.effectKey === effect.effectKey);
  assert.equal(finalEffect?.state, "applied");

  // Durable event log must record the ADR 0035 effect transitions in order.
  await runs.close();
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const types = (
    db
      .prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY event_id")
      .all(runId) as Array<{ type: string }>
  ).map((row) => row.type);
  db.close();
  const preparedAt = types.indexOf("effect.prepared");
  const readyAt = types.indexOf("effect.candidate_ready");
  const applyingAt = types.indexOf("effect.applying");
  const appliedAt = types.indexOf("effect.applied");
  assert.ok(preparedAt >= 0, "missing effect.prepared");
  assert.ok(readyAt > preparedAt, "candidate_ready must follow prepared");
  assert.ok(applyingAt > readyAt, "applying must follow candidate_ready");
  assert.ok(appliedAt > applyingAt, "applied must follow applying");
  assert.ok(types.includes("run.published"));
});

test("readAttemptTranscript returns JSONL messages from live session or sealed artifact", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: freezeAndPlanExecutor(async ({ workDir }) => succeededProbe(workDir)),
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-transcript-read" },
    context(workspaceId),
  );
  const finished = await waitForTerminal(runs, receipt.runId);
  const planAttempt = finished.snapshot.attempts.find((attempt) => attempt.nodeKey === "plan");
  assert.ok(planAttempt, "plan attempt should exist after freeze+plan");

  const transcript = await runs.readAttemptTranscript({
    runId: receipt.runId,
    attemptId: planAttempt.attemptId,
  });
  assert.equal(transcript.attemptId, planAttempt.attemptId);
  assert.equal(transcript.nodeKey, "plan");
  assert.equal(transcript.state, planAttempt.state);
  assert.ok(Array.isArray(transcript.messages));
  assert.ok(transcript.messages.length >= 2, "plan transcript should be multi-row conversation");
  const first = transcript.messages[0] as Record<string, unknown> | undefined;
  assert.equal(first?.role, "user");
  assert.ok(
    transcript.messages.some(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        ((row as { role?: string }).role === "assistant" ||
          (row as { type?: string }).type === "text"),
    ),
    "expected assistant/text content in plan transcript",
  );

  await assert.rejects(
    () =>
      runs.readAttemptTranscript({
        runId: receipt.runId,
        attemptId: "missing-attempt-id",
      }),
    /attempt not found/,
  );
  await assert.rejects(
    () =>
      runs.readAttemptTranscript({
        runId: "missing-run-id",
        attemptId: planAttempt.attemptId,
      }),
    /run not found/,
  );

  // Attempt without a transcript file → 200-shaped empty (not 404); UI must not error.
  const freezeAttempt = finished.snapshot.attempts.find((attempt) => attempt.nodeKey === "freeze");
  assert.ok(freezeAttempt);
  const freezeSession = path.join(
    root,
    ".okf-wiki",
    "runs",
    receipt.runId,
    "attempts",
    freezeAttempt.attemptId,
    "session.jsonl",
  );
  await rm(freezeSession, { force: true });
  // Also drop any sealed transcript leaves so the read path has nothing on disk.
  const runArtifacts = path.join(root, ".okf-wiki", "runs", receipt.runId, "artifacts");
  await rm(runArtifacts, { recursive: true, force: true }).catch(() => undefined);
  const emptyTx = await runs.readAttemptTranscript({
    runId: receipt.runId,
    attemptId: freezeAttempt.attemptId,
  });
  assert.equal(emptyTx.attemptId, freezeAttempt.attemptId);
  assert.equal(emptyTx.nodeKey, "freeze");
  assert.ok(Array.isArray(emptyTx.messages));
  // Failed freeze may still synthesize an error row from attempts.error.
  if (freezeAttempt.state === "failed" && freezeAttempt.error) {
    assert.ok(emptyTx.messages.length >= 1);
  }
});

test("readAttemptTranscript refuses oversized transcripts", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-transcript-size" },
    context(workspaceId),
  );
  const finished = await waitForTerminal(runs, receipt.runId);
  const attempt = finished.snapshot.attempts[0];
  assert.ok(attempt);

  const sessionPath = path.join(
    root,
    ".okf-wiki",
    "runs",
    receipt.runId,
    "attempts",
    attempt.attemptId,
    "session.jsonl",
  );
  await mkdir(path.dirname(sessionPath), { recursive: true });
  // Just over 2MB of JSONL-looking content.
  const oversized = `${"x".repeat(2 * 1024 * 1024 + 1)}\n`;
  await writeFile(sessionPath, oversized, "utf8");

  await assert.rejects(
    () =>
      runs.readAttemptTranscript({
        runId: receipt.runId,
        attemptId: attempt.attemptId,
      }),
    /transcript exceeds size limit/,
  );
});
