/**
 * Read-path Attempt transcript resolution for Node details UI.
 * Write path stays in transcript-io.ts (writeConversationTranscript).
 */

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { type AttemptTraceEvent, AttemptTraceEventSchema, type WikiRunAttempt } from "@okf-wiki/contract/wiki-runs";
import { isPathInside, runWorkDir } from "@okf-wiki/core";
import type { WikiRunsDbCtx } from "./ctx.js";
import { asRow, asRows, requiredText, type SqlRow } from "./sql.js";
import { parseTranscriptMessages } from "./transcript-io.js";
import {
  TRANSCRIPT_MAX_BYTES,
  TRANSCRIPT_PAGE_DEFAULT_LIMIT,
  TRANSCRIPT_PAGE_MAX_LIMIT,
  type WikiRunAttemptTranscript,
  WikiRunsRequestError,
} from "./types.js";


/**
 * Secret-free Attempt transcript for Node details.
 * Resolves live `attempts/<id>/session.jsonl` or a sealed transcript artifact under the run.
 */
export async function readAttemptTranscript(
  host: Pick<WikiRunsDbCtx, "workspace" | "db">,
  input: {
    runId: string;
    attemptId: string;
    beforeSequence?: number;
    afterSequence?: number;
    limit?: number;
  },
): Promise<WikiRunAttemptTranscript> {
  const runId = input.runId.trim();
  const attemptId = input.attemptId.trim();
  if (!runId) throw new WikiRunsRequestError("invalid_request", "runId is required");
  if (!attemptId) throw new WikiRunsRequestError("invalid_request", "attemptId is required");
  if (input.beforeSequence !== undefined && input.afterSequence !== undefined) {
    throw new WikiRunsRequestError(
      "invalid_request",
      "transcript cursor cannot specify before and after",
    );
  }
  for (const cursor of [input.beforeSequence, input.afterSequence]) {
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) {
      throw new WikiRunsRequestError("invalid_request", "transcript cursor is invalid");
    }
  }
  const limit = input.limit ?? TRANSCRIPT_PAGE_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TRANSCRIPT_PAGE_MAX_LIMIT) {
    throw new WikiRunsRequestError("invalid_request", "transcript page limit is invalid");
  }

  host.db.exec("BEGIN DEFERRED");
  let attempt: SqlRow | undefined;
  let sealedRelativePaths: string[];
  try {
    const run = asRow(host.db.prepare("SELECT run_id FROM runs WHERE run_id = ?").get(runId));
    if (!run) throw new WikiRunsRequestError("not_found", `run not found: ${runId}`);
    attempt = asRow(
      host.db
        .prepare(
          `SELECT attempt_id, run_id, node_key, state, error FROM attempts
           WHERE attempt_id = ? AND run_id = ?`,
        )
        .get(attemptId, runId),
    );
    if (!attempt) throw new WikiRunsRequestError("not_found", `attempt not found: ${attemptId}`);
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
  // return an empty/synthetic page — never "transcript not found" 404.
  // Only run/attempt missing stay 404 for the HTTP adapter.
  if (!transcriptPath) {
    const events: AttemptTraceEvent[] = attemptError
      ? [
          {
            trace: 1,
            ordinal: 1,
            at: new Date(0).toISOString(),
            kind: "terminal",
            status: "error",
            summary: attemptError.slice(0, 4_000),
          },
        ]
      : [];
    return pageTranscript({
      attemptId: requiredText(attempt, "attempt_id"),
      nodeKey,
      state,
      events,
      input,
      limit,
    });
  }

  const info = await lstat(transcriptPath);
  if (!info.isFile()) {
    return pageTranscript({
      attemptId: requiredText(attempt, "attempt_id"),
      nodeKey,
      state,
      events: [],
      input,
      limit,
    });
  }
  if (info.size > TRANSCRIPT_MAX_BYTES) {
    throw new WikiRunsRequestError(
      "payload_too_large",
      `transcript exceeds size limit (${TRANSCRIPT_MAX_BYTES} bytes)`,
    );
  }

  const raw = await readFile(transcriptPath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > TRANSCRIPT_MAX_BYTES) {
    throw new WikiRunsRequestError(
      "payload_too_large",
      `transcript exceeds size limit (${TRANSCRIPT_MAX_BYTES} bytes)`,
    );
  }

  let rows: unknown[];
  try {
    rows = parseTranscriptMessages(raw);
  } catch (error) {
    throw new WikiRunsRequestError(
      "invalid_request",
      `transcript is not valid JSON/JSONL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return pageTranscript({
    attemptId: requiredText(attempt, "attempt_id"),
    nodeKey,
    state,
    events: traceEventsFromRows(rows),
    input,
    limit,
  });
}

function traceEventsFromRows(rows: unknown[]): AttemptTraceEvent[] {
  const parsed = rows.map((row) => AttemptTraceEventSchema.safeParse(row));
  if (parsed.every((entry) => entry.success)) {
    return parsed.map((entry) => entry.data);
  }
  throw new WikiRunsRequestError(
    "invalid_request",
    "transcript is not valid canonical trace JSONL",
  );
}

function pageTranscript(input: {
  attemptId: string;
  nodeKey: string;
  state: WikiRunAttempt["state"];
  events: AttemptTraceEvent[];
  input: { beforeSequence?: number; afterSequence?: number };
  limit: number;
}): WikiRunAttemptTranscript {
  const { events, limit } = input;
  if (input.input.afterSequence !== undefined) {
    const eligible = events.filter((event) => event.ordinal > input.input.afterSequence!);
    const page = eligible.slice(0, limit);
    return {
      attemptId: input.attemptId,
      nodeKey: input.nodeKey,
      state: input.state,
      events: page,
      hasEarlier: false,
      hasMore: eligible.length > page.length,
      cursor: page.at(-1)?.ordinal ?? input.input.afterSequence,
    };
  }

  const eligible =
    input.input.beforeSequence === undefined
      ? events
      : events.filter((event) => event.ordinal < input.input.beforeSequence!);
  const start = Math.max(0, eligible.length - limit);
  const page = eligible.slice(start);
  return {
    attemptId: input.attemptId,
    nodeKey: input.nodeKey,
    state: input.state,
    events: page,
    hasEarlier: start > 0,
    hasMore: false,
    ...(start > 0 && page[0] ? { nextBefore: page[0].ordinal } : {}),
    cursor: page.at(-1)?.ordinal ?? 0,
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
      throw new WikiRunsRequestError("invalid_request", "transcript path escaped run work dir");
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
