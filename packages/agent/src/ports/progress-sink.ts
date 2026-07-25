/**
 * Live progress emission port (wiki_produce onUpdate / tests).
 * Event shape stays in produce/progress to avoid a second progress protocol.
 */

import type { ProduceProgress } from "../produce/progress.js";

export interface ProgressSink {
  emit(progress: ProduceProgress): void;
}

/** Adapt a callback into ProgressSink. */
export function progressSinkFromCallback(
  onProgress?: (progress: ProduceProgress) => void,
): ProgressSink {
  return {
    emit(progress) {
      try {
        onProgress?.(progress);
      } catch {
        // Display must not break the Wiki Run.
      }
    },
  };
}
