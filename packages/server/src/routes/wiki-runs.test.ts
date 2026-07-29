import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspace, saveWorkspace } from "@okf-wiki/core";
import { dispatch } from "../dispatch.ts";
import { resetWikiRunsRegistryForTests } from "../wiki-runs-registry.ts";

async function nextFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
): Promise<{ event?: string; id?: number; data?: unknown }> {
  const decoder = new TextDecoder();
  for (;;) {
    const end = state.buffer.indexOf("\n\n");
    if (end >= 0) {
      const frame = state.buffer.slice(0, end);
      state.buffer = state.buffer.slice(end + 2);
      if (frame.startsWith(":")) continue;
      const fields = new Map(
        frame.split("\n").flatMap((line) => {
          const separator = line.indexOf(": ");
          return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 2)]];
        }),
      );
      return {
        event: fields.get("event"),
        ...(fields.has("id") ? { id: Number(fields.get("id")) } : {}),
        ...(fields.has("data") ? { data: JSON.parse(fields.get("data")!) } : {}),
      };
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error("SSE ended before a frame arrived");
    state.buffer += decoder.decode(chunk.value, { stream: true });
  }
}

test("WikiRuns routes derive context server-side and replay durable events", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-runs-route-"));
  const workspace = await createWorkspace({
    name: "Durable HTTP Run",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const server = createServer((req, res) => void dispatch(req, res));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    await resetWikiRunsRegistryForTests();
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/workspaces/${workspace.id}/runs`;
  const query = `?rootPath=${encodeURIComponent(root)}`;

  const started = await fetch(`${base}/command${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "start_run",
      commandId: "start-over-http",
      // An asserted actor/workspace must be rejected rather than trusted.
      workspaceId: "attacker-workspace",
    }),
  });
  assert.equal(started.status, 400);

  const accepted = await fetch(`${base}/command${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "start_run", commandId: "start-over-http" }),
  });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  const receipt = (await accepted.json()) as { receipt: { runId: string; revision: number } };

  const read = await fetch(`${base}/${receipt.receipt.runId}${query}`);
  assert.equal(read.status, 200, await read.clone().text());
  const body = (await read.json()) as {
    snapshot: { workspaceId: string; runId: string };
    cursor: number;
  };
  assert.equal(body.snapshot.workspaceId, workspace.id);
  assert.equal(body.snapshot.runId, receipt.receipt.runId);
  assert.ok(body.cursor >= receipt.receipt.revision);

  const abort = new AbortController();
  const stream = await fetch(`${base}/${receipt.receipt.runId}/events${query}`, {
    signal: abort.signal,
  });
  assert.equal(stream.status, 200);
  assert.ok(stream.body);
  const first = await nextFrame(stream.body.getReader(), { buffer: "" });
  assert.equal(first.event, "snapshot");
  assert.equal(first.id, body.cursor);
  assert.deepEqual(
    (first.data as { snapshot: { runId: string } }).snapshot.runId,
    receipt.receipt.runId,
  );
  abort.abort();

  const replayAbort = new AbortController();
  const replay = await fetch(`${base}/${receipt.receipt.runId}/events${query}`, {
    headers: { "Last-Event-ID": "0" },
    signal: replayAbort.signal,
  });
  assert.equal(replay.status, 200);
  assert.ok(replay.body);
  const replayFrame = await nextFrame(replay.body.getReader(), { buffer: "" });
  assert.equal(replayFrame.event, "run.event");
  assert.equal(replayFrame.id, 1);
  replayAbort.abort();
});

test("GET attempt transcript returns secret-free messages from session.jsonl", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-runs-transcript-"));
  const workspace = await createWorkspace({
    name: "Transcript HTTP Run",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const server = createServer((req, res) => void dispatch(req, res));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    await resetWikiRunsRegistryForTests();
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/workspaces/${workspace.id}/runs`;
  const query = `?rootPath=${encodeURIComponent(root)}`;

  const accepted = await fetch(`${base}/command${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "start_run", commandId: "start-transcript-http" }),
  });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  const { receipt } = (await accepted.json()) as { receipt: { runId: string } };

  // Wait until freeze attempt is recorded so we have a real attempt id.
  let attemptId: string | undefined;
  let nodeKey = "freeze";
  let state = "running";
  for (let i = 0; i < 100; i += 1) {
    const read = await fetch(`${base}/${receipt.runId}${query}`);
    assert.equal(read.status, 200, await read.clone().text());
    const body = (await read.json()) as {
      snapshot: {
        attempts: Array<{ attemptId: string; nodeKey: string; state: string }>;
      };
    };
    const attempt = body.snapshot.attempts[0];
    if (attempt) {
      attemptId = attempt.attemptId;
      nodeKey = attempt.nodeKey;
      state = attempt.state;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(attemptId, "expected at least one attempt on the run");

  const sessionPath = path.join(
    root,
    ".okf-wiki",
    "runs",
    receipt.runId,
    "attempts",
    attemptId,
    "session.jsonl",
  );
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await writeFile(
    sessionPath,
    [
      JSON.stringify({ role: "user", content: "plan the wiki" }),
      JSON.stringify({ role: "assistant", content: "drafting overview" }),
    ].join("\n") + "\n",
    "utf8",
  );

  const transcriptRes = await fetch(
    `${base}/${receipt.runId}/attempts/${attemptId}/transcript${query}`,
  );
  assert.equal(transcriptRes.status, 200, await transcriptRes.clone().text());
  const transcript = (await transcriptRes.json()) as {
    attemptId: string;
    nodeKey: string;
    state: string;
    messages: unknown[];
  };
  assert.equal(transcript.attemptId, attemptId);
  assert.equal(transcript.nodeKey, nodeKey);
  assert.equal(transcript.state, state);
  assert.equal(transcript.messages.length, 2);
  assert.deepEqual(transcript.messages[0], { role: "user", content: "plan the wiki" });
  assert.deepEqual(transcript.messages[1], {
    role: "assistant",
    content: "drafting overview",
  });

  const missing = await fetch(
    `${base}/${receipt.runId}/attempts/no-such-attempt/transcript${query}`,
  );
  assert.equal(missing.status, 404);
});
