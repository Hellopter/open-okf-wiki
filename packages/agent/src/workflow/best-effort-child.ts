/**
 * Best-effort child runner: catch non-abort failures, classify, and return
 * a result shape instead of throwing. AbortError always rethrows.
 */

import type { ErrorClass } from "@okf-wiki/contract/wiki-runs";
import { classifyError } from "./retry-policy.js";

export type BestEffortResult<T> =
  | { ok: true; value: T }
  | { ok: false; errorClass?: ErrorClass; message: string };

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

/**
 * Run a child body once. On success returns { ok: true, value }.
 * On non-abort failure returns { ok: false, errorClass?, message }.
 * AbortError (or aborted signal) is rethrown.
 */
export async function runBestEffortChild<T>(input: {
  run: () => Promise<T>;
  abortSignal?: AbortSignal;
}): Promise<BestEffortResult<T>> {
  try {
    const value = await input.run();
    return { ok: true, value };
  } catch (err) {
    if (isAbortError(err, input.abortSignal)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const errorClass = classifyError(err);
    return errorClass !== undefined ? { ok: false, errorClass, message } : { ok: false, message };
  }
}
