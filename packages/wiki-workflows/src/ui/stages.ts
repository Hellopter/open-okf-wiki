import type { WikiNode, WikiNodeStatus, WikiRunSnapshot } from "../workflow-types.js";
import {
  WIKI_WORKFLOW_PHASES,
  WIKI_WORKFLOW_STAGES,
  type WikiWorkflowStage,
} from "../workflow-phases.js";
import type { PhaseDisplayStatus } from "./format.js";

export type { WikiWorkflowStage };
export { WIKI_WORKFLOW_PHASES, WIKI_WORKFLOW_STAGES };

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
