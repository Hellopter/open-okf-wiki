import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildTranscriptRows,
  createAttemptTranscriptSink,
  finalizeAttemptTranscript,
  rowsFromProgress,
} from "./attempt-transcript-sink.js";

describe("buildTranscriptRows", () => {
  it("includes user task, tools, and terminal assistant summary", () => {
    const rows = buildTranscriptRows({
      task: "plan the wiki",
      items: [
        { type: "toolCall", name: "read", status: "done", argsSummary: '{"path":"a.ts"}' },
        { type: "text", text: "looking at sources" },
      ],
      summary: "Submitted Spec",
      terminal: "done",
    });
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], { role: "user", content: "plan the wiki" });
    assert.equal((rows[1] as { type: string }).type, "toolCall");
    assert.equal((rows[2] as { type: string }).type, "text");
    assert.equal((rows[3] as { role: string }).role, "assistant");
    assert.match((rows[3] as { content: string }).content, /Submitted Spec/);
  });

  it("marks error terminal lines", () => {
    const rows = buildTranscriptRows({
      task: "x",
      summary: "boom",
      terminal: "error",
    });
    assert.equal(rows.length, 2);
    assert.match((rows[1] as { content: string }).content, /^Error:/);
  });
});

describe("rowsFromProgress", () => {
  it("maps NodeAttempt status to terminal", () => {
    const rows = rowsFromProgress(
      {
        status: "done",
        summary: "ok",
        items: [{ type: "text", text: "hi" }],
      },
      "task",
    );
    assert.ok(rows.some((r) => "role" in r && (r as { role: string }).role === "assistant"));
  });
});

describe("createAttemptTranscriptSink", () => {
  it("writes replaceable JSONL to disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-tx-"));
    const sessionPath = path.join(dir, "session.jsonl");
    const sink = createAttemptTranscriptSink(sessionPath);

    await sink.writeProgress({
      task: "plan",
      items: [{ type: "toolCall", name: "ls", status: "running" }],
      summary: "listing",
    });
    let raw = await readFile(sessionPath, "utf8");
    assert.match(raw, /"role":"user"/);
    assert.match(raw, /"name":"ls"/);

    await sink.writeProgress({
      task: "plan",
      items: [{ type: "toolCall", name: "ls", status: "done" }],
      summary: "done listing",
      terminal: "done",
    });
    raw = await readFile(sessionPath, "utf8");
    const lines = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status?: string; role?: string });
    assert.ok(lines.some((l) => l.status === "done"));
    assert.ok(lines.some((l) => l.role === "assistant"));
  });
});

describe("finalizeAttemptTranscript", () => {
  it("writes conversation plus optional meta row", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-fin-"));
    const sessionPath = path.join(dir, "session.jsonl");
    await finalizeAttemptTranscript(sessionPath, {
      task: "plan wiki",
      summary: "spec ready",
      terminal: "done",
      meta: { node: "plan", mode: "fixture" },
    });
    const lines = (await readFile(sessionPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines[0]?.role, "user");
    assert.equal(lines[1]?.role, "assistant");
    assert.equal(lines[2]?.schema, 1);
    assert.equal(lines[2]?.node, "plan");
  });
});
