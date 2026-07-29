/**
 * Leaf research prompt.
 */

export function leafResearchPrompt(input: {
  domainId: string;
  question: string;
  scope: string;
  nodeId: string;
  runId: string;
}): string {
  return [
    `Leaf research under domain ${input.domainId}`,
    `Scope: ${input.scope}`,
    `Question: ${input.question}`,
    "",
    "Read skill/references/leaf-research.md in full before investigating.",
    "Use only read tools. Narrow investigation; return findings + source paths + open questions.",
    `nodeId=${input.nodeId} runId=${input.runId}`,
  ].join("\n");
}
