/**
 * Host callbacks for mechanical node execution.
 * Owner binds db/workspace/transaction/emit — mechanical stays free of WikiRunsOwner.
 */

import path from "node:path";
import type { WikiRunsTxCtx } from "../ctx.js";
import { asRow, requiredText } from "../sql.js";
import type { ClaimedNode, TrustedFrozenInputs } from "../types.js";

export type MechanicalHost = WikiRunsTxCtx & {
  trustedPinnedInputs(runId: string): TrustedFrozenInputs | undefined;
  currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
  reconcileApplyingEffect(input: {
    effectKey: string;
    runId: string;
    candidateArtifactId: string;
    candidateDigest: string;
    expectedLiveDigest: string;
  }): Promise<void>;
};

/** Resolve a sealed attempt input role to an absolute path under the run dir. */
export function sealedInputPath(
  host: MechanicalHost,
  claim: ClaimedNode,
  runDir: string,
  role: string,
): string | undefined {
  const row = asRow(
    host.db
      .prepare(
        `SELECT artifacts.relative_path
         FROM attempt_inputs
         JOIN artifacts ON artifacts.artifact_id = attempt_inputs.artifact_id
         WHERE attempt_inputs.attempt_id = ? AND attempt_inputs.role = ?`,
      )
      .get(claim.attemptId, role),
  );
  if (!row) return undefined;
  return path.join(runDir, requiredText(row, "relative_path"));
}
