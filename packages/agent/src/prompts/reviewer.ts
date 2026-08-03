/**
 * Review council lens prompts (orthogonal perspectives for ensemble merge).
 */

export type ReviewLens = "grounding" | "coverage" | "consistency" | "general";

export function reviewerPrompt(input: {
  pages: string[];
  lens: ReviewLens;
  /**
   * Prior blocking defects from the last council round (differential re-review).
   * Reviewers must re-verify these before inventing new major noise.
   */
  priorBlocking?: ReadonlyArray<{
    path?: string;
    code?: string;
    issue: string;
  }>;
}): string {
  const lensHint = {
    grounding: [
      "Lens: GROUNDING.",
      "Focus only on claims without resolvable Source Citations, invented APIs/paths,",
      "or line ranges that cannot come from read/grep evidence.",
      "severity blocking for fabricated facts or missing citations on load-bearing claims;",
      "major for weak grounding; minor for citation style nits.",
    ].join(" "),
    coverage: [
      "Lens: COVERAGE.",
      "Focus only on Spec questions unanswered, missing critical pages, and thin overviews.",
      "Reachability is via narrative overview + directory hierarchy + mechanical multi-level indexes — not model-owned TOC.",
      "severity blocking for missing critical pages or unanswered critical domain questions;",
      "major for material gaps; minor for optional depth.",
    ].join(" "),
    consistency: [
      "Lens: CONSISTENCY.",
      "Focus only on contradictions across wiki pages, term drift, and broken internal .md links.",
      "severity blocking for direct factual contradictions; major for term drift; minor for tone.",
    ].join(" "),
    general: [
      "Lens: GENERAL.",
      "Review Staging Wiki under wiki/ against sources/ and skill/references/review.md.",
      "Navigation uses multi-level mechanical indexes (parent → subdir index → concept pages); do not fail solely because the model did not hand-craft index.md.",
      "Still flag unreachable concepts, broken cross-links, and missing critical pages.",
      "Prefer issues other lenses miss; do not restate pure grounding/coverage/consistency noise.",
    ].join(" "),
  }[input.lens];

  const prior =
    input.priorBlocking && input.priorBlocking.length > 0
      ? [
          "",
          "DIFFERENTIAL REVIEW — re-verify these prior blocking defects first:",
          ...input.priorBlocking.map(
            (d, i) => `${i + 1}. [${d.code ?? "?"}] ${d.path ?? "?"}: ${d.issue.slice(0, 200)}`,
          ),
          "If still present, re-report them (same code/path when possible).",
          "If fixed, omit them. Only then report new blocking issues with clear evidence.",
          "Do not invent a fresh set of major stylistic complaints.",
        ].join("\n")
      : "";

  return [
    lensHint,
    "Read wiki/ pages and relevant sources/ with read-only tools when needed.",
    "You MUST call submit_defect_report with a typed DefectReport — that tool is the only handoff.",
    "Do not paste DefectReport JSON into chat; free-text is never accepted as success.",
    "Fields: { reviewerId, clean, defects: [{ severity, code, path, issue }], summary }.",
    "severity is blocking | major | minor. Report every blocking defect supported by this lens; keep major/minor findings high-signal.",
    "clean=true only with empty defects; clean=false requires ≥1 defect.",
    `Pages present: ${input.pages.join(", ") || "(none)"}`,
    prior,
  ]
    .filter(Boolean)
    .join("\n");
}
