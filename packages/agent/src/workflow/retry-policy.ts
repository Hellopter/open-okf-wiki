/**
 * Pure retry policy for Run Workflow node failures (T1).
 * Maps errorClass → action; research/review phases decide how to apply.
 */

import type { ErrorClass } from "@okf-wiki/contract";

export type RetryAction = "retry" | "fail" | "skip" | "needs_input";

export type RetryDecision = {
  action: RetryAction;
  /** Suggested delay before retry (ms); 0 = immediate. */
  delayMs: number;
  reason: string;
};

const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * Decide whether a failed node attempt should retry.
 * Pure: no I/O, no Pi.
 */
export function decideNodeRetry(input: {
  errorClass?: ErrorClass;
  attemptIndex: number;
  maxAttempts?: number;
  message?: string;
}): RetryDecision {
  const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const attemptIndex = Math.max(0, input.attemptIndex);
  const cls = input.errorClass;

  if (cls === "needs_input") {
    return { action: "needs_input", delayMs: 0, reason: "operator input required" };
  }
  if (cls === "policy" || cls === "budget") {
    return {
      action: "fail",
      delayMs: 0,
      reason: cls === "budget" ? "budget exhausted" : "policy violation",
    };
  }
  if (cls === "schema" || cls === "quality") {
    // Quality/schema: one repair-style retry at most, then fail closed.
    if (attemptIndex + 1 < maxAttempts) {
      return { action: "retry", delayMs: 0, reason: `${cls}: retry once` };
    }
    return { action: "fail", delayMs: 0, reason: `${cls}: retries exhausted` };
  }
  // transient or unknown → retry with small backoff until cap
  if (attemptIndex + 1 < maxAttempts) {
    const delayMs = Math.min(2000, 200 * (attemptIndex + 1));
    return {
      action: "retry",
      delayMs,
      reason: cls === "transient" ? "transient transport" : "unknown error class",
    };
  }
  return {
    action: "fail",
    delayMs: 0,
    reason: input.message?.trim() || "retries exhausted",
  };
}

/** Whether a critical domain failure should abort the whole produce body. */
export function isCriticalDomainFailure(critical: boolean | undefined): boolean {
  return critical !== false;
}
