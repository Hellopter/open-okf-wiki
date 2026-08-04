/**
 * Inventory / plan-uncertainty adaptive orchestration router (Phase 7 + coverage Phase A + L0–L3).
 *
 * Light-path defaults (contract): planScoutCount=0, reviewCouncilSize=1, planScoutMode=auto.
 * Raise only when inventory or plan uncertainty justifies cost.
 * Operator-explicit orchestration values still win via resolveOrchestration first.
 *
 * Inventory tiers:
 * - **L0** light: small single-source (fileCount &lt; 50, no multi-entry/lang complexity)
 * - **L1** medium: single-source, fileCount in [50, 2000) or mild complexity → ≥1 thematic scout
 * - **L2** large single-repo: fileCount ≥ 2000 / multi-entry / large flag
 * - **L3** multi-source: never light; hybrid mode + source coverage; thematic DEFAULT-OFF
 *
 * Multi-source is **not** “large monorepo with multiEntry”:
 * - multi-source → hybrid scout mode (source surveys + semantic domain/flow), independent survey budget
 * - large single-repo → raise thematic scouts only
 * - multiEntry stays an explicit inventory signal (never implied by multi-source alone)
 */

import { resolveOrchestration, type WorkspaceOrchestration } from "./workspace.js";

/**
 * Deterministic host-side inventory signals used for adaptive fan-out.
 * Optional accelerator only — never a citation membership gate.
 *
 * Richer multi-source / surface fields feed scout mode selection; they do not
 * silently truncate required coverage (that is assertCoverage + orchestration caps).
 */
export type RepositoryInventory = {
  /** Number of registered sources in the freeze. */
  sourceCount: number;
  /** Approximate file count under sealed snapshots (best-effort). */
  fileCount?: number;
  /** Distinct language extensions observed (e.g. ts, py, java). */
  languages?: readonly string[];
  /**
   * Multiple package/entry manifests (package.json, pyproject, pom, …).
   * Must be set explicitly from inventory — **not** implied by multi-source.
   */
  multiEntry?: boolean;
  /** Large tree signal (file count or operator mark). Multi-source is separate. */
  large?: boolean;
  /** Per-source rows when host has a richer survey (optional). */
  sources?: readonly {
    sourceId: string;
    fileCount?: number;
    languages?: readonly string[];
    /** Inventoried surfaces for this source (paths only; ids are source-qualified). */
    surfaces?: readonly { path: string; label?: string }[];
  }[];
  /** Flattened surface count hint when sources[] is omitted. */
  surfaceCount?: number;
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
  /** Why scouts/lenses/mode were raised (empty when light path kept). */
  reasons: string[];
  /** True when light path kept (0 scouts, 1 lens, thematic/auto without force). */
  lightPath: boolean;
  /** Coarse inventory tier for host / observability. */
  tier: InventoryTier;
};

/** Coarse inventory cost tier (L0 light … L3 multi-source). */
export type InventoryTier = "L0" | "L1" | "L2" | "L3";

const LARGE_FILE_THRESHOLD = 2_000;
/** Inclusive lower bound for L1 medium single-source by file count. */
const MEDIUM_FILE_MIN = 50;
const UNCERTAINTY_SCOUT_THRESHOLD = 0.45;
const UNCERTAINTY_LENS_THRESHOLD = 0.6;

/**
 * Map inventory signals to L0–L3. Pure helper for host policy and tests.
 *
 * | Tier | Signal |
 * |------|--------|
 * | L3 | sourceCount ≥ 2 |
 * | L2 | single-source large / multi-entry / fileCount ≥ 2000 |
 * | L1 | single-source fileCount ∈ [50, 2000) or multi-language mild complexity |
 * | L0 | otherwise (small single-source light path) |
 */
export function inventoryTier(inventory?: RepositoryInventory | null): InventoryTier {
  const sourceCount = inventory?.sourceCount ?? 0;
  if (sourceCount >= 2) return "L3";

  const fileCount = inventory?.fileCount;
  const multiEntry = inventory?.multiEntry === true;
  const fileLarge =
    inventory?.large === true ||
    (fileCount !== undefined && fileCount >= LARGE_FILE_THRESHOLD);
  if (fileLarge || multiEntry) return "L2";

  const multiLang = (inventory?.languages?.length ?? 0) >= 2;
  const mediumByFiles =
    fileCount !== undefined &&
    fileCount >= MEDIUM_FILE_MIN &&
    fileCount < LARGE_FILE_THRESHOLD;
  if (mediumByFiles || multiLang) return "L1";

  return "L0";
}

/**
 * Decide scout count, scout mode, and review lenses from inventory + plan uncertainty.
 * Never lowers an operator-explicit raise above schema defaults.
 */
export function resolveAdaptiveOrchestration(
  input: AdaptiveRouterInput = {},
): AdaptiveRouterDecision {
  const base = resolveOrchestration(input.orchestration);
  const reasons: string[] = [];
  let planScoutCount = base.planScoutCount;
  let reviewCouncilSize = base.reviewCouncilSize;
  let planScoutMode = base.planScoutMode;
  let planSurveyTaskBudget = base.planSurveyTaskBudget;
  let requireSourceCoverage = base.requireSourceCoverage;
  let requireSurfaceCoverage = base.requireSurfaceCoverage;

  const inv = input.inventory;
  const uncertainty = clamp01(input.planUncertainty);
  const tier = inventoryTier(inv);

  const sourceCount = inv?.sourceCount ?? 0;
  const multiSource = sourceCount >= 2;
  const multiLang = (inv?.languages?.length ?? 0) >= 2;
  // multiEntry is never inferred from multi-source alone.
  const multiEntry = inv?.multiEntry === true;
  const fileLarge =
    inv?.large === true ||
    (inv?.fileCount !== undefined && inv.fileCount >= LARGE_FILE_THRESHOLD);
  // Large for thematic/lens purposes: file scale or multi-entry monorepo — not multi-source alone.
  const largeSingleRepo = !multiSource && (fileLarge || multiEntry);
  const mediumSingleRepo =
    !multiSource &&
    !largeSingleRepo &&
    (tier === "L1" ||
      (inv?.fileCount !== undefined &&
        inv.fileCount >= MEDIUM_FILE_MIN &&
        inv.fileCount < LARGE_FILE_THRESHOLD));
  const surfaceCount =
    inv?.surfaceCount ??
    inv?.sources?.reduce((n, s) => n + (s.surfaces?.length ?? 0), 0) ??
    0;

  // --- Scout mode (auto only; operator-explicit mode is preserved) ---
  if (planScoutMode === "auto") {
    if (multiSource) {
      planScoutMode = "hybrid";
      reasons.push("inventory:multi-source:hybrid");
    } else if (largeSingleRepo) {
      planScoutMode = "thematic";
      // keep thematic explicit in reasons when we raised scouts below
    }
  }

  // --- Source coverage flags (do not force on small single-repo light path) ---
  if (requireSourceCoverage === undefined && multiSource) {
    requireSourceCoverage = true;
    reasons.push("inventory:multi-source:require-source-coverage");
  }
  if (
    requireSurfaceCoverage === undefined &&
    largeSingleRepo &&
    surfaceCount > 0
  ) {
    requireSurfaceCoverage = true;
    reasons.push("inventory:large-single-repo:require-surface-coverage");
  }

  // --- Survey task budget: independent of thematic planScoutCount ---
  if (planSurveyTaskBudget === undefined && multiSource) {
    const maxSources = base.maxSourcesPerRun;
    // Fail-closed signal: if sourceCount exceeds maxSourcesPerRun, still set
    // budget to maxSources — host must reject over-cap source sets, not truncate.
    planSurveyTaskBudget = Math.min(sourceCount, maxSources);
    reasons.push("inventory:multi-source:survey-budget");
  }

  // --- Thematic scouts ---
  // Multi-source (L3): thematic spine DEFAULT-OFF. Semantic domain+flow scouts are
  // scheduled by selectPlanScoutTasks; planScoutCount stays 0 unless operator raises.
  // L1 medium / L2 large single-repo: raise thematic when still at light default 0.
  if (planScoutCount === 0) {
    if (multiSource) {
      // Thematic DEFAULT-OFF for multi-source — do not auto-raise planScoutCount.
      reasons.push("inventory:multi-source:thematic-default-off");
    } else if (largeSingleRepo || multiEntry) {
      planScoutCount = multiLang || multiEntry ? 2 : 1;
      reasons.push(
        fileLarge
          ? "inventory:large-single-repo"
          : multiEntry
            ? "inventory:multi-entry"
            : "inventory:large-single-repo",
      );
    } else if (mediumSingleRepo || multiLang) {
      // L1: at least one thematic scout for medium file count or mild multi-lang.
      planScoutCount = multiLang ? 2 : 1;
      reasons.push(
        multiLang ? "inventory:multi-language" : "inventory:medium-single-repo",
      );
    } else if (uncertainty >= UNCERTAINTY_SCOUT_THRESHOLD) {
      planScoutCount = 1;
      reasons.push("plan-uncertainty:scouts");
    }
  }

  // Review lenses: default 1; raise when large single-repo multi-lang or high uncertainty.
  // Multi-source alone does not force extra lenses (source coverage gate is the primary control).
  if (reviewCouncilSize === 1) {
    if (largeSingleRepo && multiLang) {
      reviewCouncilSize = 2;
      reasons.push("inventory:large+multi-language:lenses");
    } else if (multiSource && multiLang && sourceCount >= 3) {
      reviewCouncilSize = 2;
      reasons.push("inventory:multi-source+multi-language:lenses");
    } else if (uncertainty >= UNCERTAINTY_LENS_THRESHOLD) {
      reviewCouncilSize = 2;
      reasons.push("plan-uncertainty:lenses");
    }
  }

  const orchestration: WorkspaceOrchestration = {
    ...base,
    planScoutCount: Math.min(4, Math.max(0, planScoutCount)),
    reviewCouncilSize: Math.min(4, Math.max(1, reviewCouncilSize)),
    planScoutMode,
    ...(planSurveyTaskBudget !== undefined ? { planSurveyTaskBudget } : {}),
    ...(requireSourceCoverage !== undefined ? { requireSourceCoverage } : {}),
    ...(requireSurfaceCoverage !== undefined ? { requireSurfaceCoverage } : {}),
  };

  const lightPath =
    orchestration.planScoutCount === 0 &&
    orchestration.reviewCouncilSize === 1 &&
    !multiSource &&
    orchestration.requireSourceCoverage !== true &&
    orchestration.requireSurfaceCoverage !== true;

  return { orchestration, reasons, lightPath, tier };
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
  const questions = spec.domains?.reduce((n, d) => n + (d.questions?.length ?? 0), 0) ?? 0;
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
