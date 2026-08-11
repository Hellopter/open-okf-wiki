/**
 * Wiki workflow failure vocabulary and classification helpers.
 *
 * Pure module: no @earendil-works/* imports. Single source of truth for
 * durable node error codes used by engine, node-retry, and snapshots.
 */

/** Stable failure codes recorded on nodes and used by retry / terminal policy. */
export type WikiNodeErrorCode =
  | "missing_submission"
  | "invalid_submission"
  | "submission_too_large"
  | "validator_infrastructure"
  | "context_budget_exceeded"
  | "execution_failed"
  | "cancelled"
  | "research_rounds_exhausted"
  | "expand_rounds_exhausted"
  | "audit_rounds_exhausted"
  | "same_defects_twice"
  | "same_validation_twice"
  | "unroutable_validation"
  | "repair_no_progress"
  | "source_drift_blocked"
  | "structural_resynthesis_budget"
  | "local_repair_budget"
  | "missing_handoff_artifacts"
  | "snapshot_incompatible";

/** Alias kept for callers that prefer the failures-domain name. */
export type WikiFailureCode = WikiNodeErrorCode;

/** Coarse class for routing / metrics; not persisted as a separate field today. */
export type WikiFailureClass =
  | "transient"
  | "protocol"
  | "semantic"
  | "budget"
  | "policy"
  | "cancelled";

export interface WikiFailure {
  message: string;
  code: WikiNodeErrorCode;
  class: WikiFailureClass;
  details?: Record<string, unknown>;
  retryable: boolean;
}

/** Budget codes that block the run (not retryable agent attempts). */
export const WIKI_BUDGET_EXHAUSTED_CODES = [
  "research_rounds_exhausted",
  "expand_rounds_exhausted",
  "audit_rounds_exhausted",
] as const satisfies readonly WikiNodeErrorCode[];

export type WikiBudgetExhaustedCode = (typeof WIKI_BUDGET_EXHAUSTED_CODES)[number];

/**
 * Thrown when a research/expand/audit round ceiling is hit.
 * Classification keys off `code`, never message text.
 */
export class WikiBudgetExhaustedError extends Error {
  readonly code: WikiBudgetExhaustedCode;
  readonly class = "budget" as const;
  readonly retryable = false;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: WikiBudgetExhaustedCode = "research_rounds_exhausted",
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WikiBudgetExhaustedError";
    this.code = code;
    this.details = details;
  }

  toFailure(): WikiFailure {
    return {
      message: this.message,
      code: this.code,
      class: this.class,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isWikiBudgetExhaustedCode(code: unknown): code is WikiBudgetExhaustedCode {
  return code === "research_rounds_exhausted"
    || code === "expand_rounds_exhausted"
    || code === "audit_rounds_exhausted";
}

/** True for WikiBudgetExhaustedError or duck-typed `{ code: budget… }`. */
export function isWikiBudgetExhaustedError(error: unknown): boolean {
  if (error instanceof WikiBudgetExhaustedError) return true;
  if (!error || typeof error !== "object") return false;
  return isWikiBudgetExhaustedCode((error as { code?: unknown }).code);
}

export function budgetExhaustedCode(error: unknown): WikiBudgetExhaustedCode {
  if (error instanceof WikiBudgetExhaustedError) return error.code;
  if (error && typeof error === "object" && isWikiBudgetExhaustedCode((error as { code?: unknown }).code)) {
    return (error as { code: WikiBudgetExhaustedCode }).code;
  }
  return "research_rounds_exhausted";
}

/**
 * Thrown when wiki validation cannot run because of infrastructure (missing
 * roots, unsafe tree IO setup, etc.), not because page content is invalid.
 * Callers should map this to `validator_infrastructure`, not content issues.
 */
export class WikiValidationInfrastructureError extends Error {
  readonly code = "validator_infrastructure" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WikiValidationInfrastructureError";
  }
}

export function isWikiValidationInfrastructureError(error: unknown): error is WikiValidationInfrastructureError {
  return error instanceof WikiValidationInfrastructureError
    || (!!error && typeof error === "object" && (error as { name?: unknown }).name === "WikiValidationInfrastructureError");
}
