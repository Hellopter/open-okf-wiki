/**
 * Host coverage types: contract CoverageUnit shapes + host inventory/plan extensions.
 *
 * Canonical unit ids, CoverageUnit, and assertCoverage live in `@okf-wiki/contract`.
 * This module re-exports those and adds host-only inventory walk metadata,
 * BoundaryIndex, and plan policy fields.
 */

import { type CoveragePlan as ContractCoveragePlan, type CoverageSourceInventory, type CoverageSurfaceEntry, type CoverageUnit, sourceCoverageUnit, surfaceCoverageUnit, unitIdForSource, unitIdForSurface } from "@okf-wiki/contract/coverage";

export type {
  CoverageCancelledUnit,
  CoverageSurfaceEntry,
  CoverageUnit,
} from "@okf-wiki/contract/coverage";

export {
  isSurfaceUnitId,
  parseSurfaceUnitId,
  sourceCoverageUnit,
  surfaceCoverageUnit,
  unitIdForSource,
  unitIdForSurface,
} from "@okf-wiki/contract/coverage";

/** How a surface was discovered under a sealed snapshot. */
export type CoverageSurfaceOrigin = "root" | "manifest" | "workspace_dir";

/**
 * One monorepo / package surface under a source.
 * Contract-compatible (`id` / `path` / optional `label`) plus host origin metadata.
 */
export type CoverageSurface = CoverageSurfaceEntry & {
  origin: CoverageSurfaceOrigin;
};

/**
 * Per-source inventory record after a bounded sealed-tree walk.
 * Extends contract CoverageSourceInventory with host walk signals.
 */
export type CoverageSourceRecord = Omit<CoverageSourceInventory, "surfaces"> & {
  sourceId: string;
  /** Approximate ordinary-file count (respects soft caps + ignores). */
  fileCount: number;
  /** Sorted distinct language keys from file extensions. */
  languages: readonly string[];
  /** True when ≥2 package manifests were observed. */
  multiEntry: boolean;
  /** Deterministically ordered surfaces (root first, then path-sorted). */
  surfaces: readonly CoverageSurface[];
  /** True when the walk stopped early on a soft cap. */
  truncated: boolean;
};

/**
 * Frozen CoverageInventory: contract `{ version, sources }` plus host aggregates.
 * Built only from sealed snapshot roots (never live workspace checkouts).
 * Assignable to contract CoverageInventory (extra fields are host-only).
 */
export type CoverageInventory = {
  version: 1;
  sources: readonly CoverageSourceRecord[];
  /** Flattened units: one source unit per source, plus every surface unit. */
  units: readonly CoverageUnit[];
  /** Aggregate signals (compatible with adaptive-router RepositoryInventory). */
  sourceCount: number;
  fileCount: number;
  languages: readonly string[];
  multiEntry: boolean;
  large: boolean;
};

/**
 * Required units derived from inventory + policy options.
 * Contract fields: `requiredUnits`, `cancelled`. Host policy: lightPath / reasons / cap.
 */
export type CoveragePlan = ContractCoveragePlan & {
  /** True when no units are required (small single-source light path). */
  lightPath: boolean;
  reasons: readonly string[];
  maxSurfacesRequired: number;
};

/** Explicit unit → wiki page obligation for mechanical validation. */
export type CoverageObligation = {
  unitId: string;
  /** Wiki-relative POSIX page path (e.g. `sources/api.md`). */
  pagePath: string;
};

/** Declarative boundary path kinds (no graph edges). */
export type BoundaryPathKind = "openapi" | "proto" | "asyncapi" | "readme" | "manifest";

export type BoundaryPathEntry = {
  sourceId: string;
  /** Repo-relative POSIX path. */
  path: string;
  kind: BoundaryPathKind;
};

/**
 * Path-only boundary index. No service/API/event edges or inferred graphs.
 */
export type BoundaryIndex = {
  version: 1;
  entries: readonly BoundaryPathEntry[];
};

/** @deprecated Prefer {@link unitIdForSource} — bare source slug. */
export function sourceUnitId(sourceId: string): string {
  return unitIdForSource(sourceId);
}

/** @deprecated Prefer {@link unitIdForSurface}. */
export function surfaceUnitId(sourceId: string, repoRelativePath: string): string {
  return unitIdForSurface(sourceId, normalizeSurfacePath(repoRelativePath));
}

/**
 * Normalize surface path for inventory: empty / `.` / `./` → `.`;
 * strip leading `./` and trailing `/`. Matches contract surface id space for
 * non-root paths (contract `unitIdForSurface` also slash-normalizes).
 */
export function normalizeSurfacePath(repoRelativePath: string): string {
  const trimmed = repoRelativePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return trimmed === "" || trimmed === "." ? "." : trimmed;
}

/** Build a contract-valid source CoverageUnit (id = bare sourceId). */
export function makeSourceUnit(sourceId: string): CoverageUnit {
  return sourceCoverageUnit(sourceId);
}

/** Build a contract-valid surface CoverageUnit (`sourceId::path`). */
export function makeSurfaceUnit(sourceId: string, repoRelativePath: string): CoverageUnit {
  return surfaceCoverageUnit(sourceId, normalizeSurfacePath(repoRelativePath));
}
