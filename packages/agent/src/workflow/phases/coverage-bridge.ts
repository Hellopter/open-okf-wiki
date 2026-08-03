/**
 * Agent-side coverage inventory + plan bridge.
 *
 * Loads sealed host artifacts when present, otherwise builds from mounted
 * sources via @okf-wiki/core and converts to contract CoveragePlan for
 * assertCoverage (contract unit ids: bare sourceId / sourceId::path).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type CoverageInventory as ContractInventory, type CoveragePlan as ContractPlan, CoverageInventorySchema, CoveragePlanSchema, type CoverageUnit, parseSealedCoverageInventory, parseSealedCoveragePlan, requiredSourceUnitsFromInventory, requiredSurfaceUnitsFromInventory, sourceCoverageUnit } from "@okf-wiki/contract/coverage";
import type { WorkspaceOrchestration } from "@okf-wiki/contract/workspace";
import {
  type BoundaryIndex,
  buildBoundaryIndex,
  buildCoverageInventory,
  buildCoveragePlan as buildCoreCoveragePlan,
  type CoverageInventory as CoreInventory,
  type InventorySourceInput,
  toAdaptiveRepositoryInventory,
} from "@okf-wiki/core";
import type { RunWorkdirLayoutPaths } from "../../ports/agent-runner.js";

export const COVERAGE_INVENTORY_REL = "analysis/coverage-inventory.json";
export const COVERAGE_PLAN_REL = "analysis/coverage-plan.json";
export const BOUNDARY_INDEX_REL = "analysis/boundary-index.json";
export const INPUTS_COVERAGE_INVENTORY_REL = "inputs/coverage-inventory.json";
export const INPUTS_COVERAGE_PLAN_REL = "inputs/coverage-plan.json";
export const INPUTS_PRIOR_SPEC_REL = "inputs/prior-spec.json";

export type CoverageArtifacts = {
  /** Core inventory when built or loadable; undefined on light/fixture paths. */
  coreInventory?: CoreInventory;
  /** Contract inventory (subset shape) for plan helpers / prompts. */
  contractInventory: ContractInventory;
  /** Contract plan for assertCoverage. */
  plan: ContractPlan;
  boundaryIndex?: BoundaryIndex;
  /** Adaptive-router inventory signals. */
  adaptive: {
    sourceCount: number;
    fileCount?: number;
    languages?: readonly string[];
    multiEntry?: boolean;
    large?: boolean;
    surfaceCount?: number;
    sources?: readonly {
      sourceId: string;
      fileCount?: number;
      languages?: readonly string[];
      surfaces?: readonly { path: string; label?: string }[];
    }[];
  };
};

function contractInventoryFromCore(core: CoreInventory): ContractInventory {
  return CoverageInventorySchema.parse({
    version: 1,
    sources: core.sources.map((s) => ({
      sourceId: s.sourceId,
      fileCount: s.fileCount,
      languages: [...s.languages],
      surfaces: s.surfaces.map((surf) => ({
        id: surf.id,
        path: surf.path,
        label: surf.origin,
      })),
    })),
  });
}

/**
 * Convert core host CoveragePlan → contract plan (requiredUnits + cancelled).
 * Core already uses bare source ids and source-qualified surfaces.
 */
export function contractPlanFromCore(
  core: CoreInventory,
  orch: WorkspaceOrchestration,
): ContractPlan {
  const corePlan = buildCoreCoveragePlan(core, {
    maxSurfacesRequired: orch.maxSurfacesRequired,
  });
  let requiredUnits: CoverageUnit[] = [...corePlan.requiredUnits];

  // Honor explicit orchestration flags when core light-path left units empty.
  if (
    requiredUnits.length === 0 &&
    core.sourceCount >= 2 &&
    orch.requireSourceCoverage !== false
  ) {
    requiredUnits = requiredSourceUnitsFromInventory(contractInventoryFromCore(core));
  }
  if (
    requiredUnits.length === 0 &&
    core.sourceCount === 1 &&
    orch.requireSurfaceCoverage === true
  ) {
    const inv = contractInventoryFromCore(core);
    try {
      requiredUnits = requiredSurfaceUnitsFromInventory(inv, {
        maxSurfacesRequired: orch.maxSurfacesRequired,
      });
    } catch {
      // Over-cap: leave empty; caller fail-closes on inventory build separately.
    }
  }

  return CoveragePlanSchema.parse({
    version: 1,
    requiredUnits,
    cancelled: corePlan.cancelled ?? [],
  });
}

async function tryReadJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Load sealed coverage plan from workdir (inputs/ preferred, then analysis/).
 * Prefer sealed freeze bytes: host extras stripped via parseSealedCoveragePlan.
 * Accepts contract requiredUnits, freeze host shape, or legacy core required.
 */
export async function loadCoveragePlanFromWorkdir(
  runWorkDir: string,
): Promise<ContractPlan | undefined> {
  for (const rel of [INPUTS_COVERAGE_PLAN_REL, COVERAGE_PLAN_REL]) {
    const raw = await tryReadJson(path.join(runWorkDir, rel));
    if (raw === undefined) continue;
    const plan = parseSealedCoveragePlan(raw);
    if (plan) return plan;
  }
  return undefined;
}

/**
 * Load sealed coverage inventory from workdir.
 * Prefer sealed freeze bytes; strip host walk metadata via shared parser.
 */
export async function loadCoverageInventoryFromWorkdir(
  runWorkDir: string,
): Promise<ContractInventory | undefined> {
  for (const rel of [INPUTS_COVERAGE_INVENTORY_REL, COVERAGE_INVENTORY_REL]) {
    const raw = await tryReadJson(path.join(runWorkDir, rel));
    if (raw === undefined) continue;
    const parsed = parseSealedCoverageInventory(raw);
    if (parsed) return parsed;
  }
  return undefined;
}

export type ResolveCoverageArtifactsInput = {
  layout: RunWorkdirLayoutPaths;
  orch: WorkspaceOrchestration;
  /** sourceId → absolute mount path (layout.sourceMounts when available). */
  sourceMounts?: ReadonlyMap<string, string>;
  /** Effective ignores per source (optional). */
  sourceIgnores?: ReadonlyMap<string, readonly string[]>;
  abortSignal?: AbortSignal;
  /**
   * When true, walk mounts via core even if sealed plan exists (still prefer
   * sealed plan for assertCoverage). Default false: sealed plan wins.
   */
  preferBuildInventory?: boolean;
};

/**
 * Resolve coverage inventory + plan for the plan phase.
 * Prefer sealed host artifacts; otherwise build from mounts.
 */
export async function resolveCoverageArtifacts(
  input: ResolveCoverageArtifactsInput,
): Promise<CoverageArtifacts> {
  const runWorkDir = input.layout.runWorkDir;
  const sealedPlan = await loadCoveragePlanFromWorkdir(runWorkDir);
  const sealedInventory = await loadCoverageInventoryFromWorkdir(runWorkDir);

  const mounts = input.sourceMounts ?? new Map<string, string>();
  const sourceIds = [...mounts.keys()];

  // Fail-closed maxSourcesPerRun when mounts exceed cap.
  if (sourceIds.length > input.orch.maxSourcesPerRun) {
    throw new Error(
      `coverage: ${sourceIds.length} mounted sources exceed maxSourcesPerRun=${input.orch.maxSourcesPerRun}; ` +
        `reduce freeze sources or raise workspace.orchestration.maxSourcesPerRun (silent truncation is not allowed)`,
    );
  }

  let coreInventory: CoreInventory | undefined;
  let boundaryIndex: BoundaryIndex | undefined;

  const canWalk = mounts.size > 0;
  if (canWalk && (input.preferBuildInventory || !sealedInventory || !sealedPlan)) {
    const sources: InventorySourceInput[] = sourceIds.map((id) => ({
      id,
      path: mounts.get(id)!,
      effectiveIgnores: input.sourceIgnores?.get(id) ?? [],
    }));
    coreInventory = await buildCoverageInventory(sources, {
      signal: input.abortSignal,
    });
    try {
      boundaryIndex = await buildBoundaryIndex(sources, {
        signal: input.abortSignal,
      });
    } catch {
      boundaryIndex = undefined;
    }
  }

  const contractInventory =
    sealedInventory ??
    (coreInventory
      ? contractInventoryFromCore(coreInventory)
      : CoverageInventorySchema.parse({
          version: 1,
          sources: sourceIds.map((sourceId) => ({
            sourceId,
            surfaces: [],
          })),
        }));

  const plan =
    sealedPlan ??
    (coreInventory
      ? contractPlanFromCore(coreInventory, input.orch)
      : CoveragePlanSchema.parse({
          version: 1,
          requiredUnits:
            sourceIds.length >= 2 && input.orch.requireSourceCoverage !== false
              ? sourceIds.map((id) => sourceCoverageUnit(id))
              : [],
          cancelled: [],
        }));

  // Adaptive signals: prefer core walk, else coarse mount count.
  const adaptive = coreInventory
    ? {
        ...toAdaptiveRepositoryInventory(coreInventory),
        surfaceCount: coreInventory.sources.reduce((n, s) => n + s.surfaces.length, 0),
        sources: coreInventory.sources.map((s) => ({
          sourceId: s.sourceId,
          fileCount: s.fileCount,
          languages: s.languages,
          surfaces: s.surfaces.map((surf) => ({
            path: surf.path,
            label: surf.origin,
          })),
        })),
      }
    : {
        sourceCount: sourceIds.length,
        multiEntry: sourceIds.length >= 2 ? false : undefined,
        large: false,
        surfaceCount: contractInventory.sources.reduce((n, s) => n + (s.surfaces?.length ?? 0), 0),
        sources: contractInventory.sources.map((s) => ({
          sourceId: s.sourceId,
          fileCount: s.fileCount,
          languages: s.languages,
          surfaces: (s.surfaces ?? []).map((surf) => ({
            path: surf.path,
            label: surf.label,
          })),
        })),
      };

  return {
    ...(coreInventory ? { coreInventory } : {}),
    contractInventory,
    plan,
    ...(boundaryIndex ? { boundaryIndex } : {}),
    adaptive,
  };
}

/** Persist coverage artifacts under analysis/ for submit tool + audit. */
export async function writeCoverageArtifacts(
  layout: RunWorkdirLayoutPaths,
  artifacts: CoverageArtifacts,
): Promise<void> {
  await writeFile(
    path.join(layout.runWorkDir, COVERAGE_INVENTORY_REL),
    `${JSON.stringify(artifacts.contractInventory, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(layout.runWorkDir, COVERAGE_PLAN_REL),
    `${JSON.stringify(artifacts.plan, null, 2)}\n`,
    "utf8",
  );
  if (artifacts.boundaryIndex) {
    await writeFile(
      path.join(layout.runWorkDir, BOUNDARY_INDEX_REL),
      `${JSON.stringify(artifacts.boundaryIndex, null, 2)}\n`,
      "utf8",
    );
  }
}

/** Compact prompt block for inventory + required units + boundary paths. */
export function formatCoveragePlannerContext(artifacts: CoverageArtifacts): string {
  const { plan, contractInventory, boundaryIndex, adaptive } = artifacts;
  const lines: string[] = [
    "## Coverage inventory (host)",
    `- sourceCount: ${adaptive.sourceCount}`,
    adaptive.fileCount !== undefined ? `- fileCount: ${adaptive.fileCount}` : "",
    adaptive.languages?.length ? `- languages: ${adaptive.languages.join(", ")}` : "",
    adaptive.multiEntry !== undefined ? `- multiEntry: ${adaptive.multiEntry}` : "",
    adaptive.large !== undefined ? `- large: ${adaptive.large}` : "",
  ].filter(Boolean);

  if (contractInventory.sources.length > 0) {
    lines.push("", "### Sources");
    for (const s of contractInventory.sources) {
      const surfaces = (s.surfaces ?? []).map((x) => x.path).slice(0, 12);
      lines.push(
        `- ${s.sourceId}` +
          (s.fileCount !== undefined ? ` files≈${s.fileCount}` : "") +
          (surfaces.length ? ` surfaces=[${surfaces.join(", ")}]` : ""),
      );
    }
  }

  if (plan.requiredUnits.length > 0) {
    lines.push(
      "",
      "### Required coverage units (must bind on critical pages or cancel)",
      ...plan.requiredUnits.map(
        (u) => `- ${u.id} (${u.kind}${u.path ? ` path=${u.path}` : ""})`,
      ),
      "Bind via page coverageUnitIds (canonical) or sourceIds / surfaceIds projections.",
    );
  } else {
    lines.push("", "### Required coverage units", "- (none — light path / no host gate)");
  }

  if (boundaryIndex && boundaryIndex.entries.length > 0) {
    lines.push("", "### Boundary path list (accelerator only, not a citation allowlist)");
    for (const e of boundaryIndex.entries.slice(0, 40)) {
      lines.push(`- sources/${e.sourceId}/${e.path} (${e.kind})`);
    }
    if (boundaryIndex.entries.length > 40) {
      lines.push(`- … +${boundaryIndex.entries.length - 40} more (see analysis/boundary-index.json)`);
    }
  }

  return lines.join("\n");
}
