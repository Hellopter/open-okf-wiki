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
    "Use only read tools. Narrow investigation; return findings + source paths + open questions.",
    `nodeId=${input.nodeId} runId=${input.runId}`,
  ].join("\n");
}
