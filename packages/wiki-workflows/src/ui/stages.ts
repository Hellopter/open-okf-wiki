import type { WikiNode, WikiNodeStatus, WikiRunSnapshot } from "../workflow-types.js";
import type { PhaseDisplayStatus } from "./format.js";

export interface WikiWorkflowStage {
  id: string;
  title: string;
  conditional: boolean;
  waitingMessage: string;
}

/**
 * Wiki-specific execution map. The dashboard shows the complete pipeline even
 * before the engine has dynamically queued every subagent.
 */
export const WIKI_WORKFLOW_STAGES: readonly WikiWorkflowStage[] = [
  { id: "inspect", title: "Inspect", conditional: false, waitingMessage: "Waiting for the run to inspect the repository." },
  { id: "source-survey", title: "Source Survey", conditional: false, waitingMessage: "Waiting for repository inspection to complete." },
  { id: "synthesis", title: "Synthesis", conditional: false, waitingMessage: "Waiting for source survey receipts." },
  { id: "targeted-research", title: "Targeted Research", conditional: true, waitingMessage: "Runs only when synthesis identifies an evidence gap." },
  { id: "domain-writing", title: "Domain Writing", conditional: false, waitingMessage: "Waiting for a finalized Wiki specification." },
  { id: "validation", title: "Validation", conditional: false, waitingMessage: "Waiting for domain pages to be written." },
  { id: "global-review", title: "Global Review", conditional: false, waitingMessage: "Waiting for validation to complete." },
  { id: "domain-repair", title: "Domain Repair", conditional: true, waitingMessage: "Runs only when global review finds domain-specific defects." },
  { id: "structural-resynthesis", title: "Structural Re-synthesis", conditional: true, waitingMessage: "Runs only when review finds structural or coverage defects." },
];

export interface WikiPhase {
  id: string;
  title: string;
  nodeIds: string[];
  conditional: boolean;
  waitingMessage: string;
}

export type WikiRunView = WikiRunSnapshot;

/** Group nodes into the declared Wiki workflow stages for display. */
export function phaseRows(run: WikiRunView): WikiPhase[] {
  const phases: WikiPhase[] = WIKI_WORKFLOW_STAGES.map((stage) => ({ ...stage, nodeIds: [] }));
  for (const node of run.nodes) {
    const phase = phases.find((item) => item.id === workflowStageIdFor(node));
    if (phase) phase.nodeIds.push(node.id);
  }
  return phases;
}

export function workflowStageIdFor(node: WikiNode): string | undefined {
  return WIKI_WORKFLOW_STAGES.some((stage) => stage.id === node.phaseId) ? node.phaseId : undefined;
}

export function phaseStatus(phase: WikiPhase, nodes: WikiNode[]): PhaseDisplayStatus {
  if (!nodes.length) return phase.conditional ? "conditional" : "not_started";
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.some((node) => node.status === "blocked")) return "blocked";
  if (nodes.some((node) => node.status === "running")) return "running";
  if (nodes.some((node) => node.status === "queued")) return "queued";
  if (nodes.some((node) => node.status === "invalidated")) return "invalidated";
  if (nodes.every((node) => node.status === "cancelled")) return "cancelled";
  return "succeeded";
}

export function nodesForPhase(run: WikiRunView, phase: WikiPhase): WikiNode[] {
  return phase.nodeIds
    .map((id) => run.nodes.find((node) => node.id === id))
    .filter((node): node is WikiNode => Boolean(node));
}

export function aggregatePhaseStatus(nodes: WikiNode[]): WikiNodeStatus | "empty" {
  if (!nodes.length) return "empty";
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.some((node) => node.status === "blocked")) return "blocked";
  if (nodes.some((node) => node.status === "running")) return "running";
  if (nodes.some((node) => node.status === "queued")) return "queued";
  if (nodes.some((node) => node.status === "invalidated")) return "invalidated";
  if (nodes.every((node) => node.status === "cancelled")) return "cancelled";
  return "succeeded";
}
