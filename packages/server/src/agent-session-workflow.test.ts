import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WikiProduceToolDetails } from "@okf-wiki/contract";
import { addSource, createWorkspace, saveWorkspace } from "@okf-wiki/core";
import { dispatchAgentCommand, registerAgentSession } from "./agent-session/index.ts";
import { runtimeInput } from "./agent-session/runtime-input.ts";
import { resetAgentSessionRegistryForTests } from "./agent-session/test-seams.ts";
import { subscribeAgentSessionEvents } from "./agent-session-events.ts";
import { resetWikiRunsRegistryForTests, wikiRunsForWorkspace } from "./wiki-runs-registry.ts";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

async function removeRunRoot(root: string): Promise<void> {
  const makeWritable = async (entryPath: string): Promise<void> => {
    await chmod(entryPath, 0o700).catch(() => undefined);
    const entries = await readdir(entryPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = path.join(entryPath, entry.name);
      if (entry.isDirectory()) await makeWritable(child);
      else await chmod(child, 0o600).catch(() => undefined);
    }
  };
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

function detailsFromEvent(event: {
  source?: string;
  kind?: string;
  payload?: unknown;
}): WikiProduceToolDetails | undefined {
  if (event.source === "server" && event.kind === "stream" && event.payload) {
    const patch = event.payload as {
      streamingMessage?: { tools?: Array<{ details?: WikiProduceToolDetails }> } | null;
      appended?: Array<{ tools?: Array<{ details?: WikiProduceToolDetails }> }>;
      updated?: Array<{ tools?: Array<{ details?: WikiProduceToolDetails }> }>;
    };
    const messages = [patch.streamingMessage, ...(patch.appended ?? []), ...(patch.updated ?? [])];
    for (const message of messages) {
      for (const tool of message?.tools ?? []) {
        if (tool.details) return tool.details;
      }
    }
    return undefined;
  }
  return undefined;
}

test("fixture prompt dispatches wiki_produce StartRun receipt (T2 hard-cut)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-session-workflow-"));
  const source = path.join(root, "source");
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    await resetWikiRunsRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const skill = path.join(root, "skill");
  await mkdir(source, { recursive: true });
  await mkdir(skill, { recursive: true });
  git(source, "init");
  git(source, "config", "user.email", "fixture@example.test");
  git(source, "config", "user.name", "Fixture");
  await writeFile(path.join(source, "README.md"), "# Fixture\n", "utf8");
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: fixture\n---\n# skill\n", "utf8");
  git(source, "add", "README.md");
  git(source, "commit", "-m", "fixture");

  let workspace = await createWorkspace({
    name: "Fixture Workflow",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  workspace.skillPath = skill;
  await saveWorkspace(workspace);

  const sessionId = "fixture-workflow";
  await registerAgentSession({ workspace, sessionId });

  workspace = {
    ...(await addSource(workspace, { id: "main", path: source })).config,
    planConfirm: true,
  };
  await saveWorkspace(workspace);

  const events: Array<{ source?: string; kind: string; payload?: unknown }> = [];
  const unsubscribe = subscribeAgentSessionEvents(workspace.id, sessionId, (event) => {
    events.push(event);
  });
  t.after(unsubscribe);

  const prompt = await dispatchAgentCommand(workspace, sessionId, {
    type: "prompt",
    text: "Produce the wiki",
  });
  assert.equal(prompt.ok, true, prompt.message);

  // onUpdate may emit accepted before runId; wait for the receipt with runId.
  let accepted: WikiProduceToolDetails | undefined;
  for (let i = 0; i < 200; i += 1) {
    accepted = [...events]
      .map(detailsFromEvent)
      .reverse()
      .find((details) => details?.status === "accepted" && details.runId);
    if (accepted?.runId) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(accepted?.runId, "wiki_produce must return a durable runId receipt");
  assert.equal(accepted?.status, "accepted");

  // WikiRuns owns the Run after StartRun — freeze advances without Session HITL.
  const runs = await wikiRunsForWorkspace(workspace);
  let lastState = "";
  let freezeState = "";
  let sawFreeze = false;
  for (let i = 0; i < 400; i += 1) {
    const { snapshot } = await runs.read({ runId: accepted.runId! });
    lastState = snapshot.state;
    const freeze = snapshot.nodes.find((node) => node.key === "freeze");
    freezeState = freeze?.state ?? "missing";
    if (freeze?.state === "succeeded" || snapshot.state === "waiting_for_operator") {
      sawFreeze = true;
      break;
    }
    if (freeze?.state === "failed" || snapshot.state === "failed") {
      const err = snapshot.attempts.find((a) => a.nodeKey === "freeze")?.error;
      throw new Error(`freeze failed: ${err ?? snapshot.state}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(
    sawFreeze,
    `WikiRuns should advance freeze after StartRun receipt (state=${lastState} freeze=${freezeState})`,
  );
  assert.ok(events.every((event) => event.source === "server" && event.kind === "stream"));
});

test("runtime input preserves refresh intent and resolves an explicit repair node", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-runtime-input-wiki-tools-"));
  const source = path.join(root, "source");
  const skill = path.join(root, "skill");
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    await resetWikiRunsRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  await mkdir(source, { recursive: true });
  await mkdir(skill, { recursive: true });
  git(source, "init");
  git(source, "config", "user.email", "fixture@example.test");
  git(source, "config", "user.name", "Fixture");
  await writeFile(path.join(source, "README.md"), "# Fixture\n", "utf8");
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: fixture\n---\n# skill\n", "utf8");
  git(source, "add", "README.md");
  git(source, "commit", "-m", "fixture");

  let workspace = await createWorkspace({
    name: "Runtime Input Wiki Tools",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  workspace.skillPath = skill;
  workspace = {
    ...(await addSource(workspace, { id: "main", path: source })).config,
    planConfirm: true,
  };
  await saveWorkspace(workspace);

  const runtime = await runtimeInput(workspace, "runtime-input-tools");
  const { startWikiRun, resolveRepairTarget } = runtime.input.wikiProduce;
  assert.ok(resolveRepairTarget, "server runtime must compose a repair target resolver");

  const generated = await startWikiRun({
    commandId: "runtime-input-generate",
    sessionId: "runtime-input-tools",
    mode: "generate",
  });
  const runs = await wikiRunsForWorkspace(workspace);
  let planGate: Awaited<ReturnType<typeof runs.read>>["snapshot"]["gates"][number] | undefined;
  for (let i = 0; i < 240; i += 1) {
    const { snapshot } = await runs.read({ runId: generated.runId });
    planGate = snapshot.gates.find((gate) => gate.kind === "plan" && gate.state === "open");
    if (planGate) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(planGate, "fixture run should open a plan gate");
  const planRevision = (await runs.read({ runId: generated.runId })).snapshot.revision;
  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "runtime-input-approve-plan",
      runId: generated.runId,
      expectedRevision: planRevision,
      gateId: planGate.gateId,
      gateKind: "plan",
      payloadDigest: planGate.payloadDigest,
      decision: "approve",
    },
    {
      workspaceId: workspace.id,
      actor: { id: "runtime-input-tools", kind: "operator_session" },
      sessionId: "runtime-input-tools",
    },
  );

  const defaultTarget = await resolveRepairTarget({ runId: generated.runId });
  const planTarget = await resolveRepairTarget({ runId: generated.runId, nodeKey: "plan" });
  assert.deepEqual(defaultTarget?.nodeKey, "write.root");
  assert.deepEqual(planTarget, { nodeKey: "plan", generation: 0 });

  const refreshed = await startWikiRun({
    commandId: "runtime-input-refresh",
    sessionId: "runtime-input-tools",
    mode: "refresh",
    notes: "Update the public API page.",
  });
  const refreshSnapshot = (await runs.read({ runId: refreshed.runId })).snapshot;
  assert.deepEqual(refreshSnapshot.intent, {
    mode: "refresh",
    focus: "Update the public API page.",
  });
});
