/**
 * SessionRuntime: admission-before-202, agent_settled terminal, cancel scopes.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspace, saveWorkspace } from "@okf-wiki/core";
import { reducePiEvent, createPiStreamState } from "@okf-wiki/contract";
import {
  dispatchAgentCommand,
  registerAgentSession,
  resetAgentSessionRegistryForTests,
} from "../agent-session-registry.ts";
import { ensureRegistered } from "./live-session-registry.ts";
import { createSessionRuntime } from "./session-runtime.ts";

test("prompt returns acceptedTurnId before the turn fully settles", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-session-runtime-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await rm(root, { recursive: true, force: true });
  });

  const workspace = await createWorkspace({
    name: "Session Runtime",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const sessionId = "runtime-admit";
  await registerAgentSession({ workspace, sessionId });

  const started = Date.now();
  const response = await dispatchAgentCommand(workspace, sessionId, {
    type: "prompt",
    text: "hello runtime",
  });
  const elapsed = Date.now() - started;

  assert.equal(response.ok, true, response.message);
  assert.equal(response.status, "accepted");
  assert.equal(response.command, "prompt");
  assert.ok(response.acceptedTurnId, "admission must return acceptedTurnId");
  // Admission must not wait for a full multi-second turn. Fixture turns are
  // fast; we only assert the response shape and that we did not hang.
  assert.ok(elapsed < 5_000, `admission took too long: ${elapsed}ms`);

  // Wait briefly for detached turn to settle so the registry is clean.
  const entry = await ensureRegistered(workspace, sessionId);
  const deadline = Date.now() + 5_000;
  while ((entry.admittedTurnId || entry.streamState.turnActive) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
});

test("SessionRuntime.cancel scopes map to abort / clear_queue / abort_compaction", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-session-runtime-cancel-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await rm(root, { recursive: true, force: true });
  });

  const workspace = await createWorkspace({
    name: "Cancel Scopes",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const sessionId = "runtime-cancel";
  await registerAgentSession({ workspace, sessionId });
  const entry = await ensureRegistered(workspace, sessionId);
  const runtime = createSessionRuntime(entry, workspace);

  const abort = await runtime.cancel("turn");
  assert.equal(abort.ok, true);
  assert.equal(abort.command, "abort");

  const clear = await runtime.cancel("queued");
  assert.equal(clear.ok, true);
  assert.equal(clear.command, "clear_queue");

  const abortCompact = await runtime.cancel("compaction");
  assert.equal(abortCompact.ok, true);
  assert.equal(abortCompact.command, "abort_compaction");
});

test("reducePiEvent unit: agent_end is not idle terminal", () => {
  let state = createPiStreamState();
  state = reducePiEvent(state, "agent_start", { type: "agent_start" });
  state = reducePiEvent(state, "agent_end", { type: "agent_end" });
  assert.equal(state.agentStatus, "between_operations");
  assert.equal(state.turnActive, true);
  state = reducePiEvent(state, "agent_settled", { type: "agent_settled" });
  assert.equal(state.agentStatus, "idle");
  assert.equal(state.turnActive, false);
});
