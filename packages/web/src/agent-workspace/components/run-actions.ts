import type { WikiRunState } from "@okf-wiki/contract";

const CANCELLABLE_STATES: ReadonlySet<WikiRunState> = new Set([
  "queued",
  "running",
  "cancelling",
]);

/** A receipt can arrive before its first snapshot, so an unknown state stays cancellable. */
export function isRunCancellable(state: WikiRunState | undefined, hasError: boolean): boolean {
  return !hasError && (state === undefined || CANCELLABLE_STATES.has(state));
}
