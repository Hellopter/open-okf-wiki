/**
 * Pure retry policy for Run Workflow node failures.
 *
 * Maps errorClass → action; runNodeAttempt applies the decision.
 * L2 (workflow) never retries transient or capacity failures — L0 Pi
 * already handles transport retries, and capacity needs a new strategy
 * (not a blind session reopen). Unknown classes fail closed (no default retry).
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
  if (cls === "policy" || cls === "budget" || cls === "capacity" || cls === "infrastructure") {
    const reasons: Record<string, string> = {
      budget: "budget exhausted",
      policy: "policy violation",
      capacity: "context capacity exhausted",
      infrastructure: "infrastructure failure",
    };
    return { action: "fail", delayMs: 0, reason: reasons[cls] ?? `${cls}: no retry` };
  }
  if (cls === "schema" || cls === "quality") {
    // Quality/schema: one repair-style retry at most, then fail closed.
    if (attemptIndex + 1 < maxAttempts) {
      return { action: "retry", delayMs: 0, reason: `${cls}: retry once` };
    }
    return { action: "fail", delayMs: 0, reason: `${cls}: retries exhausted` };
  }
  if (cls === "transient") {
    // L0 Pi already retried transport; L2 must not open a new session.
    return { action: "fail", delayMs: 0, reason: "transient: L0 already retried" };
  }
  // unknown (undefined class) → fail closed; do not default-retry
  return {
    action: "fail",
    delayMs: 0,
    reason: input.message?.trim() || "unknown error class: no retry",
  };
}

/** Whether a critical domain failure should abort the whole produce body. */
export function isCriticalDomainFailure(critical: boolean | undefined): boolean {
  return critical !== false;
}

const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /\b(?:429|500|502|503|529)\b/,
  /\btimed?.?out\b/i,
  /\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|\bENOTFOUND\b|\bEPIPE\b/,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
  /\boverloaded\b/i,
  /service unavailable/i,
  /bad gateway/i,
  /internal server error/i,
  /connection (?:closed|reset|refused|error)/i,
];

/**
 * Best-effort error-message → ErrorClass mapping for failed node attempts.
 * Priority: empty → capacity → budget → policy → transient → undefined.
 * Pure: no I/O, no Pi.
 */
export function classifyAgentFailure(message: string | undefined): ErrorClass | undefined {
  const msg = message?.trim();
  if (!msg) return undefined;
  // capacity (context window) — before budget so "context length" is not misread
  if (
    /context overflow/i.test(msg) ||
    /compact-and-retry/i.test(msg) ||
    /context.?length/i.test(msg) ||
    /maximum context/i.test(msg) ||
    /prompt is too long/i.test(msg) ||
    /too many tokens/i.test(msg) ||
    /token limit exceeded/i.test(msg) ||
    /input is too long/i.test(msg) ||
    /exceeds capacity gate/i.test(msg)
  ) {
    return "capacity";
  }
  // budget: token budget + wall-clock "timed out after N" / workspace request timeout
  if (
    /budget exhausted|token budget/i.test(msg) ||
    /timed out after \d+/i.test(msg) ||
    /workspace request timeout/i.test(msg)
  ) {
    return "budget";
  }
  // policy: align with Pi non-retryable billing/quota failures
  if (/insufficient_quota|out of budget|quota exceeded|billing/i.test(msg)) {
    return "policy";
  }
  if (TRANSIENT_PATTERNS.some((p) => p.test(msg))) return "transient";
  return undefined;
}

/**
 * Classify a thrown value: structured errorClass / named types first, then message patterns.
 */
export function classifyError(err: unknown): ErrorClass | undefined {
  if (err && typeof err === "object" && "errorClass" in err) {
    const cls = (err as { errorClass?: unknown }).errorClass;
    if (
      cls === "transient" ||
      cls === "schema" ||
      cls === "quality" ||
      cls === "policy" ||
      cls === "budget" ||
      cls === "needs_input" ||
      cls === "capacity" ||
      cls === "infrastructure"
    ) {
      return cls;
    }
  }
  if (err instanceof Error) {
    const name = err.name;
    if (name === "CapacityError") return "capacity";
    if (name === "BudgetError") return "budget";
    if (name === "InfrastructureError") return "infrastructure";
  }
  const message = err instanceof Error ? err.message : err != null ? String(err) : undefined;
  return classifyAgentFailure(message);
}
