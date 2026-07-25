/**
 * Domain progress from Produce — never WikiProduceToolDetails.
 * The wiki_produce tool edge projects this into Pi onUpdate details.
 */

import type {
  MergedDefectReport,
  WikiProduceChildSpan,
  WikiProduceToolDetails,
  WikiRunSpec,
} from "@okf-wiki/contract";

export type ProduceProgress =
  | { kind: "status"; status: WikiProduceToolDetails["status"]; summary?: string }
  | { kind: "phase"; summary: string }
  | { kind: "pages"; pages: string[] }
  | { kind: "spec"; spec: WikiRunSpec }
  | { kind: "child"; span: WikiProduceChildSpan }
  | { kind: "defects"; defects: MergedDefectReport; summary?: string }
  | { kind: "runId"; runId: string };

/** Mutable accumulator used only at the wiki_produce tool edge. */
export type ToolDetailsAccumulator = {
  /** Live details object (mutated in place for gate/status patches). */
  details: WikiProduceToolDetails;
  apply(progress: ProduceProgress): void;
  toPartial(): { content: Array<{ type: "text"; text: string }>; details: WikiProduceToolDetails };
};

function mergeChildren(
  existing: WikiProduceChildSpan[] | undefined,
  incoming: WikiProduceChildSpan | undefined,
): WikiProduceChildSpan[] | undefined {
  if (!incoming) return existing;
  const byId = new Map((existing ?? []).map((c) => [c.id, c]));
  byId.set(incoming.id, incoming);
  return [...byId.values()].slice(-32);
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
    ...(initial?.children ? { children: initial.children } : {}),
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
        case "child":
          details.children = mergeChildren(details.children, progress.span);
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
      // Snapshot: Pi onUpdate subscribers and tests must not see later mutations.
      const snapshot: WikiProduceToolDetails = {
        status: details.status,
        ...(details.runId ? { runId: details.runId } : {}),
        ...(details.summary !== undefined ? { summary: details.summary } : {}),
        ...(details.spec ? { spec: details.spec } : {}),
        ...(details.pages ? { pages: [...details.pages] } : {}),
        ...(details.defects !== undefined ? { defects: details.defects } : {}),
        ...(details.children ? { children: [...details.children] } : {}),
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
