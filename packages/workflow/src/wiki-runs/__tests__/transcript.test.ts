import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { openWikiRuns } from "../../wiki-runs.js";
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
    { type: "start_run", commandId: "start-transcript-read" },
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
  assert.ok(Array.isArray(transcript.messages));
  assert.ok(transcript.messages.length >= 2, "plan transcript should be multi-row conversation");
  const first = transcript.messages[0] as Record<string, unknown> | undefined;
  assert.equal(first?.role, "user");
  assert.ok(
    transcript.messages.some(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        ((row as { role?: string }).role === "assistant" ||
          (row as { type?: string }).type === "text"),
    ),
    "expected assistant/text content in plan transcript",
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
  assert.ok(Array.isArray(emptyTx.messages));
  // Failed freeze may still synthesize an error row from attempts.error.
  if (freezeAttempt.state === "failed" && freezeAttempt.error) {
    assert.ok(emptyTx.messages.length >= 1);
  }
});

test("readAttemptTranscript refuses oversized transcripts", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-transcript-size" },
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
