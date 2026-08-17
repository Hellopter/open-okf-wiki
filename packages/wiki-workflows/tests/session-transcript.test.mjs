import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readWikiSessionTranscript } from "../dist/session-transcript.js";

const session = [
  { type: "session", version: 3, id: "sess-1", timestamp: "2026-08-12T00:00:00.000Z", cwd: "/workspace" },
  {
    type: "message", id: "a1", parentId: null, timestamp: "2026-08-12T00:00:01.000Z",
    message: { role: "user", content: "Write the auth page.", timestamp: Date.parse("2026-08-12T00:00:01.000Z") },
  },
  {
    type: "message", id: "a2", parentId: "a1", timestamp: "2026-08-12T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "I will inspect the source first." }, { type: "toolCall", id: "t1", name: "read", arguments: {} }],
      timestamp: Date.parse("2026-08-12T00:00:02.000Z"),
    },
  },
  {
    type: "message", id: "a3", parentId: "a2", timestamp: "2026-08-12T00:00:03.000Z",
    message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "SECRET FILE BODY" }], isError: false },
  },
  {
    type: "message", id: "a4", parentId: "a3", timestamp: "2026-08-12T00:00:04.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "t2", name: "write", arguments: { path: "wiki/a.md" } }],
      timestamp: Date.parse("2026-08-12T00:00:04.000Z"),
    },
  },
  {
    type: "message", id: "a5", parentId: "a4", timestamp: "2026-08-12T00:00:05.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Coverage is complete.\n\n- auth flow\n- token refresh" }],
      timestamp: Date.parse("2026-08-12T00:00:05.000Z"),
    },
  },
].map((entry) => JSON.stringify(entry)).join("\n");

test("session transcript keeps assistant text and omits tool-only turns and tool bodies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-"));
  const file = path.join(root, "session.jsonl");
  await writeFile(file, session);
  const messages = await readWikiSessionTranscript(file);
  assert.deepEqual(messages, [
    { at: "2026-08-12T00:00:02.000Z", text: "I will inspect the source first." },
    { at: "2026-08-12T00:00:05.000Z", text: "Coverage is complete.\n\n- auth flow\n- token refresh" },
  ]);
  assert.doesNotMatch(JSON.stringify(messages), /SECRET FILE BODY|Write the auth page/);
});

test("missing session files yield an empty transcript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-"));
  assert.deepEqual(await readWikiSessionTranscript(path.join(root, "missing.jsonl")), []);
  await writeFile(path.join(root, "empty.jsonl"), "");
  assert.deepEqual(await readWikiSessionTranscript(path.join(root, "empty.jsonl")), []);
});

test("session tail reads survive a multibyte byte boundary and preserve order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-"));
  const file = path.join(root, "large-session.jsonl");
  const prefix = Buffer.from(`${"é".repeat(600_000)}\n`);
  const entries = [
    {
      type: "message", id: "tail-1", timestamp: "2026-08-12T00:01:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "先に確認。" }] },
    },
    {
      type: "message", id: "tail-2", timestamp: "2026-08-12T00:02:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "確認完了。" }] },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(file, Buffer.concat([prefix, Buffer.from(`${entries}\n`)]));

  assert.deepEqual(await readWikiSessionTranscript(file), [
    { at: "2026-08-12T00:01:00.000Z", text: "先に確認。" },
    { at: "2026-08-12T00:02:00.000Z", text: "確認完了。" },
  ]);
});

test("oversized transcript lines are bounded and latest messages remain ordered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-"));
  const file = path.join(root, "many-messages.jsonl");
  const entries = Array.from({ length: 205 }, (_, index) => JSON.stringify({
    type: "message", id: `m-${index}`, timestamp: `2026-08-12T00:${String(index).padStart(2, "0")}:00.000Z`,
    message: { role: "assistant", content: [{ type: "text", text: `message-${index}` }] },
  })).join("\n");
  await writeFile(file, `${"x".repeat(1_100_000)}\n${entries}\n`);

  const messages = await readWikiSessionTranscript(file);
  assert.equal(messages.length, 200);
  assert.equal(messages[0].text, "message-5");
  assert.equal(messages.at(-1).text, "message-204");
});

test("an oversized single JSONL line does not produce a partial message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-"));
  const file = path.join(root, "oversized-line.jsonl");
  await writeFile(file, JSON.stringify({
    type: "message", id: "huge", timestamp: "2026-08-12T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "界".repeat(600_000) }] },
  }));

  assert.deepEqual(await readWikiSessionTranscript(file), []);
});
