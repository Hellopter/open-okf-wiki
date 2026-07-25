/**
 * Domain progress from Produce / Run Workflow — never a second protocol.
 * The wiki_produce tool edge projects this into Pi onUpdate details.graph.
 */

import type {
  GraphNodeDef,
  MergedDefectReport,
  NodeAttempt,
  RunGraphSnapshot,
  WikiProduceToolDetails,
  WikiRunSpec,
} from "@okf-wiki/contract";
import { emptyRunGraphSnapshot } from "@okf-wiki/contract";

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

/** Mutable accumulator used only at the wiki_produce tool edge. */
export type ToolDetailsAccumulator = {
  /** Live details object (mutated in place for gate/status patches). */
  details: WikiProduceToolDetails;
  apply(progress: ProduceProgress): void;
  toPartial(): { content: Array<{ type: "text"; text: string }>; details: WikiProduceToolDetails };
};

const MAX_LIVE_ATTEMPTS = 256;

/**
 * Upsert by attemptId (streaming updates to the same attempt).
 * New attemptIds append — never wipe prior rounds for the same nodeKey.
 */
export function upsertAttempt(
  graph: RunGraphSnapshot,
  attempt: NodeAttempt,
): RunGraphSnapshot {
  const attempts = [...graph.attempts];
  const idx = attempts.findIndex((a) => a.attemptId === attempt.attemptId);
  if (idx >= 0) attempts[idx] = attempt;
  else attempts.push(attempt);
  return {
    topologyVersion: graph.topologyVersion,
    topology: graph.topology,
    attempts: attempts.slice(-MAX_LIVE_ATTEMPTS),
    playhead: { nodeKey: attempt.nodeKey, attemptId: attempt.attemptId },
  };
}

function snapshotGraph(graph: RunGraphSnapshot | undefined): RunGraphSnapshot | undefined {
  if (!graph) return undefined;
  return {
    topologyVersion: graph.topologyVersion,
    topology: [...graph.topology],
    attempts: [...graph.attempts],
    ...(graph.playhead ? { playhead: { ...graph.playhead } } : {}),
  };
}

export function createToolDetailsAccumulator(
  initial?: Partial<WikiProduceToolDetails>,
): ToolDetailsAccumulator {
  const details: WikiProduceToolDetails = {
    status: initial?.status ?? "producing",
    ...(initial?.runId ? { runId: initial.runId } : {}),
    ...(initial?.summary ? { summary: initial.summary } : {}),
    ...(initial?.spec ? { spec: initial.spec } : {}),
    ...(initial?.pages ? { pages: initial.pages } : {}),
    ...(initial?.defects !== undefined ? { defects: initial.defects } : {}),
    ...(initial?.graph ? { graph: initial.graph } : {}),
  };

  return {
    details,
    apply(progress: ProduceProgress): void {
      switch (progress.kind) {
        case "status":
          details.status = progress.status;
          if (progress.summary !== undefined) details.summary = progress.summary;
          break;
        case "phase":
          details.summary = progress.summary;
          break;
        case "pages":
          details.pages = progress.pages;
          break;
        case "spec":
          details.spec = progress.spec;
          break;
        case "attempt": {
          const base = details.graph ?? emptyRunGraphSnapshot(0);
          details.graph = upsertAttempt(base, progress.attempt);
          break;
        }
        case "graph":
          details.graph = progress.graph;
          break;
        case "topology": {
          const base = details.graph ?? emptyRunGraphSnapshot(0);
          details.graph = {
            topologyVersion:
              progress.topologyVersion ?? Math.max(1, base.topologyVersion + 1),
            topology: progress.topology,
            attempts: base.attempts,
            ...(base.playhead ? { playhead: base.playhead } : {}),
          };
          break;
        }
        case "defects":
          details.defects = progress.defects;
          if (progress.summary !== undefined) details.summary = progress.summary;
          break;
        case "runId":
          details.runId = progress.runId;
          break;
        default: {
          const _exhaustive: never = progress;
          return _exhaustive;
        }
      }
    },
    toPartial() {
      const snapshot: WikiProduceToolDetails = {
        status: details.status,
        ...(details.runId ? { runId: details.runId } : {}),
        ...(details.summary !== undefined ? { summary: details.summary } : {}),
        ...(details.spec ? { spec: details.spec } : {}),
        ...(details.pages ? { pages: [...details.pages] } : {}),
        ...(details.defects !== undefined ? { defects: details.defects } : {}),
        ...(details.graph ? { graph: snapshotGraph(details.graph) } : {}),
      };
      return {
        content: [
          {
            type: "text" as const,
            text: snapshot.summary ?? snapshot.status,
          },
        ],
        details: snapshot,
      };
    },
  };
}

export function emitProduceProgress(
  onProgress: ((p: ProduceProgress) => void) | undefined,
  progress: ProduceProgress,
): void {
  try {
    onProgress?.(progress);
  } catch {
    // Display subscribers must not break the Wiki Run.
  }
}
