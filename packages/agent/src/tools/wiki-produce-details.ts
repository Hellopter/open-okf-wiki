/**
 * Tool-edge accumulator for ProduceProgress → WikiProduceToolDetails.
 * Graph authority lives in workflow RunGraphOwner; this only projects
 * status/meta fields and whole-graph replacements (kind "graph").
 */

import type { RunGraphSnapshot, WikiProduceToolDetails } from "@okf-wiki/contract";
import type { ProduceProgress } from "../ports/progress-sink.js";

/** Mutable accumulator used only at the wiki_produce / wiki_repair tool edge. */
export type ToolDetailsAccumulator = {
  /** Live details object (mutated in place for gate/status patches). */
  details: WikiProduceToolDetails;
  apply(progress: ProduceProgress): void;
  toPartial(): { content: Array<{ type: "text"; text: string }>; details: WikiProduceToolDetails };
};

function cloneGraph(graph: RunGraphSnapshot): RunGraphSnapshot {
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
        case "attempt":
        case "topology":
          // Graph authority is RunGraphOwner; tool edge only accepts kind "graph".
          break;
        case "graph":
          details.graph = cloneGraph(progress.graph);
          break;
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
        ...(details.graph ? { graph: cloneGraph(details.graph) } : {}),
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
