/**
 * Mechanical publish — CAS effect to applying, rename under publication lock.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PiAttemptOutcome } from "@okf-wiki/contract";
import { applySealedPublicationCandidate, PublicationConflictError } from "@okf-wiki/core";
import { asRow, parseJson, requiredNumber, requiredText } from "../sql.js";
import { writeConversationTranscript } from "../transcript-io.js";
import type { ClaimedNode } from "../types.js";
import { mechanicalFailed } from "./failed.js";
import type { MechanicalHost } from "./host.js";

export async function mechanicalPublish(
  host: MechanicalHost,
  claim: ClaimedNode,
  workDir: string,
  runDir: string,
): Promise<PiAttemptOutcome> {
  const effect = asRow(
    host.db
      .prepare(
        `SELECT effect_key, state, candidate_artifact_id, candidate_digest, expected_live_digest,
                publication_node_key, publication_node_generation, gate_id
         FROM effects
         WHERE run_id = ? AND state = 'candidate_ready'
         ORDER BY effect_key LIMIT 1`,
      )
      .get(claim.runId),
  );
  if (!effect) {
    return mechanicalFailed({
      claim,
      runDir,
      error: "publish requires a candidate_ready effect",
      failureClass: "infrastructure",
    });
  }
  const effectKey = requiredText(effect, "effect_key");
  const candidateId = requiredText(effect, "candidate_artifact_id");
  const expectedLiveDigest = requiredText(effect, "expected_live_digest");
  const publicationNodeKey = requiredText(effect, "publication_node_key");
  const publicationNodeGeneration = requiredNumber(effect, "publication_node_generation");
  const gateId = requiredText(effect, "gate_id");

  const candidateRow = asRow(
    host.db.prepare("SELECT relative_path FROM artifacts WHERE artifact_id = ?").get(candidateId),
  );
  if (!candidateRow) {
    return mechanicalFailed({
      claim,
      runDir,
      error: "publication candidate artifact missing",
      failureClass: "infrastructure",
    });
  }
  const candidatePath = path.join(runDir, requiredText(candidateRow, "relative_path"));
  const workspace = host.workspaceForRun(claim.runId);
  const publicationPath =
    workspace.publicationPath || path.join(workspace.rootPath, "published-wiki");

  /**
   * Under the publication lock (inside applySealedPublicationCandidate):
   * verify baseline, then CAS candidate_ready → applying BEFORE any rename.
   * Validates cancel_requested, owning generation still current, gate approved.
   */
  const beginApply = (): boolean => {
    let accepted = false;
    host.transaction(() => {
      const run = asRow(
        host.db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?").get(claim.runId),
      );
      if (!run || requiredNumber(run, "cancel_requested") !== 0) return;

      const liveGen = host.currentNodeGeneration(claim.runId, publicationNodeKey);
      if (liveGen !== publicationNodeGeneration) return;

      const gate = asRow(
        host.db
          .prepare(
            `SELECT state, decision_json FROM gates
             WHERE gate_id = ? AND run_id = ? AND kind = 'publication'`,
          )
          .get(gateId, claim.runId),
      );
      if (!gate || requiredText(gate, "state") !== "resolved") return;
      const decision = parseJson<{ decision?: string }>(gate.decision_json);
      if (decision.decision !== "approve") return;

      const cas = host.db
        .prepare(
          `UPDATE effects SET state = 'applying'
           WHERE effect_key = ? AND state = 'candidate_ready'`,
        )
        .run(effectKey);
      if (cas.changes !== 1) return;
      host.emit(claim.runId, "effect.applying");
      accepted = true;
    });
    return accepted;
  };

  try {
    const result = await applySealedPublicationCandidate({
      candidateDir: candidatePath,
      publicationPath,
      expectedLiveDigest,
      effectKey,
      beginApply,
    });

    if (result.status === "conflict") {
      host.transaction(() => {
        host.db
          .prepare(
            `UPDATE effects SET state = 'conflict', observed_outcome = ?
             WHERE effect_key = ? AND state IN ('candidate_ready', 'applying')`,
          )
          .run(
            `PublicationConflict live=${result.liveDigest} expected=${result.expectedLiveDigest}`.slice(
              0,
              4_000,
            ),
            effectKey,
          );
        host.db
          .prepare(
            `UPDATE gates
             SET state = 'open', decision_json = NULL, detail_json = ?, opened_at = ?,
                 opened_revision = (SELECT revision FROM runs WHERE run_id = ?)
             WHERE gate_id = ? AND run_id = ? AND kind = 'publication' AND state = 'resolved'`,
          )
          .run(
            JSON.stringify({
              summary:
                "Publication conflict: the published Wiki changed after this candidate was sealed.",
              expectedLiveDigest: result.expectedLiveDigest,
              observedLiveDigest: result.liveDigest,
            }),
            new Date().toISOString(),
            claim.runId,
            gateId,
            claim.runId,
          );
        host.db
          .prepare(
            `UPDATE nodes SET state = 'waiting', current_attempt_id = NULL
             WHERE run_id = ? AND node_key = 'gate.publication'
               AND generation = (SELECT node_generation FROM gates WHERE gate_id = ?)`,
          )
          .run(claim.runId, gateId);
        host.db
          .prepare(
            "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
          )
          .run(new Date().toISOString(), claim.runId);
        host.emit(claim.runId, "effect.conflict");
        host.emit(claim.runId, "gate.opened");
      });
      return mechanicalFailed({
        claim,
        runDir,
        error: new PublicationConflictError(result.liveDigest, result.expectedLiveDigest).message,
        failureClass: "publication_conflict",
      });
    }

    if (result.status === "aborted") {
      // Cancel or stale generation/gate — leave effect as candidate_ready or cancelled.
      const current = asRow(
        host.db.prepare("SELECT state FROM effects WHERE effect_key = ?").get(effectKey),
      );
      const state = current ? requiredText(current, "state") : "unknown";
      return mechanicalFailed({
        claim,
        runDir,
        error: `publish apply aborted (effect state=${state}; cancel or stale generation/gate)`,
        failureClass: "cancelled",
      });
    }

    host.transaction(() => {
      host.db
        .prepare(
          `UPDATE effects SET state = 'applied', observed_outcome = ?
           WHERE effect_key = ? AND state IN ('applying', 'candidate_ready')`,
        )
        .run(`published:${result.liveDigest}`, effectKey);
      host.emit(claim.runId, "effect.applied");
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "publish failed";
    const current = asRow(
      host.db.prepare("SELECT state FROM effects WHERE effect_key = ?").get(effectKey),
    );
    const state = current ? requiredText(current, "state") : null;
    if (state === "candidate_ready") {
      // Error before CAS — safe to mark failed; live was never mutated.
      host.transaction(() => {
        host.db
          .prepare("UPDATE effects SET state = 'failed', observed_outcome = ? WHERE effect_key = ?")
          .run(message.slice(0, 4_000), effectKey);
        host.emit(claim.runId, "effect.failed");
      });
      return mechanicalFailed({
        claim,
        runDir,
        error: message.slice(0, 4_000),
        failureClass: "infrastructure",
      });
    }
    if (state === "applying") {
      // Crash window after CAS: never guess cancelled/failed. Reconcile against
      // live / sealed candidate / aside markers (ADR 0035).
      try {
        await host.reconcileApplyingEffect({
          effectKey,
          runId: claim.runId,
          candidateArtifactId: candidateId,
          candidateDigest: requiredText(effect, "candidate_digest"),
          expectedLiveDigest,
        });
      } catch {
        // Leave applying for owner reopen recovery.
      }
      const after = asRow(
        host.db
          .prepare("SELECT state, observed_outcome FROM effects WHERE effect_key = ?")
          .get(effectKey),
      );
      const afterState = after ? requiredText(after, "state") : "applying";
      if (afterState === "applied") {
        // Rename actually committed; continue the success path below.
      } else {
        const detail =
          after && typeof after.observed_outcome === "string" && after.observed_outcome
            ? after.observed_outcome
            : message;
        return mechanicalFailed({
          claim,
          runDir,
          error: `publish apply ${afterState}: ${detail}`.slice(0, 4_000),
          failureClass: "infrastructure",
        });
      }
    } else {
      return mechanicalFailed({
        claim,
        runDir,
        error: message.slice(0, 4_000),
        failureClass: "infrastructure",
      });
    }
  }

  const receiptPath = path.join(workDir, "publish-receipt.json");
  await writeFile(
    receiptPath,
    `${JSON.stringify({ schema: 1, effectKey, state: "applied" })}\n`,
    "utf8",
  );
  const transcript = await writeConversationTranscript({
    sessionPath: path.join(runDir, "attempts", claim.attemptId, "session.jsonl"),
    nodeKey: claim.nodeKey,
    summary: "published",
    meta: { effectKey },
  });
  return {
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "receipt", role: "publish_receipt", sourcePath: receiptPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: "published",
  };
}
