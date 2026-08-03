/**
 * Publication Effect state machine in one place (ADR 0035).
 *
 * States (do not rename):
 *   prepared → candidate_ready → applying → applied | conflict | failed
 *   prepared | candidate_ready → cancelled  (pre-apply only; never from applying)
 *   conflict may cancel when operator revises / restarts the candidate path
 *
 * Callers: gate-open (insert prepared), gate-resolve (ready / cancel),
 * publication-control (applying / applied / conflict around sealed apply),
 * mechanical publish (candidate_ready → failed on pre-CAS error), owner recover.
 */

import path from "node:path";
import { reconcilePublicationApply, runWorkDir } from "@okf-wiki/core";
import { now } from "./crypto-util.js";
import type { WikiRunsControl, WikiRunsTxCtx } from "./ctx.js";
import { asRow, asRows, requiredText } from "./sql.js";

/** Control surface for effect transitions (tx + closed). */
export type PublicationEffectControl = Pick<WikiRunsControl, keyof WikiRunsTxCtx | "closed">;

export type PreparedEffectInsert = {
  effectKey: string;
  runId: string;
  publicationNodeKey: string;
  publicationNodeGeneration: number;
  gateId: string;
  requestDigest: string;
  expectedLiveDigest: string;
  candidateArtifactId: string;
  candidateDigest: string;
};

/**
 * Create effect in `prepared` when publication gate opens.
 * Emits `effect.prepared`.
 */
export function insertPreparedEffect(
  host: Pick<PublicationEffectControl, "db" | "emit">,
  input: PreparedEffectInsert,
): void {
  host.db
    .prepare(
      `INSERT INTO effects (
        effect_key, run_id, publication_node_key, publication_node_generation, gate_id, state,
        request_digest, expected_live_digest, candidate_artifact_id, candidate_digest, observed_outcome
      ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, NULL)`,
    )
    .run(
      input.effectKey,
      input.runId,
      input.publicationNodeKey,
      input.publicationNodeGeneration,
      input.gateId,
      input.requestDigest,
      input.expectedLiveDigest,
      input.candidateArtifactId,
      input.candidateDigest,
    );
  host.emit(input.runId, "effect.prepared");
}

/** prepared → candidate_ready (ResolveGate approve). Returns false if CAS misses. */
export function transitionPreparedToCandidateReady(
  host: Pick<PublicationEffectControl, "db" | "emit">,
  runId: string,
  effectKey: string,
): boolean {
  const cas = host.db
    .prepare(
      `UPDATE effects SET state = 'candidate_ready'
       WHERE effect_key = ? AND state = 'prepared'`,
    )
    .run(effectKey);
  if (cas.changes !== 1) return false;
  host.emit(runId, "effect.candidate_ready");
  return true;
}

/** candidate_ready → applying (publish beginApply under lock). Returns false if CAS misses. */
export function transitionCandidateReadyToApplying(
  host: Pick<PublicationEffectControl, "db" | "emit">,
  runId: string,
  effectKey: string,
): boolean {
  const cas = host.db
    .prepare(
      `UPDATE effects SET state = 'applying'
       WHERE effect_key = ? AND state = 'candidate_ready'`,
    )
    .run(effectKey);
  if (cas.changes !== 1) return false;
  host.emit(runId, "effect.applying");
  return true;
}

/**
 * candidate_ready | applying → applied after successful rename.
 * Returns false if the effect was not in an apply-eligible state.
 */
export function transitionToApplied(
  host: Pick<PublicationEffectControl, "db" | "emit">,
  runId: string,
  effectKey: string,
  observedOutcome: string,
): boolean {
  const cas = host.db
    .prepare(
      `UPDATE effects SET state = 'applied', observed_outcome = ?
       WHERE effect_key = ? AND state IN ('applying', 'candidate_ready')`,
    )
    .run(observedOutcome.slice(0, 4_000), effectKey);
  if (cas.changes !== 1) return false;
  host.emit(runId, "effect.applied");
  return true;
}

/**
 * candidate_ready | applying → conflict (live baseline drifted).
 * Returns false if the effect was not in an apply-eligible state.
 */
export function transitionToConflict(
  host: Pick<PublicationEffectControl, "db" | "emit">,
  runId: string,
  effectKey: string,
  observedOutcome: string,
): boolean {
  const cas = host.db
    .prepare(
      `UPDATE effects SET state = 'conflict', observed_outcome = ?
       WHERE effect_key = ? AND state IN ('candidate_ready', 'applying')`,
    )
    .run(observedOutcome.slice(0, 4_000), effectKey);
  if (cas.changes !== 1) return false;
  host.emit(runId, "effect.conflict");
  return true;
}

/**
 * Pre-apply error: candidate_ready → failed (live never mutated).
 * Returns false if not in candidate_ready.
 */
export function transitionCandidateReadyToFailed(
  host: Pick<PublicationEffectControl, "db" | "emit">,
  runId: string,
  effectKey: string,
  observedOutcome: string,
): boolean {
  const cas = host.db
    .prepare(
      `UPDATE effects SET state = 'failed', observed_outcome = ?
       WHERE effect_key = ? AND state = 'candidate_ready'`,
    )
    .run(observedOutcome.slice(0, 4_000), effectKey);
  if (cas.changes !== 1) return false;
  host.emit(runId, "effect.failed");
  return true;
}

/** Cancel a single effect when still pre-apply (or conflict on revise). */
export function cancelEffect(
  host: Pick<PublicationEffectControl, "db">,
  effectKey: string,
  fromStates: readonly string[] = ["prepared", "candidate_ready", "conflict"],
): void {
  if (fromStates.length === 0) return;
  const placeholders = fromStates.map(() => "?").join(", ");
  host.db
    .prepare(
      `UPDATE effects SET state = 'cancelled'
       WHERE effect_key = ? AND state IN (${placeholders})`,
    )
    .run(effectKey, ...fromStates);
}

/** Cancel effects bound to a gate (deny / revise). */
export function cancelEffectsForGate(
  host: Pick<PublicationEffectControl, "db">,
  runId: string,
  gateId: string,
  fromStates: readonly string[] = ["prepared", "candidate_ready", "conflict"],
): void {
  if (fromStates.length === 0) return;
  const placeholders = fromStates.map(() => "?").join(", ");
  host.db
    .prepare(
      `UPDATE effects SET state = 'cancelled'
       WHERE run_id = ? AND gate_id = ? AND state IN (${placeholders})`,
    )
    .run(runId, gateId, ...fromStates);
}

export function cancelPreApplyEffects(
  host: Pick<PublicationEffectControl, "db">,
  runId: string,
): void {
  host.db
    .prepare(
      `UPDATE effects SET state = 'cancelled'
       WHERE run_id = ? AND state IN ('prepared', 'candidate_ready')`,
    )
    .run(runId);
}

export function cancelPreApplyEffectsForPublication(
  host: Pick<PublicationEffectControl, "db" | "emit">,
  runId: string,
  publicationNodeKey: string,
  publicationNodeGeneration: number,
): void {
  const effects = asRows(
    host.db
      .prepare(
        `SELECT effect_key, gate_id FROM effects
         WHERE run_id = ?
           AND publication_node_key = ?
           AND publication_node_generation = ?
           AND state IN ('prepared', 'candidate_ready')`,
      )
      .all(runId, publicationNodeKey, publicationNodeGeneration),
  );
  if (effects.length === 0) return;
  for (const effect of effects) {
    host.db
      .prepare(
        "UPDATE effects SET state = 'cancelled' WHERE effect_key = ? AND state IN ('prepared', 'candidate_ready')",
      )
      .run(requiredText(effect, "effect_key"));
    // Bound publication Gate must not stay open for a cancelled candidate.
    host.db
      .prepare("UPDATE gates SET state = 'withdrawn' WHERE gate_id = ? AND state = 'open'")
      .run(requiredText(effect, "gate_id"));
  }
  host.emit(runId, "gate.withdrawn");
}

/**
 * ADR 0035: effects left in `applying` after a crash are reconciled against
 * live / sealed candidate / aside markers. Never mark them `cancelled`.
 */
export async function reconcileApplyingEffects(host: PublicationEffectControl): Promise<void> {
  const rows = asRows(
    host.db
      .prepare(
        `SELECT effect_key, run_id, candidate_artifact_id, candidate_digest, expected_live_digest
         FROM effects WHERE state = 'applying' ORDER BY effect_key`,
      )
      .all(),
  );
  for (const row of rows) {
    await reconcileApplyingEffect(host, {
      effectKey: requiredText(row, "effect_key"),
      runId: requiredText(row, "run_id"),
      candidateArtifactId: requiredText(row, "candidate_artifact_id"),
      candidateDigest: requiredText(row, "candidate_digest"),
      expectedLiveDigest: requiredText(row, "expected_live_digest"),
    });
  }
}

export async function reconcileApplyingEffect(
  host: PublicationEffectControl,
  input: {
    effectKey: string;
    runId: string;
    candidateArtifactId: string;
    candidateDigest: string;
    expectedLiveDigest: string;
  },
): Promise<void> {
  if (host.closed) return;
  const workspace = host.workspaceForRun(input.runId);
  const runDir = runWorkDir(workspace.rootPath, input.runId);
  const artifact = asRow(
    host.db
      .prepare("SELECT relative_path FROM artifacts WHERE artifact_id = ?")
      .get(input.candidateArtifactId),
  );
  const publicationPath =
    workspace.publicationPath || path.join(workspace.rootPath, "published-wiki");

  let outcome: "applied" | "failed" | "unknown" = "unknown";
  let detail = "applying effect recovered without filesystem evidence";
  if (!artifact) {
    detail = "candidate artifact missing during reconcile";
  } else {
    const candidateDir = path.join(runDir, requiredText(artifact, "relative_path"));
    try {
      const result = await reconcilePublicationApply({
        publicationPath,
        candidateDir,
        candidateDigest: input.candidateDigest,
        expectedLiveDigest: input.expectedLiveDigest,
        effectKey: input.effectKey,
      });
      outcome = result.status;
      detail =
        result.status === "applied"
          ? "reconciled applied"
          : result.status === "failed"
            ? result.reason
            : result.reason;
    } catch (error) {
      outcome = "unknown";
      detail = error instanceof Error ? error.message : "reconcile failed";
    }
  }

  if (host.closed) return;
  host.transaction(() => {
    const current = asRow(
      host.db.prepare("SELECT state FROM effects WHERE effect_key = ?").get(input.effectKey),
    );
    if (!current || requiredText(current, "state") !== "applying") return;
    // applying → applied | failed | unknown only — never cancelled.
    host.db
      .prepare(
        "UPDATE effects SET state = ?, observed_outcome = ? WHERE effect_key = ? AND state = 'applying'",
      )
      .run(outcome, detail.slice(0, 4_000), input.effectKey);
    if (outcome === "applied") {
      host.emit(input.runId, "effect.applied");
      host.db
        .prepare(
          `UPDATE runs SET state = 'published', updated_at = ?
           WHERE run_id = ? AND cancel_requested = 0
             AND state NOT IN ('published', 'cancelled', 'failed', 'completed_unpublished')`,
        )
        .run(now(), input.runId);
      const run = asRow(
        host.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(input.runId),
      );
      if (run && requiredText(run, "state") === "published") {
        host.emit(input.runId, "run.published");
      }
    } else if (outcome === "failed") {
      host.emit(input.runId, "effect.failed");
    } else {
      host.emit(input.runId, "effect.unknown");
    }
  });
}
