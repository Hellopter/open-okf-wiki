/**
 * CoverageUnit-based plan coverage (Phase A foundation).
 *
 * Fail-closed host gate for multi-source and large single-repo surface coverage.
 * Pure contract types + helpers — no knowledge graph, no FS.
 *
 * Unit id conventions:
 * - source unit id = bare sourceId (slug)
 * - surface unit id = `{sourceId}::{path}` (source-qualified path)
 *
 * Prefer `coverageUnitIds` on Spec pages/domains as canonical; `sourceIds` /
 * `surfaceIds` are projections that normalize into the same id space.
 */

import { z } from "zod";
import { SourceIdSchema } from "./workspace.js";

/** Max length for a source-qualified surface id (`sourceId::path`). */
const COVERAGE_UNIT_ID_MAX = 400;
const SURFACE_PATH_MAX = 300;
const COVERAGE_REASON_MAX = 2_000;

// ---------------------------------------------------------------------------
// Unit ids
// ---------------------------------------------------------------------------

/**
 * Canonical id for a whole-source coverage unit (multi-source plan gate).
 * Bare source slug — never includes `::`.
 */
export function unitIdForSource(sourceId: string): string {
  return sourceId.trim();
}

/**
 * Canonical id for a surface (entry/module/package path) within a source.
 * Format: `{sourceId}::{path}` with trimmed, slash-normalized path (no leading `/`).
 */
export function unitIdForSurface(sourceId: string, path: string): string {
  const id = sourceId.trim();
  const normalized = normalizeSurfacePath(path);
  return `${id}::${normalized}`;
}

/** True when unit id looks like a surface (`sourceId::path`), not a bare source. */
export function isSurfaceUnitId(unitId: string): boolean {
  return unitId.includes("::");
}

/** Parse `sourceId::path` surface ids; returns null for bare source ids. */
export function parseSurfaceUnitId(
  unitId: string,
): { sourceId: string; path: string } | null {
  const trimmed = unitId.trim();
  const sep = trimmed.indexOf("::");
  if (sep <= 0) return null;
  const sourceId = trimmed.slice(0, sep).trim();
  const path = trimmed.slice(sep + 2).trim();
  if (!sourceId || !path) return null;
  return { sourceId, path: normalizeSurfacePath(path) };
}

function normalizeSurfacePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/{2,}/g, "/");
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const CoverageUnitKindSchema = z.enum(["source", "surface"]);
export type CoverageUnitKind = z.infer<typeof CoverageUnitKindSchema>;

/**
 * One obligatory plan-coverage atom: either a whole source or a surface path
 * inside a source.
 */
export const CoverageUnitSchema = z
  .object({
    id: z.string().trim().min(1).max(COVERAGE_UNIT_ID_MAX),
    kind: CoverageUnitKindSchema,
    sourceId: SourceIdSchema,
    /** Present when kind is `surface` (repository-relative path). */
    path: z.string().trim().min(1).max(SURFACE_PATH_MAX).optional(),
  })
  .strict()
  .superRefine((unit, ctx) => {
    if (unit.kind === "source") {
      if (unit.path !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "source coverage unit must not set path",
          path: ["path"],
        });
      }
      if (unit.id !== unitIdForSource(unit.sourceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `source unit id must equal sourceId (expected "${unitIdForSource(unit.sourceId)}")`,
          path: ["id"],
        });
      }
    } else {
      if (unit.path === undefined || unit.path.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "surface coverage unit requires path",
          path: ["path"],
        });
      } else {
        const expected = unitIdForSurface(unit.sourceId, unit.path);
        if (unit.id !== expected) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `surface unit id must be source-qualified (expected "${expected}")`,
            path: ["id"],
          });
        }
      }
    }
  });

export type CoverageUnit = z.infer<typeof CoverageUnitSchema>;

/** One inventoried surface under a source (host inventory / accelerator). */
export const CoverageSurfaceEntrySchema = z
  .object({
    /** Source-qualified id: `{sourceId}::{path}`. */
    id: z.string().trim().min(1).max(COVERAGE_UNIT_ID_MAX),
    path: z.string().trim().min(1).max(SURFACE_PATH_MAX),
    /** Optional human label (package name, entry kind, …). */
    label: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type CoverageSurfaceEntry = z.infer<typeof CoverageSurfaceEntrySchema>;

/** Per-source inventory row used to derive required coverage units. */
export const CoverageSourceInventorySchema = z
  .object({
    sourceId: SourceIdSchema,
    fileCount: z.number().int().nonnegative().optional(),
    languages: z.array(z.string().trim().min(1).max(40)).max(64).optional(),
    /**
     * Surfaces with source-qualified ids `{sourceId}::{path}`.
     * Host must not silently drop surfaces past budget — raise caps or cancel
     * units explicitly via CoveragePlan.cancelled.
     */
    surfaces: z.array(CoverageSurfaceEntrySchema).max(256).default([]),
  })
  .strict()
  .superRefine((row, ctx) => {
    for (let i = 0; i < row.surfaces.length; i++) {
      const surface = row.surfaces[i]!;
      const expected = unitIdForSurface(row.sourceId, surface.path);
      if (surface.id !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `surface id must be "${expected}"`,
          path: ["surfaces", i, "id"],
        });
      }
    }
  });

export type CoverageSourceInventory = z.infer<typeof CoverageSourceInventorySchema>;

/**
 * Host-side coverage inventory (best-effort accelerator + gate input).
 * Not a citation membership oracle.
 */
export const CoverageInventorySchema = z
  .object({
    version: z.literal(1).default(1),
    sources: z.array(CoverageSourceInventorySchema).max(64).default([]),
  })
  .strict();

export type CoverageInventory = z.infer<typeof CoverageInventorySchema>;

/** Explicit cancellation of a required unit (operator or synthesizer). */
export const CoverageCancelledUnitSchema = z
  .object({
    unitId: z.string().trim().min(1).max(COVERAGE_UNIT_ID_MAX),
    reason: z.string().trim().min(1).max(COVERAGE_REASON_MAX),
  })
  .strict();

export type CoverageCancelledUnit = z.infer<typeof CoverageCancelledUnitSchema>;

/**
 * What the plan phase must cover before Spec is accepted.
 * Built by host from inventory + orchestration flags — never silent truncation.
 */
export const CoveragePlanSchema = z
  .object({
    version: z.literal(1).default(1),
    requiredUnits: z.array(CoverageUnitSchema).default([]),
    cancelled: z.array(CoverageCancelledUnitSchema).default([]),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    for (let i = 0; i < plan.requiredUnits.length; i++) {
      const id = plan.requiredUnits[i]!.id;
      if (ids.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate required unit id: ${id}`,
          path: ["requiredUnits", i, "id"],
        });
      }
      ids.add(id);
    }
  });

export type CoveragePlan = z.infer<typeof CoveragePlanSchema>;

/**
 * Parse sealed freeze / host coverage-plan.json into strict contract CoveragePlan.
 *
 * Host freeze writes extras (`lightPath`, `reasons`, `maxSurfacesRequired`) that
 * {@link CoveragePlanSchema} rejects under `.strict()`. This helper strips unknown
 * keys and maps to `{ version, requiredUnits, cancelled }`.
 *
 * Also accepts legacy core shape `{ required: CoverageUnit[] }` (maps to
 * `requiredUnits`; source units normalize via `sourceId`, not legacy `source:id`).
 *
 * Returns `undefined` when the payload is not a recognizable plan.
 */
export function parseSealedCoveragePlan(raw: unknown): CoveragePlan | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;

  const hasRequiredUnits = Array.isArray(obj.requiredUnits);
  const hasLegacyRequired = Array.isArray(obj.required);
  if (!hasRequiredUnits && !hasLegacyRequired) return undefined;

  let requiredUnits: unknown[] = hasRequiredUnits
    ? (obj.requiredUnits as unknown[])
    : [];

  if (!hasRequiredUnits && hasLegacyRequired) {
    requiredUnits = [];
    for (const u of obj.required as unknown[]) {
      const mapped = mapLegacyCoverageUnit(u);
      if (mapped) requiredUnits.push(mapped);
    }
  }

  const parsed = CoveragePlanSchema.safeParse({
    version: obj.version ?? 1,
    requiredUnits,
    cancelled: Array.isArray(obj.cancelled) ? obj.cancelled : [],
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Parse sealed freeze / host coverage-inventory.json into strict contract
 * CoverageInventory. Strips host walk metadata (`units`, `sourceCount`,
 * `multiEntry`, `large`, per-source `truncated` / `origin`, …).
 *
 * Returns `undefined` when the payload is not a recognizable inventory.
 */
export function parseSealedCoverageInventory(
  raw: unknown,
): CoverageInventory | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.sources)) return undefined;

  const sources = obj.sources.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const row = entry as Record<string, unknown>;
    const surfaces = Array.isArray(row.surfaces)
      ? row.surfaces.map((surf) => {
          if (!surf || typeof surf !== "object" || Array.isArray(surf)) return surf;
          const s = surf as Record<string, unknown>;
          // Keep contract surface fields only (drop host `origin`, etc.).
          return {
            id: s.id,
            path: s.path,
            ...(typeof s.label === "string" ? { label: s.label } : {}),
          };
        })
      : [];
    return {
      sourceId: row.sourceId,
      ...(typeof row.fileCount === "number" ? { fileCount: row.fileCount } : {}),
      ...(Array.isArray(row.languages) ? { languages: row.languages } : {}),
      surfaces,
    };
  });

  const parsed = CoverageInventorySchema.safeParse({
    version: obj.version ?? 1,
    sources,
  });
  return parsed.success ? parsed.data : undefined;
}

/** Map legacy / loose unit rows onto contract CoverageUnit objects. */
function mapLegacyCoverageUnit(raw: unknown): CoverageUnit | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const u = raw as Record<string, unknown>;
  const sourceId =
    typeof u.sourceId === "string"
      ? u.sourceId.trim()
      : typeof u.id === "string" && !String(u.id).includes("::")
        ? String(u.id)
            .replace(/^source:/, "")
            .trim()
        : "";
  if (!sourceId) return undefined;
  try {
    if (u.kind === "surface" || (typeof u.path === "string" && u.path.length > 0)) {
      return surfaceCoverageUnit(sourceId, String(u.path ?? "."));
    }
    return sourceCoverageUnit(sourceId);
  } catch {
    return undefined;
  }
}

export const CoverageRowStatusSchema = z.enum(["covered", "gap", "cancelled"]);
export type CoverageRowStatus = z.infer<typeof CoverageRowStatusSchema>;

export const CoverageResultRowSchema = z
  .object({
    unitId: z.string().trim().min(1).max(COVERAGE_UNIT_ID_MAX),
    kind: CoverageUnitKindSchema,
    status: CoverageRowStatusSchema,
    /** Wiki page paths that cover this unit (when status is covered). */
    coveredBy: z.array(z.string().trim().min(1).max(200)).default([]),
    reason: z.string().trim().min(1).max(COVERAGE_REASON_MAX).optional(),
  })
  .strict();

export type CoverageResultRow = z.infer<typeof CoverageResultRowSchema>;

export const CoverageStopReasonSchema = z.enum([
  /** Every required unit covered or explicitly cancelled. */
  "complete",
  /** One or more required units neither covered nor cancelled. */
  "coverage_gap",
  /** No required units (light path / nothing to gate). */
  "not_required",
]);
export type CoverageStopReason = z.infer<typeof CoverageStopReasonSchema>;

export const CoverageResultSchema = z
  .object({
    ok: z.boolean(),
    rows: z.array(CoverageResultRowSchema).default([]),
    stop_reason: CoverageStopReasonSchema,
    /** Required units that remain as gaps (convenience). */
    gaps: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export type CoverageResult = z.infer<typeof CoverageResultSchema>;

// ---------------------------------------------------------------------------
// Spec-facing helpers (canonical coverageUnitIds + projections)
// ---------------------------------------------------------------------------

export type SpecCoverageBinding = {
  coverageUnitIds?: readonly string[] | undefined;
  sourceIds?: readonly string[] | undefined;
  surfaceIds?: readonly string[] | undefined;
};

/**
 * Normalize page/domain coverage bindings.
 * `coverageUnitIds` is canonical; `sourceIds` / `surfaceIds` project into the
 * same id space and are re-derived for consumers that only read projections.
 */
export function normalizeSpecUnitIds(binding: SpecCoverageBinding): {
  coverageUnitIds: string[];
  sourceIds: string[];
  surfaceIds: string[];
} {
  const unitIds = new Set<string>();

  for (const raw of binding.coverageUnitIds ?? []) {
    const id = raw.trim();
    if (id) unitIds.add(id);
  }
  for (const raw of binding.sourceIds ?? []) {
    const id = unitIdForSource(raw);
    if (id) unitIds.add(id);
  }
  for (const raw of binding.surfaceIds ?? []) {
    const id = raw.trim();
    if (!id) continue;
    // Accept already-qualified surface ids; reject bare paths without source.
    if (isSurfaceUnitId(id)) {
      const parsed = parseSurfaceUnitId(id);
      unitIds.add(parsed ? unitIdForSurface(parsed.sourceId, parsed.path) : id);
    } else {
      // Bare surface path is not source-qualified — keep as-is only if it was
      // listed under surfaceIds without :: (host/planner bug); still record.
      unitIds.add(id);
    }
  }

  const coverageUnitIds = [...unitIds].sort();
  const sourceIds: string[] = [];
  const surfaceIds: string[] = [];
  for (const id of coverageUnitIds) {
    if (isSurfaceUnitId(id)) surfaceIds.push(id);
    else sourceIds.push(id);
  }
  return { coverageUnitIds, sourceIds, surfaceIds };
}

/** Collect unit ids covered by critical pages (and optionally domains). */
export function collectCoveredUnitIds(
  spec: {
    pages: readonly (SpecCoverageBinding & {
      path: string;
      critical?: boolean;
    })[];
    domains?: readonly (SpecCoverageBinding & { id: string })[];
  },
  options?: { includeDomains?: boolean; criticalPagesOnly?: boolean },
): Map<string, string[]> {
  const criticalPagesOnly = options?.criticalPagesOnly !== false;
  const covered = new Map<string, string[]>();

  const add = (unitId: string, by: string) => {
    const list = covered.get(unitId) ?? [];
    if (!list.includes(by)) list.push(by);
    covered.set(unitId, list);
  };

  for (const page of spec.pages) {
    if (criticalPagesOnly && page.critical === false) continue;
    const { coverageUnitIds } = normalizeSpecUnitIds(page);
    for (const unitId of coverageUnitIds) {
      add(unitId, page.path);
    }
  }

  if (options?.includeDomains) {
    for (const domain of spec.domains ?? []) {
      const { coverageUnitIds } = normalizeSpecUnitIds(domain);
      for (const unitId of coverageUnitIds) {
        add(unitId, `domain:${domain.id}`);
      }
    }
  }

  return covered;
}

// ---------------------------------------------------------------------------
// Build plan helpers (host / tests)
// ---------------------------------------------------------------------------

export function sourceCoverageUnit(sourceId: string): CoverageUnit {
  const id = unitIdForSource(sourceId);
  return CoverageUnitSchema.parse({
    id,
    kind: "source",
    sourceId: id,
  });
}

export function surfaceCoverageUnit(sourceId: string, path: string): CoverageUnit {
  const sid = sourceId.trim();
  const normalized = normalizeSurfacePath(path);
  return CoverageUnitSchema.parse({
    id: unitIdForSurface(sid, normalized),
    kind: "surface",
    sourceId: sid,
    path: normalized,
  });
}

/**
 * Derive required source units from inventory when multi-source coverage is on.
 * Does not truncate — caller must enforce maxSourcesPerRun before inventoring
 * or cancel excess units explicitly.
 */
export function requiredSourceUnitsFromInventory(
  inventory: CoverageInventory,
): CoverageUnit[] {
  return inventory.sources.map((s) => sourceCoverageUnit(s.sourceId));
}

/**
 * Derive required surface units from inventory (large single-repo path).
 * Does not silently truncate past maxSurfaces — throws if over budget.
 */
export function requiredSurfaceUnitsFromInventory(
  inventory: CoverageInventory,
  options?: { maxSurfacesRequired?: number },
): CoverageUnit[] {
  const max = options?.maxSurfacesRequired ?? 12;
  const units: CoverageUnit[] = [];
  for (const source of inventory.sources) {
    for (const surface of source.surfaces) {
      units.push(surfaceCoverageUnit(source.sourceId, surface.path));
    }
  }
  if (units.length > max) {
    throw new CoverageAssertError(
      `inventory has ${units.length} surfaces but maxSurfacesRequired is ${max}; ` +
        `reduce inventoried surfaces, raise workspace.orchestration.maxSurfacesRequired, ` +
        `or cancel units explicitly (silent truncation is not allowed)`,
    );
  }
  return units;
}

// ---------------------------------------------------------------------------
// Spec → plan cancelled merge (assertCoverage cancel path)
// ---------------------------------------------------------------------------

/**
 * Spec rows that can declare unit cancellations for the coverage gate.
 * Matches WikiRunSpec `sourceCoverage` / `surfaceCoverage` cancel fields.
 */
export type SpecCoverageCancelSource = {
  sourceCoverage?: readonly {
    sourceId: string;
    cancelled?: boolean | undefined;
    notes?: string | undefined;
  }[];
  surfaceCoverage?: readonly {
    surfaceId: string;
    cancelled?: boolean | undefined;
    notes?: string | undefined;
  }[];
};

/**
 * Collect explicit unit cancellations from Spec sourceCoverage / surfaceCoverage
 * rows (`cancelled: true` + `notes` as the reason). Silent cancel (no notes) is
 * ignored here; Spec schema should reject those at parse time.
 */
export function cancelledUnitsFromSpec(
  spec: SpecCoverageCancelSource,
): CoverageCancelledUnit[] {
  const out: CoverageCancelledUnit[] = [];
  const seen = new Set<string>();

  for (const row of spec.sourceCoverage ?? []) {
    if (row.cancelled !== true) continue;
    const unitId = unitIdForSource(row.sourceId);
    if (!unitId || seen.has(unitId)) continue;
    const reason = row.notes?.trim();
    if (!reason) continue;
    seen.add(unitId);
    out.push(CoverageCancelledUnitSchema.parse({ unitId, reason }));
  }

  for (const row of spec.surfaceCoverage ?? []) {
    if (row.cancelled !== true) continue;
    const unitId = row.surfaceId.trim();
    if (!unitId || seen.has(unitId)) continue;
    const reason = row.notes?.trim();
    if (!reason) continue;
    seen.add(unitId);
    out.push(CoverageCancelledUnitSchema.parse({ unitId, reason }));
  }

  return out;
}

/**
 * Merge Spec-declared cancellations into a host CoveragePlan for assertCoverage.
 * Freeze-built plans usually have `cancelled: []`; the synthesizer cancels via
 * Spec `sourceCoverage` / `surfaceCoverage` rows (`cancelled: true` + notes).
 * Existing plan.cancelled entries are preserved (first reason wins per unitId).
 */
export function effectiveCoveragePlan(
  plan: CoveragePlan,
  spec: SpecCoverageCancelSource,
): CoveragePlan {
  const fromSpec = cancelledUnitsFromSpec(spec);
  if (fromSpec.length === 0) return plan;

  const cancelled = [...(plan.cancelled ?? [])];
  const seen = new Set(cancelled.map((c) => c.unitId.trim()));
  for (const c of fromSpec) {
    if (seen.has(c.unitId)) continue;
    cancelled.push(c);
    seen.add(c.unitId);
  }

  return CoveragePlanSchema.parse({
    version: plan.version ?? 1,
    requiredUnits: plan.requiredUnits,
    cancelled,
  });
}

// ---------------------------------------------------------------------------
// assertCoverage
// ---------------------------------------------------------------------------

export type AssertCoverageOptions = {
  /**
   * When true (default), throw {@link CoverageAssertError} if any required
   * unit is a gap. When false, only return the CoverageResult.
   */
  throwOnGap?: boolean;
  /**
   * Count of freeze sources. When >= 2, source-kind required units are gated
   * (unless the plan has no source units). Informational for callers; the plan
   * already lists requiredUnits.
   */
  sourceCount?: number;
  /**
   * When true, also credit domain-level coverage bindings (default false —
   * critical pages are the Spec coverage authority).
   */
  includeDomains?: boolean;
};

export class CoverageAssertError extends Error {
  readonly code = "COVERAGE_GAP";
  readonly result: CoverageResult;

  constructor(message: string, result?: CoverageResult) {
    super(message);
    this.name = "CoverageAssertError";
    this.result =
      result ??
      CoverageResultSchema.parse({
        ok: false,
        rows: [],
        stop_reason: "coverage_gap",
        gaps: [],
      });
  }
}

/**
 * Fail-closed coverage check: every plan.requiredUnits entry must be covered
 * by a critical page's coverageUnitIds / sourceIds / surfaceIds, or listed in
 * plan.cancelled **or** Spec sourceCoverage/surfaceCoverage with cancelled:true.
 *
 * - Multi-source: plan should list one source unit per freeze source.
 * - Large single-repo with surfaces: plan lists surface units.
 * - One page may cover multiple units.
 * - Non-critical pages do not satisfy the gate.
 * - Spec cancel path: `sourceCoverage`/`surfaceCoverage` rows with
 *   `cancelled: true` and `notes` (reason) merge into the effective plan.
 */
export function assertCoverage(
  spec: {
    pages: readonly (SpecCoverageBinding & {
      path: string;
      critical?: boolean;
    })[];
    domains?: readonly (SpecCoverageBinding & { id: string })[];
  } & SpecCoverageCancelSource,
  plan: CoveragePlan,
  options: AssertCoverageOptions = {},
): CoverageResult {
  const throwOnGap = options.throwOnGap !== false;
  const effective = effectiveCoveragePlan(plan, spec);
  const required = effective.requiredUnits;
  if (required.length === 0) {
    const empty = CoverageResultSchema.parse({
      ok: true,
      rows: [],
      stop_reason: "not_required",
      gaps: [],
    });
    return empty;
  }

  const cancelledById = new Map<string, string>();
  for (const c of effective.cancelled) {
    cancelledById.set(c.unitId.trim(), c.reason);
  }

  const covered = collectCoveredUnitIds(spec, {
    criticalPagesOnly: true,
    includeDomains: options.includeDomains === true,
  });

  const rows: CoverageResultRow[] = [];
  const gaps: string[] = [];

  for (const unit of required) {
    const cancelReason = cancelledById.get(unit.id);
    if (cancelReason !== undefined) {
      rows.push(
        CoverageResultRowSchema.parse({
          unitId: unit.id,
          kind: unit.kind,
          status: "cancelled",
          coveredBy: [],
          reason: cancelReason,
        }),
      );
      continue;
    }

    const by = covered.get(unit.id);
    if (by && by.length > 0) {
      rows.push(
        CoverageResultRowSchema.parse({
          unitId: unit.id,
          kind: unit.kind,
          status: "covered",
          coveredBy: by,
        }),
      );
      continue;
    }

    // Projection fallback: a source unit is also covered if any surface unit
    // under that source is covered? No — fail-closed; source units need
    // explicit source id binding. Surface units need exact id match.

    gaps.push(unit.id);
    rows.push(
      CoverageResultRowSchema.parse({
        unitId: unit.id,
        kind: unit.kind,
        status: "gap",
        coveredBy: [],
        reason:
          unit.kind === "source"
            ? `required source "${unit.sourceId}" is not covered by any critical page ` +
              `(set coverageUnitIds or sourceIds, or cancel the unit)`
            : `required surface "${unit.id}" is not covered by any critical page ` +
              `(set coverageUnitIds or surfaceIds, or cancel the unit)`,
      }),
    );
  }

  const ok = gaps.length === 0;
  const result = CoverageResultSchema.parse({
    ok,
    rows,
    stop_reason: ok ? "complete" : "coverage_gap",
    gaps,
  });

  if (!ok && throwOnGap) {
    const preview = gaps.slice(0, 8).join(", ");
    const more = gaps.length > 8 ? ` (+${gaps.length - 8} more)` : "";
    throw new CoverageAssertError(
      `coverage gate failed: ${gaps.length} gap(s): ${preview}${more}`,
      result,
    );
  }

  return result;
}
