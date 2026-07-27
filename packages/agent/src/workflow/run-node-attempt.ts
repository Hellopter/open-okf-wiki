/**
 * Retry executor for Run Workflow node attempts (wires retry-policy).
 *
 * Phases pass the attempt body; this consults classifyAgentFailure +
 * decideNodeRetry per failure. AbortError always rethrows immediately.
 * onExhausted controls exhausted / non-retryable outcomes: "throw" rethrows
 * the last error; a function returns a fallback value (e.g. fail-closed
 * reviewer defect text). No Pi imports — pure control flow.
 */

import type { AttemptRole, NodeAttempt } from "@okf-wiki/contract";
import { classifyAgentFailure, decideNodeRetry, type RetryDecision } from "./retry-policy.js";

export type RunNodeAttemptOptions<T> = {
  abortSignal?: AbortSignal;
  maxAttempts: number;
  nodeKey: string;
  role?: AttemptRole;
  attemptId: (attemptIndex: number) => string;
  run: (attemptIndex: number) => Promise<T>;
  /** Optional attempt lifecycle observer; phases usually pass onProgress into runAgent instead. */
  onAttempt?: (span: NodeAttempt) => void;
  onExhausted: "throw" | ((err: unknown, ctx: { attemptIndex: number; message: string }) => T);
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

function emitAttempt(
  onAttempt: RunNodeAttemptOptions<unknown>["onAttempt"],
  span: NodeAttempt,
): void {
  if (!onAttempt) return;
  try {
    onAttempt(span);
  } catch {
    // observers must not break the attempt loop
  }
}

/**
 * Run one node body with policy-driven retries.
 * The caller owns attempt identity via attemptId / nodeKey / runIndex.
 */
export async function runNodeAttempt<T>(opts: RunNodeAttemptOptions<T>): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts);
  for (let attemptIndex = 0; ; attemptIndex++) {
    const id = opts.attemptId(attemptIndex);
    try {
      emitAttempt(opts.onAttempt, {
        attemptId: id,
        nodeKey: opts.nodeKey,
        runIndex: attemptIndex,
        ...(opts.role !== undefined ? { role: opts.role } : {}),
        status: "running",
      });
      const result = await opts.run(attemptIndex);
      emitAttempt(opts.onAttempt, {
        attemptId: id,
        nodeKey: opts.nodeKey,
        runIndex: attemptIndex,
        ...(opts.role !== undefined ? { role: opts.role } : {}),
        status: "done",
      });
      return result;
    } catch (err) {
      if (isAbortError(err, opts.abortSignal)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      emitAttempt(opts.onAttempt, {
        attemptId: id,
        nodeKey: opts.nodeKey,
        runIndex: attemptIndex,
        ...(opts.role !== undefined ? { role: opts.role } : {}),
        status: "error",
        summary: message.slice(0, 4000),
        errorClass: classifyAgentFailure(message),
      });
      const decision = decideNodeRetry({
        errorClass: classifyAgentFailure(message),
        attemptIndex,
        maxAttempts,
        message,
      });
      if (decision.action !== "retry") {
        if (opts.onExhausted === "throw") throw err;
        return opts.onExhausted(err, { attemptIndex, message });
      }
      try {
        opts.onRetry?.({ attemptIndex, decision, message });
      } catch {
        // observers must not break the retry loop
      }
      await sleepWithAbort(decision.delayMs, opts.abortSignal);
      if (opts.abortSignal?.aborted) throw err;
    }
  }
}
