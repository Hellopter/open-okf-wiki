/**
 * Review council lens prompts.
 */

export function reviewerPrompt(input: {
  pages: string[];
  lens: "grounding" | "coverage" | "consistency" | "general";
}): string {
  const lensHint = {
    grounding: "Focus on claims without resolvable Source Citations or invented APIs.",
    coverage: "Focus on Spec questions unanswered and missing critical pages.",
    consistency: "Focus on contradictions across pages and term drift.",
    general: "Review Staging Wiki under wiki/ against sources/ and skill/references/review.md.",
  }[input.lens];

  return [
    lensHint,
    "Return JSON: { clean: boolean, defects: [{ severity, code, path, issue }], summary }.",
    "severity is blocking | major | minor.",
    `Pages present: ${input.pages.join(", ") || "(none)"}`,
  ].join("\n");
}
