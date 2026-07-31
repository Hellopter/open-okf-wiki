import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WikiRunAttemptTranscriptDoneFrameSchema,
  WikiRunAttemptTranscriptTraceFrameSchema,
} from "@okf-wiki/contract";
import { createWorkspace, registerWorkspaceInAppIndex, saveWorkspace } from "@okf-wiki/core";
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
  await registerWorkspaceInAppIndex(root);
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

  const started = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "start_run",
      commandId: "start-over-http",
      intent: { mode: "generate" },
      // An asserted actor/workspace must be rejected rather than trusted.
      workspaceId: "attacker-workspace",
    }),
  });
  assert.equal(started.status, 400);

  const accepted = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "start_run",
      commandId: "start-over-http",
      intent: { mode: "generate" },
    }),
  });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  const receipt = (await accepted.json()) as { receipt: { runId: string; revision: number } };

  const read = await fetch(`${base}/${receipt.receipt.runId}`);
  assert.equal(read.status, 200, await read.clone().text());
  const body = (await read.json()) as {
    snapshot: { workspaceId: string; runId: string };
    cursor: number;
  };
  assert.equal(body.snapshot.workspaceId, workspace.id);
  assert.equal(body.snapshot.runId, receipt.receipt.runId);
  assert.ok(body.cursor >= receipt.receipt.revision);

  const abort = new AbortController();
  const stream = await fetch(`${base}/${receipt.receipt.runId}/events`, {
    signal: abort.signal,
  });
  assert.equal(stream.status, 200);
  assert.ok(stream.body);
  const first = await nextFrame(stream.body.getReader(), { buffer: "" });
  assert.equal(first.event, "snapshot");
  // Cursor may advance between GET and SSE open; snapshot id is monotonic ≥ GET cursor.
  assert.ok(
    typeof first.id === "number" && first.id >= body.cursor,
    `sse id ${first.id} should be >= get cursor ${body.cursor}`,
  );
  assert.deepEqual(
    (first.data as { snapshot: { runId: string } }).snapshot.runId,
    receipt.receipt.runId,
  );
  abort.abort();

  const replayAbort = new AbortController();
  const replay = await fetch(`${base}/${receipt.receipt.runId}/events`, {
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
  await registerWorkspaceInAppIndex(root);
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

  const accepted = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "start_run",
      commandId: "start-transcript-http",
      intent: { mode: "generate" },
    }),
  });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  const { receipt } = (await accepted.json()) as { receipt: { runId: string } };

  // Wait until freeze attempt is terminal so the executor is not still writing session.jsonl.
  let attemptId: string | undefined;
  let nodeKey = "freeze";
  for (let i = 0; i < 200; i += 1) {
    const read = await fetch(`${base}/${receipt.runId}`);
    assert.equal(read.status, 200, await read.clone().text());
    const body = (await read.json()) as {
      snapshot: {
        attempts: Array<{ attemptId: string; nodeKey: string; state: string }>;
      };
    };
    const attempt =
      body.snapshot.attempts.find((a) => a.nodeKey === "freeze") ?? body.snapshot.attempts[0];
    if (attempt && attempt.state !== "running" && attempt.state !== "suspended") {
      attemptId = attempt.attemptId;
      nodeKey = attempt.nodeKey;
      break;
    }
    if (attempt && !attemptId) {
      attemptId = attempt.attemptId;
      nodeKey = attempt.nodeKey;
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
  const expectedLines = [
    JSON.stringify({
      trace: 1,
      ordinal: 1,
      at: "2026-07-31T00:00:00.000Z",
      kind: "input",
      content: "plan the wiki",
    }),
    JSON.stringify({
      trace: 1,
      ordinal: 2,
      at: "2026-07-31T00:00:01.000Z",
      kind: "assistant",
      content: "drafting overview",
    }),
  ];
  await writeFile(sessionPath, `${expectedLines.join("\n")}\n`, "utf8");

  const transcriptRes = await fetch(`${base}/${receipt.runId}/attempts/${attemptId}/transcript`);
  assert.equal(transcriptRes.status, 200, await transcriptRes.clone().text());
  const transcript = (await transcriptRes.json()) as {
    attemptId: string;
    nodeKey: string;
    state: string;
    events: Array<{ kind: string; content?: unknown }>;
    cursor: number;
  };
  assert.equal(transcript.attemptId, attemptId);
  assert.equal(transcript.nodeKey, nodeKey);
  assert.ok(typeof transcript.state === "string" && transcript.state.length > 0);
  assert.ok(transcript.events.length >= 2);
  assert.equal(transcript.events[0]?.kind, "input");
  assert.equal(transcript.events[0]?.content, "plan the wiki");
  assert.equal(transcript.events[1]?.kind, "assistant");
  assert.equal(transcript.events[1]?.content, "drafting overview");
  assert.equal(transcript.cursor, 2);

  const missing = await fetch(`${base}/${receipt.runId}/attempts/no-such-attempt/transcript`);
  assert.equal(missing.status, 404);

  // Attempt exists but no session file → 200 with empty (or synthesized) messages, not 404.
  await rm(sessionPath, { force: true });
  // Drop sealed transcript leaves if any so the read path has nothing on disk.
  await rm(path.join(root, ".okf-wiki", "runs", receipt.runId, "artifacts"), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
  const emptyRes = await fetch(`${base}/${receipt.runId}/attempts/${attemptId}/transcript`);
  assert.equal(emptyRes.status, 200, await emptyRes.clone().text());
  const emptyBody = (await emptyRes.json()) as { events: unknown[]; attemptId: string };
  assert.equal(emptyBody.attemptId, attemptId);
  assert.ok(Array.isArray(emptyBody.events));
});

test("GET attempt transcript events streams snapshot then done for terminal attempt", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-runs-tx-sse-"));
  const workspace = await createWorkspace({
    name: "Transcript SSE Run",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  await registerWorkspaceInAppIndex(root);
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

  const accepted = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "start_run",
      commandId: "start-transcript-sse",
      intent: { mode: "generate" },
    }),
  });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  const { receipt } = (await accepted.json()) as { receipt: { runId: string } };

  let attemptId: string | undefined;
  for (let i = 0; i < 200; i += 1) {
    const read = await fetch(`${base}/${receipt.runId}`);
    const body = (await read.json()) as {
      snapshot: { attempts: Array<{ attemptId: string; nodeKey: string; state: string }> };
    };
    const attempt =
      body.snapshot.attempts.find((a) => a.nodeKey === "freeze") ?? body.snapshot.attempts[0];
    if (attempt && attempt.state !== "running" && attempt.state !== "suspended") {
      attemptId = attempt.attemptId;
      break;
    }
    if (attempt) attemptId = attempt.attemptId;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(attemptId);

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
    `${JSON.stringify({
      trace: 1,
      ordinal: 1,
      at: "2026-07-31T00:00:00.000Z",
      kind: "assistant",
      content: "stream me",
    })}\n`,
    "utf8",
  );

  const abort = new AbortController();
  const stream = await fetch(`${base}/${receipt.runId}/attempts/${attemptId}/transcript/events`, {
    signal: abort.signal,
  });
  assert.equal(stream.status, 200, await stream.clone().text());
  assert.ok(stream.body);
  const reader = stream.body.getReader();
  // Share buffer: both frames may arrive in one TCP chunk.
  const sseBuf = { buffer: "" };
  const first = await nextFrame(reader, sseBuf);
  assert.equal(first.event, "trace");
  assert.ok(first.data && typeof first.data === "object");
  const payload = WikiRunAttemptTranscriptTraceFrameSchema.parse(first.data);
  assert.ok(payload.events.length >= 1);
  assert.equal(payload.cursor, 1);

  // Terminal attempt should also emit done and end the stream.
  const second = await nextFrame(reader, sseBuf);
  assert.equal(second.event, "done");
  WikiRunAttemptTranscriptDoneFrameSchema.parse(second.data);
  abort.abort();

  // EventSource sends Last-Event-ID after a transport reconnect. The trace
  // endpoint must honor it rather than replaying the prior batch from `after=0`.
  const replayAbort = new AbortController();
  const replay = await fetch(`${base}/${receipt.runId}/attempts/${attemptId}/transcript/events`, {
    headers: { "Last-Event-ID": "1" },
    signal: replayAbort.signal,
  });
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.ok(replay.body);
  const replayFirst = await nextFrame(replay.body.getReader(), { buffer: "" });
  assert.equal(replayFirst.event, "done");
  replayAbort.abort();
});
