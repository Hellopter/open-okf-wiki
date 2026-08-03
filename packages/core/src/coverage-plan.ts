/**
 * Deterministic CoveragePlan builder: inventory + policy → required units.
 *
 * Rules (fail-closed host policy, no LLM):
 * - multi-source (≥2): every source unit is required
 * - single source that is large / multiEntry / multi-language / surfaces≥3:
 *   critical surfaces required; if surfaces exceed maxSurfacesRequired, **throw**
 *   (never silent slice — align with contract requiredSurfaceUnitsFromInventory)
 * - small single source: empty required (light path)
 *
 * Output shape matches `@okf-wiki/contract` CoveragePlan (`requiredUnits`,
 * `cancelled`) plus host policy fields (`lightPath`, `reasons`, cap).
 */

import { CoverageAssertError } from "@okf-wiki/contract";
import {
  type CoverageInventory,
  type CoveragePlan,
  type CoverageUnit,
  makeSourceUnit,
  makeSurfaceUnit,
} from "./coverage-types.js";
import { INVENTORY_LARGE_FILE_THRESHOLD } from "./repository-inventory.js";

export const DEFAULT_MAX_SURFACES_REQUIRED = 12;
/** Surfaces threshold that forces surface obligations on a single source. */
export const SURFACE_COMPLEXITY_THRESHOLD = 3;

export type BuildCoveragePlanOptions = {
  /** Max surface units required for complex single-source (default 12). */
  maxSurfacesRequired?: number;
  /** Override large-file threshold (default matches inventory). */
  largeFileThreshold?: number;
};

/**
 * Derive required coverage units from a frozen CoverageInventory.
 */
export function buildCoveragePlan(
  inventory: CoverageInventory,
  options: BuildCoveragePlanOptions = {},
): CoveragePlan {
  const maxSurfacesRequired = Math.max(
    0,
    Math.floor(options.maxSurfacesRequired ?? DEFAULT_MAX_SURFACES_REQUIRED),
  );
  const largeThreshold = options.largeFileThreshold ?? INVENTORY_LARGE_FILE_THRESHOLD;
  const reasons: string[] = [];

  if (inventory.sourceCount >= 2) {
    // Always require every freeze source unit.
    const requiredUnits: CoverageUnit[] = inventory.sources.map((s) =>
      makeSourceUnit(s.sourceId),
    );
    reasons.push("multi-source: each source unit required");

    // ADR 0040: surfaces are additive when a source is multi-entry (monorepo
    // package roots inside one freeze member). Source-qualified; fail-closed
    // per multi-entry source when over maxSurfacesRequired (no silent slice).
    for (const source of inventory.sources) {
      if (!source.multiEntry) continue;
      if (source.surfaces.length > maxSurfacesRequired) {
        throw new CoverageAssertError(
          `multi-entry source "${source.sourceId}" has ${source.surfaces.length} surfaces ` +
            `but maxSurfacesRequired is ${maxSurfacesRequired}; ` +
            `reduce inventoried surfaces, raise workspace.orchestration.maxSurfacesRequired, ` +
            `or cancel units explicitly (silent truncation is not allowed)`,
        );
      }
      for (const surface of source.surfaces) {
        requiredUnits.push(makeSurfaceUnit(source.sourceId, surface.path));
      }
      reasons.push(
        `multi-source additive surfaces for multi-entry source "${source.sourceId}" ` +
          `(${source.surfaces.length} unit(s), cap ${maxSurfacesRequired})`,
      );
    }

    return {
      version: 1,
      requiredUnits,
      cancelled: [],
      lightPath: false,
      reasons,
      maxSurfacesRequired,
    };
  }

  // Single source (or empty inventory).
  if (inventory.sourceCount === 0) {
    reasons.push("no sources: empty plan");
    return {
      version: 1,
      requiredUnits: [],
      cancelled: [],
      lightPath: true,
      reasons,
      maxSurfacesRequired,
    };
  }

  const sole = inventory.sources[0]!;
  const multiLang = sole.languages.length >= 2;
  const multiEntry = sole.multiEntry;
  const large = sole.fileCount >= largeThreshold || inventory.large;
  const complexSurfaces = sole.surfaces.length >= SURFACE_COMPLEXITY_THRESHOLD;

  if (!large && !multiEntry && !multiLang && !complexSurfaces) {
    reasons.push("small single-source: light path (no required units)");
    return {
      version: 1,
      requiredUnits: [],
      cancelled: [],
      lightPath: true,
      reasons,
      maxSurfacesRequired,
    };
  }

  if (large) reasons.push("single-source:large");
  if (multiEntry) reasons.push("single-source:multi-entry");
  if (multiLang) reasons.push("single-source:multi-language");
  if (complexSurfaces) reasons.push("single-source:surfaces>=3");

  // Critical surfaces: deterministic order already on inventory (root first).
  // Fail-closed: never silently slice past maxSurfacesRequired (silent under-coverage).
  // Prefer throw at freeze/plan build so under-coverage cannot seal. Callers must
  // raise workspace.orchestration.maxSurfacesRequired, reduce inventoried surfaces,
  // or cancel units explicitly — not drop them without audit (ADR 0040 / contract parity).
  if (sole.surfaces.length > maxSurfacesRequired) {
    throw new CoverageAssertError(
      `inventory has ${sole.surfaces.length} surfaces but maxSurfacesRequired is ${maxSurfacesRequired}; ` +
        `reduce inventoried surfaces, raise workspace.orchestration.maxSurfacesRequired, ` +
        `or cancel units explicitly (silent truncation is not allowed)`,
    );
  }
  const requiredUnits: CoverageUnit[] = sole.surfaces.map((s) =>
    makeSurfaceUnit(sole.sourceId, s.path),
  );
  reasons.push(`critical surfaces required (cap ${maxSurfacesRequired})`);

  return {
    version: 1,
    requiredUnits,
    cancelled: [],
    lightPath: false,
    reasons,
    maxSurfacesRequired,
  };
}

/**
 * Look up a unit from an inventory by id (source or surface).
 */
export function findInventoryUnit(
  inventory: CoverageInventory,
  unitId: string,
): CoverageUnit | undefined {
  return inventory.units.find((u) => u.id === unitId);
}
