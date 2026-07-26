/**
 * Living WikiRunSpec — convenience re-exports over ports SpecStore.
 * Sole Spec write path remains commitSpec (via defaultSpecStore).
 *
 * Planner handoff (path-first): analysis/plan-draft.json is the candidate Spec
 * written by submit_wiki_run_spec; commitSpec promotes to spec.json.
 */

import { rm } from "node:fs/promises";
import type { WikiRunSpec } from "@okf-wiki/contract";
import {
  DEFECTS_FILE_NAME,
  defaultSpecStore,
  defectsPath,
  PLAN_DRAFT_FILE_NAME,
  PLAN_DRAFT_REL_PATH,
  planDraftPathFromRunWorkDir,
  runAnalysisDir,
  SPEC_FILE_NAME,
  specPath,
} from "../ports/core-spec-store.js";
import type { CommitSpecOptions, SpecStore } from "../ports/spec-store.js";

export type { CommitSpecOptions } from "../ports/spec-store.js";
export {
  DEFECTS_FILE_NAME,
  defectsPath,
  PLAN_DRAFT_FILE_NAME,
  PLAN_DRAFT_REL_PATH,
  planDraftPathFromRunWorkDir,
  runAnalysisDir,
  SPEC_FILE_NAME,
  specPath,
};

/**
 * Remove a stale planner candidate Spec before a (re)plan round.
 * Without this, a revision planner that fails to call submit_wiki_run_spec
 * would silently re-resolve the previous round's draft as if replanning
 * succeeded, dropping operator feedback.
 */
export async function clearPlanDraft(runWorkDir: string): Promise<void> {
  await rm(planDraftPathFromRunWorkDir(runWorkDir), { force: true });
}

/**
 * Persist a candidate WikiRunSpec for path-first plan handoff.
 * Does not touch living analysis/spec.json (that is commitSpec only).
 */
export async function writePlanDraft(
  runWorkDir: string,
  spec: WikiRunSpec,
  store: SpecStore = defaultSpecStore,
): Promise<string> {
  return store.writePlanDraft(runWorkDir, spec);
}

export async function readPlanDraft(
  runWorkDir: string,
  store: SpecStore = defaultSpecStore,
): Promise<WikiRunSpec | null> {
  return store.readPlanDraft(runWorkDir);
}

/**
 * Sole Spec write path: disk analysis/spec.json (+ optional Run Record).
 */
export async function commitSpec(
  workspaceRoot: string,
  runId: string,
  spec: WikiRunSpec,
  opts?: CommitSpecOptions,
  store: SpecStore = defaultSpecStore,
): Promise<string> {
  return store.commitSpec(workspaceRoot, runId, spec, opts);
}

export async function readCommittedSpec(
  workspaceRoot: string,
  runId: string,
  store: SpecStore = defaultSpecStore,
): Promise<WikiRunSpec | null> {
  return store.readCommittedSpec(workspaceRoot, runId);
}
