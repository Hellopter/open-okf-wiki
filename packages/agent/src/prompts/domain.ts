/**
 * Domain research prompt.
 */

export function domainResearchPrompt(input: {
  domainId: string;
  title: string;
  scope: string;
  questions: string[];
  nodeId: string;
  runId: string;
}): string {
  return [
    `Domain research: ${input.title} (${input.domainId})`,
    `Scope: ${input.scope}`,
    "Questions:",
    ...(input.questions.length
      ? input.questions.map((q) => `- ${q}`)
      : ["- What are the main boundaries and entry points in this scope?"]),
    "",
    "Use only read tools (ls, find, grep, read). Never write wiki pages.",
    "Return a concise evidence summary:",
    "- key findings (bullet list)",
    "- source paths with line ranges when known from tools",
    "- open questions",
    `Produce will persist this as analysis receipt nodeId=${input.nodeId} runId=${input.runId}.`,
  ].join("\n");
}
