/**
 * Single post-attempt finish hub after a sealed/terminal attempt.
 *
 * Ordered control effects:
 * 1. CAS / terminal attempt+node rows (success: commitNodeArtifacts; failure: fail rows)
 * 2. Success: gates / unlock / EvaluationRound re-arm / run-state
 * 3. Failure: research auto-retry / scheduleMechanicalRepair / recovery / fail run
 *
 * Scheduler claims + executes, then calls commitSuccessfulAttempt / failNode here.
 * Gate open / repair schedule policy lives here — not in the scheduler loop.
 *
 * Layout:
 *   terminal-rows.ts  — attempt/node terminal rows, metrics, orphan prep, emit
 *   run-state.ts      — recomputeRunState / hasWork / published / failed
 *   on-success.ts     — onAttemptSucceeded kind dispatch + commitSuccessfulAttempt
 *   on-failure.ts     — failNode retry/repair/recovery (+ publication_conflict hook)
 *   recover.ts        — recoverPreparedArtifacts
 *   plan-prepare.ts   — preparePlanExecutionPlan
 */

export {
  commitSuccessfulAttempt,
  onAttemptSucceeded,
} from "./on-success.js";
export {
  failNode,
  failureClassOf,
  shouldAutoRetryResearch,
} from "./on-failure.js";
export { recoverPreparedArtifacts } from "./recover.js";
export { preparePlanExecutionPlan } from "./plan-prepare.js";
