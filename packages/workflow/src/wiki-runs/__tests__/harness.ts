import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { defaultWikiRunSpec, type PiAttemptInput, type PiAttemptOutcome } from "@okf-wiki/contract";
import { createWorkspace, saveWorkspace } from "@okf-wiki/core";
import { openWikiRuns } from "../../wiki-runs.js";


/** Minimal successful outcome for freeze-path executor probes. */
export function succeededProbe(workDir: string): PiAttemptOutcome {
  return {
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "manifest", role: "attempt_output", sourcePath: workDir, directory: true },
    ],
  };
}

/** Plan success with a sealed-ready Spec so freeze-only executors do not fail the run. */
export async function succeededPlan(
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
export function freezeAndPlanExecutor(
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
export async function fullGraphFixtureExecutor(
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

export async function waitForRunState(
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

export async function makeWorkspace(): Promise<{ root: string; workspaceId: string }> {
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


export async function removeWorkspace(root: string): Promise<void> {
  spawnSync("chmod", ["-R", "u+w", root], { stdio: "ignore" });
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

export function context(workspaceId: string) {
  return { workspaceId, actor: { id: "operator", kind: "local_operator" as const } };
}

export function blockingFreeze(root: string, started: () => void) {
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

export async function waitForChildMessage(
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

export async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

export async function stopChild(child: ChildProcess): Promise<void> {
  const exited = waitForChildExit(child);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}

export function startChildOwner(root: string, workspaceId: string): ChildProcess {
  const workflowModuleUrl = pathToFileURL(
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "index.js"),
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
export async function waitForTerminal(runs: Awaited<ReturnType<typeof openWikiRuns>>, runId: string) {
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

export function assertFreezeAdvancedToPlan(
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

export const PLAN_PAYLOAD_DIGEST = "b".repeat(64);

/** Seed a durable open plan gate without running the full Pi graph (T3). */
export function seedOpenPlanGate(root: string, runId: string, options?: { gateId?: string }): string {
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
export async function seedPlanSpecArtifact(root: string, runId: string): Promise<void> {
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

/** Approve the plan gate once Spec is sealed (helper for T4 retry/rerun tests). */
export async function approvePlanGate(
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

export async function reachPublicationGate(
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
