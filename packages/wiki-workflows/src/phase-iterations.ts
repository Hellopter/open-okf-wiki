import type { WikiNode } from "./workflow-types.js";

/**
 * Static phase ids group the whole workflow for display. Phase retry instead
 * targets only the most recent execution iteration in that display group.
 */
export function latestPhaseIteration(nodes: readonly WikiNode[], phaseId: string): WikiNode[] {
  const phaseNodes = nodes.filter((node) => node.phaseId === phaseId);
  if (!phaseNodes.length) return [];
  const latest = phaseNodes.at(-1)!;
  const key = iterationKey(latest, phaseId);
  if (!key && (phaseId === "source-survey" || phaseId === "targeted-research")) return phaseNodes;
  if (!key) return [latest];
  return phaseNodes.filter((node) => iterationKey(node, phaseId) === key);
}

function iterationKey(node: WikiNode, phaseId: string): string | undefined {
  if (phaseId === "source-survey" || phaseId === "targeted-research") {
    const batch = numberField(node.input, "batch");
    return batch === undefined ? undefined : `research:${batch}`;
  }
  if (phaseId === "domain-writing") {
    const synthesisNodeId = stringField(node.input, "synthesisNodeId");
    return synthesisNodeId ? `synthesis:${synthesisNodeId}` : undefined;
  }
  if (phaseId === "domain-repair") {
    const repairGroupId = stringField(node.input, "repairGroupId");
    return repairGroupId ? `repair:${repairGroupId}` : undefined;
  }
  return undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isInteger(field) ? field : undefined;
}
