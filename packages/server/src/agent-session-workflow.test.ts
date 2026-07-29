import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WikiProduceToolDetails } from "@okf-wiki/contract";
import { addSource, createWorkspace, saveWorkspace } from "@okf-wiki/core";
import { subscribeAgentSessionEvents } from "./agent-session-events.ts";
import {
  dispatchAgentCommand,
  registerAgentSession,
  resetAgentSessionRegistryForTests,
} from "./agent-session-registry.ts";
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
