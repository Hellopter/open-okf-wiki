/**
 * Living WikiRunSpec persistence port.
 *
 * Planner handoff (path-first): plan-draft.json is the candidate Spec;
 * commitSpec promotes to analysis/spec.json. Ports stay free of produce/runtime.
 */

import type { WikiRunSpec } from "@okf-wiki/contract";

export type CommitSpecOptions = {
  /** Optional summary for callers that surface commit context (not a v2 dual-write). */
  summary?: string;
};

/**
 * Spec read/write surface for plan → produce orchestration.
 */
export interface SpecStore {
  commitSpec(
    workspaceRoot: string,
    runId: string,
    spec: WikiRunSpec,
    opts?: CommitSpecOptions,
  ): Promise<string>;
  readCommittedSpec(workspaceRoot: string, runId: string): Promise<WikiRunSpec | null>;
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
