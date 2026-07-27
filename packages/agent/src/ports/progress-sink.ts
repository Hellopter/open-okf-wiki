/**
 * Live progress emission port (wiki_produce onUpdate / tests).
 *
 * Event shape uses contract types only — no produce/ or pi/ imports.
 */

import type {
  GraphNodeDef,
  MergedDefectReport,
  NodeAttempt,
  RunGraphSnapshot,
  WikiProduceToolDetails,
  WikiRunSpec,
} from "@okf-wiki/contract";

/** Domain progress from Run Workflow — single protocol for tool edge + sink. */
export type ProduceProgress =
  | { kind: "status"; status: WikiProduceToolDetails["status"]; summary?: string }
  | { kind: "phase"; summary: string }
  | { kind: "pages"; pages: string[] }
  | { kind: "spec"; spec: WikiRunSpec }
  | { kind: "attempt"; attempt: NodeAttempt }
  | { kind: "graph"; graph: RunGraphSnapshot }
  /** Set/replace topology without wiping append-only attempts. */
  | { kind: "topology"; topology: GraphNodeDef[]; topologyVersion?: number }
  | { kind: "defects"; defects: MergedDefectReport; summary?: string }
  | { kind: "runId"; runId: string };

export interface ProgressSink {
  emit(progress: ProduceProgress): void;
}

/** Adapt a callback into ProgressSink. */
export function progressSinkFromCallback(
  onProgress?: (progress: ProduceProgress) => void,
): ProgressSink {
  return {
    emit(progress) {
      emitProgress(onProgress, progress);
    },
  };
}

/** Safe fan-out for optional onProgress callbacks (display must not break the run). */
export function emitProgress(
  onProgress: ((p: ProduceProgress) => void) | undefined,
  progress: ProduceProgress,
): void {
  try {
    onProgress?.(progress);
  } catch {
    // Display subscribers must not break the Wiki Run.
  }
}
