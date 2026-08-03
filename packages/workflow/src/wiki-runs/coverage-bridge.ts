/**
 * Host coverage helpers for WikiRuns: load sealed freeze inventory/plan,
 * assertCoverage at Spec seal points, and Spec → validate-wiki obligations.
 *
 * Core builders already emit contract CoveragePlan (`requiredUnits` + bare
 * source unit ids). This module is the workflow-side load/assert surface.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  assertCoverage,
  type CoveragePlan as ContractCoveragePlan,
  CoveragePlanSchema,
  CoverageAssertError,
  type CoverageResult,
  isSurfaceUnitId,
  parseSealedCoveragePlan as parseContractSealedCoveragePlan,
  unitIdForSource,
  type WikiRunSpec,
  WikiRunSpecSchema,
} from "@okf-wiki/contract";
import type {
  CoverageInventory as CoreCoverageInventory,
  CoverageObligation,
  CoveragePlan as CoreCoveragePlan,
} from "@okf-wiki/core";
import { asRow, requiredText } from "./sql.js";

/** Canonical filenames inside sealed coverage_* artifact directories. */
export const COVERAGE_INVENTORY_FILE = "coverage-inventory.json";
export const COVERAGE_PLAN_FILE = "coverage-plan.json";
export const BOUNDARY_INDEX_FILE = "boundary-index.json";

/**
 * Parse a sealed coverage-plan.json into host CoreCoveragePlan.
 * Contract fields come from shared {@link parseContractSealedCoveragePlan}
 * (strips strict-schema-rejected host extras); lightPath/reasons/cap reattached
 * for host consumers. Prefer sealed freeze plan over re-walk when bytes exist.
 */
export function parseSealedCoveragePlan(raw: unknown): CoreCoveragePlan | undefined {
  const contract = parseContractSealedCoveragePlan(raw);
  if (!contract) return undefined;
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    ...contract,
    lightPath:
      obj.lightPath === true ||
      (typeof obj.lightPath !== "boolean" && contract.requiredUnits.length === 0),
    reasons: Array.isArray(obj.reasons)
      ? obj.reasons.filter((r): r is string => typeof r === "string")
      : [],
    maxSurfacesRequired:
      typeof obj.maxSurfacesRequired === "number" && Number.isFinite(obj.maxSurfacesRequired)
        ? Math.floor(obj.maxSurfacesRequired)
        : 12,
  };
}

/** Contract-only view of a host CoveragePlan (for assertCoverage). */
export function toContractCoveragePlan(
  plan: Pick<CoreCoveragePlan, "requiredUnits" | "cancelled" | "version">,
): ContractCoveragePlan {
  return CoveragePlanSchema.parse({
    version: plan.version ?? 1,
    requiredUnits: plan.requiredUnits ?? [],
    cancelled: plan.cancelled ?? [],
  });
}

/** Load coverage-plan.json from a sealed artifact root (directory or file). */
export function loadCoveragePlanFromArtifactRoot(
  artifactRoot: string,
): CoreCoveragePlan | undefined {
  const candidates = [
    path.join(artifactRoot, COVERAGE_PLAN_FILE),
    artifactRoot,
    path.join(artifactRoot, "analysis", COVERAGE_PLAN_FILE),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
      const plan = parseSealedCoveragePlan(raw);
      if (plan) return plan;
    } catch {
      // try next
    }
  }
  return undefined;
}

/** Load coverage-inventory.json from a sealed artifact root. */
export function loadCoverageInventoryFromArtifactRoot(
  artifactRoot: string,
): CoreCoverageInventory | undefined {
  const candidates = [
    path.join(artifactRoot, COVERAGE_INVENTORY_FILE),
    artifactRoot,
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") continue;
      const inv = raw as CoreCoverageInventory;
      if (inv.version === 1 && Array.isArray(inv.sources)) return inv;
    } catch {
      // try next
    }
  }
  return undefined;
}

/**
 * Build validate-wiki coverageObligations from Spec page bindings.
 * Unit ids match contract/core space (bare sourceId / `sourceId::path`).
 */
export function coverageObligationsFromSpec(spec: WikiRunSpec): CoverageObligation[] {
  const obligations: CoverageObligation[] = [];
  const seen = new Set<string>();
  for (const page of spec.pages) {
    if (page.critical === false) continue;
    const pagePath = page.path.trim();
    if (!pagePath) continue;
    const unitIds = new Set<string>();
    for (const uid of page.coverageUnitIds ?? []) {
      const id = uid.trim();
      if (id) unitIds.add(id);
    }
    for (const sid of page.sourceIds ?? []) {
      const id = unitIdForSource(sid);
      if (id) unitIds.add(id);
    }
    for (const surfaceId of page.surfaceIds ?? []) {
      const id = surfaceId.trim();
      if (id) unitIds.add(id);
    }
    for (const unitId of unitIds) {
      const key = `${unitId}→${pagePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      obligations.push({ unitId, pagePath });
    }
  }
  return obligations;
}

/** Page-set diff between prior and current Spec paths. */
export function pageSetDiffFromSpecs(
  prior: WikiRunSpec | undefined,
  current: WikiRunSpec,
): { added: string[]; removed: string[]; retained: string[] } | undefined {
  if (!prior) return undefined;
  const priorPaths = new Set(prior.pages.map((p) => p.path.trim()).filter(Boolean));
  const currentPaths = new Set(current.pages.map((p) => p.path.trim()).filter(Boolean));
  const added: string[] = [];
  const removed: string[] = [];
  const retained: string[] = [];
  for (const p of currentPaths) {
    if (priorPaths.has(p)) retained.push(p);
    else added.push(p);
  }
  for (const p of priorPaths) {
    if (!currentPaths.has(p)) removed.push(p);
  }
  added.sort();
  removed.sort();
  retained.sort();
  return { added, removed, retained };
}

/** Soft-read plan-scouts directory under run analysis (if present). */
export type ScoutsSummaryProjection = {
  kinds: string[];
  receiptCount: number;
  scouts: Array<{
    kind: string;
    ok?: boolean;
    relPath?: string;
    preview?: string;
  }>;
};

const SCOUT_FAILED_PREFIX = /^scout failed\b/i;
const PREVIEW_MAX = 2000;

function scoutReceiptOk(body: string): boolean {
  // Receipts write "Scout failed …" on the first content line after the title.
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return !SCOUT_FAILED_PREFIX.test(trimmed);
  }
  return true;
}

/** Soft-read plan-scouts directory under run analysis (if present). */
export function readScoutsSummary(analysisDir: string): ScoutsSummaryProjection | undefined {
  const scoutsDir = path.join(analysisDir, "plan-scouts");
  try {
    const entries = readdirSync(scoutsDir).filter((name) => name.endsWith(".md"));
    if (entries.length === 0) return undefined;
    const kinds = entries
      .map((name) => name.replace(/\.md$/i, ""))
      .sort((a, b) => a.localeCompare(b));
    const scouts = kinds.map((kind) => {
      const fileName = `${kind}.md`;
      const relPath = `analysis/plan-scouts/${fileName}`;
      let preview: string | undefined;
      let ok: boolean | undefined;
      try {
        const body = readFileSync(path.join(scoutsDir, fileName), "utf8");
        ok = scoutReceiptOk(body);
        const trimmed = body.trim();
        if (trimmed.length > 0) {
          preview = trimmed.length > PREVIEW_MAX ? `${trimmed.slice(0, PREVIEW_MAX)}…` : trimmed;
        }
      } catch {
        ok = undefined;
      }
      return {
        kind,
        ...(ok !== undefined ? { ok } : {}),
        relPath,
        ...(preview !== undefined ? { preview } : {}),
      };
    });
    return { kinds, receiptCount: kinds.length, scouts };
  } catch {
    return undefined;
  }
}

/** Soft-load CoverageResult-shaped assertCoverage output for plan-review (no throw). */
export type SoftCoverageProjection = {
  result: CoverageResult;
  stop_reason: CoverageResult["stop_reason"];
};

/** Resolve sealed freeze coverage_plan relative path for a run (if any). */
export function sealedCoveragePlanRelativePath(
  db: DatabaseSync,
  runId: string,
): string | undefined {
  const row = asRow(
    db
      .prepare(
        `SELECT artifacts.relative_path
         FROM node_outputs
         JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
         JOIN (
           SELECT node_key, MAX(generation) AS generation FROM nodes
           WHERE run_id = ? AND node_key = 'freeze' GROUP BY node_key
         ) cur ON cur.node_key = node_outputs.node_key
              AND cur.generation = node_outputs.node_generation
         WHERE node_outputs.run_id = ?
           AND node_outputs.node_key = 'freeze'
           AND node_outputs.role = 'coverage_plan'
         LIMIT 1`,
      )
      .get(runId, runId),
  );
  return row ? requiredText(row, "relative_path") : undefined;
}

/** Resolve sealed freeze coverage_inventory relative path for a run (if any). */
export function sealedCoverageInventoryRelativePath(
  db: DatabaseSync,
  runId: string,
): string | undefined {
  const row = asRow(
    db
      .prepare(
        `SELECT artifacts.relative_path
         FROM node_outputs
         JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
         JOIN (
           SELECT node_key, MAX(generation) AS generation FROM nodes
           WHERE run_id = ? AND node_key = 'freeze' GROUP BY node_key
         ) cur ON cur.node_key = node_outputs.node_key
              AND cur.generation = node_outputs.node_generation
         WHERE node_outputs.run_id = ?
           AND node_outputs.node_key = 'freeze'
           AND node_outputs.role = 'coverage_inventory'
         LIMIT 1`,
      )
      .get(runId, runId),
  );
  return row ? requiredText(row, "relative_path") : undefined;
}

/** Load contract CoveragePlan from sealed freeze artifact or analysis fallback. */
export function loadSealedContractCoveragePlan(
  db: DatabaseSync,
  runId: string,
  runDir: string,
): ContractCoveragePlan | undefined {
  const relative = sealedCoveragePlanRelativePath(db, runId);
  const roots = [
    ...(relative ? [path.join(runDir, relative)] : []),
    path.join(runDir, "analysis"),
  ];
  for (const root of roots) {
    const corePlan = loadCoveragePlanFromArtifactRoot(root);
    if (corePlan) return toContractCoveragePlan(corePlan);
  }
  return undefined;
}

/** Load core CoverageInventory from sealed freeze artifact or analysis fallback. */
export function loadSealedCoverageInventory(
  db: DatabaseSync,
  runId: string,
  runDir: string,
): CoreCoverageInventory | undefined {
  const relative = sealedCoverageInventoryRelativePath(db, runId);
  const roots = [
    ...(relative ? [path.join(runDir, relative)] : []),
    path.join(runDir, "analysis"),
  ];
  for (const root of roots) {
    const inv = loadCoverageInventoryFromArtifactRoot(root);
    if (inv) return inv;
  }
  return undefined;
}

/**
 * Fail-closed coverage gate for a sealed Spec when a CoveragePlan is available.
 * Used by planConfirm=false auto-approve and plan approve.
 *
 * Multi-source (or explicit requirePlan): missing / empty plan is a hard fail —
 * never soft-skip (ADR 0040). Spec sourceCoverage/surfaceCoverage cancellations
 * merge via assertCoverage → effectiveCoveragePlan.
 */
export function assertCoverageForSealedSpec(
  db: DatabaseSync,
  runId: string,
  runDir: string,
  spec: ReturnType<typeof WikiRunSpecSchema.parse> | undefined,
  options?: {
    requireSpec?: boolean;
    /** Force fail when plan is missing even for single-source. */
    requirePlan?: boolean;
  },
): void {
  const inventory = loadSealedCoverageInventory(db, runId, runDir);
  const sourceCount =
    typeof inventory?.sourceCount === "number"
      ? inventory.sourceCount
      : (inventory?.sources?.length ?? 0);
  const multiSource = sourceCount >= 2;
  const requirePlan = options?.requirePlan === true || multiSource;

  const coveragePlan = loadSealedContractCoveragePlan(db, runId, runDir);
  if (!coveragePlan) {
    if (requirePlan) {
      throw new CoverageAssertError(
        multiSource
          ? `coverage gate requires a sealed CoveragePlan for multi-source runs ` +
              `(sourceCount=${sourceCount}); freeze must produce coverage_plan`
          : "coverage gate requires a sealed CoveragePlan (requirePlan)",
      );
    }
    return;
  }
  if (coveragePlan.requiredUnits.length === 0) {
    if (multiSource) {
      throw new CoverageAssertError(
        `coverage gate: multi-source CoveragePlan has empty requiredUnits ` +
          `(sourceCount=${sourceCount}); inventory/plan build incomplete`,
      );
    }
    return;
  }
  if (!spec) {
    if (options?.requireSpec || requirePlan) {
      throw new CoverageAssertError(
        "coverage gate requires a parseable Spec when CoveragePlan has required units",
      );
    }
    return;
  }
  assertCoverage(spec, coveragePlan, { throwOnGap: true, sourceCount });
}

/** @internal test helper — unit id projection for obligations. */
export function isSourceLikeUnitId(unitId: string): boolean {
  return !isSurfaceUnitId(unitId);
}
