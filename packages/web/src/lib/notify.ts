import { toast } from "sonner";

/** Default stay for action errors — long enough to read and act. */
const ERROR_DURATION_MS = 8_000;

/**
 * Coerce unknown failures into a short user-facing string.
 * Shared by toast errors and the load-state ErrorBanner.
 */
export function formatError(error: unknown, unknownLabel = "Unknown error"): string {
  if (!error) {
    return unknownLabel;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Action-result success (non-blocking, top-right). */
export function notifySuccess(message: string): void {
  toast.success(message);
}

/**
 * Action-result failure (non-blocking, top-right).
 * Use for user-triggered writes/commands — not for page load state.
 */
export function notifyError(error: unknown, unknownLabel = "Unknown error"): void {
  toast.error(formatError(error, unknownLabel), { duration: ERROR_DURATION_MS });
}
