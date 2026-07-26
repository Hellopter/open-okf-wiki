import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { redactErrorMessage } from "@okf-wiki/agent";
import {
  readDurableOperatorBranchMessagesForTests,
  readRawOperatorBranchMessagesForTests,
} from "@okf-wiki/agent/testing";
import type { WikiProduceToolDetails } from "@okf-wiki/contract";
import { addSource, createWorkspace, listRuns, saveWorkspace } from "@okf-wiki/core";
import { subscribeAgentSessionEvents } from "./agent-session-events.ts";
import {
  ageLiveSessionForTests,
  deleteAgentSession,
  dispatchAgentCommand,
  emitProductSseForTests,
  ensureRegistered,
  evictLiveAgentSessionForTests,
  injectDurableMessagesForTests,
  listLiveAgentSessionSummaries,
  loadAgentSessionHistory,
  markLiveSessionBusyForTests,
  registerAgentSession,
  resetAgentSessionRegistryForTests,
  setLiveSessionIdleTtlForTests,
  sweepIdleLiveSessions,
} from "./agent-session-registry.ts";

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

function detailsFromEvent(event: { payload?: unknown }): WikiProduceToolDetails | undefined {
  const payload = event.payload as {
    partialResult?: { details?: WikiProduceToolDetails };
    result?: { details?: WikiProduceToolDetails };
  };
  return payload?.partialResult?.details ?? payload?.result?.details;
}

async function fixtureWorkspace(root: string) {
  const source = path.join(root, "source");
  await mkdir(source, { recursive: true });
  git(source, "init");
  git(source, "config", "user.email", "fixture@example.test");
  git(source, "config", "user.name", "Fixture");
  await writeFile(path.join(source, "README.md"), "# Fixture\n", "utf8");
  git(source, "add", "README.md");
  git(source, "commit", "-m", "fixture");

  let workspace = await createWorkspace({
    name: "Registry Fixture",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  workspace = {
    ...(await addSource(workspace, { id: "main", path: source })).config,
    planConfirm: true,
  };
  await saveWorkspace(workspace);
  return workspace;
}

const SECRET_ERROR =
  "HTTP 401 Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz " +
  "api_key=super-secret-value path=/home/cyberspace/projects/secret/key.json";

test("H1: history snapshot redacts secrets while Pi storage stays intact", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-history-redact-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await createWorkspace({
    name: "History Redact",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);

  const sessionId = "history-redact";
  await registerAgentSession({ workspace, sessionId });

  await injectDurableMessagesForTests(workspace, sessionId, [
    {
      role: "assistant",
      content: [{ type: "text", text: "failed" }],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: SECRET_ERROR,
      timestamp: Date.now(),
    },
    {
      role: "toolResult",
      toolCallId: "tool-hist-1",
      toolName: "wiki_produce",
      content: [{ type: "text", text: "published" }],
      details: {
        status: "published",
        runId: "run-hist",
        summary: "Published",
        pages: ["overview.md"],
        spec: { version: 1, summary: "Should not leave snapshot", pages: [] },
        children: [{ id: "plan", role: "plan", status: "done" }],
        defects: { version: 1, clean: true, defects: [], reviewerIds: [] },
      },
      isError: false,
      timestamp: Date.now(),
    },
  ] as never);

  const history = await loadAgentSessionHistory(workspace, sessionId);
  assert.ok(history);
  const serialized = JSON.stringify(history.messages);
  assert.equal(serialized.includes("sk-live"), false);
  assert.equal(serialized.includes("super-secret-value"), false);
  assert.equal(serialized.includes("/home/cyberspace"), false);
  assert.match(
    serialized,
    /\[redacted-key\]|Bearer \[redacted\]|api_key=\[redacted\]|\[redacted-path\]/,
  );
  assert.equal(serialized.includes("Should not leave snapshot"), false);
  assert.equal(serialized.includes('"children"'), false);
  assert.equal(serialized.includes('"graph"'), false);

  // Cold reopen reads durable JSONL — secrets remain in Pi storage (not mutated).
  // Product projection strips fat wiki details; raw branch still has them.
  evictLiveAgentSessionForTests(workspace.id, sessionId);
  const entry = await ensureRegistered(workspace, sessionId);
  const projected = JSON.stringify(readDurableOperatorBranchMessagesForTests(entry.handle));
  assert.equal(projected.includes("Should not leave snapshot"), false);
  const rawSerialized = JSON.stringify(readRawOperatorBranchMessagesForTests(entry.handle));
  assert.ok(rawSerialized.includes("Should not leave snapshot"));
  assert.equal(rawSerialized.includes("sk-live-abcdefghijklmnopqrstuvwxyz"), true);
});

test("H1: prompt failure message redacts secrets from assistant errorMessage", () => {
  // Pure product redaction path (no monkey-patch of Pi AgentSession.prompt).
  const secret = "provider exploded Bearer sk-proj-ABCDEFGHIJKLMNOP path=/home/runner/work/okf/key";
  const message = `prompt failed: ${redactErrorMessage(new Error(secret))}`;
  assert.equal(message.includes("sk-proj"), false);
  assert.equal(message.includes("/home/runner"), false);
  assert.match(message, /\[redacted-key\]|Bearer \[redacted\]|\[redacted-path\]/);
});

test("H1: live Pi subscribe emits redacted SSE payloads", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-sse-redact-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await createWorkspace({
    name: "SSE Redact",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const sessionId = "sse-redact";
  await registerAgentSession({ workspace, sessionId });

  const seen: unknown[] = [];
  const unsub = subscribeAgentSessionEvents(workspace.id, sessionId, (event) => {
    seen.push(event.payload);
  });
  t.after(unsub);

  const secretEvent = {
    type: "auto_retry_start",
    errorMessage: SECRET_ERROR,
  };

  // Product SSE bus + pure projector — never poke Pi `_eventListeners`.
  emitProductSseForTests(workspace.id, sessionId, secretEvent);

  assert.ok(seen.length > 0, "registry should have fanned out a Pi SSE event");
  const blob = JSON.stringify(seen);
  assert.equal(blob.includes("sk-live"), false);
  assert.equal(blob.includes("super-secret-value"), false);
  assert.equal(blob.includes("/home/cyberspace"), false);
  assert.match(blob, /\[redacted-key\]|Bearer \[redacted\]|api_key=\[redacted\]|\[redacted-path\]/);
});

test("H2: concurrent ensureRegistered opens a single live SessionManager", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-open-race-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await createWorkspace({
    name: "Open Race",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const sessionId = "open-race";

  // Persist a real SessionManager JSONL (Pi only flushes after an assistant
  // message), then drop the live handle so the next ensureRegistered is cold.
  await registerAgentSession({ workspace, sessionId });
  await injectDurableMessagesForTests(workspace, sessionId, [
    {
      role: "user",
      content: [{ type: "text", text: "persist me" }],
      timestamp: Date.now(),
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ] as never);
  evictLiveAgentSessionForTests(workspace.id, sessionId);
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 0);

  const [a, b, c] = await Promise.all([
    ensureRegistered(workspace, sessionId),
    ensureRegistered(workspace, sessionId),
    ensureRegistered(workspace, sessionId),
  ]);

  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 1);
  assert.equal(listLiveAgentSessionSummaries(workspace.id)[0]?.id, sessionId);
});

test("H2: delete wins over concurrent cold ensureRegistered (no reanimation)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-delete-open-race-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await createWorkspace({
    name: "Delete Open Race",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const sessionId = "delete-open-race";
  const sessionsDir = path.join(workspace.rootPath, ".okf-wiki", "pi-sessions");

  // Persist a real SessionManager JSONL, then drop the live handle so the next
  // ensureRegistered is a cold open that can race with delete.
  await registerAgentSession({ workspace, sessionId });
  await injectDurableMessagesForTests(workspace, sessionId, [
    {
      role: "user",
      content: [{ type: "text", text: "persist me" }],
      timestamp: Date.now(),
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ] as never);
  evictLiveAgentSessionForTests(workspace.id, sessionId);
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 0);
  const beforeFiles = await readdir(sessionsDir);
  assert.ok(
    beforeFiles.some((name) => name.includes(sessionId)),
    `expected persisted JSONL for ${sessionId}, got ${beforeFiles.join(", ")}`,
  );

  // Start cold open first so it is in-flight when delete begins, then race a
  // second waiter + delete. Delete must serialize against the open single-flight.
  const openA = ensureRegistered(workspace, sessionId).then(
    (entry) => ({ ok: true as const, entry }),
    (error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  const openB = ensureRegistered(workspace, sessionId).then(
    (entry) => ({ ok: true as const, entry }),
    (error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  const dispatch = dispatchAgentCommand(workspace, sessionId, {
    type: "prompt",
    text: "hello after race",
  }).then(
    (response) => ({ ok: true as const, response }),
    (error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    }),
  );

  const deleted = await deleteAgentSession(workspace, sessionId);
  assert.ok(deleted.removed >= 1);

  const [a, b, cmd] = await Promise.all([openA, openB, dispatch]);
  // Waiters may succeed briefly (then be disposed) or reject with delete/not-found;
  // either way they must not leave a live reanimation after delete resolves.
  for (const result of [a, b]) {
    if (!result.ok) {
      assert.match(
        result.message,
        /deleted|not found|being deleted/i,
        `unexpected open failure: ${result.message}`,
      );
    }
  }
  void cmd; // may reject or return failed — disk/live assertions below are the contract

  // After delete resolves: no live entry, JSONL gone.
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 0);
  const afterFiles = await readdir(sessionsDir).catch(() => [] as string[]);
  assert.equal(
    afterFiles.some((name) => name.includes(sessionId)),
    false,
    `session JSONL must be gone after delete; found ${afterFiles.join(", ")}`,
  );

  // Post-delete open must fail (session is gone; product does not resurrect).
  await assert.rejects(
    () => ensureRegistered(workspace, sessionId),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /not found|deleted/i);
      return true;
    },
  );
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 0);
  const finalFiles = await readdir(sessionsDir).catch(() => [] as string[]);
  assert.equal(
    finalFiles.some((name) => name.includes(sessionId)),
    false,
    `post-delete open must not recreate JSONL; found ${finalFiles.join(", ")}`,
  );
});

test("H2: concurrent delete is single-flight; create blocked mid-cascade", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-delete-flight-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await createWorkspace({
    name: "Delete Flight",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const sessionId = "delete-flight";

  await registerAgentSession({ workspace, sessionId });
  await ensureRegistered(workspace, sessionId);

  // Hold waitForSessionQuiet via registry busy (product flag — not Pi private).
  markLiveSessionBusyForTests(workspace.id, sessionId, true);

  const deleteA = deleteAgentSession(workspace, sessionId);
  // Yield so delete marks the barrier and enters waitForSessionQuiet.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const deleteB = deleteAgentSession(workspace, sessionId);

  // Create with the same id must fail cleanly while delete is in flight.
  await assert.rejects(
    () => registerAgentSession({ workspace, sessionId }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /being deleted/i);
      return true;
    },
  );
  // Cold open must also refuse while the cascade holds the barrier.
  await assert.rejects(
    () => ensureRegistered(workspace, sessionId),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /being deleted/i);
      return true;
    },
  );

  // Release settle so both delete waiters can finish the shared flight.
  markLiveSessionBusyForTests(workspace.id, sessionId, false);

  const [a, b] = await Promise.all([deleteA, deleteB]);
  assert.equal(a.sessionId, sessionId);
  assert.equal(b.sessionId, sessionId);
  assert.equal(a.removed, b.removed);
  assert.ok(a.removed >= 1);
  // Shared flight: no live entry left, no mid-cascade reopen window.
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 0);

  // After delete completes, create may reuse the id as a brand-new session.
  const recreated = await registerAgentSession({ workspace, sessionId });
  assert.equal(recreated.id, sessionId);
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 1);
});

test("H3: delete mid-gate aborts, settles, and cascades run data", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-delete-gate-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await fixtureWorkspace(root);
  const sessionId = "delete-mid-gate";
  await registerAgentSession({ workspace, sessionId });

  const events: Array<{ kind: string; payload?: unknown }> = [];
  const waiters = new Map<string, () => void>();
  const unsubscribe = subscribeAgentSessionEvents(workspace.id, sessionId, (event) => {
    events.push(event);
    const status = detailsFromEvent(event)?.status;
    if (status) waiters.get(status)?.();
  });
  t.after(unsubscribe);

  const waitForStatus = (status: string) =>
    new Promise<void>((resolve, reject) => {
      if (events.some((event) => detailsFromEvent(event)?.status === status)) {
        resolve();
        return;
      }
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `missing ${status}; saw ${events
                .map((event) => detailsFromEvent(event)?.status ?? event.kind)
                .join(", ")}`,
            ),
          ),
        10_000,
      );
      waiters.set(status, () => {
        clearTimeout(timer);
        waiters.delete(status);
        resolve();
      });
    });

  const prompt = dispatchAgentCommand(workspace, sessionId, {
    type: "prompt",
    text: "Produce the wiki",
  });
  await waitForStatus("awaiting_plan");
  const plan = detailsFromEvent(
    events.find((event) => detailsFromEvent(event)?.status === "awaiting_plan")!,
  )!;
  assert.ok(plan.runId);
  const runId = plan.runId;
  const runDir = path.join(workspace.rootPath, ".okf-wiki", "runs", runId);
  await access(runDir);

  const deleted = await deleteAgentSession(workspace, sessionId);
  assert.ok(deleted.removed >= 1);

  // Prompt should settle without throw storms.
  const promptResult = await prompt;
  assert.equal(typeof promptResult.ok, "boolean");

  // Live cache cleared.
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 0);

  // Run artifacts and session gone.
  await assert.rejects(access(runDir));
  await assert.rejects(access(path.join(workspace.rootPath, ".okf-wiki", "runs", `${runId}.json`)));
  const remaining = await listRuns(workspace.rootPath);
  assert.equal(remaining.filter((run) => run.sessionId === sessionId).length, 0);

  // Brief settle: no new run dirs reappear for this session.
  await new Promise((r) => setTimeout(r, 200));
  const remainingAfter = await listRuns(workspace.rootPath);
  assert.equal(remainingAfter.filter((run) => run.sessionId === sessionId).length, 0);
});

test("idle sweep disposes live handle without deleting Session JSONL", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-idle-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await createWorkspace({
    name: "Idle Sweep",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const sessionId = "idle-sweep";

  await registerAgentSession({ workspace, sessionId });
  // Persist so cold reopen can find the SessionManager file.
  await injectDurableMessagesForTests(workspace, sessionId, [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ] as never);

  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 1);

  setLiveSessionIdleTtlForTests(1);
  // Age the entry past TTL without waiting wall clock.
  ageLiveSessionForTests(workspace.id, sessionId, Date.now() - 10_000);
  const removed = sweepIdleLiveSessions();
  assert.equal(removed, 1);
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 0);

  // Restore default TTL before reopen: listLiveAgentSessionSummaries /
  // ensureRegistered both call sweepIdleLiveSessions(), and a 1ms TTL would
  // immediately re-evict a just-registered live handle.
  setLiveSessionIdleTtlForTests(null);

  // Disk JSONL still there; cold ensureRegistered reopens.
  const reopened = await ensureRegistered(workspace, sessionId);
  assert.ok(reopened.handle.sessionId === sessionId);
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 1);
});
