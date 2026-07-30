/**
 * Planner draft persistence port.
 *
 * Planner handoff is path-first: plan-draft.json is this Attempt's candidate
 * Spec. Ports stay free of produce/runtime.
 */

import type { WikiRunSpec } from "@okf-wiki/contract";

/**
 * Spec draft surface for plan orchestration.
 */
export interface SpecStore {
  writePlanDraft(runWorkDir: string, spec: WikiRunSpec): Promise<string>;
  readPlanDraft(runWorkDir: string): Promise<WikiRunSpec | null>;
  /**
   * Remove a stale planner candidate Spec before a (re)plan round.
   * Without this, a revision planner that fails to call submit_wiki_run_spec
   * would silently re-resolve the previous round's draft as if replanning
   * succeeded, dropping operator feedback.
   */
  clearPlanDraft(runWorkDir: string): Promise<void>;
}
