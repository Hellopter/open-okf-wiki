import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ATTEMPT_TRACE_MAX_BYTES,
  createAttemptTranscriptSink,
  finalizeAttemptTranscript,
} from "./attempt-transcript-sink.js";

type TraceRow = Record<string, unknown>;

async function traceRows(filePath: string): Promise<TraceRow[]> {
  return (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceRow);
}

describe("Attempt transcript trace sink", () => {
  it("keeps more than the 20-item live tail in append-only ordinal order", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-trace-"));
    const sessionPath = path.join(dir, "session.jsonl");
    const sink = createAttemptTranscriptSink(sessionPath, "plan the wiki");
    await sink.start();

    for (let i = 0; i < 25; i += 1) {
      await sink.writeSessionEvent({
        type: "tool_execution_start",
        toolCallId: `call-${i}`,
        toolName: "read",
        args: { path: `source-${i}.md` },
      });
      await sink.writeSessionEvent({
        type: "tool_execution_end",
        toolCallId: `call-${i}`,
        toolName: "read",
        result: { content: [{ type: "text", text: `result ${i}` }] },
      });
    }
    await sink.appendTerminal({ terminal: "done", summary: "complete" });
    await sink.flush();

    const rows = await traceRows(sessionPath);
    assert.equal(rows[0]?.kind, "input");
    assert.ok(rows.length > 50, "full trace must not use the 20-item live tail");
    assert.equal(rows[1]?.toolCallId, "call-0");
    assert.equal(rows.at(-2)?.toolCallId, "call-24");
    assert.equal(rows.at(-1)?.kind, "terminal");
    assert.deepEqual(
      rows.map((row) => row.ordinal),
      rows.map((_row, index) => index + 1),
    );
  });

  it("records redacted tool output and marks field truncation explicitly", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-trace-output-"));
    const sessionPath = path.join(dir, "session.jsonl");
    const sink = createAttemptTranscriptSink(sessionPath, "inspect");
    await sink.start();
    await sink.writeSessionEvent({
      type: "tool_execution_start",
      toolCallId: "secret-call",
      toolName: "read",
      args: { authorization: "Bearer sk-secret-token-123456" },
    });
    await sink.writeSessionEvent({
      type: "tool_execution_end",
      toolCallId: "secret-call",
      toolName: "read",
      result: { content: [{ type: "text", text: `${"x".repeat(70_000)} sk-secret-token-123456` }] },
    });
    await sink.flush();

    const output = (await traceRows(sessionPath)).find((row) => row.kind === "tool_result");
    assert.ok(typeof output?.output === "string");
    assert.equal((output!.output as string).includes("sk-secret-token-123456"), false);
    assert.match(output!.output as string, /\.\.\.\[truncated \d+ chars\]/);
  });

  it("ends at the 2 MiB cap with a durable truncation marker", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-trace-cap-"));
    const sessionPath = path.join(dir, "session.jsonl");
    const sink = createAttemptTranscriptSink(sessionPath, "inspect");
    await sink.start();
    for (let i = 0; i < 40; i += 1) {
      await sink.writeSessionEvent({
        type: "tool_execution_end",
        toolCallId: `call-${i}`,
        toolName: "read",
        result: `${"x".repeat(64 * 1024)}-${i}`,
      });
    }
    await sink.flush();

    const raw = await readFile(sessionPath, "utf8");
    assert.ok(Buffer.byteLength(raw, "utf8") <= ATTEMPT_TRACE_MAX_BYTES);
    assert.ok((await traceRows(sessionPath)).some((row) => row.kind === "truncated"));
  });

  it("flushes uninterrupted assistant deltas in bounded chunks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-trace-deltas-"));
    const sessionPath = path.join(dir, "session.jsonl");
    const sink = createAttemptTranscriptSink(sessionPath, "stream");
    await sink.start();

    for (let i = 0; i < 48; i += 1) {
      await sink.writeSessionEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: `${String(i).padStart(2, "0")}:${"x".repeat(1_024)}`,
        },
      });
    }
    await sink.flush();

    const assistant = (await traceRows(sessionPath)).filter((row) => row.kind === "assistant");
    assert.ok(assistant.length >= 3, "16 KiB threshold should flush before terminal cleanup");
    assert.equal(
      assistant
        .map((row) => row.content)
        .join("")
        .includes("47:"),
      true,
      "all streamed deltas should remain durable",
    );
  });

  it("finalize only appends terminal evidence to an existing trace", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-trace-final-"));
    const sessionPath = path.join(dir, "session.jsonl");
    const sink = createAttemptTranscriptSink(sessionPath, "plan wiki");
    await sink.start();
    await sink.writeSessionEvent({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "a.md" },
    });
    await sink.flush();

    await finalizeAttemptTranscript(sessionPath, {
      task: "plan wiki",
      items: [{ type: "text", text: "live tail must not be duplicated" }],
      summary: "spec ready",
      terminal: "done",
    });

    const rows = await traceRows(sessionPath);
    assert.equal(rows.filter((row) => row.kind === "input").length, 1);
    assert.equal(rows[1]?.kind, "tool_call");
    assert.equal(
      rows.some((row) => row.content === "live tail must not be duplicated"),
      false,
    );
    assert.equal(rows.at(-1)?.kind, "terminal");
  });
});
