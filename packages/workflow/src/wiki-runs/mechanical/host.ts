/**
 * Mechanical node helpers. Execution uses WikiRunsControl (no separate MechanicalHost).
 */

import path from "node:path";
import type { WikiRunsControl } from "../ctx.js";
import { asRow, requiredText } from "../sql.js";
import type { ClaimedNode } from "../types.js";

/** Resolve a sealed attempt input role to an absolute path under the run dir. */
export function sealedInputPath(
  ctrl: Pick<WikiRunsControl, "db">,
  claim: ClaimedNode,
  runDir: string,
  role: string,
): string | undefined {
  const row = asRow(
    ctrl.db
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
