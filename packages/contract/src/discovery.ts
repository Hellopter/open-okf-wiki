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

function sourceHasEvidence(
  discovery: DiscoveryMap | null | undefined,
  sourceId: string,
  spec: SemanticSufficiencySpec,
): { ok: boolean; reason?: string } {
  const sid = unitIdForSource(sourceId);
  const row = discovery?.sources.find((s) => unitIdForSource(s.sourceId) === sid);
  if (row && row.evidencePaths.length > 0) {
    return { ok: true };
  }
  // Prefer repositoryMap as a secondary sealed narrative aid (entry points).
  const mapRow = spec.repositoryMap?.sources?.find(
    (s) => unitIdForSource(s.sourceId) === sid,
  );
  if (mapRow && (mapRow.entryPoints?.length ?? 0) > 0) {
    return { ok: true, reason: "covered via Spec.repositoryMap entryPoints" };
  }
  if (row && (row.entryPoints.length > 0 || row.surfaces.length > 0)) {
    // Entry/surface lists without evidencePaths are not enough for multi-source.
    return {
      ok: false,
      reason: `discovery source "${sid}" has no evidencePaths (entry/surface lists alone are insufficient)`,
    };
  }
  return {
    ok: false,
    reason:
      `required source "${sid}" has no discovery evidencePaths ` +
      `(or Spec.repositoryMap entryPoints) and is not cancelled`,
  };
}

/**
 * Fail-closed semantic discovery check for plan sufficiency.
 *
 * - **Multi-source** (`sourceCount >= 2`): every required source needs a
 *   discovery sources row with ≥1 `evidencePath` (or Spec `repositoryMap`
 *   entryPoints), or explicit Spec cancel; plus a cross-source flow **or**
 *   an explicit openQuestion (discovery or Spec).
 * - **Light / small single-source**: soft pass when discovery is not required
 *   (`lightPath` or sourceCount < 2 without a required map).
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

  // Light / small single-source: soft pass when discovery not required.
  if (!multiSource || lightPath) {
    const empty = SemanticSufficiencyResultSchema.parse({
      ok: true,
      rows: [
        {
          unitId: "_discovery",
          kind: "discovery",
          status: "not_required",
          reason: multiSource
            ? "lightPath override — discovery gate skipped"
            : "single-source / light path — DiscoveryMap not required",
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
    const ev = sourceHasEvidence(discovery, sourceId, spec);
    if (ev.ok) {
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
    gaps.push(sourceId);
    rows.push(
      SemanticSufficiencyRowSchema.parse({
        unitId: sourceId,
        kind: "source",
        status: "gap",
        reason: ev.reason,
      }),
    );
  }

  // Cross-source flow or explicit openQuestion.
  const hasCrossFlow = discovery.flows.some((f) => f.crossSource === true);
  const openQs = [
    ...(discovery.openQuestions ?? []),
    ...(spec.openQuestions ?? []),
  ].filter((q) => q.trim().length > 0);
  if (hasCrossFlow || openQs.length > 0) {
    rows.push(
      SemanticSufficiencyRowSchema.parse({
        unitId: "_cross_source",
        kind: "cross_source",
        status: "covered",
        reason: hasCrossFlow
          ? "cross-source flow present"
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
          "multi-source discovery requires a crossSource flow or an explicit openQuestion",
      }),
    );
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
