/**
 * Publication effect cancel / applying reconcile (ADR 0035).
 * Owner binds db/workspace/transaction/emit — effects stay free of WikiRunsOwner.
 */

import path from "node:path";
import { reconcilePublicationApply, runWorkDir } from "@okf-wiki/core";
import { now } from "./crypto-util.js";
import type { WikiRunsTxCtx } from "./ctx.js";
import { asRow, asRows, requiredText } from "./sql.js";

export type EffectsHost = WikiRunsTxCtx & {
  closed: boolean;
};

export function cancelPreApplyEffects(host: Pick<EffectsHost, "db">, runId: string): void {
  host.db
    .prepare(
      `UPDATE effects SET state = 'cancelled'
       WHERE run_id = ? AND state IN ('prepared', 'candidate_ready')`,
    )
    .run(runId);
}

export function cancelPreApplyEffectsForPublication(
  host: Pick<EffectsHost, "db" | "emit">,
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
export async function reconcileApplyingEffects(host: EffectsHost): Promise<void> {
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
  host: EffectsHost,
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
