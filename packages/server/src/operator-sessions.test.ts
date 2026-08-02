import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type createOperatorSession } from "@okf-wiki/agent";
import {
  type AgentSseStream,
  createPiStreamState,
  WorkspaceConfigSchema,
} from "@okf-wiki/contract";
import { resetOperatorSessionsForTests } from "./operator-session-test-seams.ts";
import {
  createLiveSession,
  dispatchSessionCommand,
  projectOperatorStreamState,
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

test("Operator Session browser projection excludes Pi thinking and raw tool payloads", () => {
  const projected = projectOperatorStreamState(
    createPiStreamState([
      {
        id: "assistant-private",
        role: "assistant",
        content: "Public answer",
        thinking: "private chain of thought",
        thinkingStatus: "done",
        createdAt: "2026-08-02T00:00:00.000Z",
        status: "done",
        parts: [
          { type: "thinking", thinking: "private chain of thought" },
          { type: "text", text: "Public answer" },
          { type: "tool", toolId: "tool-private" },
        ],
        tools: [
          {
            id: "tool-private",
            name: "wiki_repair",
            args: { runId: "run-safe", path: "/private/path" },
            output: "private file content",
            status: "done",
          },
        ],
      },
    ]),
  );

  const wire = JSON.stringify(projected);
  assert.equal(wire.includes("private chain of thought"), false);
  assert.equal(wire.includes("private file content"), false);
  assert.equal(wire.includes("/private/path"), false);
  assert.equal(projected.messages[0]?.content, "Public answer");
  assert.deepEqual(projected.messages[0]?.tools, [
    {
      id: "tool-private",
      name: "wiki_repair",
      args: { runId: "run-safe" },
      status: "done",
    },
  ]);
});

test("rejected detached prompt emits a redacted error patch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-operator-session-error-"));
  const skillPath = path.join(root, "skill");
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), "# fixture skill\n", "utf8");
  t.after(async () => {
    resetOperatorSessionsForTests();
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
    resetOperatorSessionsForTests();
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
  assert.equal(snapshot.payload.messages.length, 2);
});
