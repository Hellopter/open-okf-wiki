/**
 * Inventory / plan-uncertainty adaptive orchestration router (Phase 7).
 *
 * Light-path defaults (contract): planScoutCount=0, reviewCouncilSize=1.
 * Raise only when inventory or plan uncertainty justifies cost.
 * Operator-explicit orchestration values still win via resolveOrchestration first.
 */

import { type WorkspaceOrchestration, resolveOrchestration } from "./workspace.js";

/**
 * Deterministic host-side inventory signals used for adaptive fan-out.
 * Optional accelerator only — never a citation membership gate.
 */
export type RepositoryInventory = {
  /** Number of registered sources in the freeze. */
  sourceCount: number;
  /** Approximate file count under sealed snapshots (best-effort). */
  fileCount?: number;
  /** Distinct language extensions observed (e.g. ts, py, java). */
  languages?: readonly string[];
  /** Multiple package/entry manifests (package.json, pyproject, pom, …). */
  multiEntry?: boolean;
  /** Large tree signal (file count or multi-source). */
  large?: boolean;
};

export type AdaptiveRouterInput = {
  /** Workspace orchestration after schema resolve (defaults applied). */
  orchestration?: Partial<WorkspaceOrchestration> | null;
  inventory?: RepositoryInventory | null;
  /**
   * Plan uncertainty in [0, 1]. Higher → more scouts / lenses.
   * Derived from openQuestions density, multi-domain Spec, or operator focus ambiguity.
   */
  planUncertainty?: number | null;
};

export type AdaptiveRouterDecision = {
  orchestration: WorkspaceOrchestration;
  /** Why scouts/lenses were raised (empty when light path kept). */
  reasons: string[];
  /** True when light path kept (0 scouts, 1 lens unless operator raised). */
  lightPath: boolean;
};

const LARGE_FILE_THRESHOLD = 2_000;
const UNCERTAINTY_SCOUT_THRESHOLD = 0.45;
const UNCERTAINTY_LENS_THRESHOLD = 0.6;

/**
 * Decide scout count and review lenses from inventory + plan uncertainty.
 * Never lowers an operator-explicit raise above schema defaults.
 */
export function resolveAdaptiveOrchestration(
  input: AdaptiveRouterInput = {},
): AdaptiveRouterDecision {
  const base = resolveOrchestration(input.orchestration);
  const reasons: string[] = [];
  let planScoutCount = base.planScoutCount;
  let reviewCouncilSize = base.reviewCouncilSize;

  const inv = input.inventory;
  const uncertainty = clamp01(input.planUncertainty);

  const multiSource = (inv?.sourceCount ?? 0) >= 2;
  const multiLang = (inv?.languages?.length ?? 0) >= 2;
  const multiEntry = inv?.multiEntry === true;
  const large =
    inv?.large === true ||
    multiSource ||
    (inv?.fileCount !== undefined && inv.fileCount >= LARGE_FILE_THRESHOLD);

  // Scouts: default 0; raise when inventory shows scale or plan is uncertain.
  if (planScoutCount === 0) {
    if (large || multiEntry || multiLang) {
      planScoutCount = multiSource || multiLang ? 2 : 1;
      reasons.push(
        large
          ? "inventory:large-or-multi-source"
          : multiEntry
            ? "inventory:multi-entry"
            : "inventory:multi-language",
      );
    } else if (uncertainty >= UNCERTAINTY_SCOUT_THRESHOLD) {
      planScoutCount = 1;
      reasons.push("plan-uncertainty:scouts");
    }
  }

  // Review lenses: default 1; raise when multi-domain scale or high uncertainty.
  if (reviewCouncilSize === 1) {
    if (large && multiLang) {
      reviewCouncilSize = 2;
      reasons.push("inventory:large+multi-language:lenses");
    } else if (uncertainty >= UNCERTAINTY_LENS_THRESHOLD) {
      reviewCouncilSize = 2;
      reasons.push("plan-uncertainty:lenses");
    }
  }

  const orchestration: WorkspaceOrchestration = {
    ...base,
    planScoutCount: Math.min(4, Math.max(0, planScoutCount)),
    reviewCouncilSize: Math.min(4, Math.max(1, reviewCouncilSize)),
  };

  const lightPath =
    orchestration.planScoutCount === 0 && orchestration.reviewCouncilSize === 1;

  return { orchestration, reasons, lightPath };
}

/**
 * Derive a coarse planUncertainty from Spec-shaped signals (no LLM).
 * openQuestions density and domain fan-out raise uncertainty.
 */
export function planUncertaintyFromSpec(spec: {
  domains?: readonly { questions?: readonly string[] }[];
  openQuestions?: readonly string[];
}): number {
  const domains = spec.domains?.length ?? 0;
  const questions =
    spec.domains?.reduce((n, d) => n + (d.questions?.length ?? 0), 0) ?? 0;
  const open = spec.openQuestions?.length ?? 0;
  // Heuristic: more open Qs and multi-domain → higher uncertainty.
  const openScore = Math.min(1, open / 6);
  const domainScore = domains <= 1 ? 0 : Math.min(1, (domains - 1) / 4);
  const questionScore = questions <= 2 ? 0 : Math.min(1, (questions - 2) / 10);
  return clamp01(0.5 * openScore + 0.3 * domainScore + 0.2 * questionScore);
}

function clamp01(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
