/**
 * Living WikiRunSpec — single writer for analysis/spec.json.
 * Run Record mirror is optional and only via commitSpec.
 *
 * Planner handoff (path-first): analysis/plan-draft.json is the candidate Spec
 * written by submit_wiki_run_spec or Host spill; commitSpec promotes to spec.json.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { type WikiRunSpec, WikiRunSpecSchema } from "@okf-wiki/contract";
import { analysisScratchDir, atomicWriteJson, updateRunRecord } from "@okf-wiki/core";

export const SPEC_FILE_NAME = "spec.json";
export const PLAN_DRAFT_FILE_NAME = "plan-draft.json";
export const DEFECTS_FILE_NAME = "defects.json";

/** Run-workdir relative path for the planner candidate Spec. */
export const PLAN_DRAFT_REL_PATH = `analysis/${PLAN_DRAFT_FILE_NAME}`;

export function runAnalysisDir(workspaceRoot: string, runId: string): string {
  return analysisScratchDir(workspaceRoot, runId);
}

export function specPath(workspaceRoot: string, runId: string): string {
  return path.join(runAnalysisDir(workspaceRoot, runId), SPEC_FILE_NAME);
}

export function defectsPath(workspaceRoot: string, runId: string): string {
  return path.join(runAnalysisDir(workspaceRoot, runId), DEFECTS_FILE_NAME);
}

/** Absolute path to planner candidate Spec under a run workdir. */
export function planDraftPathFromRunWorkDir(runWorkDir: string): string {
  return path.join(path.resolve(runWorkDir), "analysis", PLAN_DRAFT_FILE_NAME);
}

/**
 * Persist a candidate WikiRunSpec for path-first plan handoff.
 * Does not touch living analysis/spec.json (that is commitSpec only).
 */
export async function writePlanDraft(runWorkDir: string, spec: WikiRunSpec): Promise<string> {
  const parsed = WikiRunSpecSchema.parse(spec);
  const filePath = planDraftPathFromRunWorkDir(runWorkDir);
  await atomicWriteJson(filePath, parsed);
  return filePath;
}

export async function readPlanDraft(runWorkDir: string): Promise<WikiRunSpec | null> {
  try {
    const raw = await readFile(planDraftPathFromRunWorkDir(runWorkDir), "utf8");
    return WikiRunSpecSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export type CommitSpecOptions = {
  /** Also patch Run Record.spec (same Spec object). */
  mirrorRunRecord?: boolean;
  summary?: string;
};

/**
 * Sole Spec write path: disk analysis/spec.json (+ optional Run Record).
 */
export async function commitSpec(
  workspaceRoot: string,
  runId: string,
  spec: WikiRunSpec,
  opts?: CommitSpecOptions,
): Promise<string> {
  const parsed = WikiRunSpecSchema.parse(spec);
  const filePath = specPath(workspaceRoot, runId);
  await atomicWriteJson(filePath, parsed);
  if (opts?.mirrorRunRecord) {
    await updateRunRecord(workspaceRoot, runId, {
      spec: parsed,
      ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
    });
  }
  return filePath;
}

export async function readCommittedSpec(
  workspaceRoot: string,
  runId: string,
): Promise<WikiRunSpec | null> {
  try {
    const raw = await readFile(specPath(workspaceRoot, runId), "utf8");
    return WikiRunSpecSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
