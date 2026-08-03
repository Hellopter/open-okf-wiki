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
  /** Projected evidence index text (Phase 2). */
  receiptIndex?: string;
  /** Inline child receipt summaries when projected. */
  childReceiptSummaries?: string;
  /** Freeze / Spec coverage source ids this domain should prioritize. */
  sourceIds?: readonly string[];
}): string {
  const evidenceBlock = input.receiptIndex?.trim()
    ? [
        "",
        "## Projected child receipts (prefer these over full re-scan)",
        input.receiptIndex.trim(),
      ]
    : [
        "",
        "## Projected child receipts",
        "Check inputs/evidence/index.json and inputs/evidence/receipts/ when present.",
      ];
  const childBlock = input.childReceiptSummaries?.trim()
    ? ["", "## Child receipt bodies (already loaded)", input.childReceiptSummaries.trim()]
    : [];
  const sourceBlock =
    input.sourceIds && input.sourceIds.length > 0
      ? [
          "",
          `## Coverage sources: ${input.sourceIds.join(", ")}`,
          "Prefer evidence under the matching sources/<id>/ mounts when reconciling findings.",
          "Multi-source claims need repo:<id>/path citations in later wiki pages.",
        ]
      : [];

  return [
    `Domain research: ${input.title} (${input.domainId})`,
    `Scope: ${input.scope}`,
    "Questions:",
    ...(input.questions.length
      ? input.questions.map((q) => `- ${q}`)
      : ["- What are the main boundaries and entry points in this scope?"]),
    ...sourceBlock,
    ...evidenceBlock,
    ...childBlock,
    "",
    "Read skill/references/domain-research.md in full before investigating.",
    "Use only read tools (ls, find, grep, read). Never write wiki pages.",
    "Cognitive locality: when child receipts are projected under inputs/evidence/,",
    "synthesize and reconcile them first. Only re-open sources to fill genuine gaps.",
    "Return a concise evidence summary:",
    "- key findings (bullet list)",
    "- source paths with line ranges when known from tools or child receipts",
    "- open questions",
    `Produce will persist this as analysis receipt nodeId=${input.nodeId} runId=${input.runId}.`,
  ].join("\n");
}
