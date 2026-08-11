/**
 * Model-facing JSON contract guidance for control submission tools.
 *
 * Field names live here so agent-submissions and prompt surfaces share one source.
 */

import type { SubmissionToolName } from "../agent-errors.js";

/** Research handoff top-level fields. */
export const RESEARCH_ARTIFACT_FIELDS = ["summary", "findings", "gaps"] as const;

/** Research finding object fields. */
export const RESEARCH_FINDING_FIELDS = ["kind", "title", "readerQuestion", "priority", "evidence"] as const;

/** Research gap object fields. */
export const RESEARCH_GAP_FIELDS = ["question", "priority", "sourcePaths"] as const;

/** Allowed research finding kinds. */
export const RESEARCH_FINDING_KINDS = ["domain", "concept", "flow", "boundary", "state-data"] as const;

/** Priority values shared by findings and gaps. */
export const RESEARCH_PRIORITIES = ["critical", "normal"] as const;

/** Synthesis finalize decision fields. */
export const SYNTHESIS_FINALIZE_FIELDS = ["decision", "spec", "rationale"] as const;

/** Synthesis expand decision fields. */
export const SYNTHESIS_EXPAND_FIELDS = ["decision", "researchScopes", "rationale"] as const;

/** Spec page descriptor fields under synthesis finalize. */
export const SYNTHESIS_PAGE_FIELDS = ["pageType", "path", "title", "purpose", "findingIds"] as const;

/** Spec top-level fields. */
export const SYNTHESIS_SPEC_FIELDS = ["domains", "crossLinks", "sharedTerms", "omissions"] as const;

/** Expand scope fields. */
export const SYNTHESIS_SCOPE_FIELDS = ["id", "sourcePaths", "task"] as const;

/** Review result top-level fields. */
export const REVIEW_RESULT_FIELDS = ["defects", "summary"] as const;

/** Local review defect kinds. */
export const REVIEW_LOCAL_DEFECT_KINDS = ["evidence", "link", "depth", "diagram"] as const;

/** Structural review defect kinds. */
export const REVIEW_STRUCTURAL_DEFECT_KINDS = ["topology", "coverage"] as const;

/** Local defect object fields. */
export const REVIEW_LOCAL_DEFECT_FIELDS = ["kind", "page", "detail"] as const;

/** Structural defect object fields. */
export const REVIEW_STRUCTURAL_DEFECT_FIELDS = ["kind", "detail"] as const;

/** Keep every model-facing control surface explicit about its JSON contract. */
export function submissionContractGuidance(toolName: SubmissionToolName): string {
  if (toolName === "wiki_submit_research") {
    const kinds = RESEARCH_FINDING_KINDS.join("|");
    const priorities = RESEARCH_PRIORITIES.join("|");
    return `Use {"summary":"...","findings":[{"kind":"${kinds}","title":"...","readerQuestion":"...","priority":"${priorities}","evidence":["project/path#L1-L2"]}],"gaps":[{"question":"...","priority":"${priorities}","sourcePaths":["project"]}]}`;
  }
  if (toolName === "wiki_submit_page") {
    return "Call the tool with the exact assigned page path after writing. Fix every returned issue and resubmit until accepted.";
  }
  if (toolName === "wiki_submit_synthesis") {
    const [pageType, pagePath, title, purpose, findingIds] = SYNTHESIS_PAGE_FIELDS;
    return `For a final decision, use {"decision":"finalize","spec":{"domains":[...],"crossLinks":[...],"sharedTerms":[...],"omissions":[...]},"rationale":"..."}. Each page contains ${pageType}, ${pagePath}, ${title}, ${purpose}, and ${findingIds}. For expansion, omit spec and use {"decision":"expand","researchScopes":[{"id":"new-scope-id","sourcePaths":["declared-source"],"task":"..."}],"rationale":"..."}.`;
  }
  const localKinds = REVIEW_LOCAL_DEFECT_KINDS.join("|");
  const structuralKinds = REVIEW_STRUCTURAL_DEFECT_KINDS.join("|");
  return `Use {"defects":[...],"summary":"..."}. A local defect is exactly {"kind":"${localKinds}","page":"...","detail":"..."}; a structural defect is exactly {"kind":"${structuralKinds}","detail":"..."}. defects and summary are required; use [] when there are no actionable defects.`;
}
