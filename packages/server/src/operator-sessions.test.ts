import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type createOperatorSession } from "@okf-wiki/agent";
import { type AgentSseStream, diffSessionStreamState } from "@okf-wiki/contract/session";
import { createPiStreamState } from "@okf-wiki/contract/stream-server";
import { WorkspaceConfigSchema } from "@okf-wiki/contract/workspace";
import { resetOperatorSessionsForTests } from "./operator-session-test-seams.ts";
import {
  createLiveSession,
  dispatchSessionCommand,
  invalidateOperatorSessions,
  OperatorSessionWorkspaceDeletedError,
  projectOperatorStreamState,
  retireOperatorSessionsForDeletedWorkspace,
  sessionSnapshot,
  subscribeSession,
} from "./operator-sessions.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture session events");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function fixtureWorkspace(root: string, skillPath: string) {
  return WorkspaceConfigSchema.parse({
    version: 3,
    id: "session-stream-workspace",
    name: "Session stream workspace",
    rootPath: root,
    sources: [],
    skillPath,
    model: { id: "openai/test" },
    publicationPath: path.join(root, "published"),
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
    limits: { requestTimeoutSeconds: 60 },
    planConfirm: true,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });
}

test("Operator Session browser projection excludes Pi thinking and raw tool bodies", () => {
  const projected = projectOperatorStreamState(
    createPiStreamState([
      {
        id: "assistant-private",
        role: "assistant",
        content: "Public answer with sk-super-secret at /workspace/private.md",
        thinking: "chain of thought with sk-super-secret",
        thinkingStatus: "done",
        createdAt: "2026-08-02T00:00:00.000Z",
        status: "done",
        parts: [
          { type: "thinking", thinking: "chain of thought with sk-super-secret" },
          { type: "text", text: "Public answer with sk-super-secret" },
          { type: "tool", toolId: "tool-private" },
        ],
        tools: [
          {
            id: "tool-private",
            name: "wiki_repair",
            args: { runId: "run-safe", path: "/private/path", token: "sk-super-secret" },
            output: "tool result containing sk-super-secret and useful detail",
            status: "done",
          },
        ],
      },
    ]),
  );

  const message = projected.messages[0];
  assert.ok(message);
  assert.equal("thinking" in message, false);
  assert.equal("thinkingStatus" in message, false);
  assert.equal(message.content, "Public answer with [redacted-key] at [redacted-path]");
  assert.equal("parts" in message, false);

  const tool = message.tools?.[0];
  assert.ok(tool);
  assert.equal(tool.id, "tool-private");
  assert.equal(tool.name, "wiki_repair");
  assert.equal(tool.status, "done");
  assert.equal("args" in tool, false);
  assert.equal("output" in tool, false);
  assert.equal("receipt" in tool, false);

  const wire = JSON.stringify(projected);
  assert.equal(wire.includes("sk-super-secret"), false);
  assert.equal(wire.includes("/workspace/private.md"), false);
});

test("Operator Session browser projection bounds wiki_produce receipt summaries", () => {
  const huge = `prefix ${"x".repeat(20_000)} suffix`;
  const projected = projectOperatorStreamState(
    createPiStreamState([
      {
        id: "assistant-huge-tool",
        role: "assistant",
        content: "done",
        createdAt: "2026-08-02T00:00:00.000Z",
        status: "done",
        tools: [
          {
            id: "tool-huge",
            name: "wiki_produce",
            details: { status: "accepted", summary: huge },
            status: "done",
          },
        ],
      },
    ]),
  );

  const summary = projected.messages[0]?.tools?.[0]?.receipt?.summary;
  assert.ok(summary);
  assert.ok(summary.length <= 4_000);
  assert.ok(summary.startsWith("prefix "));
  assert.equal(summary.includes("suffix"), false);
});

test("rejected detached prompt emits a redacted error patch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-operator-session-error-"));
  const skillPath = path.join(root, "skill");
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), "# fixture skill\n", "utf8");
  t.after(async () => {
    await resetOperatorSessionsForTests();
    await rm(root, { recursive: true, force: true });
  });

  const rejectedHandle = {
    sessionId: "rejected-prompt",
    session: {
      setSessionName() {},
      sessionManager: { getSessionName: () => "Failure fixture" },
      subscribe() {
        return () => undefined;
      },
      async prompt() {
        throw new Error("provider rejected sk-super-secret");
      },
    },
    dispose() {},
  } as unknown as Awaited<ReturnType<typeof createOperatorSession>>;
  const workspace = fixtureWorkspace(root, skillPath);
  const session = await createLiveSession(
    workspace,
    undefined,
    rejectedHandle.sessionId,
    async () => ({ handle: rejectedHandle }),
  );
  const streams: AgentSseStream[] = [];
  const unsubscribe = await subscribeSession(workspace, session.id, (event) => {
    if (event.kind === "stream") streams.push(event);
  });
  t.after(unsubscribe);

  const response = await dispatchSessionCommand(workspace, session.id, {
    type: "prompt",
    text: "Trigger rejected promise",
  });
  assert.equal(response.ok, true);
  await waitFor(() => streams.some((event) => event.payload.errorText !== null));
  const error = streams.find((event) => event.payload.errorText !== null)?.payload.errorText;
  assert.ok(error);
  assert.equal(error.includes("sk-super-secret"), false);
});

test("workspace invalidation aborts the active turn, closes subscribers, and drops only the live handle", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-operator-session-invalidate-"));
  const skillPath = path.join(root, "skill");
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), "# fixture skill\n", "utf8");
  t.after(async () => {
    await resetOperatorSessionsForTests();
    await rm(root, { recursive: true, force: true });
  });

  let aborts = 0;
  let disposed = 0;
  const activeHandle = {
    sessionId: "invalidated-session",
    session: {
      setSessionName() {},
      sessionManager: { getSessionName: () => "Invalidation fixture" },
      subscribe() {
        return () => undefined;
      },
      async prompt() {
        await new Promise<void>(() => undefined);
      },
      async abort() {
        aborts += 1;
      },
    },
    dispose() {
      disposed += 1;
    },
  } as unknown as Awaited<ReturnType<typeof createOperatorSession>>;
  const workspace = fixtureWorkspace(root, skillPath);
  const session = await createLiveSession(
    workspace,
    undefined,
    activeHandle.sessionId,
    async () => ({ handle: activeHandle }),
  );
  const response = await dispatchSessionCommand(workspace, session.id, {
    type: "prompt",
    text: "Keep this turn active",
  });
  assert.equal(response.ok, true);

  let subscriberClosed = 0;
  await subscribeSession(
    workspace,
    session.id,
    () => undefined,
    () => {
      subscriberClosed += 1;
    },
  );
  assert.equal(await invalidateOperatorSessions(workspace.id, "settings changed"), 1);
  assert.equal(aborts, 1);
  assert.equal(disposed, 1);
  assert.equal(subscriberClosed, 1);
});

test("workspace deletion fence disposes a racing Session handle before it can attach", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-operator-session-retire-"));
  const skillPath = path.join(root, "skill");
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), "# fixture skill\n", "utf8");
  t.after(async () => {
    await resetOperatorSessionsForTests();
    await rm(root, { recursive: true, force: true });
  });

  let releaseBuild!: () => void;
  const buildReleased = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  let buildStarted!: () => void;
  const buildStartedPromise = new Promise<void>((resolve) => {
    buildStarted = resolve;
  });
  let disposed = 0;
  const handle = {
    sessionId: "racing-session",
    session: {
      setSessionName() {},
      sessionManager: { getSessionName: () => "Racing fixture" },
      subscribe() {
        return () => undefined;
      },
    },
    dispose() {
      disposed += 1;
    },
  } as unknown as Awaited<ReturnType<typeof createOperatorSession>>;
  const workspace = fixtureWorkspace(root, skillPath);
  const creating = createLiveSession(workspace, undefined, handle.sessionId, async () => {
    buildStarted();
    await buildReleased;
    return { handle };
  });
  await buildStartedPromise;

  assert.equal(await retireOperatorSessionsForDeletedWorkspace(workspace.id), 0);
  releaseBuild();
  await assert.rejects(
    () => creating,
    (error: unknown) => error instanceof OperatorSessionWorkspaceDeletedError,
  );
  assert.equal(disposed, 1);
  await assert.rejects(
    () => createLiveSession(workspace, undefined, "later-session", async () => ({ handle })),
    OperatorSessionWorkspaceDeletedError,
  );
});

test("control slash /compact maps to compact AgentCommand, not a prompt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-operator-session-compact-"));
  const skillPath = path.join(root, "skill");
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), "# fixture skill\n", "utf8");
  t.after(async () => {
    await resetOperatorSessionsForTests();
    await rm(root, { recursive: true, force: true });
  });

  let compactCalls = 0;
  let promptCalls = 0;
  let abortCompactionCalls = 0;
  let abortTurnCalls = 0;
  const compactHandle = {
    sessionId: "compact-slash",
    session: {
      setSessionName() {},
      sessionManager: { getSessionName: () => "Compact fixture" },
      subscribe() {
        return () => undefined;
      },
      async prompt() {
        promptCalls += 1;
      },
      async compact() {
        compactCalls += 1;
      },
      abortCompaction() {
        abortCompactionCalls += 1;
      },
      async abort() {
        abortTurnCalls += 1;
      },
    },
    dispose() {},
  } as unknown as Awaited<ReturnType<typeof createOperatorSession>>;
  const workspace = fixtureWorkspace(root, skillPath);
  const session = await createLiveSession(
    workspace,
    undefined,
    compactHandle.sessionId,
    async () => ({
      handle: compactHandle,
      model: { profileId: "default", modelId: "openai/test", name: "Test" },
      contextBudget: {
        contextWindow: 64_000,
        contextTarget: 54_400,
        reserveTokens: 9_600,
      },
    }),
  );

  const compact = await dispatchSessionCommand(workspace, session.id, {
    type: "prompt",
    text: "/compact",
  });
  assert.equal(compact.ok, true);
  assert.equal(compact.command, "compact");
  assert.equal(compactCalls, 1);
  assert.equal(promptCalls, 0);
  assert.equal(abortTurnCalls, 0);

  // /compact stop aborts the turn first (stop_and_compact), still not a prompt.
  const stopCompact = await dispatchSessionCommand(workspace, session.id, {
    type: "prompt",
    text: "/compact stop",
  });
  assert.equal(stopCompact.ok, true);
  assert.equal(stopCompact.command, "compact");
  assert.equal(abortTurnCalls, 1);
  assert.equal(compactCalls, 2);
  assert.equal(promptCalls, 0);

  const abort = await dispatchSessionCommand(workspace, session.id, {
    type: "prompt",
    text: "/abort-compact",
  });
  assert.equal(abort.ok, true);
  assert.equal(abort.command, "abort_compaction");
  assert.equal(abortCompactionCalls, 1);
  assert.equal(promptCalls, 0);

  // /wiki still expands to a prompt (template path unchanged).
  const wiki = await dispatchSessionCommand(workspace, session.id, {
    type: "prompt",
    text: "/wiki notes",
  });
  assert.equal(wiki.ok, true);
  assert.equal(wiki.command, "prompt");
  assert.equal(promptCalls, 1);
});

test("session snapshot includes live model, contextBudget, and usage denominators", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-operator-session-chrome-"));
  const skillPath = path.join(root, "skill");
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), "# fixture skill\n", "utf8");
  t.after(async () => {
    await resetOperatorSessionsForTests();
    await rm(root, { recursive: true, force: true });
  });

  const chromeHandle = {
    sessionId: "chrome-snapshot",
    session: {
      setSessionName() {},
      sessionManager: { getSessionName: () => "Chrome fixture" },
      subscribe() {
        return () => undefined;
      },
    },
    dispose() {},
  } as unknown as Awaited<ReturnType<typeof createOperatorSession>>;
  const workspace = fixtureWorkspace(root, skillPath);
  const session = await createLiveSession(
    workspace,
    undefined,
    chromeHandle.sessionId,
    async () => ({
      handle: chromeHandle,
      model: { profileId: "default", modelId: "gpt-test", name: "Test model" },
      contextBudget: {
        contextWindow: 128_000,
        contextTarget: 108_800,
        reserveTokens: 19_200,
      },
    }),
  );

  const snapshot = await sessionSnapshot(workspace, session.id);
  assert.deepEqual(snapshot.payload.session.model, {
    profileId: "default",
    modelId: "gpt-test",
    name: "Test model",
  });
  assert.deepEqual(snapshot.payload.session.contextBudget, {
    contextWindow: 128_000,
    contextTarget: 108_800,
    reserveTokens: 19_200,
  });
  // Chrome is also on state so clients reduce from snapshot without reading session.
  assert.deepEqual(snapshot.payload.state.model, snapshot.payload.session.model);
  assert.deepEqual(snapshot.payload.state.contextBudget, snapshot.payload.session.contextBudget);
  assert.equal(snapshot.payload.state.sessionUsage?.contextWindow, 128_000);
  assert.equal(snapshot.payload.state.sessionUsage?.contextTarget, 108_800);
});

test("stream chrome projection emits model + contextBudget on set_model-style diffs", () => {
  // Tokens at target on a small seat, then re-derived to normal after a larger window.
  const priorState = { ...createPiStreamState(), contextPhase: "at_target" as const };
  const prior = projectOperatorStreamState(
    priorState,
    { contextTokens: 54_400, contextWindow: 64_000, contextTarget: 54_400 },
    {
      model: { profileId: "default", modelId: "gpt-a" },
      contextBudget: { contextWindow: 64_000, contextTarget: 54_400, reserveTokens: 9_600 },
    },
  );
  const nextState = { ...createPiStreamState(), contextPhase: "normal" as const };
  const next = projectOperatorStreamState(
    nextState,
    { contextTokens: 54_400, contextWindow: 200_000, contextTarget: 170_000 },
    {
      model: { profileId: "fast", modelId: "gpt-b", name: "Fast" },
      contextBudget: { contextWindow: 200_000, contextTarget: 170_000, reserveTokens: 30_000 },
    },
  );
  const patch = diffSessionStreamState(prior, next);
  assert.deepEqual(patch.model, {
    profileId: "fast",
    modelId: "gpt-b",
    name: "Fast",
  });
  assert.equal(patch.contextBudget?.contextWindow, 200_000);
  assert.equal(patch.sessionUsage?.contextWindow, 200_000);
  // set_model re-derives contextPhase so clients do not keep a stale fill phase.
  assert.equal(patch.contextPhase, "normal");
});

test("Operator Session SSE emits stream patches without replaying prior history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-operator-session-stream-"));
  const skillPath = path.join(root, "skill");
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), "# fixture skill\n", "utf8");
  const originalFixtureMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    if (originalFixtureMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = originalFixtureMode;
    await resetOperatorSessionsForTests();
    await rm(root, { recursive: true, force: true });
  });

  const workspace = fixtureWorkspace(root, skillPath);
  const session = await createLiveSession(workspace);
  const streams: AgentSseStream[] = [];
  const unsubscribe = await subscribeSession(workspace, session.id, (event) => {
    if (event.kind === "stream") streams.push(event);
  });
  t.after(unsubscribe);

  const first = await dispatchSessionCommand(workspace, session.id, {
    type: "prompt",
    text: "First historical turn",
  });
  assert.equal(first.ok, true);
  await waitFor(() => streams.some((event) => event.payload.appended.length === 1));

  const firstMessageId = streams.flatMap((event) => event.payload.appended).at(-1)?.id;
  assert.ok(firstMessageId);

  const second = await dispatchSessionCommand(workspace, session.id, {
    type: "prompt",
    text: "Second live turn",
  });
  assert.equal(second.ok, true);
  await waitFor(
    () =>
      new Set(streams.flatMap((event) => event.payload.appended).map((message) => message.id))
        .size >= 2,
  );

  const appendedIds = streams
    .flatMap((event) => event.payload.appended)
    .map((message) => message.id);
  assert.equal(appendedIds.filter((id) => id === firstMessageId).length, 1);
  assert.equal(new Set(appendedIds).size, appendedIds.length);
  assert.ok(streams.every((event) => "messages" in event.payload === false));

  const snapshot = await sessionSnapshot(workspace, session.id);
  assert.equal(
    snapshot.payload.state.messages.filter((message) => message.role === "assistant").length,
    2,
  );
});
