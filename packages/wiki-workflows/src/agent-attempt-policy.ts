import type { WikiDelegateError, WikiTaskFailureCode } from "./delegate-contracts.js";
import { budgetExhaustedCode, isWikiBudgetExhaustedError } from "./failures.js";

export type WikiAttemptDecision =
  | { action: "retry"; failure: WikiDelegateError; delayMs: number }
  | { action: "pause" | "fail"; failure: WikiDelegateError };

/** Pure, shared Lead/Leaf attempt decision including classification and full jitter. */
export function decideWikiAgentAttempt(input: {
  error: unknown;
  attempt: number;
  maxAttempts: number;
  aborted?: boolean;
  baseRetryDelayMs?: number;
  random?: () => number;
}): WikiAttemptDecision {
  const { attempt, maxAttempts } = input;
  const baseRetryDelayMs = input.baseRetryDelayMs ?? 1_000;
  if (!Number.isInteger(attempt) || attempt < 1 || !Number.isInteger(maxAttempts) || maxAttempts < attempt) {
    throw new Error("Invalid Wiki Agent attempt policy input");
  }
  if (!Number.isFinite(baseRetryDelayMs) || baseRetryDelayMs < 0) throw new Error("baseRetryDelayMs must be non-negative");
  const failure = classifyWikiAttemptFailure(input.error, input.aborted ?? false);
  if (failure.code === "quota" || failure.code === "usage_limit") return { action: "pause", failure };
  if (!failure.retryable || attempt >= maxAttempts) return { action: "fail", failure };
  const cap = baseRetryDelayMs * (2 ** Math.max(0, attempt - 1));
  const sample = (input.random ?? Math.random)();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new Error("Wiki Agent attempt random sample must be between zero and one");
  const delayMs = failure.code === "rate_limit" && failure.retryAfterMs !== undefined
    ? failure.retryAfterMs
    : Math.floor(sample * cap);
  return { action: "retry", failure, delayMs };
}

export function classifyWikiAttemptFailure(error: unknown, aborted = false): WikiDelegateError {
  if (aborted) return classified("cancelled", messageOf(error), false);
  if (isWikiBudgetExhaustedError(error)) return classified(budgetExhaustedCode(error), messageOf(error), false);
  const typed = taskExecutionError(error);
  if (typed?.code) return classified(typed.code, typed.message, retryableCode(typed.code), typed.retryAfterMs);
  const value = error && typeof error === "object" ? error as { code?: unknown; status?: unknown; statusCode?: unknown; retryAfterMs?: unknown } : {};
  const status = numberValue(value.status) ?? numberValue(value.statusCode);
  const code = typeof value.code === "string" ? value.code.toLowerCase() : "";
  const retryAfterMs = numberValue(value.retryAfterMs);
  if (status === 429) return classified("rate_limit", messageOf(error), true, retryAfterMs);
  if (status === 401) return classified("unauthorized", messageOf(error), false);
  if (status === 403) return classified("forbidden", messageOf(error), false);
  if (status !== undefined && status >= 500 && status <= 504) return classified("server_error", messageOf(error), true);
  if (["econnreset", "etimedout", "eai_again"].includes(code)) return classified("network_reset", messageOf(error), true);
  const message = messageOf(error);
  if (/usage limit|quota exceeded|insufficient[_ -]?quota|billing|credit balance/i.test(message)) {
    const failureCode: WikiTaskFailureCode = /billing|credit balance/i.test(message)
      ? "billing" : /usage limit/i.test(message) ? "usage_limit" : "quota";
    return classified(failureCode, message, false, retryAfterMs);
  }
  if (/\b429\b|too many requests|rate limit/i.test(message)) return classified("rate_limit", message, true, retryAfterMs);
  if (/\b50[0-4]\b|internal server error|service unavailable|bad gateway|gateway timeout/i.test(message)) return classified("server_error", message, true);
  if (/econnreset|socket hang up|connection reset/i.test(message)) return classified("network_reset", message, true);
  if (/context (?:window|length)|context.*exhaust|overflow|compaction failed|range of input length should be|4(?:00|13)\s*(?:status code)?\s*\(no body\)/i.test(message)) return classified("context_exhausted", message, true);
  if (/timed? out|timeout/i.test(message)) return classified("timeout", message, true);
  if (/\b401\b|unauthorized|invalid api key/i.test(message)) return classified("unauthorized", message, false);
  if (/\b403\b|forbidden/i.test(message)) return classified("forbidden", message, false);
  if (status === 400 || /\b400\b|bad request/i.test(message)) return classified("server_error", message, true, retryAfterMs);
  if (/invalid request|schema|validation/i.test(message)) return classified(/schema|validation/i.test(message) ? "schema" : "invalid_request", message, false);
  return classified("unknown", message, false);
}

function taskExecutionError(error: unknown): { code?: WikiTaskFailureCode; message: string; retryAfterMs?: number } | undefined {
  if (!error || typeof error !== "object" || (error as { name?: unknown }).name !== "WikiTaskExecutionError") return undefined;
  const value = error as { code?: WikiTaskFailureCode; message?: unknown; options?: { retryAfterMs?: number } };
  return { code: value.code, message: typeof value.message === "string" ? value.message : String(error), retryAfterMs: value.options?.retryAfterMs };
}

function classified(code: WikiTaskFailureCode, message: string, retryable: boolean, retryAfterMs?: number): WikiDelegateError {
  return { code, message, retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

function retryableCode(code: WikiTaskFailureCode): boolean {
  return ["rate_limit", "server_error", "network_reset", "timeout", "context_exhausted"].includes(code);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
