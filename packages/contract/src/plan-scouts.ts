/**
 * Pure plan-scout task selection (host / freeze materialization + agent runtime).
 *
 * Hybrid scouts (MoA proposers) before the Spec synthesizer:
 * - unit surveys: source / surface (budgeted; fail-closed)
 * - semantic scouts: per-source `domain:{id}` / `flow:{id}` + multi-source `flow:cross`
 *   (optional `concept:{id}` for large tiers later; not auto-scheduled)
 * - thematic (entry|layout|tests|risks): optional soft spine; DEFAULT-OFF for multi-source
 *
 * Fail-closed: multi-source required surveys must not silently slice past budget.
 * Workflow materializes durable `plan.scout.<slug>` nodes after freeze using this
 * selector — agent must not own topology.
 */

import type { CoverageInventory, CoveragePlan, CoverageUnit } from "./coverage.js";
import { isSurfaceUnitId, parseSurfaceUnitId, unitIdForSource } from "./coverage.js";
import type { WorkspaceOrchestration } from "./workspace.js";

export type ThematicScoutKind = "entry" | "layout" | "tests" | "risks";

export const THEMATIC_SCOUT_KINDS: readonly ThematicScoutKind[] = [
  "entry",
  "layout",
  "tests",
  "risks",
] as const;

/** @deprecated Prefer THEMATIC_SCOUT_KINDS; kept for callers that only slice thematic. */
export const PLAN_SCOUT_KINDS = THEMATIC_SCOUT_KINDS;

/** Semantic discovery scout kinds (domain map / flow / concept). */
export type SemanticScoutKind = "domain" | "flow" | "concept";

export const SEMANTIC_SCOUT_KINDS: readonly SemanticScoutKind[] = [
  "domain",
  "flow",
  "concept",
] as const;

/** Required semantic kinds scheduled per source for multi-source / hybrid. */
export const REQUIRED_SEMANTIC_SCOUT_KINDS: readonly SemanticScoutKind[] = [
  "domain",
  "flow",
] as const;

/** Stable id for the multi-source cross-flow scout. */
export const FLOW_CROSS_ID = "flow:cross" as const;

export type PlanScoutKind = ThematicScoutKind | "source" | "surface" | SemanticScoutKind;

export type PlanScoutTask =
  | {
      kind: "thematic";
      thematic: ThematicScoutKind;
      /** Stable id for receipts / concurrency keys (thematic name). */
      id: ThematicScoutKind;
      /** Required unit failure is a hard gap; thematic scouts are optional. */
      required: false;
    }
  | {
      kind: "source";
      sourceId: string;
      id: string;
      required: boolean;
    }
  | {
      kind: "surface";
      sourceId: string;
      /** Repo-relative surface path (`.` for root). */
      path: string;
      /** Source-qualified unit id `{sourceId}::{path}`. */
      unitId: string;
      id: string;
      required: boolean;
    }
  | {
      kind: SemanticScoutKind;
      /**
       * Stable id: `domain:{sourceId}`, `flow:{sourceId}`, `flow:cross`,
       * or bare `domain|flow|concept` for legacy global (compat only).
       */
      id: string;
      required: boolean;
      /** Per-source qualifier; `"cross"` when this is the multi-source cross-flow. */
      sourceId?: string;
      /** True for multi-source cross-flow scout (`flow:cross`). */
      cross?: boolean;
    };

/** Build a source-qualified or cross semantic scout task. */
export function makeSemanticScoutTask(
  kind: SemanticScoutKind,
  opts: {
    sourceId?: string;
    /** Force cross-flow (`flow:cross`); also inferred when sourceId === "cross". */
    cross?: boolean;
    required?: boolean;
  } = {},
): Extract<PlanScoutTask, { kind: SemanticScoutKind }> {
  const cross =
    opts.cross === true || (kind === "flow" && (opts.sourceId ?? "").trim() === "cross");
  const required =
    opts.required !== undefined
      ? opts.required
      : kind === "concept"
        ? false
        : true;
  if (cross) {
    return {
      kind,
      id: `${kind}:cross`,
      required,
      cross: true,
      sourceId: "cross",
    };
  }
  const sourceId = opts.sourceId?.trim();
  if (sourceId) {
    return {
      kind,
      id: `${kind}:${sourceId}`,
      sourceId,
      required,
    };
  }
  // Legacy bare global semantic (compat / single-source callers).
  return { kind, id: kind, required };
}

/** Filesystem-safe slug for plan.scout.<slug> keys and analysis/plan-scouts/<slug>.md */
export function scoutTaskFileSlug(task: PlanScoutTask): string {
  if (task.kind === "thematic") return task.thematic;
  if (task.kind === "source") return `source-${sanitizeSlug(task.sourceId)}`;
  if (task.kind === "surface") {
    return `surface-${sanitizeSlug(task.sourceId)}-${sanitizeSlug(task.path === "." ? "root" : task.path)}`;
  }
  // domain | flow | concept — source-qualified or cross
  if (task.cross) return `${task.kind}-cross`;
  if (task.sourceId) return `${task.kind}-${sanitizeSlug(task.sourceId)}`;
  return task.kind;
}

function sanitizeSlug(value: string): string {
  return (
    value
      .trim()
      .replace(/\\/g, "/")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "unit"
  );
}

/** Human label for receipts / planner context headings / node detail. */
export function scoutTaskLabel(task: PlanScoutTask): string {
  if (task.kind === "thematic") return `thematic:${task.thematic}`;
  if (task.kind === "source") return `source:${task.sourceId}`;
  if (task.kind === "surface") return `surface:${task.unitId}`;
  if (task.cross) return `${task.kind}:cross`;
  if (task.sourceId) return `${task.kind}:${task.sourceId}`;
  return `semantic:${task.kind}`;
}

/** Durable WikiRuns node key for a selected scout task. */
export function planScoutNodeKey(task: PlanScoutTask): string {
  return `plan.scout.${scoutTaskFileSlug(task)}`;
}

/**
 * Parse a gap / detail id into a semantic scout task when it looks like
 * `domain:api`, `flow:web`, `flow:cross`, `concept:x`, or `flow-cross`.
 */
function semanticTaskFromQualifiedId(
  raw: string,
  required: boolean,
): Extract<PlanScoutTask, { kind: SemanticScoutKind }> | undefined {
  const value = raw.trim();
  if (!value) return undefined;

  // flow-cross alias (hyphen form used in some node keys / scoutKind)
  if (value === "flow-cross" || value === "flow:cross") {
    return makeSemanticScoutTask("flow", { cross: true, required });
  }

  const m = /^(domain|flow|concept)[:\-](.+)$/.exec(value);
  if (!m) return undefined;
  const kind = m[1] as SemanticScoutKind;
  const qual = m[2]!.trim();
  if (!qual) return undefined;
  if (kind === "flow" && qual === "cross") {
    return makeSemanticScoutTask("flow", { cross: true, required });
  }
  return makeSemanticScoutTask(kind, { sourceId: qual, required });
}

/**
 * Build a PlanScoutTask from sealed plan.scout node detail.
 * Fail-closed when scoutKind / required fields are missing or inconsistent.
 *
 * Semantic compatibility:
 * - `scoutKind` domain|flow|concept + optional `sourceId` in detail
 * - `scoutKind` `domain:api` / `flow:web` / `concept:x` qualified forms
 * - flow cross: `sourceId: "cross"`, `scoutKind: "flow-cross"`, or `flow:cross`
 */
export function planScoutTaskFromDetail(detail: {
  scoutKind?: string;
  unitId?: string;
  sourceId?: string;
  surfacePath?: string;
  critical?: boolean;
  taskLabel?: string;
}): PlanScoutTask {
  const kind = (detail.scoutKind ?? "").trim();
  if (!kind) throw new Error("plan.scout requires detail.scoutKind");

  const thematic = THEMATIC_SCOUT_KINDS.find((k) => k === kind);
  if (thematic) {
    return {
      kind: "thematic",
      thematic,
      id: thematic,
      required: false,
    };
  }

  // flow-cross / flow:cross / domain:api forms before bare semantic match
  const qualifiedFromKind = semanticTaskFromQualifiedId(
    kind,
    // concept soft unless critical; domain/flow hard unless critical:false
    kind.startsWith("concept")
      ? detail.critical === true
      : detail.critical !== false,
  );
  if (qualifiedFromKind) {
    // Prefer detail.sourceId when scoutKind was bare-qualified without cross conflict
    if (
      !qualifiedFromKind.cross &&
      detail.sourceId?.trim() &&
      detail.sourceId.trim() !== qualifiedFromKind.sourceId
    ) {
      // scoutKind already carried qualifier — keep it (detail.sourceId is secondary).
    }
    return qualifiedFromKind;
  }

  const semantic = SEMANTIC_SCOUT_KINDS.find((k) => k === kind);
  if (semantic) {
    const sourceId = detail.sourceId?.trim();
    const required =
      semantic === "concept" ? detail.critical === true : detail.critical !== false;
    if (sourceId === "cross" && semantic === "flow") {
      return makeSemanticScoutTask("flow", { cross: true, required });
    }
    if (sourceId) {
      return makeSemanticScoutTask(semantic, { sourceId, required });
    }
    // Legacy bare global semantic (compat for pre-WP2 nodes).
    return makeSemanticScoutTask(semantic, { required });
  }

  if (kind === "source" || kind.startsWith("source:")) {
    const sourceId =
      detail.sourceId?.trim() ||
      (kind.startsWith("source:") ? kind.slice("source:".length).trim() : "");
    if (!sourceId) throw new Error("plan.scout source survey requires detail.sourceId");
    return {
      kind: "source",
      sourceId,
      id: `source:${sourceId}`,
      required: detail.critical !== false,
    };
  }

  if (kind === "surface" || kind.startsWith("surface:")) {
    const sourceId = detail.sourceId?.trim() ?? "";
    const surfacePath = (detail.surfacePath ?? ".").trim() || ".";
    const unitId =
      detail.unitId?.trim() ||
      (sourceId
        ? `${sourceId}::${surfacePath}`
        : kind.startsWith("surface:")
          ? kind.slice("surface:".length)
          : "");
    if (!sourceId || !unitId) {
      throw new Error("plan.scout surface survey requires detail.sourceId and detail.unitId");
    }
    return {
      kind: "surface",
      sourceId,
      path: surfacePath,
      unitId,
      id: `surface:${unitId}`,
      required: detail.critical !== false,
    };
  }

  throw new Error(
    `plan.scout detail.scoutKind must be thematic (entry|layout|tests|risks), ` +
      `semantic (domain|flow|concept, optionally source-qualified), source, or surface; got ${JSON.stringify(kind)}`,
  );
}

function resolveScoutMode(
  orch: WorkspaceOrchestration,
  sourceCount: number,
): "thematic" | "source" | "hybrid" {
  const mode = orch.planScoutMode ?? "auto";
  if (mode === "auto") {
    return sourceCount >= 2 ? "hybrid" : "thematic";
  }
  return mode;
}

function thematicKinds(count: number): ThematicScoutKind[] {
  const n = Math.max(0, Math.min(count, THEMATIC_SCOUT_KINDS.length));
  return THEMATIC_SCOUT_KINDS.slice(0, n) as ThematicScoutKind[];
}

function sourceIdsFromInventory(inventory?: CoverageInventory): string[] {
  if (!inventory?.sources?.length) return [];
  return inventory.sources.map((s) => s.sourceId);
}

function requiredUnits(plan?: CoveragePlan): CoverageUnit[] {
  return plan?.requiredUnits ?? [];
}

/**
 * Select hybrid scout tasks from orchestration + inventory + optional gap filter.
 * Pure — safe for freeze materialization (no agent import).
 *
 * Order: unit surveys (source/surface) → per-source domain+flow (+ flow:cross when
 * multi-source) → optional thematic spine when planScoutCount > 0.
 *
 * Never schedules bare global domain/flow without sourceId on the multi-source path.
 */
export function selectPlanScoutTasks(input: {
  orch: WorkspaceOrchestration;
  coveragePlan?: CoveragePlan;
  coverageInventory?: CoverageInventory;
  /** @deprecated Prefer coverageInventory — same shape. */
  inventory?: CoverageInventory;
  /**
   * Gap re-scout filter: unit ids (`api`, `mono::pkg`) and/or semantic ids
   * (`domain:api`, `flow:web`, `flow:cross`, `concept:x`).
   */
  gapUnitIds?: readonly string[];
}): PlanScoutTask[] {
  const orch = input.orch;
  const inventory = input.coverageInventory ?? input.inventory;
  const inventorySources = sourceIdsFromInventory(inventory);
  const required = requiredUnits(input.coveragePlan);
  const requiredSourceIds = required
    .filter((u) => u.kind === "source")
    .map((u) => u.sourceId);
  const requiredSurfaces = required.filter((u) => u.kind === "surface");

  // Source universe: required sources first, else inventory, else empty.
  const allSourceIds =
    requiredSourceIds.length > 0
      ? requiredSourceIds
      : inventorySources.length > 0
        ? inventorySources
        : [];

  const sourceCount = Math.max(allSourceIds.length, inventorySources.length);
  const mode = resolveScoutMode(orch, sourceCount);
  const multiSource = sourceCount >= 2;
  const gapSet =
    input.gapUnitIds && input.gapUnitIds.length > 0
      ? new Set(input.gapUnitIds.map((g) => g.trim()).filter(Boolean))
      : undefined;

  const tasks: PlanScoutTask[] = [];
  const seen = new Set<string>();

  const push = (task: PlanScoutTask) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    tasks.push(task);
  };

  // --- Gap-only re-scout: unit-keyed and/or semantic-id scouts ---
  if (gapSet) {
    for (const unitId of gapSet) {
      const semanticGap = semanticTaskFromQualifiedId(unitId, true);
      if (semanticGap) {
        push(semanticGap);
        continue;
      }
      if (isSurfaceUnitId(unitId)) {
        const parsed = parseSurfaceUnitId(unitId);
        if (!parsed) continue;
        push({
          kind: "surface",
          sourceId: parsed.sourceId,
          path: parsed.path,
          unitId,
          id: `surface:${unitId}`,
          required: true,
        });
      } else {
        // Bare semantic kinds without qualifier are not unit ids — skip unless source.
        if ((SEMANTIC_SCOUT_KINDS as readonly string[]).includes(unitId)) {
          // gap of bare "domain" / "flow" / "concept" — reopen legacy global
          push(makeSemanticScoutTask(unitId as SemanticScoutKind, { required: true }));
          continue;
        }
        const sid = unitIdForSource(unitId);
        if (!sid) continue;
        // unitIdForSource accepts bare source ids; reject semantic-looking noise already handled
        push({
          kind: "source",
          sourceId: sid,
          id: `source:${sid}`,
          required: true,
        });
      }
    }
    // Optional light thematic re-scout when gaps remain and thematic budget > 0.
    if (orch.planScoutCount > 0 && tasks.length > 0) {
      for (const thematic of thematicKinds(Math.min(1, orch.planScoutCount))) {
        push({
          kind: "thematic",
          thematic,
          id: thematic,
          required: false,
        });
      }
    }
    return tasks;
  }

  // --- Survey budget for source (+ optional surface) tasks ---
  const surveyBudget =
    orch.planSurveyTaskBudget !== undefined
      ? orch.planSurveyTaskBudget
      : sourceCount >= 2
        ? Math.min(sourceCount, orch.maxSourcesPerRun)
        : 0;

  let surveySlots = surveyBudget;

  // Source surveys (hybrid or source mode; multi-source never skips when required).
  const wantSourceSurveys =
    mode === "source" || mode === "hybrid" || requiredSourceIds.length >= 2;
  if (wantSourceSurveys && allSourceIds.length > 0) {
    if (allSourceIds.length > surveyBudget && surveyBudget >= 0) {
      // Fail-closed: do not silently drop sources past budget.
      throw new Error(
        `plan scouts: ${allSourceIds.length} source survey(s) exceed planSurveyTaskBudget=${surveyBudget}; ` +
          `raise workspace.orchestration.planSurveyTaskBudget / maxSourcesPerRun or cancel units explicitly`,
      );
    }
    for (const sourceId of allSourceIds) {
      if (surveySlots <= 0 && surveyBudget > 0) break;
      push({
        kind: "source",
        sourceId,
        id: `source:${sourceId}`,
        required: requiredSourceIds.includes(sourceId) || allSourceIds.length >= 2,
      });
      if (surveyBudget > 0) surveySlots -= 1;
    }
  }

  // Surface surveys: large single-repo with required surfaces (hybrid/thematic + surfaces).
  const wantSurfaceSurveys =
    requiredSurfaces.length > 0 &&
    (mode === "hybrid" || mode === "thematic" || mode === "source");
  if (wantSurfaceSurveys) {
    for (const unit of requiredSurfaces) {
      if (surveySlots <= 0 && surveyBudget > 0) {
        throw new Error(
          `plan scouts: required surface surveys exceed remaining planSurveyTaskBudget ` +
            `(need unit ${unit.id}); raise planSurveyTaskBudget or maxSurfacesRequired policy`,
        );
      }
      const surfacePath = unit.path ?? parseSurfaceUnitId(unit.id)?.path ?? ".";
      push({
        kind: "surface",
        sourceId: unit.sourceId,
        path: surfacePath,
        unitId: unit.id,
        id: `surface:${unit.id}`,
        required: true,
      });
      if (surveyBudget > 0) surveySlots -= 1;
    }
  }

  // --- Semantic discovery scouts (after unit surveys) ---
  // Multi-source / hybrid: per-source domain + flow required; multi-source also flow:cross.
  // Do NOT schedule bare global domain/flow without sourceId.
  // Concept is never auto-required (large-tier optional later).
  if ((multiSource || mode === "hybrid") && allSourceIds.length > 0) {
    for (const sourceId of allSourceIds) {
      for (const semantic of REQUIRED_SEMANTIC_SCOUT_KINDS) {
        push(makeSemanticScoutTask(semantic, { sourceId, required: true }));
      }
    }
    if (multiSource) {
      push(makeSemanticScoutTask("flow", { cross: true, required: true }));
    }
  }

  // Thematic scouts (independent of survey budget).
  // Multi-source: thematic spine DEFAULT-OFF — only when planScoutCount > 0 (operator/soft raise).
  const wantThematic = mode === "thematic" || mode === "hybrid";
  if (wantThematic && orch.planScoutCount > 0) {
    for (const thematic of thematicKinds(orch.planScoutCount)) {
      push({
        kind: "thematic",
        thematic,
        id: thematic,
        required: false,
      });
    }
  }

  // Source-only mode with zero thematic and no sources discovered → no scouts.
  return tasks;
}
