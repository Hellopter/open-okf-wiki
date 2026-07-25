/**
 * Living WikiRunSpec persistence port.
 *
 * Planner handoff (path-first): plan-draft.json is the candidate Spec;
 * commitSpec promotes to analysis/spec.json. Ports stay free of produce/runtime.
 */

import type { WikiRunSpec } from "@okf-wiki/contract";

export type CommitSpecOptions = {
  /** Also patch Run Record.spec (same Spec object). */
  mirrorRunRecord?: boolean;
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
}
