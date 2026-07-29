/**
 * SpecStore adapter over Core analysis scratch (spec.json / plan-draft).
 *
 * Uses @okf-wiki/core only (ports ban produce/). Does **not** dual-write
 * `okf.wiki-run/v2` Run Records — WikiRuns owns durable control state.
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { type WikiRunSpec, WikiRunSpecSchema } from "@okf-wiki/contract";
import { analysisScratchDir, atomicWriteJson } from "@okf-wiki/core";
import type { CommitSpecOptions, SpecStore } from "./spec-store.js";

export const SPEC_FILE_NAME = "spec.json";
export const PLAN_DRAFT_FILE_NAME = "plan-draft.json";

/** Run-workdir relative path for the planner candidate Spec. */
export const PLAN_DRAFT_REL_PATH = `analysis/${PLAN_DRAFT_FILE_NAME}`;

export function runAnalysisDir(workspaceRoot: string, runId: string): string {
  return analysisScratchDir(workspaceRoot, runId);
}

export function specPath(workspaceRoot: string, runId: string): string {
  return path.join(runAnalysisDir(workspaceRoot, runId), SPEC_FILE_NAME);
}

/** Absolute path to planner candidate Spec under a run workdir. */
export function planDraftPathFromRunWorkDir(runWorkDir: string): string {
  return path.join(path.resolve(runWorkDir), "analysis", PLAN_DRAFT_FILE_NAME);
}

/** Core-backed SpecStore for production plan/produce. */
export function createCoreSpecStore(): SpecStore {
  return {
    async commitSpec(
      workspaceRoot: string,
      runId: string,
      spec: WikiRunSpec,
      opts?: CommitSpecOptions,
    ): Promise<string> {
      void opts; // CommitSpecOptions reserved for future non-v2 metadata only
      const parsed = WikiRunSpecSchema.parse(spec);
      const filePath = specPath(workspaceRoot, runId);
      await atomicWriteJson(filePath, parsed);
      return filePath;
    },

    async readCommittedSpec(workspaceRoot: string, runId: string): Promise<WikiRunSpec | null> {
      try {
        const raw = await readFile(specPath(workspaceRoot, runId), "utf8");
        return WikiRunSpecSchema.parse(JSON.parse(raw));
      } catch {
        return null;
      }
    },

    async writePlanDraft(runWorkDir: string, spec: WikiRunSpec): Promise<string> {
      const parsed = WikiRunSpecSchema.parse(spec);
      const filePath = planDraftPathFromRunWorkDir(runWorkDir);
      await atomicWriteJson(filePath, parsed);
      return filePath;
    },

    async readPlanDraft(runWorkDir: string): Promise<WikiRunSpec | null> {
      try {
        const raw = await readFile(planDraftPathFromRunWorkDir(runWorkDir), "utf8");
        return WikiRunSpecSchema.parse(JSON.parse(raw));
      } catch {
        return null;
      }
    },

    async clearPlanDraft(runWorkDir: string): Promise<void> {
      await rm(planDraftPathFromRunWorkDir(runWorkDir), { force: true });
    },
  };
}

/** Default singleton for call sites that do not inject a store. */
export const defaultSpecStore: SpecStore = createCoreSpecStore();
