/**
 * Planner deep module: living WikiRunSpec via AgentRunner (or default Spec for fixture).
 *
 * Owns plan policy end-to-end (Epic D.4 locality):
 * - inventory / coverage resolve + adaptive orchestration
 * - synthesizer from sealed inputs/plan-scouts/* (durable plan.scout Attempts)
 * - host assertCoverage (fail-closed; no nested re-scout)
 * - draft clear / path-first resolve via commitPlanDraft
 *
 * Path-first handoff: prefer analysis/plan-draft.json from submit_wiki_run_spec;
 * fail-closed when draft is missing — no invented thin plans / chat JSON spill.
 *
 * Workflow stays free of Pi SDK and tools/: live callers inject customTools or
 * createCustomTools (after adaptive caps are known) via PlanWikiSpecInput.
 * Spec draft I/O is commitPlanDraft / readPlanDraft / clearPlanDraft (no SpecStore port).
 */

import {
  assertCoverage,
  type CoveragePlan,
  type CoverageResult,
  CoverageAssertError,
} from "@okf-wiki/contract/coverage";
import {
  type AttemptItem,
  type AttemptMetrics,
  assertSemanticSufficiency,
  type DiscoveryMap,
  defaultWikiRunSpec,
  type NodeAttempt,
  parseDiscoveryMapStrict,
  planUncertaintyFromSpec,
  type RepositoryInventory,
  resolveAdaptiveOrchestration,
  SemanticSufficiencyError,
  type SemanticSufficiencyResult,
  SUBMIT_WIKI_RUN_SPEC_TOOL_NAME,
  type WikiRunSpec,
} from "@okf-wiki/contract/wiki-runs";
import {
  resolveOrchestration,
  type RetryLimits,
  type WorkspaceOrchestration,
} from "@okf-wiki/contract/workspace";
import type {
  AgentRunner,
  RunWorkdirLayoutPaths,
  SourceIgnoreInput,
} from "../../ports/agent-runner.js";
import {
  clearPlanDraft,
  commitPlanDraft,
  PLAN_DRAFT_REL_PATH,
  planDraftPathFromRunWorkDir,
  readPlanDraft,
} from "../../plan/commit-plan-draft.js";
import { plannerPrompt } from "../../prompts/plan.js";
import {
  type CoverageArtifacts,
  formatCoveragePlannerContext,
  resolveCoverageArtifacts,
  writeCoverageArtifacts,
} from "./coverage-bridge.js";
import {
  DISCOVERY_MAP_INPUT_REL,
  formatScoutPlannerContextFromJson,
  loadProjectedDiscoveryMap,
  loadProjectedPlanScoutReceipts,
} from "./plan-scouts.js";

/** Tool name constant (contract-owned — no tools/ import). */
export { SUBMIT_WIKI_RUN_SPEC_TOOL_NAME };

/**
 * Call contract assertSemanticSufficiency when a DiscoveryMap object is present.
 * Soft no-op when discovery is missing/unparseable (light path has no map).
 * Multi-source fail-closed callers pass throwOnGap: true.
 */
function tryAssertSemanticSufficiency(input: {
  discovery: unknown;
  spec: WikiRunSpec;
  sourceCount: number;
  throwOnGap: boolean;
}): SemanticSufficiencyResult | undefined {
  if (!input.discovery || typeof input.discovery !== "object") return undefined;
  let discovery: DiscoveryMap;
  try {
    discovery = parseDiscoveryMapStrict(input.discovery);
  } catch {
    // Unparseable map: soft skip (mechanical reduce seals valid maps).
    return undefined;
  }
  try {
    return assertSemanticSufficiency(
      discovery,
      input.spec,
      { sourceCount: input.sourceCount },
      { throwOnGap: input.throwOnGap },
    );
  } catch (err) {
    if (err instanceof SemanticSufficiencyError) throw err;
    if (input.throwOnGap && err instanceof Error) throw err;
    return undefined;
  }
}

function snippet(text: string, max = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Coarse inventory from workspace source count only (no tree walk).
 * Used when mounts are unavailable or coverage walk fails on small single-source.
 */
export function inventoryFromWorkspace(workspace: {
  sources?: readonly unknown[];
  sourceCount?: number;
}): RepositoryInventory {
  const sourceCount =
    workspace.sourceCount ?? workspace.sources?.length ?? 0;
  return {
    sourceCount,
    // multiEntry must not be inferred from multi-source alone.
    multiEntry: false,
    large: false,
  };
}

/** Adaptive inventory signals from resolved coverage artifacts. */
export function inventoryFromCoverageArtifacts(
  artifacts: CoverageArtifacts,
): RepositoryInventory {
  return {
    sourceCount: artifacts.adaptive.sourceCount,
    multiEntry: artifacts.adaptive.multiEntry,
    large: artifacts.adaptive.large,
    ...(artifacts.adaptive.fileCount !== undefined
      ? { fileCount: artifacts.adaptive.fileCount }
      : {}),
    ...(artifacts.adaptive.languages
      ? { languages: artifacts.adaptive.languages }
      : {}),
    ...(artifacts.adaptive.surfaceCount !== undefined
      ? { surfaceCount: artifacts.adaptive.surfaceCount }
      : {}),
    ...(artifacts.adaptive.sources
      ? { sources: artifacts.adaptive.sources }
      : {}),
  };
}

/**
 * Resolve Spec from path-first draft only (disk).
 * Control plane is short summary + path; full Spec is never required in summary.
 */
export async function resolvePlanSpecFromAgentResult(input: {
  runWorkDir: string;
  /** Short control summary only (never the full Spec payload). */
  summary?: string;
}): Promise<{ spec: WikiRunSpec; source: "draft"; draftPath: string }> {
  const fromDisk = await readPlanDraft(input.runWorkDir);
  if (fromDisk) {
    // Re-commit normalizes / re-validates; path stays plan-draft.json.
    const committed = await commitPlanDraft(input.runWorkDir, fromDisk);
    return { spec: fromDisk, source: "draft", draftPath: committed.absolutePath };
  }

  const hint = input.summary?.trim()
    ? ` control summary was: ${JSON.stringify(snippet(input.summary, 160))}`
    : "";
  throw new Error(
    `Planner did not submit a complete WikiRunSpec via ${SUBMIT_WIKI_RUN_SPEC_TOOL_NAME} ` +
      `(missing ${PLAN_DRAFT_REL_PATH}).${hint}`,
  );
}

/** Context passed to createCustomTools after adaptive + coverage resolve. */
export type PlanCustomToolsContext = {
  orchestration: WorkspaceOrchestration;
  coveragePlan: CoveragePlan;
  /** Why adaptive raised scouts / lenses (empty on light path). */
  adaptiveReasons: readonly string[];
  lightPath: boolean;
};

export type PlanWikiSpecInput = {
  layout: RunWorkdirLayoutPaths;
  workspaceName: string;
  runtime: AgentRunner;
  wikiLanguage?: "en" | "zh";
  /** Opaque model handle — runtime adapters cast to Pi Model. */
  model?: unknown;
  /** Opaque model runtime — runtime adapters cast to Pi ModelRuntime. */
  modelRuntime?: unknown;
  /**
   * @deprecated Nested scouts removed (U2 durable plan.scout). Ignored.
   */
  scoutModel?: unknown;
  /** @deprecated Nested scouts removed (U2). Ignored. */
  scoutModelRuntime?: unknown;
  /** @deprecated Nested scouts removed (U2). Ignored. */
  scoutMaxContextTokens?: number;
  sourceIgnores?: SourceIgnoreInput;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  /** Pi transport retry (workspace.limits.retry). */
  retry?: RetryLimits;
  /** Wall-clock budget for planner synthesizer. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  operatorNotes?: string;
  revisionFeedback?: string;
  /**
   * Sealed prior Spec for plan revise (ADR 0040 / 0036).
   * Injected into the planner prompt; synthesizer must submit a complete new Spec.
   * Also drives planUncertainty for adaptive orchestration.
   */
  priorSpec?: WikiRunSpec;
  /** Host coverage plan override (else resolved from workdir / inventory). */
  coveragePlan?: CoveragePlan;
  /** Pre-resolved coverage artifacts (skips re-walk when caller already built). */
  coverageArtifacts?: CoverageArtifacts;
  /**
   * Base workspace orchestration (before adaptive). planWikiSpec owns
   * resolveAdaptiveOrchestration from inventory + priorSpec uncertainty.
   * Operator-explicit raises are preserved by the adaptive router.
   */
  orchestration?: Partial<WorkspaceOrchestration> | null;
  /**
   * Workspace source count for maxSources fail-closed and coarse inventory
   * fallback when mounts / coverage walk are unavailable.
   */
  workspaceSourceCount?: number;
  onProgress?: (attempt: NodeAttempt) => void;
  /**
   * Opaque custom tools (e.g. submit_wiki_run_spec). Prefer createCustomTools
   * when tool caps depend on adaptive orchestration.
   */
  customTools?: readonly unknown[];
  /**
   * Build custom tools after adaptive + coverage are known so caps and
   * coveragePlan match the plan-phase decision. Preferred over pre-built
   * customTools for live plan Attempts.
   */
  createCustomTools?: (
    ctx: PlanCustomToolsContext,
  ) => readonly unknown[] | Promise<readonly unknown[]>;
  /**
   * Attempt session.jsonl for Node details transcript (live + fixture).
   * Passed through to the synthesizer runAgent only (scouts stay private).
   */
  transcriptPath?: string;
};

export type PlanWikiSpecResult = {
  spec: WikiRunSpec;
  mode: "fixture" | "live";
  /** Short control summary only (never full Spec JSON). */
  rawSummary?: string;
  /** How the Spec was obtained. */
  source?: "draft" | "fixture";
  draftPath?: string;
  /** Scout kinds loaded from sealed inputs/plan-scouts (empty when none bound). */
  scoutKinds?: string[];
  /** Final tool/text trail from the planner agent when available. */
  items?: AttemptItem[];
  /** Best-effort projector metrics from the planner synthesizer seat. */
  metrics?: AttemptMetrics;
  /** Coverage assert result after final Spec (when plan had required units). */
  coverage?: CoverageResult;
  /**
   * @deprecated Nested re-scout removed (U2). Always 0; host re-arms plan.scout DAG.
   */
  rescoutRounds?: number;
  /** Adaptive router reasons (empty when light path kept). */
  adaptiveReasons?: string[];
  /** Effective orchestration after adaptive resolve. */
  orchestration?: WorkspaceOrchestration;
};

function formatPriorSpecPrompt(prior: WikiRunSpec): string {
  const pageLines = prior.pages
    .slice(0, 40)
    .map((p) => {
      const units = [
        ...(p.coverageUnitIds ?? []),
        ...(p.sourceIds ?? []),
        ...(p.surfaceIds ?? []),
      ];
      const unitHint = units.length ? ` units=[${units.slice(0, 8).join(", ")}]` : "";
      return `- ${p.path}: ${p.purpose.slice(0, 120)}${unitHint}`;
    })
    .join("\n");
  const domainLines = prior.domains
    .slice(0, 20)
    .map((d) => `- ${d.id}: ${d.title} — ${d.scope.slice(0, 100)}`)
    .join("\n");
  return [
    "## Prior Spec (sealed — revise, do not invent a blank tree)",
    `Summary: ${prior.summary.slice(0, 500)}`,
    prior.domains.length ? `Domains:\n${domainLines}` : "Domains: (none)",
    `Pages:\n${pageLines || "(none)"}`,
    prior.changelog?.length
      ? `Prior changelog (tail):\n${prior.changelog.slice(-5).map((c) => `- ${c}`).join("\n")}`
      : "",
    "Submit a **complete** revised WikiRunSpec with changelog entry describing this revision.",
    "Preserve useful page paths and coverage bindings unless operator feedback or evidence requires change.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Resolve coverage + adaptive orchestration for the plan phase.
 * Exported for unit tests of the deep policy surface.
 */
export async function resolvePlanInventoryAndAdaptive(input: {
  layout: RunWorkdirLayoutPaths;
  orchestration?: Partial<WorkspaceOrchestration> | null;
  workspaceSourceCount?: number;
  sourceIgnores?: SourceIgnoreInput;
  abortSignal?: AbortSignal;
  priorSpec?: WikiRunSpec;
  coveragePlan?: CoveragePlan;
  coverageArtifacts?: CoverageArtifacts;
  /** When true, inventory walk failure is fatal for multi-source. Default true for live. */
  failClosedMultiSource?: boolean;
}): Promise<{
  coverageArtifacts: CoverageArtifacts;
  inventory: RepositoryInventory;
  adaptive: ReturnType<typeof resolveAdaptiveOrchestration>;
}> {
  const baseOrch = resolveOrchestration(input.orchestration);

  const workspaceSourceCount = input.workspaceSourceCount ?? 0;
  const mountCount = input.layout.sourceMounts?.size ?? 0;
  const sourceCount = Math.max(workspaceSourceCount, mountCount);
  const maxSources = baseOrch.maxSourcesPerRun;

  // Fail-closed: mounted / workspace sources must not exceed maxSourcesPerRun.
  if (sourceCount > maxSources) {
    throw new Error(
      `plan: ${sourceCount} sources exceed maxSourcesPerRun=${maxSources}; ` +
        `reduce freeze sources or raise workspace.orchestration.maxSourcesPerRun ` +
        `(silent truncation is not allowed)`,
    );
  }

  let coverageArtifacts: CoverageArtifacts;
  let inventory: RepositoryInventory;

  if (input.coverageArtifacts) {
    coverageArtifacts = input.coverageArtifacts;
    inventory = inventoryFromCoverageArtifacts(coverageArtifacts);
  } else {
    try {
      coverageArtifacts = await resolveCoverageArtifacts({
        layout: input.layout,
        orch: baseOrch,
        sourceMounts: input.layout.sourceMounts,
        sourceIgnores:
          input.sourceIgnores instanceof Map ? input.sourceIgnores : undefined,
        abortSignal: input.abortSignal,
      });
      inventory = inventoryFromCoverageArtifacts(coverageArtifacts);
    } catch (err) {
      // Inventory walk failure: fail-closed when multi-source; else coarse fallback.
      const failClosed = input.failClosedMultiSource !== false && sourceCount >= 2;
      if (failClosed) {
        throw err instanceof Error
          ? err
          : new Error(`plan inventory failed: ${String(err)}`);
      }
      inventory = inventoryFromWorkspace({ sourceCount: workspaceSourceCount || sourceCount });
      coverageArtifacts = await resolveCoverageArtifacts({
        layout: input.layout,
        orch: baseOrch,
        // No mounts → sealed/light path without walk.
        sourceMounts: new Map(),
        abortSignal: input.abortSignal,
      });
    }
  }

  if (input.coveragePlan) {
    coverageArtifacts = { ...coverageArtifacts, plan: input.coveragePlan };
  }

  const planUncertainty = input.priorSpec
    ? planUncertaintyFromSpec(input.priorSpec)
    : 0;

  const adaptive = resolveAdaptiveOrchestration({
    orchestration: input.orchestration,
    inventory,
    planUncertainty,
  });

  return { coverageArtifacts, inventory, adaptive };
}

/**
 * Plan a WikiRunSpec. Fixture runtime → default Spec (no scouts).
 * Live → adaptive + synthesizer reading sealed inputs/plan-scouts/* only
 * (durable plan.scout Attempts; no nested runPlanScouts / re-scout loop).
 */
export async function planWikiSpec(input: PlanWikiSpecInput): Promise<PlanWikiSpecResult> {
  if (input.runtime.kind === "fixture") {
    const spec = defaultWikiRunSpec(input.workspaceName);
    const committed = await commitPlanDraft(input.layout.runWorkDir, spec);
    const items: AttemptItem[] = [
      {
        type: "text",
        text: `pages=${spec.pages.length} draft=${PLAN_DRAFT_REL_PATH}`,
      },
    ];
    const summary = "Fixture default WikiRunSpec";
    input.onProgress?.({
      attemptId: "plan",
      nodeKey: "plan",
      runIndex: 0,
      role: "plan",
      status: "done",
      summary,
      items,
    });
    // Transcript disk write is owned by pi-attempt-executor (runtime edge).
    return {
      spec,
      mode: "fixture",
      source: "fixture",
      draftPath: committed.absolutePath,
      scoutKinds: [],
      items,
      adaptiveReasons: [],
      orchestration: resolveOrchestration(input.orchestration),
      rescoutRounds: 0,
    };
  }

  if (!input.model) {
    throw new Error("Live plan phase requires a model");
  }

  const { coverageArtifacts, adaptive } = await resolvePlanInventoryAndAdaptive({
    layout: input.layout,
    orchestration: input.orchestration,
    workspaceSourceCount: input.workspaceSourceCount,
    sourceIgnores: input.sourceIgnores,
    abortSignal: input.abortSignal,
    priorSpec: input.priorSpec,
    coveragePlan: input.coveragePlan,
    coverageArtifacts: input.coverageArtifacts,
    failClosedMultiSource: true,
  });

  const orch = adaptive.orchestration;
  await writeCoverageArtifacts(input.layout, coverageArtifacts);

  const customTools =
    (input.createCustomTools
      ? await input.createCustomTools({
          orchestration: orch,
          coveragePlan: coverageArtifacts.plan,
          adaptiveReasons: adaptive.reasons,
          lightPath: adaptive.lightPath,
        })
      : input.customTools) ?? [];

  // Durable scouts: load sealed receipts projected into inputs/plan-scouts/.
  // Index-card only in the planner task — never multi-kB body paste.
  const scoutReceipts = await loadProjectedPlanScoutReceipts(input.layout);
  const scoutKinds = scoutReceipts.map((r) => r.kind);
  const discoveryMap = await loadProjectedDiscoveryMap(input.layout);
  const plannerScoutContext = formatScoutPlannerContextFromJson(scoutReceipts, {
    ...(discoveryMap?.path ? { discoveryMapPath: discoveryMap.path } : {}),
  });
  const requiredScoutGaps = scoutReceipts
    .filter((r) => r.critical && !r.ok)
    .map((r) => r.unitId ?? r.kind)
    .filter(Boolean);

  const coverageContext = formatCoveragePlannerContext(coverageArtifacts);
  const priorBlock = input.priorSpec ? formatPriorSpecPrompt(input.priorSpec) : "";
  const revisionPrompt = input.revisionFeedback?.trim()
    ? [
        "Produce a fresh WikiRunSpec after re-reading the frozen sources.",
        `Operator feedback: ${input.revisionFeedback.trim()}`,
      ].join("\n\n")
    : "";

  const basePrompt = plannerPrompt({
    layout: input.layout,
    workspaceName: input.workspaceName,
    wikiLanguage: input.wikiLanguage,
    operatorNotes: input.operatorNotes,
    maxDomainFanOut: orch.maxDomainFanOut,
    maxLeafFanOut: orch.maxLeafFanOut,
    sourceCount: coverageArtifacts.adaptive.sourceCount,
    requiredUnitIds: coverageArtifacts.plan.requiredUnits.map((u) => u.id),
    ...(discoveryMap?.path ? { discoveryMapPath: discoveryMap.path } : {}),
  });

  const systemPrompt = [
    "You are the Wiki planner (Spec synthesizer).",
    "File-first: read DiscoveryMap and inputs/plan-scouts/* with read tools; do not rely on index-card previews alone.",
    discoveryMap?.path
      ? `DiscoveryMap is at ${discoveryMap.path} — read it first when synthesizing.`
      : `If ${DISCOVERY_MAP_INPUT_REL} exists, read it first.`,
    `Submit the complete WikiRunSpec via the ${SUBMIT_WIKI_RUN_SPEC_TOOL_NAME} tool (Run Boundary writes ${PLAN_DRAFT_REL_PATH}).`,
    "Do not write wiki pages. Chat is never Spec authority — sealed plan-draft.json is.",
    "Host dual gates: assertCoverage + assertSemanticSufficiency (when DiscoveryMap present).",
    coverageArtifacts.plan.requiredUnits.length > 0
      ? "Every required coverage unit must be bound on critical pages or cancelled via sourceCoverage/surfaceCoverage (cancelled:true + notes)."
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Fail-closed: clear stale draft before synthesizer so a previous plan-draft.json
  // cannot be re-resolved if this Attempt fails to call submit_wiki_run_spec.
  await clearPlanDraft(input.layout.runWorkDir);

  const requiredScoutGapNote =
    requiredScoutGaps.length > 0
      ? [
          "## Required scout failures (coverage gaps)",
          `These unit surveys failed or returned empty: ${requiredScoutGaps.join(", ")}.`,
          "Still attempt a Spec that binds known units; do not pretend failed surveys covered them.",
        ].join("\n")
      : "";

  const child = await input.runtime.runAgent({
    role: "plan",
    spanId: "plan",
    nodeKey: "plan",
    runIndex: 0,
    runWorkDir: input.layout.runWorkDir,
    task: [
      basePrompt,
      coverageContext,
      plannerScoutContext,
      priorBlock,
      revisionPrompt,
      requiredScoutGapNote,
    ]
      .filter(Boolean)
      .join("\n\n"),
    systemPrompt,
    preferFinalMessage: true,
    customTools,
    model: input.model,
    modelRuntime: input.modelRuntime,
    sourceIgnores: input.sourceIgnores,
    maxContextTokens: input.maxContextTokens,
    contextTargetTokens: input.contextTargetTokens,
    retry: input.retry,
    timeoutMs: input.timeoutMs,
    abortSignal: input.abortSignal,
    onProgress: input.onProgress,
    transcriptPath: input.transcriptPath,
  });

  const resolved = await resolvePlanSpecFromAgentResult({
    runWorkDir: input.layout.runWorkDir,
    summary: child.summary,
  });

  // Host assertCoverage after Spec submit (defense in depth with tool-time gate).
  let lastCoverage: CoverageResult | undefined;
  if (coverageArtifacts.plan.requiredUnits.length === 0) {
    lastCoverage = assertCoverage(resolved.spec, coverageArtifacts.plan, {
      throwOnGap: false,
    });
  } else {
    const coverage = assertCoverage(resolved.spec, coverageArtifacts.plan, {
      throwOnGap: false,
    });
    lastCoverage = coverage;

    const gaps = new Set(coverage.gaps);
    for (const unitId of requiredScoutGaps) {
      if (!coverage.rows.some((r) => r.unitId === unitId && r.status === "covered")) {
        gaps.add(unitId);
      }
    }

    if (gaps.size > 0) {
      const preview = [...gaps].slice(0, 8).join(", ");
      const more = gaps.size > 8 ? ` (+${gaps.size - 8} more)` : "";
      throw new CoverageAssertError(
        `plan coverage gaps after durable scout synthesis: ${gaps.size} gap(s): ${preview}${more}`,
        {
          ...coverage,
          ok: false,
          stop_reason: "coverage_gap",
          gaps: [...gaps],
        },
      );
    }
  }

  // Dual gate: assertSemanticSufficiency + DiscoveryMap when present (soft without map).
  // Multi-source with a map: fail-closed as SemanticSufficiencyError (not CoverageAssertError).
  const semantic = tryAssertSemanticSufficiency({
    discovery: discoveryMap?.data,
    spec: resolved.spec,
    sourceCount: coverageArtifacts.adaptive.sourceCount,
    throwOnGap:
      Boolean(discoveryMap?.data) && coverageArtifacts.adaptive.sourceCount >= 2,
  });
  if (semantic && semantic.ok === false) {
    const gaps = semantic.gaps ?? [];
    const preview = gaps.slice(0, 8).join(", ") || "semantic gap";
    const more = gaps.length > 8 ? ` (+${gaps.length - 8} more)` : "";
    throw new SemanticSufficiencyError(
      `plan semantic sufficiency gaps after durable scout synthesis: ${preview}${more}`,
      semantic,
    );
  }

  return {
    spec: resolved.spec,
    mode: "live",
    rawSummary: child.summary,
    source: resolved.source,
    draftPath: resolved.draftPath,
    scoutKinds,
    ...(child.items ? { items: child.items } : {}),
    ...(child.metrics ? { metrics: child.metrics } : {}),
    ...(lastCoverage ? { coverage: lastCoverage } : {}),
    rescoutRounds: 0,
    adaptiveReasons: adaptive.reasons,
    orchestration: orch,
  };
}

/** Re-export path helpers for tests and handlers. */
export {
  planDraftPathFromRunWorkDir,
  PLAN_DRAFT_REL_PATH,
  clearPlanDraft,
  readPlanDraft,
  commitPlanDraft,
};

/** Test seam: prior-spec aware planUncertainty without full planWikiSpec. */
export function planUncertaintyForPriorSpec(spec: WikiRunSpec | undefined): number {
  return spec ? planUncertaintyFromSpec(spec) : 0;
}
