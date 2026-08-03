/**
 * Hybrid plan scouts (MoA proposers) before the Spec synthesizer.
 *
 * - Thematic scouts (entry|layout|tests|risks): optional; soft-fail OK
 * - Source surveys: budgeted by planSurveyTaskBudget (not planScoutCount alone)
 * - Surface surveys: large single-repo / monorepo when required surfaces exist
 *
 * Required unit scout failures are coverage gaps (not silent success).
 * Scouts write analysis/plan-scouts/*.md; plannerContext is sectioned by
 * ## Source / ## Surface / ## Thematic.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CoverageInventory,
  CoveragePlan,
  CoverageUnit,
  NodeAttempt,
  WorkspaceOrchestration,
} from "@okf-wiki/contract";
import { isSurfaceUnitId, parseSurfaceUnitId, unitIdForSource } from "@okf-wiki/contract";
import type {
  AgentRunner,
  RunWorkdirLayoutPaths,
  SourceIgnoreInput,
} from "../../ports/agent-runner.js";
import {
  type PlanScoutTask,
  planScoutPrompt,
  scoutTaskFileSlug,
  scoutTaskLabel,
  THEMATIC_SCOUT_KINDS,
  type ThematicScoutKind,
} from "../../prompts/plan-scout.js";
import { runBestEffortChild } from "../best-effort-child.js";
import { mapWithConcurrency } from "../map-with-concurrency.js";

export type PlanScoutReceipt = {
  task: PlanScoutTask;
  /** Bundle-relative path under run workdir. */
  relPath: string;
  summary: string;
  ok: boolean;
  /** True when this scout is required for coverage (source/surface unit). */
  required: boolean;
};

export type RunPlanScoutsInput = {
  layout: RunWorkdirLayoutPaths;
  workspaceName: string;
  runtime: AgentRunner;
  orch: WorkspaceOrchestration;
  operatorNotes?: string;
  /** Prefer worker (cheap); fall back to planner. */
  model?: unknown;
  modelRuntime?: unknown;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  sourceIgnores?: SourceIgnoreInput;
  abortSignal?: AbortSignal;
  onProgress?: (attempt: NodeAttempt) => void;
  /** Round index for graph attempts (0 = first plan). */
  runIndex?: number;
  /**
   * When set, schedule only scouts for these unit ids (re-scout path).
   * Bare source ids and source-qualified surface ids.
   */
  gapUnitIds?: readonly string[];
  /** Host coverage plan (required units drive required source/surface scouts). */
  coveragePlan?: CoveragePlan;
  /** Inventory for source/surface discovery when plan is light. */
  coverageInventory?: CoverageInventory;
  /**
   * Explicit task list override (tests / re-scout). When set, selection is skipped.
   */
  tasks?: readonly PlanScoutTask[];
};

export type RunPlanScoutsResult = {
  receipts: PlanScoutReceipt[];
  /** Text block injected into the planner task. */
  plannerContext: string;
  /** Tasks that were scheduled. */
  tasks: PlanScoutTask[];
  /**
   * Required unit ids whose scout failed or returned empty — treat as coverage gaps.
   */
  requiredScoutGaps: string[];
};

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
 * Exported for unit tests.
 */
export function selectPlanScoutTasks(input: {
  orch: WorkspaceOrchestration;
  coveragePlan?: CoveragePlan;
  coverageInventory?: CoverageInventory;
  gapUnitIds?: readonly string[];
}): PlanScoutTask[] {
  const orch = input.orch;
  const inventorySources = sourceIdsFromInventory(input.coverageInventory);
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

  // --- Gap-only re-scout: only unit-keyed scouts for missing units ---
  if (gapSet) {
    for (const unitId of gapSet) {
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
        const sid = unitIdForSource(unitId);
        if (!sid) continue;
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

  // Thematic scouts (independent of survey budget).
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

/**
 * Build plannerContext sectioned by Source / Surface / Thematic.
 */
export function formatScoutPlannerContext(receipts: readonly PlanScoutReceipt[]): string {
  const ok = receipts.filter((r) => r.ok);
  if (ok.length === 0) return "";

  const sources = ok.filter((r) => r.task.kind === "source");
  const surfaces = ok.filter((r) => r.task.kind === "surface");
  const thematic = ok.filter((r) => r.task.kind === "thematic");

  const sections: string[] = [
    "Plan scout receipts (multi-angle survey — synthesize into ONE WikiRunSpec):",
  ];

  if (sources.length > 0) {
    sections.push("## Source surveys");
    for (const r of sources) {
      const sid = r.task.kind === "source" ? r.task.sourceId : "?";
      sections.push(`### Source: ${sid} (${r.relPath})\n${r.summary.slice(0, 2500)}`);
    }
  }
  if (surfaces.length > 0) {
    sections.push("## Surface surveys");
    for (const r of surfaces) {
      const label = r.task.kind === "surface" ? r.task.unitId : "?";
      sections.push(`### Surface: ${label} (${r.relPath})\n${r.summary.slice(0, 2500)}`);
    }
  }
  if (thematic.length > 0) {
    sections.push("## Thematic scouts");
    for (const r of thematic) {
      const label = r.task.kind === "thematic" ? r.task.thematic : "?";
      sections.push(`### Scout ${label} (${r.relPath})\n${r.summary.slice(0, 2500)}`);
    }
  }

  sections.push(
    "Use scout findings as evidence. Resolve conflicts explicitly in openQuestions.",
    "You remain the sole author of the WikiRunSpec — scouts do not submit specs.",
    "Every required coverage unit must appear on critical pages (coverageUnitIds / sourceIds / surfaceIds) or be cancelled via sourceCoverage/surfaceCoverage (cancelled:true + notes).",
  );

  return sections.join("\n\n");
}

/**
 * Run plan scouts when tasks exist and runtime is live.
 * Fixture / empty selection → empty receipts (caller uses single planner only).
 */
export async function runPlanScouts(input: RunPlanScoutsInput): Promise<RunPlanScoutsResult> {
  if (input.runtime.kind === "fixture") {
    return { receipts: [], plannerContext: "", tasks: [], requiredScoutGaps: [] };
  }

  const tasks = input.tasks
    ? [...input.tasks]
    : selectPlanScoutTasks({
        orch: input.orch,
        coveragePlan: input.coveragePlan,
        coverageInventory: input.coverageInventory,
        gapUnitIds: input.gapUnitIds,
      });

  // Light path: no tasks (classic planScoutCount=0 and no multi-source surveys).
  if (tasks.length === 0) {
    return { receipts: [], plannerContext: "", tasks: [], requiredScoutGaps: [] };
  }

  const concurrency = Math.max(
    1,
    Math.min(
      tasks.length,
      input.orch.planScoutConcurrency ??
        Math.max(input.orch.planScoutCount || 1, tasks.length > 4 ? 4 : tasks.length),
    ),
  );
  const runIndex = input.runIndex ?? 0;
  const scoutsDir = path.join(input.layout.analysisDir, "plan-scouts");
  await mkdir(scoutsDir, { recursive: true });

  const receipts = await mapWithConcurrency(tasks, concurrency, input.abortSignal, async (task) => {
    const slug = scoutTaskFileSlug(task);
    const attemptId = `plan@${runIndex}:scout-${slug}`;
    const relPath = `analysis/plan-scouts/${slug}.md`;
    const label = scoutTaskLabel(task);

    const outcome = await runBestEffortChild({
      abortSignal: input.abortSignal,
      run: () =>
        input.runtime.runAgent({
          role: "root_research",
          spanId: attemptId,
          nodeKey: "plan",
          runIndex,
          runWorkDir: input.layout.runWorkDir,
          task: planScoutPrompt({
            task,
            workspaceName: input.workspaceName,
            operatorNotes: input.operatorNotes,
          }),
          systemPrompt:
            "You are a read-only plan scout. Inspect sources/ and return a compact structured report. Do not write wiki pages.",
          preferFinalMessage: false,
          model: input.model,
          modelRuntime: input.modelRuntime,
          maxContextTokens: input.maxContextTokens,
          contextTargetTokens: input.contextTargetTokens,
          sourceIgnores: input.sourceIgnores,
          abortSignal: input.abortSignal,
          onProgress: input.onProgress,
        }),
    });

    if (outcome.ok) {
      const child = outcome.value;
      const summaryText = (child.summary ?? "").trim();
      // Soft-empty required scout = gap (not silent success).
      const emptyRequired = task.required && summaryText.length === 0;
      const body = [
        `# Plan scout: ${label}`,
        "",
        summaryText || (emptyRequired ? "(empty scout summary — coverage gap)" : "(empty scout summary)"),
        "",
      ].join("\n");
      await writeFile(path.join(input.layout.runWorkDir, relPath), body, "utf8");
      return {
        task,
        relPath,
        summary: summaryText.slice(0, 4000),
        ok: !emptyRequired,
        required: task.required,
      } satisfies PlanScoutReceipt;
    }

    const message = outcome.message;
    const cls = outcome.errorClass ? ` (${outcome.errorClass})` : "";
    const body = [`# Plan scout: ${label}`, "", `Scout failed${cls}: ${message}`, ""].join("\n");
    await writeFile(path.join(input.layout.runWorkDir, relPath), body, "utf8");
    input.onProgress?.({
      attemptId,
      nodeKey: "plan",
      runIndex,
      role: "root_research",
      status: "error",
      summary: `scout ${label} failed${cls}: ${message}`.slice(0, 4000),
      ...(outcome.errorClass !== undefined ? { errorClass: outcome.errorClass } : {}),
    });
    return {
      task,
      relPath,
      summary: message.slice(0, 4000),
      ok: false,
      required: task.required,
    } satisfies PlanScoutReceipt;
  });

  const requiredScoutGaps: string[] = [];
  for (const r of receipts) {
    if (r.ok || !r.required) continue;
    if (r.task.kind === "source") requiredScoutGaps.push(unitIdForSource(r.task.sourceId));
    else if (r.task.kind === "surface") requiredScoutGaps.push(r.task.unitId);
  }

  return {
    receipts,
    plannerContext: formatScoutPlannerContext(receipts),
    tasks,
    requiredScoutGaps,
  };
}
