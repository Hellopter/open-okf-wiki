/**
 * Leaf research prompt — short task; evidence file seal doctrine.
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
    "Use only read tools (ls, find, grep, read). Narrow investigation; never write wiki pages; never use bash.",
    "",
    "## Evidence file seal doctrine",
    "- Findings authority is the sealed Analysis Receipt file (Host seals after this Attempt).",
    "- Return a **short** control summary only: key findings bullets, source paths with tool-derived line ranges, open questions.",
    "- Do not paste multi-kB source dumps into the final message.",
    "- Do not invent Host tools, handoff JSON schemas, or further delegation.",
    "- Do not change Spec domains/pages — research only.",
    "",
    `nodeId=${input.nodeId} runId=${input.runId}`,
  ].join("\n");
}
