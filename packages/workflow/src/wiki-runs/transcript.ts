/**
 * Read-path Attempt transcript resolution for Node details UI.
 * Write path stays in transcript-io.ts (writeConversationTranscript).
 */

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { WikiRunAttempt } from "@okf-wiki/contract";
import { isPathInside, runWorkDir } from "@okf-wiki/core";
import type { WikiRunsDbCtx } from "./ctx.js";
import { asRow, asRows, requiredText, type SqlRow } from "./sql.js";
import { parseTranscriptMessages } from "./transcript-io.js";
import { TRANSCRIPT_MAX_BYTES, type WikiRunAttemptTranscript } from "./types.js";

export type TranscriptHost = Pick<WikiRunsDbCtx, "workspace" | "db">;

/**
 * Secret-free Attempt transcript for Node details.
 * Resolves live `attempts/<id>/session.jsonl` or a sealed transcript artifact under the run.
 */
export async function readAttemptTranscript(
  host: TranscriptHost,
  input: { runId: string; attemptId: string },
): Promise<WikiRunAttemptTranscript> {
  const runId = input.runId.trim();
  const attemptId = input.attemptId.trim();
  if (!runId) throw new Error("runId is required");
  if (!attemptId) throw new Error("attemptId is required");

  host.db.exec("BEGIN DEFERRED");
  let attempt: SqlRow | undefined;
  let sealedRelativePaths: string[];
  try {
    const run = asRow(host.db.prepare("SELECT run_id FROM runs WHERE run_id = ?").get(runId));
    if (!run) throw new Error(`run not found: ${runId}`);
    attempt = asRow(
      host.db
        .prepare(
          `SELECT attempt_id, run_id, node_key, state, error FROM attempts
           WHERE attempt_id = ? AND run_id = ?`,
        )
        .get(attemptId, runId),
    );
    if (!attempt) throw new Error(`attempt not found: ${attemptId}`);
    sealedRelativePaths = asRows(
      host.db
        .prepare(
          `SELECT relative_path FROM artifacts
           WHERE run_id = ? AND producer_attempt_id = ? AND kind = 'transcript'
           ORDER BY sealed_at DESC`,
        )
        .all(runId, attemptId),
    ).map((row) => requiredText(row, "relative_path"));
    // Also accept node_outputs role=transcript for this attempt's generation
    // when producer_attempt_id was not recorded on older rows (defensive).
    if (sealedRelativePaths.length === 0) {
      sealedRelativePaths = asRows(
        host.db
          .prepare(
            `SELECT artifacts.relative_path
             FROM attempts
             JOIN node_outputs
               ON node_outputs.run_id = attempts.run_id
              AND node_outputs.node_key = attempts.node_key
              AND node_outputs.node_generation = attempts.node_generation
             JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
             WHERE attempts.attempt_id = ?
               AND attempts.run_id = ?
               AND (node_outputs.role = 'transcript' OR artifacts.kind = 'transcript')
             ORDER BY artifacts.sealed_at DESC`,
          )
          .all(attemptId, runId),
      ).map((row) => requiredText(row, "relative_path"));
    }
    host.db.exec("COMMIT");
  } catch (error) {
    try {
      host.db.exec("ROLLBACK");
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
    throw error;
  }

  const nodeKey = requiredText(attempt, "node_key");
  const state = requiredText(attempt, "state") as WikiRunAttempt["state"];
  const attemptError =
    typeof attempt.error === "string" && attempt.error.trim() ? attempt.error.trim() : null;

  const runDir = runWorkDir(host.workspace.rootPath, runId);
  const candidates = transcriptCandidatePaths(runDir, attemptId, sealedRelativePaths);
  const transcriptPath = await firstExistingTranscriptFile(runDir, candidates);

  // Attempt exists but no file yet (running) or never sealed (legacy / wipe):
  // return 200-shaped empty/synthetic messages — never "transcript not found" 404.
  // Only run/attempt missing stay 404 for the HTTP adapter.
  if (!transcriptPath) {
    const messages: unknown[] = attemptError
      ? [
          { role: "assistant", content: `Error: ${attemptError.slice(0, 4_000)}` },
          {
            schema: 1,
            node: nodeKey,
            mode: "missing_transcript",
            summary: attemptError.slice(0, 4_000),
            error: attemptError.slice(0, 4_000),
          },
        ]
      : [];
    return {
      attemptId: requiredText(attempt, "attempt_id"),
      nodeKey,
      state,
      messages,
    };
  }

  const info = await lstat(transcriptPath);
  if (!info.isFile()) {
    return {
      attemptId: requiredText(attempt, "attempt_id"),
      nodeKey,
      state,
      messages: [],
    };
  }
  if (info.size > TRANSCRIPT_MAX_BYTES) {
    throw new Error(`transcript exceeds size limit (${TRANSCRIPT_MAX_BYTES} bytes)`);
  }

  const raw = await readFile(transcriptPath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > TRANSCRIPT_MAX_BYTES) {
    throw new Error(`transcript exceeds size limit (${TRANSCRIPT_MAX_BYTES} bytes)`);
  }

  let messages: unknown[];
  try {
    messages = parseTranscriptMessages(raw);
  } catch (error) {
    throw new Error(
      `transcript is not valid JSON/JSONL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    attemptId: requiredText(attempt, "attempt_id"),
    nodeKey,
    state,
    messages,
  };
}

/**
 * Candidate transcript files under the run work dir.
 * Live session first, then sealed transcript artifact leaves.
 */
export function transcriptCandidatePaths(
  runDir: string,
  attemptId: string,
  sealedRelativePaths: string[],
): string[] {
  const candidates: string[] = [path.join(runDir, "attempts", attemptId, "session.jsonl")];
  for (const relativePath of sealedRelativePaths) {
    // Reject absolute or parent-escaping relative paths before join.
    if (path.isAbsolute(relativePath) || relativePath.split(/[/\\]/).includes("..")) continue;
    const artifactRoot = path.join(runDir, relativePath);
    candidates.push(
      path.join(artifactRoot, "session.jsonl"),
      path.join(artifactRoot, "transcript.jsonl"),
      artifactRoot,
    );
  }
  return candidates;
}

/** First ordinary file among candidates that stays inside the run work dir. */
export async function firstExistingTranscriptFile(
  runDir: string,
  candidates: string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!isPathInside(runDir, resolved)) {
      throw new Error("transcript path escaped run work dir");
    }
    const info = await lstat(resolved).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) continue;
    if (info.isSymbolicLink()) continue;
    if (info.isFile()) return resolved;
  }
  return undefined;
}
