/**
 * Retry executor for Run Workflow node attempts (wires retry-policy T1).
 *
 * Phases pass the attempt body; this consults classifyAgentFailure +
 * decideNodeRetry per failure. AbortError always rethrows immediately;
 * exhausted or non-retryable failures rethrow the last error.
 * No Pi imports — pure control flow over an injected async body.
 */

import { classifyAgentFailure, decideNodeRetry, type RetryDecision } from "./retry-policy.js";

export type AttemptRetryInput<T> = {
  /** Body for one attempt; attemptIndex is 0-based. */
  run: (attemptIndex: number) => Promise<T>;
  /** Total attempt cap (initial + retries). Default 2 = one retry. */
  maxAttempts?: number;
  abortSignal?: AbortSignal;
  /** Observe a granted retry (logging/progress); failures here are ignored. */
  onRetry?: (info: { attemptIndex: number; decision: RetryDecision; message: string }) => void;
};

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run one node body with policy-driven retries.
 * The caller owns attempt identity (spanId/runIndex from attemptIndex).
 */
export async function runAttemptWithRetry<T>(input: AttemptRetryInput<T>): Promise<T> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? 2);
  for (let attemptIndex = 0; ; attemptIndex++) {
    try {
      return await input.run(attemptIndex);
    } catch (err) {
      if (isAbortError(err, input.abortSignal)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const decision = decideNodeRetry({
        errorClass: classifyAgentFailure(message),
        attemptIndex,
        maxAttempts,
        message,
      });
      if (decision.action !== "retry") throw err;
      try {
        input.onRetry?.({ attemptIndex, decision, message });
      } catch {
        // observers must not break the retry loop
      }
      await sleepWithAbort(decision.delayMs, input.abortSignal);
      if (input.abortSignal?.aborted) throw err;
    }
  }
}
