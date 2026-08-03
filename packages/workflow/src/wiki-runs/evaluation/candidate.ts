/**
 * Durable WikiCandidate registration for multi-round evaluation identity.
 * Rows live in wiki_candidates; contract WikiCandidate is the validated projection.
 */

import { type WikiCandidate, type WikiCandidateProducedBy, WikiCandidateSchema } from "@okf-wiki/contract/wiki-runs";
import { now } from "../crypto-util.js";
import { asRow, asRows, requiredNumber, requiredText, type SqlRow } from "../sql.js";

/** Minimal host surface for candidate persistence (owner SQLite). */
export type WikiCandidateHost = {
  db: {
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown;
    };
  };
};

export type RegisterWikiCandidateInput = {
  runId: string;
  digest: string;
  artifactId: string;
  producedBy: WikiCandidateProducedBy;
  /** When omitted, derived from producedBy + latest row. */
  parentCandidateId?: string;
  /** When omitted, nextCandidateRound(host, runId). */
  round?: number;
  /** When omitted, cand-${round}-${digest.slice(0, 12)}. */
  candidateId?: string;
  createdAt?: string;
  producerNodeKey?: string;
  producerAttemptId?: string;
};

function rowToCandidate(row: SqlRow): WikiCandidate {
  const parentRaw = row.parent_candidate_id;
  const createdRaw = row.created_at;
  return WikiCandidateSchema.parse({
    candidateId: requiredText(row, "candidate_id"),
    digest: requiredText(row, "digest"),
    artifactId: requiredText(row, "artifact_id"),
    parentCandidateId:
      typeof parentRaw === "string" && parentRaw.trim().length > 0 ? parentRaw : undefined,
    producedBy: requiredText(row, "produced_by"),
    round: requiredNumber(row, "round"),
    createdAt:
      typeof createdRaw === "string" && createdRaw.trim().length > 0 ? createdRaw : undefined,
  });
}

/**
 * Map node kind/key → how the wiki tree was produced.
 * - write.root → write
 * - repair* → repair
 * - validate.* (and other re-seals e.g. review.reduce) → mechanical_fix
 */
export function producedByForNode(kind: string, nodeKey: string): WikiCandidateProducedBy {
  const key = nodeKey.trim();
  const k = kind.trim();
  if (key === "write.root" || k === "write.root") return "write";
  if (k === "repair" || key.startsWith("repair.") || key.startsWith("repair")) return "repair";
  if (k.startsWith("validate.") || key.startsWith("validate.")) return "mechanical_fix";
  // review.reduce re-seals wiki after merge / carry-forward.
  return "mechanical_fix";
}

/**
 * Number of durable candidates for a run.
 * Missing `wiki_candidates` table (partial unit fixtures / pre-migrate) → 0.
 */
export function countWikiCandidates(host: WikiCandidateHost, runId: string): number {
  try {
    const row = asRow(
      host.db.prepare(`SELECT COUNT(*) AS count FROM wiki_candidates WHERE run_id = ?`).get(runId),
    );
    return requiredNumber(row ?? { count: 0 }, "count");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table:\s*wiki_candidates/i.test(message)) return 0;
    throw error;
  }
}

/**
 * Count model-produced Wiki candidates that consume the bounded repair budget.
 * Mechanical validation/review re-seals remain auditable candidate rows, but
 * they do not represent another model proposal and must not consume this cap.
 */
export function countModelWikiCandidates(host: WikiCandidateHost, runId: string): number {
  try {
    const row = asRow(
      host.db
        .prepare(
          `SELECT COUNT(*) AS count FROM wiki_candidates
           WHERE run_id = ? AND produced_by IN ('write', 'repair')`,
        )
        .get(runId),
    );
    return requiredNumber(row ?? { count: 0 }, "count");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table:\s*wiki_candidates/i.test(message)) return 0;
    throw error;
  }
}

/**
 * Next evaluation round index (0-based): current count, which equals max(round)+1
 * when rounds are assigned sequentially without gaps.
 */
export function nextCandidateRound(host: WikiCandidateHost, runId: string): number {
  return countWikiCandidates(host, runId);
}

/** Throw when the run is already at the EvaluationPolicy maxCandidates cap. */
export function assertUnderMaxCandidates(
  host: WikiCandidateHost,
  runId: string,
  maxCandidates: number,
): void {
  const count = countModelWikiCandidates(host, runId);
  if (count >= maxCandidates) {
    throw new Error(
      `wiki candidate cap reached (${count}/${maxCandidates}); cannot schedule another repair round`,
    );
  }
}

/** Latest candidate by round DESC, created_at DESC. */
export function latestWikiCandidate(
  host: WikiCandidateHost,
  runId: string,
): WikiCandidate | undefined {
  const row = asRow(
    host.db
      .prepare(
        `SELECT * FROM wiki_candidates
         WHERE run_id = ?
         ORDER BY round DESC, created_at DESC, candidate_id DESC
         LIMIT 1`,
      )
      .get(runId),
  );
  return row ? rowToCandidate(row) : undefined;
}

/**
 * A candidate identity is scoped to one durable run. Repair requests use this
 * lookup to bind their declared baseline rather than selecting a newer tree.
 */
export function wikiCandidateById(
  host: WikiCandidateHost,
  runId: string,
  candidateId: string,
): WikiCandidate | undefined {
  const row = asRow(
    host.db
      .prepare(
        `SELECT * FROM wiki_candidates
         WHERE run_id = ? AND candidate_id = ?`,
      )
      .get(runId, candidateId),
  );
  return row ? rowToCandidate(row) : undefined;
}

/** All candidates for a run, ordered by round ASC then created_at ASC. */
export function listWikiCandidates(host: WikiCandidateHost, runId: string): WikiCandidate[] {
  const rows = asRows(
    host.db
      .prepare(
        `SELECT * FROM wiki_candidates
         WHERE run_id = ?
         ORDER BY round ASC, created_at ASC, candidate_id ASC`,
      )
      .all(runId),
  );
  return rows.map(rowToCandidate);
}

/**
 * Insert a WikiCandidate row. Always allowed on commit (truth of production).
 * Cap enforcement belongs in repair scheduling via assertUnderMaxCandidates.
 */
export function registerWikiCandidate(
  host: WikiCandidateHost,
  input: RegisterWikiCandidateInput,
): WikiCandidate {
  const round = input.round ?? nextCandidateRound(host, input.runId);
  const shortDigest = input.digest.slice(0, 12);
  const candidateId = input.candidateId ?? `cand-${round}-${shortDigest}`;
  const createdAt = input.createdAt ?? now();

  let parentCandidateId = input.parentCandidateId;
  if (parentCandidateId === undefined && input.producedBy !== "write") {
    parentCandidateId = latestWikiCandidate(host, input.runId)?.candidateId;
  }

  host.db
    .prepare(
      `INSERT INTO wiki_candidates (
         run_id, candidate_id, digest, artifact_id, parent_candidate_id,
         produced_by, round, created_at, producer_node_key, producer_attempt_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, candidate_id) DO NOTHING`,
    )
    .run(
      input.runId,
      candidateId,
      input.digest,
      input.artifactId,
      parentCandidateId ?? null,
      input.producedBy,
      round,
      createdAt,
      input.producerNodeKey ?? null,
      input.producerAttemptId ?? null,
    );

  const row = asRow(
    host.db
      .prepare(`SELECT * FROM wiki_candidates WHERE run_id = ? AND candidate_id = ?`)
      .get(input.runId, candidateId),
  );
  if (!row) {
    throw new Error(`failed to register wiki candidate ${candidateId} for run ${input.runId}`);
  }
  return rowToCandidate(row);
}
