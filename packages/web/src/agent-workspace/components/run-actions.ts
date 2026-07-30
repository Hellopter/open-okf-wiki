import type { WikiRunState } from "@okf-wiki/contract";

const CANCELLABLE_STATES: ReadonlySet<WikiRunState> = new Set(["queued", "running", "cancelling"]);

const TERMINAL_STATES: ReadonlySet<WikiRunState> = new Set([
  "published",
  "cancelled",
  "failed",
  "completed_unpublished",
  "publication_declined",
]);

/** A receipt can arrive before its first snapshot, so an unknown state stays cancellable. */
export function isRunCancellable(state: WikiRunState | undefined, hasError: boolean): boolean {
  return !hasError && (state === undefined || CANCELLABLE_STATES.has(state));
}

export function isTerminalWikiRunState(state: WikiRunState): boolean {
  return TERMINAL_STATES.has(state);
}
