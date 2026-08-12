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
export const SYNTHESIS_FINALIZE_FIELDS = ["spec", "rationale"] as const;

/** Spec page descriptor fields under synthesis finalize. */
export const SYNTHESIS_PAGE_FIELDS = [
  "pageType", "path", "title", "purpose", "readerQuestions", "requiredFacets", "findingIds",
] as const;

/** Spec top-level fields. */
export const SYNTHESIS_SPEC_FIELDS = ["domains", "crossLinks", "sharedTerms", "omissions"] as const;


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
    const priorities = RESEARCH_PRIORITIES.join("|");
    return `First upsert {slot,finding} entries in batches of at most 20 with wiki_research_put_findings; retract invalid slots with wiki_research_remove_finding; use wiki_research_findings, wiki_research_scopes, and wiki_submission_status to inspect staging. Then submit only {"summary":"...","gaps":[{"question":"...","priority":"${priorities}","sourcePaths":["project"]}]}.`;
  }
  if (toolName === "wiki_submit_page") {
    return "Call the tool with the exact assigned page path after writing. Fix every returned issue and resubmit until accepted.";
  }
  if (toolName === "wiki_submit_synthesis_finalize") {
    return "Stage the WikiSpec with wiki_plan_put_domain, wiki_plan_remove_domain, and wiki_plan_set_coordination; inspect it with wiki_spec_get_domain and wiki_submission_status. Then submit only {\"rationale\":\"...\"}.";
  }
  const localKinds = REVIEW_LOCAL_DEFECT_KINDS.join("|");
  const structuralKinds = REVIEW_STRUCTURAL_DEFECT_KINDS.join("|");
  return `Upsert {slot,defect} entries in batches of at most 20 with wiki_review_put_defects; retract resolved slots with wiki_review_remove_defect; inspect them with wiki_review_defects and wiki_submission_status. A local defect is exactly {"kind":"${localKinds}","page":"...","detail":"..."}; a structural defect is exactly {"kind":"${structuralKinds}","detail":"..."}. Then submit only {"summary":"..."}; stage no defects when clean.`;
}
