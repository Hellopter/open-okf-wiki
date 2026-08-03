/**
 * Mechanical publish — load sealed candidate, apply under publication lock,
 * then hand control-plane consequences to publication-control.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PiAttemptOutcome } from "@okf-wiki/contract/pi-attempt";
import { applySealedPublicationCandidate, PublicationConflictError } from "@okf-wiki/core";
import type { WikiRunsControl } from "../ctx.js";
import {
  beginPublicationApply,
  onPublicationApplyResult,
  type PublicationApplyBinding,
} from "../publication-control.js";
import {
  transitionCandidateReadyToFailed,
} from "../publication-effect.js";
import { asRow, requiredNumber, requiredText } from "../sql.js";
import { writeConversationTranscript } from "../transcript-io.js";
import type { ClaimedNode } from "../types.js";
import { mechanicalFailed } from "./failed.js";

export async function mechanicalPublish(
  host: WikiRunsControl,
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
  const binding: PublicationApplyBinding = {
    runId: claim.runId,
    effectKey,
    gateId: requiredText(effect, "gate_id"),
    publicationNodeKey: requiredText(effect, "publication_node_key"),
    publicationNodeGeneration: requiredNumber(effect, "publication_node_generation"),
  };

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

  try {
    const result = await applySealedPublicationCandidate({
      candidateDir: candidatePath,
      publicationPath,
      expectedLiveDigest,
      effectKey,
      beginApply: () => beginPublicationApply(host, binding),
    });

    onPublicationApplyResult(host, binding, result);

    if (result.status === "conflict") {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "publish failed";
    const current = asRow(
      host.db.prepare("SELECT state FROM effects WHERE effect_key = ?").get(effectKey),
    );
    const state = current ? requiredText(current, "state") : null;
    if (state === "candidate_ready") {
      // Error before CAS — safe to mark failed; live was never mutated.
      host.transaction(() => {
        transitionCandidateReadyToFailed(host, claim.runId, effectKey, message);
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
