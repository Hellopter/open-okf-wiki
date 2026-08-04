/**
 * Semantic DiscoveryMap + plan sufficiency gate (Phase 1).
 *
 * Discovery is a sealed, file-authority artifact produced by plan scouts /
 * plan.discover.reduce — not a knowledge graph. Host asserts semantic
 * sufficiency fail-closed for multi-source; light/small single-source soft-passes
 * when discovery is not required.
 *
 * Pure contract types + helpers — no FS, no agent imports.
 */

import { z } from "zod";
import type { SpecCoverageCancelSource } from "./coverage.js";
import { unitIdForSource } from "./coverage.js";
import { SourceIdSchema } from "./workspace.js";

const PATH_MAX = 300;
const TITLE_MAX = 200;
const SCOPE_MAX = 2_000;
const HINT_MAX = 1_000;
const QUESTION_MAX = 500;
const EVIDENCE_MAX = 64;
const LIST_MAX = 64;
const STEPS_MAX = 32;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** One frozen source as observed during discovery (roles / entry / surfaces). */
export const DiscoverySourceRowSchema = z
  .object({
    sourceId: SourceIdSchema,
    role: z.string().trim().min(1).max(500).optional(),
    entryPoints: z.array(z.string().trim().min(1).max(PATH_MAX)).max(32).default([]),
    surfaces: z.array(z.string().trim().min(1).max(PATH_MAX)).max(64).default([]),
    purpose: z.string().trim().min(1).max(SCOPE_MAX).default(""),
    evidencePaths: z.array(z.string().trim().min(1).max(PATH_MAX)).max(EVIDENCE_MAX).default([]),
  })
  .strict();

export type DiscoverySourceRow = z.infer<typeof DiscoverySourceRowSchema>;

/** Candidate domain for Spec synthesizer (reader-facing, coverage-bound). */
export const DiscoveryDomainRowSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(TITLE_MAX),
    scope: z.string().trim().min(1).max(SCOPE_MAX),
    coverageUnitIds: z.array(z.string().trim().min(1).max(400)).max(LIST_MAX).default([]),
    evidencePaths: z.array(z.string().trim().min(1).max(PATH_MAX)).max(EVIDENCE_MAX).default([]),
    readerQuestion: z.string().trim().min(1).max(QUESTION_MAX),
  })
  .strict();

export type DiscoveryDomainRow = z.infer<typeof DiscoveryDomainRowSchema>;

/** Cross-cutting or in-source flow candidate. */
export const DiscoveryFlowRowSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(TITLE_MAX),
    steps: z.array(z.string().trim().min(1).max(500)).max(STEPS_MAX).default([]),
    /** True when the flow spans two or more freeze sources. */
    crossSource: z.boolean().default(false),
    coverageUnitIds: z.array(z.string().trim().min(1).max(400)).max(LIST_MAX).default([]),
    evidencePaths: z.array(z.string().trim().min(1).max(PATH_MAX)).max(EVIDENCE_MAX).default([]),
  })
  .strict();

export type DiscoveryFlowRow = z.infer<typeof DiscoveryFlowRowSchema>;

/** Glossary / concept candidate (soft; not a coverage gate atom). */
export const DiscoveryConceptRowSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    term: z.string().trim().min(1).max(TITLE_MAX),
    definitionHint: z.string().trim().min(1).max(HINT_MAX),
    evidencePaths: z.array(z.string().trim().min(1).max(PATH_MAX)).max(EVIDENCE_MAX).default([]),
  })
  .strict();

export type DiscoveryConceptRow = z.infer<typeof DiscoveryConceptRowSchema>;

/** Optional module / package candidate under a surface. */
export const DiscoveryModuleRowSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(TITLE_MAX),
    path: z.string().trim().min(1).max(PATH_MAX).optional(),
    coverageUnitIds: z.array(z.string().trim().min(1).max(400)).max(LIST_MAX).default([]),
    evidencePaths: z.array(z.string().trim().min(1).max(PATH_MAX)).max(EVIDENCE_MAX).default([]),
  })
  .strict();

export type DiscoveryModuleRow = z.infer<typeof DiscoveryModuleRowSchema>;

/**
 * Sealed semantic discovery plane for plan sufficiency.
 * File is authority — control returns only a short handoff + path.
 */
export const DiscoveryMapSchema = z
  .object({
    version: z.literal(1).default(1),
    sources: z.array(DiscoverySourceRowSchema).max(LIST_MAX).default([]),
    domains: z.array(DiscoveryDomainRowSchema).max(LIST_MAX).default([]),
    flows: z.array(DiscoveryFlowRowSchema).max(LIST_MAX).default([]),
    concepts: z.array(DiscoveryConceptRowSchema).max(LIST_MAX).default([]),
    modules: z.array(DiscoveryModuleRowSchema).max(LIST_MAX).optional(),
    openQuestions: z.array(z.string().trim().min(1).max(QUESTION_MAX)).max(LIST_MAX).default([]),
    boundaryPaths: z.array(z.string().trim().min(1).max(PATH_MAX)).max(256).default([]),
    /** Scout kinds that contributed (thematic/source/surface/domain/flow/concept). */
    scoutKinds: z.array(z.string().trim().min(1).max(80)).max(LIST_MAX).default([]),
  })
  .strict();

export type DiscoveryMap = z.infer<typeof DiscoveryMapSchema>;

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Parse a sealed discovery_map payload. Returns `undefined` when the payload
 * is not a recognizable DiscoveryMap (missing version/sources shape).
 */
export function parseDiscoveryMap(raw: unknown): DiscoveryMap | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  // Accept version 1 or omitted (defaulted); require at least one structural key.
  const hasShape =
    Array.isArray(obj.sources) ||
    Array.isArray(obj.domains) ||
    Array.isArray(obj.flows) ||
    obj.version === 1;
  if (!hasShape) return undefined;
  const parsed = DiscoveryMapSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Strict parse — throws ZodError on invalid shape. */
export function parseDiscoveryMapStrict(raw: unknown): DiscoveryMap {
  return DiscoveryMapSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// assertSemanticSufficiency
// ---------------------------------------------------------------------------

export type SemanticSufficiencyStatus = "covered" | "cancelled" | "gap" | "not_required";

export const SemanticSufficiencyRowSchema = z
  .object({
    unitId: z.string().trim().min(1).max(400),
    kind: z.enum(["source", "cross_source", "discovery"]),
    status: z.enum(["covered", "cancelled", "gap", "not_required"]),
    reason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export type SemanticSufficiencyRow = z.infer<typeof SemanticSufficiencyRowSchema>;

export const SemanticSufficiencyResultSchema = z
  .object({
    ok: z.boolean(),
    rows: z.array(SemanticSufficiencyRowSchema).default([]),
    stop_reason: z.enum(["complete", "semantic_gap", "not_required"]),
    gaps: z.array(z.string()).default([]),
  })
  .strict();

export type SemanticSufficiencyResult = z.infer<typeof SemanticSufficiencyResultSchema>;

export type AssertSemanticSufficiencyOptions = {
  /**
   * When true (default), throw {@link SemanticSufficiencyError} if any required
   * semantic obligation is a gap. When false, only return the result.
   */
  throwOnGap?: boolean;
};

/**
 * Inventory / host hints for the semantic gate. Mirrors assertCoverage's
 * `sourceCount` option and light-path soft-pass.
 */
export type SemanticInventoryHints = {
  sourceCount?: number;
  /** Required freeze source ids (when omitted, derived from discovery + Spec). */
  sourceIds?: readonly string[];
  /**
   * When true, discovery is not required (L0 light / small single-source).
   * Soft-pass with stop_reason not_required.
   */
  lightPath?: boolean;
};

export type SemanticSufficiencySpec = SpecCoverageCancelSource & {
  repositoryMap?: {
    sources?: readonly {
      sourceId: string;
      role?: string | undefined;
      entryPoints?: readonly string[] | undefined;
    }[];
  };
  openQuestions?: readonly string[];
};

export class SemanticSufficiencyError extends Error {
  readonly code = "SEMANTIC_GAP";
  readonly result: SemanticSufficiencyResult;

  constructor(message: string, result?: SemanticSufficiencyResult) {
    super(message);
    this.name = "SemanticSufficiencyError";
    this.result =
      result ??
      SemanticSufficiencyResultSchema.parse({
        ok: false,
        rows: [],
        stop_reason: "semantic_gap",
        gaps: [],
      });
  }
}

/**
 * Minimum non-doc evidencePaths required per required source on multi-source.
 * Scout prompts ask for ≥3 when possible; gate floor is 2.
 */
export const MIN_SOURCE_NON_DOC_EVIDENCE = 2;

function cancelledSourceIds(spec: SemanticSufficiencySpec): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of spec.sourceCoverage ?? []) {
    if (row.cancelled !== true) continue;
    const reason = row.notes?.trim();
    if (!reason) continue;
    out.set(unitIdForSource(row.sourceId), reason);
  }
  return out;
}

/**
 * Doc-like paths (README, docs/, license, …) do not count toward the
 * multi-source non-doc evidence floor.
 */
export function isDocLikeEvidencePath(path: string): boolean {
  const n = path.replace(/\\/g, "/").trim().toLowerCase();
  if (!n) return true;
  const segments = n.split("/").filter(Boolean);
  const base = segments[segments.length - 1] ?? n;
  if (/^readme(\.|$)/i.test(base)) return true;
  if (/(^|\/)(docs?|documentation)(\/|$)/.test(n)) return true;
  if (
    /^(license|licence|changelog|contributing|code_of_conduct|authors|copying|notice|security)(\.|$)/i.test(
      base,
    )
  ) {
    return true;
  }
  return false;
}

/** Count evidence paths that are not doc-like (README / docs / license). */
export function countNonDocEvidencePaths(paths: readonly string[] | undefined): number {
  if (!paths?.length) return 0;
  let n = 0;
  for (const p of paths) {
    if (!isDocLikeEvidencePath(p)) n += 1;
  }
  return n;
}

/**
 * True when a domain's coverageUnitIds binds this source (bare source id or
 * a surface unit under that source: `{sourceId}::…`).
 */
function domainBindsSource(
  domain: DiscoveryDomainRow,
  sourceId: string,
): boolean {
  const sid = unitIdForSource(sourceId);
  if (!sid) return false;
  for (const raw of domain.coverageUnitIds) {
    const id = raw.trim();
    if (!id) continue;
    if (unitIdForSource(id) === sid) return true;
    if (id.startsWith(`${sid}::`)) return true;
  }
  return false;
}

function sourceHasEvidence(
  discovery: DiscoveryMap | null | undefined,
  sourceId: string,
): { ok: boolean; reason?: string } {
  const sid = unitIdForSource(sourceId);
  const row = discovery?.sources.find((s) => unitIdForSource(s.sourceId) === sid);
  if (!row) {
    return {
      ok: false,
      reason: `required source "${sid}" has no discovery sources row and is not cancelled`,
    };
  }
  const nonDoc = countNonDocEvidencePaths(row.evidencePaths);
  if (nonDoc >= MIN_SOURCE_NON_DOC_EVIDENCE) {
    return {
      ok: true,
      reason: `${nonDoc} non-doc evidencePaths (≥${MIN_SOURCE_NON_DOC_EVIDENCE})`,
    };
  }
  if (row.evidencePaths.length > 0) {
    return {
      ok: false,
      reason:
        `discovery source "${sid}" needs ≥${MIN_SOURCE_NON_DOC_EVIDENCE} non-doc evidencePaths ` +
        `(got ${nonDoc} non-doc of ${row.evidencePaths.length} total; README/docs-only do not count)`,
    };
  }
  if (row.entryPoints.length > 0 || row.surfaces.length > 0) {
    return {
      ok: false,
      reason:
        `discovery source "${sid}" has no evidencePaths ` +
        `(entry/surface lists alone are insufficient; need ≥${MIN_SOURCE_NON_DOC_EVIDENCE} non-doc paths)`,
    };
  }
  return {
    ok: false,
    reason:
      `required source "${sid}" has a discovery row but fewer than ` +
      `${MIN_SOURCE_NON_DOC_EVIDENCE} non-doc evidencePaths and is not cancelled`,
  };
}

function sourceHasDomain(
  discovery: DiscoveryMap,
  sourceId: string,
): { ok: boolean; reason?: string } {
  const sid = unitIdForSource(sourceId);
  const hit = discovery.domains.some((d) => domainBindsSource(d, sid));
  if (hit) {
    return { ok: true, reason: `domain candidate binds coverage unit "${sid}"` };
  }
  return {
    ok: false,
    reason:
      `required source "${sid}" has no domain candidate whose coverageUnitIds includes ` +
      `"${sid}" (or a surface under it)`,
  };
}

/** Cross-source flow with non-empty steps and/or evidencePaths. */
function hasQualifiedCrossFlow(discovery: DiscoveryMap): boolean {
  return discovery.flows.some(
    (f) =>
      f.crossSource === true &&
      (f.steps.length > 0 || f.evidencePaths.length > 0),
  );
}

/**
 * Fail-closed semantic discovery check for plan sufficiency.
 *
 * - **Soft only** for L0 / lightPath or `sourceCount < 2` (DiscoveryMap not required).
 * - **Multi-source** (`sourceCount ≥ 2`, not light): for each required source
 *   (unless Spec-cancelled):
 *   1. discovery `sources[]` row with ≥{@link MIN_SOURCE_NON_DOC_EVIDENCE} non-doc
 *      `evidencePaths` (README/docs alone fail)
 *   2. ≥1 domain candidate whose `coverageUnitIds` includes that sourceId
 *      (or a surface unit under it)
 *   3. ≥1 `crossSource:true` flow with non-empty `steps` and/or `evidencePaths`,
 *      **or** an explicit openQuestion (discovery or Spec) — escape hatch when
 *      the join is unknown. When fewer than 2 non-cancelled sources remain,
 *      the cross-source obligation is not required.
 */
export function assertSemanticSufficiency(
  discovery: DiscoveryMap | null | undefined,
  spec: SemanticSufficiencySpec = {},
  inventoryHints: SemanticInventoryHints = {},
  options: AssertSemanticSufficiencyOptions = {},
): SemanticSufficiencyResult {
  const throwOnGap = options.throwOnGap !== false;
  const sourceCount =
    inventoryHints.sourceCount ??
    inventoryHints.sourceIds?.length ??
    discovery?.sources.length ??
    0;
  const multiSource = sourceCount >= 2;
  const lightPath = inventoryHints.lightPath === true;

  // Soft only L0 / lightPath or sourceCount < 2.
  if (!multiSource || lightPath) {
    const empty = SemanticSufficiencyResultSchema.parse({
      ok: true,
      rows: [
        {
          unitId: "_discovery",
          kind: "discovery",
          status: "not_required",
          reason: multiSource
            ? "lightPath / L0 override — discovery gate skipped"
            : "single-source / sourceCount < 2 — DiscoveryMap not required",
        },
      ],
      stop_reason: "not_required",
      gaps: [],
    });
    return empty;
  }

  // Multi-source requires a DiscoveryMap object (may be empty → gaps).
  if (!discovery) {
    const result = SemanticSufficiencyResultSchema.parse({
      ok: false,
      rows: [
        {
          unitId: "_discovery",
          kind: "discovery",
          status: "gap",
          reason: "multi-source run requires a sealed DiscoveryMap",
        },
      ],
      stop_reason: "semantic_gap",
      gaps: ["_discovery"],
    });
    if (throwOnGap) {
      throw new SemanticSufficiencyError(
        "semantic sufficiency: multi-source run requires a sealed DiscoveryMap",
        result,
      );
    }
    return result;
  }

  const cancelled = cancelledSourceIds(spec);
  const requiredSourceIds: string[] = [];
  if (inventoryHints.sourceIds && inventoryHints.sourceIds.length > 0) {
    for (const id of inventoryHints.sourceIds) {
      const sid = unitIdForSource(id);
      if (sid && !requiredSourceIds.includes(sid)) requiredSourceIds.push(sid);
    }
  } else {
    for (const s of discovery.sources) {
      const sid = unitIdForSource(s.sourceId);
      if (sid && !requiredSourceIds.includes(sid)) requiredSourceIds.push(sid);
    }
    for (const row of spec.repositoryMap?.sources ?? []) {
      const sid = unitIdForSource(row.sourceId);
      if (sid && !requiredSourceIds.includes(sid)) requiredSourceIds.push(sid);
    }
  }

  const rows: SemanticSufficiencyRow[] = [];
  const gaps: string[] = [];
  const activeSourceIds: string[] = [];

  for (const sourceId of requiredSourceIds) {
    const cancelReason = cancelled.get(sourceId);
    if (cancelReason !== undefined) {
      rows.push(
        SemanticSufficiencyRowSchema.parse({
          unitId: sourceId,
          kind: "source",
          status: "cancelled",
          reason: cancelReason,
        }),
      );
      continue;
    }
    activeSourceIds.push(sourceId);

    const ev = sourceHasEvidence(discovery, sourceId);
    if (!ev.ok) {
      gaps.push(sourceId);
      rows.push(
        SemanticSufficiencyRowSchema.parse({
          unitId: sourceId,
          kind: "source",
          status: "gap",
          reason: ev.reason,
        }),
      );
      continue;
    }

    const dom = sourceHasDomain(discovery, sourceId);
    if (!dom.ok) {
      const gapId = `domain:${sourceId}`;
      gaps.push(gapId);
      rows.push(
        SemanticSufficiencyRowSchema.parse({
          unitId: gapId,
          kind: "source",
          status: "gap",
          reason: dom.reason,
        }),
      );
      // Still record source evidence covered for operator clarity.
      rows.push(
        SemanticSufficiencyRowSchema.parse({
          unitId: sourceId,
          kind: "source",
          status: "covered",
          reason: ev.reason,
        }),
      );
      continue;
    }

    rows.push(
      SemanticSufficiencyRowSchema.parse({
        unitId: sourceId,
        kind: "source",
        status: "covered",
        reason: `${ev.reason}; ${dom.reason}`,
      }),
    );
  }

  // Cross-source flow (qualified) or explicit openQuestion — only when ≥2 active.
  const openQs = [
    ...(discovery.openQuestions ?? []),
    ...(spec.openQuestions ?? []),
  ].filter((q) => q.trim().length > 0);
  const needCross = activeSourceIds.length >= 2;
  if (!needCross) {
    rows.push(
      SemanticSufficiencyRowSchema.parse({
        unitId: "_cross_source",
        kind: "cross_source",
        status: "not_required",
        reason:
          "fewer than 2 non-cancelled sources — cross-source flow not required",
      }),
    );
  } else {
    const qualifiedCross = hasQualifiedCrossFlow(discovery);
    if (qualifiedCross || openQs.length > 0) {
      rows.push(
        SemanticSufficiencyRowSchema.parse({
          unitId: "_cross_source",
          kind: "cross_source",
          status: "covered",
          reason: qualifiedCross
            ? "crossSource flow with non-empty steps/evidencePaths"
            : "explicit openQuestion present for multi-source join",
        }),
      );
    } else {
      gaps.push("_cross_source");
      rows.push(
        SemanticSufficiencyRowSchema.parse({
          unitId: "_cross_source",
          kind: "cross_source",
          status: "gap",
          reason:
            "multi-source discovery requires a crossSource flow with non-empty steps/evidencePaths " +
            "or an explicit openQuestion",
        }),
      );
    }
  }

  const ok = gaps.length === 0;
  const result = SemanticSufficiencyResultSchema.parse({
    ok,
    rows,
    stop_reason: ok ? "complete" : "semantic_gap",
    gaps,
  });

  if (!ok && throwOnGap) {
    throw new SemanticSufficiencyError(
      `semantic sufficiency gap: ${gaps.join(", ")}`,
      result,
    );
  }
  return result;
}
