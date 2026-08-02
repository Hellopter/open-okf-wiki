import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { openWikiRuns } from "../../wiki-runs.js";
import { appendAttemptFailureTranscript } from "../transcript-io.js";
import { TRANSCRIPT_MAX_BYTES } from "../types.js";
import {
  context,
  freezeAndPlanExecutor,
  makeWorkspace,
  removeWorkspace,
  succeededProbe,
  waitForTerminal,
} from "./harness.js";

test("readAttemptTranscript returns JSONL messages from live session or sealed artifact", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: freezeAndPlanExecutor(async ({ workDir }) => succeededProbe(workDir)),
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-transcript-read", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const finished = await waitForTerminal(runs, receipt.runId);
  const planAttempt = finished.snapshot.attempts.find((attempt) => attempt.nodeKey === "plan");
  assert.ok(planAttempt, "plan attempt should exist after freeze+plan");

  const transcript = await runs.readAttemptTranscript({
    runId: receipt.runId,
    attemptId: planAttempt.attemptId,
  });
  assert.equal(transcript.attemptId, planAttempt.attemptId);
  assert.equal(transcript.nodeKey, "plan");
  assert.equal(transcript.state, planAttempt.state);
  assert.ok(Array.isArray(transcript.events));
  assert.ok(transcript.events.length >= 2, "plan transcript should be multi-row conversation");
  const first = transcript.events[0];
  assert.equal(first?.kind, "input");
  assert.equal(
    first?.kind === "input" ? first.content : undefined,
    "Plan WikiRunSpec for Workflow test",
  );
  assert.ok(
    transcript.events.some((event) => event.kind === "assistant" && event.content.length > 0),
    "expected canonical assistant content in plan transcript",
  );

  await assert.rejects(
    () =>
      runs.readAttemptTranscript({
        runId: receipt.runId,
        attemptId: "missing-attempt-id",
      }),
    /attempt not found/,
  );
  await assert.rejects(
    () =>
      runs.readAttemptTranscript({
        runId: "missing-run-id",
        attemptId: planAttempt.attemptId,
      }),
    /run not found/,
  );

  // Attempt without a transcript file → 200-shaped empty (not 404); UI must not error.
  const freezeAttempt = finished.snapshot.attempts.find((attempt) => attempt.nodeKey === "freeze");
  assert.ok(freezeAttempt);
  const freezeSession = path.join(
    root,
    ".okf-wiki",
    "runs",
    receipt.runId,
    "attempts",
    freezeAttempt.attemptId,
    "session.jsonl",
  );
  await rm(freezeSession, { force: true });
  // Also drop any sealed transcript leaves so the read path has nothing on disk.
  const runArtifacts = path.join(root, ".okf-wiki", "runs", receipt.runId, "artifacts");
  await rm(runArtifacts, { recursive: true, force: true }).catch(() => undefined);
  const emptyTx = await runs.readAttemptTranscript({
    runId: receipt.runId,
    attemptId: freezeAttempt.attemptId,
  });
  assert.equal(emptyTx.attemptId, freezeAttempt.attemptId);
  assert.equal(emptyTx.nodeKey, "freeze");
  assert.ok(Array.isArray(emptyTx.events));
  // Failed freeze may still synthesize an error row from attempts.error.
  if (freezeAttempt.state === "failed" && freezeAttempt.error) {
    assert.ok(emptyTx.events.length >= 1);
  }
});

test("readAttemptTranscript returns the newest page and cursor-pages older trace entries", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-transcript-page", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const finished = await waitForTerminal(runs, receipt.runId);
  const attempt = finished.snapshot.attempts[0];
  assert.ok(attempt);
  const sessionPath = path.join(
    root,
    ".okf-wiki",
    "runs",
    receipt.runId,
    "attempts",
    attempt.attemptId,
    "session.jsonl",
  );
  await mkdir(path.dirname(sessionPath), { recursive: true });
  const rows = Array.from({ length: 205 }, (_, index) =>
    JSON.stringify({
      trace: 1,
      ordinal: index + 1,
      at: new Date().toISOString(),
      kind: "assistant",
      content: `event ${index + 1}`,
    }),
  );
  await writeFile(sessionPath, `${rows.join("\n")}\n`, "utf8");

  const newest = await runs.readAttemptTranscript({
    runId: receipt.runId,
    attemptId: attempt.attemptId,
    limit: 100,
  });
  assert.equal(newest.events.length, 100);
  assert.equal(newest.events[0]?.ordinal, 106);
  assert.equal(newest.cursor, 205);
  assert.equal(newest.hasEarlier, true);
  assert.equal(newest.nextBefore, 106);

  const earlier = await runs.readAttemptTranscript({
    runId: receipt.runId,
    attemptId: attempt.attemptId,
    beforeSequence: newest.nextBefore,
    limit: 100,
  });
  assert.equal(earlier.events.length, 100);
  assert.equal(earlier.events[0]?.ordinal, 6);
  assert.equal(earlier.cursor, 105);
  assert.equal(earlier.hasEarlier, true);

  await writeFile(
    sessionPath,
    [
      JSON.stringify({ role: "assistant", content: "legacy preface" }),
      JSON.stringify({
        trace: 1,
        ordinal: 1,
        at: "2026-07-31T00:00:00.000Z",
        kind: "tool_call",
        toolCallId: "read-1",
        name: "read",
      }),
      JSON.stringify({
        trace: 1,
        ordinal: 2,
        at: "2026-07-31T00:00:01.000Z",
        kind: "tool_result",
        toolCallId: "read-1",
        name: "read",
        output: "result stays typed",
        status: "done",
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  await assert.rejects(
    () => runs.readAttemptTranscript({ runId: receipt.runId, attemptId: attempt.attemptId }),
    /canonical trace JSONL/,
  );

  await writeFile(
    sessionPath,
    `${JSON.stringify({
      trace: 1,
      ordinal: 1,
      at: "2026-07-31T00:00:00.000Z",
      kind: "assistant",
      content: "valid prefix",
    })}\n{"trace":1`,
    "utf8",
  );
  await assert.rejects(
    () => runs.readAttemptTranscript({ runId: receipt.runId, attemptId: attempt.attemptId }),
    /not valid JSON\/JSONL/,
    "a corrupt JSONL tail must not silently truncate the audit trace",
  );
});

test("appendAttemptFailureTranscript preserves a trace that is already at its retention cap", async (t) => {
  const { root } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const sessionPath = path.join(root, "session.jsonl");
  const rows: string[] = [];
  let size = 0;
  for (let ordinal = 1; ordinal <= 31; ordinal += 1) {
    const line = `${JSON.stringify({
      trace: 1,
      ordinal,
      at: "2026-07-31T00:00:00.000Z",
      kind: "assistant",
      content: "x".repeat(64 * 1024),
    })}\n`;
    rows.push(line);
    size += Buffer.byteLength(line, "utf8");
  }
  const emptyFinal = `${JSON.stringify({
    trace: 1,
    ordinal: 32,
    at: "2026-07-31T00:00:00.000Z",
    kind: "assistant",
    content: "",
  })}\n`;
  const finalContentLength =
    TRANSCRIPT_MAX_BYTES - 48 - size - Buffer.byteLength(emptyFinal, "utf8");
  assert.ok(finalContentLength > 0 && finalContentLength <= 64 * 1024);
  const finalLine = `${JSON.stringify({
    trace: 1,
    ordinal: 32,
    at: "2026-07-31T00:00:00.000Z",
    kind: "assistant",
    content: "x".repeat(finalContentLength),
  })}\n`;
  rows.push(finalLine);
  const before = rows.join("");
  assert.ok(Buffer.byteLength(before, "utf8") > TRANSCRIPT_MAX_BYTES - 128);
  await writeFile(sessionPath, before, "utf8");

  await appendAttemptFailureTranscript({ sessionPath, summary: "Attempt failed." });
  assert.equal(await readFile(sessionPath, "utf8"), before);
});

test("appendAttemptFailureTranscript writes the real error summary", async (t) => {
  const { root } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const sessionPath = path.join(root, "session-real.jsonl");

  await appendAttemptFailureTranscript({
    sessionPath,
    summary: "WikiRunSpec has 5 domains but maxDomainFanOut is 4",
  });

  const raw = await readFile(sessionPath, "utf8");
  const lines = raw
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]!) as {
    kind: string;
    status: string;
    summary: string;
    ordinal: number;
  };
  assert.equal(row.kind, "terminal");
  assert.equal(row.status, "error");
  assert.equal(row.summary, "WikiRunSpec has 5 domains but maxDomainFanOut is 4");
  assert.equal(row.ordinal, 1);
});

test("appendAttemptFailureTranscript skips when last terminal is already error with summary", async (t) => {
  const { root } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const sessionPath = path.join(root, "session-idempotent.jsonl");
  const existing = [
    JSON.stringify({
      trace: 1,
      ordinal: 1,
      at: "2026-07-31T00:00:00.000Z",
      kind: "assistant",
      content: "working…",
    }),
    JSON.stringify({
      trace: 1,
      ordinal: 2,
      at: "2026-07-31T00:00:01.000Z",
      kind: "terminal",
      status: "error",
      summary: "provider rate limited",
    }),
  ].join("\n") + "\n";
  await writeFile(sessionPath, existing, "utf8");

  await appendAttemptFailureTranscript({
    sessionPath,
    summary: "second failure should not append",
  });
  assert.equal(await readFile(sessionPath, "utf8"), existing);
});

test("appendAttemptFailureTranscript falls back to Attempt failed. when summary is empty", async (t) => {
  const { root } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const sessionPath = path.join(root, "session-empty.jsonl");

  await appendAttemptFailureTranscript({ sessionPath, summary: "   \n\t  " });

  const raw = await readFile(sessionPath, "utf8");
  const row = JSON.parse(raw.trim()) as { kind: string; status: string; summary: string };
  assert.equal(row.kind, "terminal");
  assert.equal(row.status, "error");
  assert.equal(row.summary, "Attempt failed.");
});

test("appendAttemptFailureTranscript appends after a done terminal", async (t) => {
  const { root } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const sessionPath = path.join(root, "session-done-then-fail.jsonl");
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      trace: 1,
      ordinal: 1,
      at: "2026-07-31T00:00:00.000Z",
      kind: "terminal",
      status: "done",
      summary: "completed",
    })}\n`,
    "utf8",
  );

  await appendAttemptFailureTranscript({
    sessionPath,
    summary: "late host failure after partial success path",
  });

  const lines = (await readFile(sessionPath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  assert.equal(lines.length, 2);
  const last = JSON.parse(lines[1]!) as { kind: string; status: string; summary: string; ordinal: number };
  assert.equal(last.kind, "terminal");
  assert.equal(last.status, "error");
  assert.equal(last.summary, "late host failure after partial success path");
  assert.equal(last.ordinal, 2);
});

test("readAttemptTranscript refuses oversized transcripts", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-transcript-size", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const finished = await waitForTerminal(runs, receipt.runId);
  const attempt = finished.snapshot.attempts[0];
  assert.ok(attempt);

  const sessionPath = path.join(
    root,
    ".okf-wiki",
    "runs",
    receipt.runId,
    "attempts",
    attempt.attemptId,
    "session.jsonl",
  );
  await mkdir(path.dirname(sessionPath), { recursive: true });
  // Just over 2MB of JSONL-looking content.
  const oversized = `${"x".repeat(2 * 1024 * 1024 + 1)}\n`;
  await writeFile(sessionPath, oversized, "utf8");

  await assert.rejects(
    () =>
      runs.readAttemptTranscript({
        runId: receipt.runId,
        attemptId: attempt.attemptId,
      }),
    /transcript exceeds size limit/,
  );
});
