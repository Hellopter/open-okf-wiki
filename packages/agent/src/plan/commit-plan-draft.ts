/**
 * Deep module: validate and atomically commit a planner candidate Spec.
 *
 * Path-first handoff (ADR 0011 / hard-cut Epic D): analysis/plan-draft.json is
 * this Plan Attempt's candidate. Tools stay thin (TypeBox + dispatch here).
 * Composition may inject commitPlanDraft for tests — not a SpecStore port.
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  assertCoverage,
  type CoveragePlan,
  CoverageAssertError,
  parseSealedCoveragePlan,
} from "@okf-wiki/contract/coverage";
import {
  assertSpecWithinFanOutCaps,
  SpecFanOutCapError,
  type SpecFanOutCaps,
  type WikiRunSpec,
  WikiRunSpecSchema,
} from "@okf-wiki/contract/wiki-runs";
import { atomicWriteJson } from "@okf-wiki/core";

export const PLAN_DRAFT_FILE_NAME = "plan-draft.json";

/** Run-workdir relative path for the planner candidate Spec. */
export const PLAN_DRAFT_REL_PATH = `analysis/${PLAN_DRAFT_FILE_NAME}`;

/** Absolute path to planner candidate Spec under a run workdir. */
export function planDraftPathFromRunWorkDir(runWorkDir: string): string {
  return path.join(path.resolve(runWorkDir), "analysis", PLAN_DRAFT_FILE_NAME);
}

export type CommitPlanDraftOptions = {
  /** Topology fan-out caps (adaptive orchestration). When set, over-cap Specs fail. */
  caps?: SpecFanOutCaps;
  /**
   * Coverage plan for assertCoverage. When omitted and `loadCoveragePlan` is not
   * provided, no coverage gate runs (host assertCoverage remains defense-in-depth).
   */
  coveragePlan?: CoveragePlan;
};

export type CommitPlanDraftResult = {
  /** Absolute path written. */
  absolutePath: string;
  /** Run-workdir relative path (control plane). */
  specPath: string;
  /** Validated Spec that was written. */
  spec: WikiRunSpec;
  pageCount: number;
  domainCount: number;
  summary: string;
};

/**
 * Zod-validate Spec, optionally enforce fan-out caps and coverage, then
 * atomically write analysis/plan-draft.json.
 */
export async function commitPlanDraft(
  runWorkDir: string,
  spec: unknown,
  opts?: CommitPlanDraftOptions,
): Promise<CommitPlanDraftResult> {
  const parsed = WikiRunSpecSchema.safeParse(spec);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue
      ? `${issue.path.join(".") || "spec"}: ${issue.message}`
      : "invalid Spec";
    throw new Error(
      `commitPlanDraft rejected: ${where}. ` +
        "Fix the named field(s) and resubmit a complete WikiRunSpec " +
        "(pages min 1, include critical overview.md; never index.md/log.md).",
    );
  }

  try {
    assertSpecWithinFanOutCaps(parsed.data, opts?.caps);
  } catch (err) {
    if (err instanceof SpecFanOutCapError) {
      throw new Error(`commitPlanDraft rejected: ${err.message}`);
    }
    throw err;
  }

  const plan = opts?.coveragePlan;
  if (plan && plan.requiredUnits.length > 0) {
    try {
      assertCoverage(parsed.data, plan, { throwOnGap: true });
    } catch (err) {
      if (err instanceof CoverageAssertError) {
        const gaps = err.result.gaps.slice(0, 12).join(", ");
        throw new Error(
          `commitPlanDraft rejected: coverage gap — ${err.message}. ` +
            `Missing units: ${gaps || "(see plan)"}. ` +
            "Bind each required unit on a critical page via coverageUnitIds / sourceIds / surfaceIds, " +
            "or cancel via sourceCoverage/surfaceCoverage with cancelled:true and notes reason.",
        );
      }
      throw err;
    }
  }

  const absolutePath = planDraftPathFromRunWorkDir(runWorkDir);
  await atomicWriteJson(absolutePath, parsed.data);
  return {
    absolutePath,
    specPath: PLAN_DRAFT_REL_PATH,
    spec: parsed.data,
    pageCount: parsed.data.pages.length,
    domainCount: parsed.data.domains.length,
    summary: parsed.data.summary.slice(0, 200),
  };
}

/** Read planner candidate Spec from disk (null when missing/invalid). */
export async function readPlanDraft(runWorkDir: string): Promise<WikiRunSpec | null> {
  try {
    const raw = await readFile(planDraftPathFromRunWorkDir(runWorkDir), "utf8");
    return WikiRunSpecSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Remove a stale planner candidate Spec before a (re)plan round.
 * Without this, a revision planner that fails to call submit_wiki_run_spec
 * would silently re-resolve the previous round's draft as if replanning
 * succeeded, dropping operator feedback.
 */
export async function clearPlanDraft(runWorkDir: string): Promise<void> {
  await rm(planDraftPathFromRunWorkDir(runWorkDir), { force: true });
}

/** Load sealed coverage plan from run workdir (inputs/ preferred, then analysis/). */
export async function loadCoveragePlanFromWorkdir(
  runWorkDir: string,
): Promise<CoveragePlan | undefined> {
  for (const rel of ["inputs/coverage-plan.json", "analysis/coverage-plan.json"]) {
    try {
      const raw = JSON.parse(await readFile(path.join(runWorkDir, rel), "utf8")) as unknown;
      const parsed = parseSealedCoveragePlan(raw);
      if (parsed) return parsed;
    } catch {
      // try next path
    }
  }
  return undefined;
}
