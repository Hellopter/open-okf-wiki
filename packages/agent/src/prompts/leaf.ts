/**
 * Leaf research prompt.
 */

export function leafResearchPrompt(input: {
  domainId: string;
  question: string;
  scope: string;
  nodeId: string;
  runId: string;
  /** Freeze / Spec coverage source ids this leaf should prioritize. */
  sourceIds?: readonly string[];
}): string {
  const sourceBlock =
    input.sourceIds && input.sourceIds.length > 0
      ? [
          `Coverage sources for this leaf: ${input.sourceIds.join(", ")}.`,
          "Prefer evidence under the matching sources/<id>/ mounts; multi-source citations use repo:<id>/path.",
        ]
      : [];
  return [
    `Leaf research under domain ${input.domainId}`,
    `Scope: ${input.scope}`,
    `Question: ${input.question}`,
    ...sourceBlock,
    "",
    "Read skill/references/leaf-research.md in full before investigating.",
    "Use only read tools. Narrow investigation; return findings + source paths + open questions.",
    `nodeId=${input.nodeId} runId=${input.runId}`,
  ].join("\n");
}
