/**
 * Sole attempt-edge failure classifier for disposable Pi Attempts.
 *
 * **Single entry:** all thrown values that become `PiAttemptOutcome.failed`
 * must go through `classifyPiFailureClass` / `failure` in this module.
 * Do not re-implement message → failureClass maps in handlers or the executor.
 *
 * **Layering (dual taxonomies, no contract merge):**
 * - `workflow/retry-policy` owns pure `ErrorClass` for research L_control
 *   auto-retry (`classifyError` / `classifyAgentFailure`).
 * - This module owns `PiAttemptFailureClass` for one Attempt outcome.
 * - Always call `classifyError` first; map to Pi enum; only then apply
 *   Pi-specific message fallbacks (provider auth, bare "capacity", credits).
 *
 * ## ErrorClass → PiAttemptFailureClass map
 *
 * | Source / ErrorClass              | PiAttemptFailureClass | Notes |
 * |----------------------------------|-----------------------|-------|
 * | AbortSignal / AbortError         | cancelled             | Operator cancel; never budget |
 * | capacity                         | capacity              | Overflow / compact exhausted; not transport |
 * | budget                           | budget                | Token budget + wall-clock timeout |
 * | policy                           | budget                | Quota/billing folds into Pi budget enum |
 * | transient                        | infrastructure        | L0 transport already exhausted in-session |
 * | infrastructure                   | infrastructure        | Host / runtime failures |
 * | schema / quality / needs_input   | infrastructure        | Product schema gates live on WikiRuns, not Pi edge |
 * | (message) provider/auth          | provider              | Stable credential / model-not-found (Pi-edge only) |
 * | (unclassified)                   | infrastructure        | Fail closed |
 *
 * Capacity must never look like transport. Transport (429/5xx/overload/network)
 * maps to infrastructure so L_control may requeue research once.
 */

import type { PiAttemptFailureClass } from "@okf-wiki/contract/pi-attempt";
import { type PiAttemptOutcome, PiAttemptOutcomeSchema } from "@okf-wiki/contract/pi-attempt";
import { redactSensitiveText } from "../../redact/index.js";
import { classifyError } from "../../workflow/retry-policy.js";
import { bounded } from "./shared.js";

/**
 * Map a thrown value to PiAttemptFailureClass.
 *
 * Order:
 * 1. Abort → cancelled
 * 2. Shared structured / named classification via `classifyError`
 * 3. Pi-edge message fallbacks (capacity extras, budget/credits, transport, provider)
 * 4. Fail closed as infrastructure
 */
export function classifyPiFailureClass(error: unknown, signal: AbortSignal): PiAttemptFailureClass {
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return "cancelled";
  }

  // Shared structured / named classification (CapacityError, BudgetError, errorClass, …).
  const shared = classifyError(error);
  if (shared === "capacity") return "capacity";
  if (shared === "budget") return "budget";
  // ErrorClass "policy" (quota/billing) folds to budget for the Pi enum.
  if (shared === "policy") return "budget";
  if (shared === "infrastructure") return "infrastructure";
  // ErrorClass "transient" has no PiAttemptOutcome twin — infrastructure is the
  // control-plane equivalent after L0 transport exhaustion.
  if (shared === "transient") return "infrastructure";
  // schema/quality/needs_input stay fail-closed as infrastructure at the Pi edge
  // (WikiRuns mechanical gates own product "schema" outcomes separately).
  if (shared === "schema" || shared === "quality" || shared === "needs_input") {
    return "infrastructure";
  }

  const message = bounded(error instanceof Error ? error.message : error);
  const lower = message.toLowerCase();

  // Capacity first — context overflow / compact exhausted (not transport).
  // Extra patterns beyond classifyAgentFailure (e.g. bare "capacity").
  if (
    /context overflow|context.?length|maximum context|prompt is too long|context_length|too many tokens|token limit exceeded|input is too long|compact-and-retry|exceeds capacity gate|\bcapacity\b/i.test(
      lower,
    )
  ) {
    return "capacity";
  }
  // Budget / wall-clock / quota (policy-ish billing folded to budget for Pi enum).
  if (
    /budget exhausted|token budget|timed out after \d+|workspace request timeout|insufficient_quota|quota exceeded|billing|out of (?:budget|credits?)|\bcredits?\b/i.test(
      lower,
    )
  ) {
    return "budget";
  }
  // Transport / overload → infrastructure (L_control may auto-requeue research).
  if (
    /rate.?limit|too many requests|\b(?:429|500|502|503|529)\b|overloaded|temporar(?:y|ily) unavailable|service unavailable|bad gateway|internal server error|econnreset|etimedout|econnrefused|eai_again|enotfound|epipe|socket hang up|fetch failed|network error|connection (?:closed|reset|refused|error)/i.test(
      lower,
    )
  ) {
    return "infrastructure";
  }
  // Stable provider / auth failures.
  if (
    /credential|api key|authentication|unauthori[sz]ed|forbidden|invalid.?api|model not found/i.test(
      lower,
    )
  ) {
    return "provider";
  }
  return "infrastructure";
}

/** Build a typed failed PiAttemptOutcome from a thrown value + abort signal. */
export function failure(error: unknown, signal: AbortSignal): PiAttemptOutcome {
  const message = bounded(
    redactSensitiveText(error instanceof Error ? error.message : String(error)),
  );
  const failureClass = classifyPiFailureClass(error, signal);
  return PiAttemptOutcomeSchema.parse({ type: "failed", error: message, failureClass });
}
