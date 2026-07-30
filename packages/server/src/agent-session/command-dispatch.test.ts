/**
 * Slash-command interception in Operator Session prompt dispatch.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspace, saveWorkspace } from "@okf-wiki/core";
import { dispatchAgentCommand, ensureRegistered, registerAgentSession } from "./index.ts";
import { resetAgentSessionRegistryForTests } from "./test-seams.ts";

test("prompt dispatch expands slash commands and rejects unknown ones", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-cmd-dispatch-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await rm(root, { recursive: true, force: true });
  });

  const workspace = await createWorkspace({
    name: "Command Dispatch",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const sessionId = "cmd-dispatch";
  await registerAgentSession({ workspace, sessionId });

  // Unknown command fails fast without reaching the model.
  const unknown = await dispatchAgentCommand(workspace, sessionId, {
    type: "prompt",
    text: "/deploy prod",
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.message ?? "", /unknown command: \/deploy/);

  // Known command expands and is admitted immediately (detached turn).
  // The failed unknown command must not leave an admission lock.
  const status = await dispatchAgentCommand(workspace, sessionId, {
    type: "prompt",
    text: "/status",
  });
  assert.equal(status.ok, true, status.message);
  assert.ok(status.acceptedTurnId, "prompt admission returns acceptedTurnId");

  // Wait for the detached fixture turn to settle before the next prompt.
  const entry = await ensureRegistered(workspace, sessionId);
  const deadline = Date.now() + 5_000;
  while (entry.isBusy() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }

  // Path-like input is not treated as a command.
  const pathLike = await dispatchAgentCommand(workspace, sessionId, {
    type: "prompt",
    text: "/home/user/repo 里有什么?",
  });
  assert.equal(pathLike.ok, true, pathLike.message);
  assert.ok(pathLike.acceptedTurnId);

  const deadline2 = Date.now() + 5_000;
  while (entry.isBusy() && Date.now() < deadline2) {
    await new Promise((r) => setTimeout(r, 20));
  }

  // set_model resolves through provider Settings; without a configured
  // provider it must fail gracefully, never crash the session.
  const setModel = await dispatchAgentCommand(workspace, sessionId, {
    type: "set_model",
    profileId: "no-such-profile",
  });
  assert.equal(setModel.command, "set_model");
  assert.equal(setModel.ok, false);
  assert.ok(setModel.message);
});
