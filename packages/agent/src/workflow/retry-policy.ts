/**
 * Pure error classification for Wiki Run child failures.
 *
 * Layering (ADR 0013 / ADR 0035):
 * - L0 Pi settings.retry: in-session transport only (createWikiSession).
 * - L0 compaction: overflow → capacity (not transport-retried).
 * - L_control: WikiRuns may auto-requeue research.leaf/domain ONCE for
 *   failureClass infrastructure|transient only — never capacity|budget|
 *   policy|provider|cancelled. This classifier does not decide requeue;
 *   scheduler.shouldAutoRetryResearch owns that policy.
 * - Manual: RetryFailedNode / RerunNode.
 *
 * Unknown classes fail closed (no default retry).
 */

import type { ErrorClass } from "@okf-wiki/contract";

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
  // capacity (context window) — before budget so "context length" is not misread.
  // Keep aligned with run-scoped-agent overflow detection (shared via this helper).
  if (
    /context (?:window )?overflow/i.test(msg) ||
    /compact-and-retry/i.test(msg) ||
    /context.?length/i.test(msg) ||
    /maximum context/i.test(msg) ||
    /prompt is too long/i.test(msg) ||
    /too many tokens/i.test(msg) ||
    /token limit exceeded/i.test(msg) ||
    /input is too long/i.test(msg) ||
    /exceeds capacity gate/i.test(msg) ||
    /capacity (?:gate|exhausted)/i.test(msg)
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
