/**
 * Plan scout run helpers (single-task + multi-task harness).
 *
 * Selection lives in `@okf-wiki/contract/wiki-runs` (U1). Durable mode (U2):
 * each scout is a plan.scout Attempt via handlePlanScout; plan synthesizer
 * reads sealed receipts from inputs/plan-scouts/.
 *
 * runPlanScouts remains for unit tests / offline multi-scout harness only —
 * plan-phase no longer nests it.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CoverageInventory,
  type CoveragePlan,
  unitIdForSource,
} from "@okf-wiki/contract/coverage";
import {
  type NodeAttempt,
  type PlanScoutTask,
  scoutTaskFileSlug,
  scoutTaskLabel,
  selectPlanScoutTasks,
  THEMATIC_SCOUT_KINDS,
} from "@okf-wiki/contract/wiki-runs";
import type { WorkspaceOrchestration } from "@okf-wiki/contract/workspace";
import type {
  AgentRunner,
  AgentRunResult,
  RunWorkdirLayoutPaths,
  SourceIgnoreInput,
} from "../../ports/agent-runner.js";
import { planScoutPrompt } from "../../prompts/plan-scout.js";
import { runBestEffortChild } from "../best-effort-child.js";
import { mapWithConcurrency } from "../map-with-concurrency.js";

export { selectPlanScoutTasks } from "@okf-wiki/contract/wiki-runs";

/** Lightweight sealed scout receipt (Attempt business output). */
export type PlanScoutReceiptJson = {
  version: 1;
  kind: string;
  unitId?: string;
  sourceId?: string;
  summary: string;
  ok: boolean;
  critical: boolean;
  openQuestions?: string[];
  paths?: string[];
  /** Bundle-relative markdown report when written. */
  relPath?: string;
  taskLabel?: string;
};

export type PlanScoutReceipt = {
  task: PlanScoutTask;
  /** Bundle-relative path under run workdir (markdown report). */
  relPath: string;
  /** Bundle-relative path of the lightweight JSON receipt when written. */
  receiptRelPath?: string;
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

/** Open-questions bullets from free-text scout summary (best-effort). */
export function openQuestionsFromScoutSummary(summary: string): string[] {
  const lines = summary.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{0,3}\s*open questions/i.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^#{1,3}\s/.test(trimmed) && !/^#{1,3}\s*open questions/i.test(trimmed)) break;
      const item = trimmed
        .replace(/^[-*•]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim();
      if (item) out.push(item.slice(0, 500));
    }
  }
  return out.slice(0, 20);
}

/** Repo-ish paths mentioned in scout summary (best-effort, bounded). */
export function pathsFromScoutSummary(summary: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const re =
    /(?:sources\/[^\s)\]"'`]+|[A-Za-z0-9_./-]+\.(?:md|ts|tsx|js|jsx|py|go|rs|java|json|yml|yaml|toml)(?:#L\d+(?:-L\d+)?)?)/g;
  for (const match of summary.matchAll(re)) {
    const raw = (match[0] ?? "").replace(/[.,;:]+$/, "");
    if (!raw || raw.length < 3 || raw.length > 200) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    paths.push(raw);
    if (paths.length >= 30) break;
  }
  return paths;
}

/** Build lightweight receipt JSON for a single scout task outcome. */
export function buildPlanScoutReceiptJson(input: {
  task: PlanScoutTask;
  summary: string;
  ok: boolean;
  relPath?: string;
}): PlanScoutReceiptJson {
  const label = scoutTaskLabel(input.task);
  const kind =
    input.task.kind === "thematic"
      ? input.task.thematic
      : input.task.kind === "source"
        ? `source:${input.task.sourceId}`
        : `surface:${input.task.unitId}`;
  const openQuestions = openQuestionsFromScoutSummary(input.summary);
  const paths = pathsFromScoutSummary(input.summary);
  return {
    version: 1,
    kind,
    ...(input.task.kind === "source"
      ? { unitId: unitIdForSource(input.task.sourceId), sourceId: input.task.sourceId }
      : {}),
    ...(input.task.kind === "surface"
      ? {
          unitId: input.task.unitId,
          sourceId: input.task.sourceId,
        }
      : {}),
    summary: input.summary.slice(0, 4_000),
    ok: input.ok,
    critical: input.task.required,
    ...(openQuestions.length > 0 ? { openQuestions } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(input.relPath ? { relPath: input.relPath } : {}),
    taskLabel: label,
  };
}

/**
 * Write analysis/plan-scouts/<slug>.md + .json for one scout outcome.
 * Returns receipt paths and the JSON payload.
 */
export async function writePlanScoutReceiptFiles(input: {
  layout: RunWorkdirLayoutPaths;
  task: PlanScoutTask;
  summary: string;
  ok: boolean;
}): Promise<{
  relPath: string;
  receiptRelPath: string;
  receiptAbsPath: string;
  receipt: PlanScoutReceiptJson;
}> {
  const slug = scoutTaskFileSlug(input.task);
  const label = scoutTaskLabel(input.task);
  const scoutsDir = path.join(input.layout.analysisDir, "plan-scouts");
  await mkdir(scoutsDir, { recursive: true });
  const relPath = `analysis/plan-scouts/${slug}.md`;
  const receiptRelPath = `analysis/plan-scouts/${slug}.json`;
  const body = [
    `# Plan scout: ${label}`,
    "",
    input.summary.trim() ||
      (input.task.required && !input.ok
        ? "(empty scout summary — coverage gap)"
        : "(empty scout summary)"),
    "",
  ].join("\n");
  await writeFile(path.join(input.layout.runWorkDir, relPath), body, "utf8");
  const receipt = buildPlanScoutReceiptJson({
    task: input.task,
    summary: input.summary,
    ok: input.ok,
    relPath,
  });
  const receiptAbsPath = path.join(input.layout.runWorkDir, receiptRelPath);
  await writeFile(receiptAbsPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { relPath, receiptRelPath, receiptAbsPath, receipt };
}

/**
 * Run one plan scout task (worker model). Soft-fails non-abort errors into ok:false
 * when `softFail` is true (optional scouts). Critical empty summary → ok:false.
 */
export async function runOnePlanScout(input: {
  layout: RunWorkdirLayoutPaths;
  workspaceName: string;
  runtime: AgentRunner;
  task: PlanScoutTask;
  operatorNotes?: string;
  model?: unknown;
  modelRuntime?: unknown;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  sourceIgnores?: SourceIgnoreInput;
  abortSignal?: AbortSignal;
  onProgress?: (attempt: NodeAttempt) => void;
  /** Span / node key for progress (default plan.scout.<slug>). */
  nodeKey?: string;
  spanId?: string;
  runIndex?: number;
  transcriptPath?: string;
  /** When true, agent failures become ok:false receipts instead of throwing. Default true. */
  softFail?: boolean;
  timeoutMs?: number;
  retry?: unknown;
}): Promise<{
  receipt: PlanScoutReceipt;
  receiptJson: PlanScoutReceiptJson;
  receiptAbsPath: string;
  child?: AgentRunResult;
  /** Soft-fail message when agent failed. */
  errorMessage?: string;
}> {
  const task = input.task;
  const slug = scoutTaskFileSlug(task);
  const label = scoutTaskLabel(task);
  const runIndex = input.runIndex ?? 0;
  const nodeKey = input.nodeKey ?? `plan.scout.${slug}`;
  const spanId = input.spanId ?? nodeKey;
  const softFail = input.softFail !== false;

  const outcome = await runBestEffortChild({
    abortSignal: input.abortSignal,
    run: () =>
      input.runtime.runAgent({
        role: "root_research",
        spanId,
        nodeKey,
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
        ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.retry !== undefined ? { retry: input.retry as never } : {}),
      }),
  });

  if (outcome.ok) {
    const child = outcome.value;
    const summaryText = (child.summary ?? "").trim();
    const emptyRequired = task.required && summaryText.length === 0;
    const ok = !emptyRequired;
    const written = await writePlanScoutReceiptFiles({
      layout: input.layout,
      task,
      summary: summaryText,
      ok,
    });
    return {
      receipt: {
        task,
        relPath: written.relPath,
        receiptRelPath: written.receiptRelPath,
        summary: summaryText.slice(0, 4000),
        ok,
        required: task.required,
      },
      receiptJson: written.receipt,
      receiptAbsPath: written.receiptAbsPath,
      child,
    };
  }

  const message = outcome.message;
  const cls = outcome.errorClass ? ` (${outcome.errorClass})` : "";
  if (!softFail) {
    throw new Error(`scout ${label} failed${cls}: ${message}`);
  }

  const written = await writePlanScoutReceiptFiles({
    layout: input.layout,
    task,
    summary: `Scout failed${cls}: ${message}`,
    ok: false,
  });
  input.onProgress?.({
    attemptId: spanId,
    nodeKey,
    runIndex,
    role: "root_research",
    status: "error",
    summary: `scout ${label} failed${cls}: ${message}`.slice(0, 4000),
    ...(outcome.errorClass !== undefined ? { errorClass: outcome.errorClass } : {}),
  });
  return {
    receipt: {
      task,
      relPath: written.relPath,
      receiptRelPath: written.receiptRelPath,
      summary: message.slice(0, 4000),
      ok: false,
      required: task.required,
    },
    receiptJson: written.receipt,
    receiptAbsPath: written.receiptAbsPath,
    errorMessage: message,
  };
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
 * Format planner context from projected durable scout receipts (JSON files).
 */
export function formatScoutPlannerContextFromJson(
  receipts: readonly PlanScoutReceiptJson[],
): string {
  const ok = receipts.filter((r) => r.ok && r.summary.trim().length > 0);
  if (ok.length === 0) return "";

  const sourceOnly = ok.filter((r) => r.kind.startsWith("source:"));
  const surfaceOnly = ok.filter((r) => r.kind.startsWith("surface:"));
  const thematicOnly = ok.filter(
    (r) => !r.kind.startsWith("source:") && !r.kind.startsWith("surface:"),
  );

  const sections: string[] = [
    "Plan scout receipts (multi-angle survey — synthesize into ONE WikiRunSpec):",
    "Receipts are under inputs/plan-scouts/ (sealed from durable plan.scout Attempts).",
  ];

  if (sourceOnly.length > 0) {
    sections.push("## Source surveys");
    for (const r of sourceOnly) {
      const sid = r.sourceId ?? r.kind.replace(/^source:/, "");
      const pathHint = r.relPath ?? `inputs/plan-scouts/${sid}.json`;
      sections.push(`### Source: ${sid} (${pathHint})\n${r.summary.slice(0, 2500)}`);
    }
  }
  if (surfaceOnly.length > 0) {
    sections.push("## Surface surveys");
    for (const r of surfaceOnly) {
      const label = r.unitId ?? r.kind.replace(/^surface:/, "");
      const pathHint = r.relPath ?? `inputs/plan-scouts/${label}.json`;
      sections.push(`### Surface: ${label} (${pathHint})\n${r.summary.slice(0, 2500)}`);
    }
  }
  if (thematicOnly.length > 0) {
    sections.push("## Thematic scouts");
    for (const r of thematicOnly) {
      const pathHint = r.relPath ?? `inputs/plan-scouts/${r.kind}.json`;
      sections.push(`### Scout ${r.kind} (${pathHint})\n${r.summary.slice(0, 2500)}`);
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
 * Load projected durable scout receipts from inputs/plan-scouts/*.json
 * (and soft-read analysis/plan-scouts/*.json when present).
 */
export async function loadProjectedPlanScoutReceipts(
  layout: RunWorkdirLayoutPaths,
): Promise<PlanScoutReceiptJson[]> {
  const dirs = [
    path.join(layout.runWorkDir, "inputs", "plan-scouts"),
    path.join(layout.analysisDir, "plan-scouts"),
  ];
  const byKind = new Map<string, PlanScoutReceiptJson>();

  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(dir, name), "utf8");
        const parsed = JSON.parse(raw) as Partial<PlanScoutReceiptJson>;
        if (!parsed || typeof parsed !== "object") continue;
        const kind =
          typeof parsed.kind === "string" && parsed.kind.trim()
            ? parsed.kind.trim()
            : name.replace(/\.json$/, "");
        const summary = typeof parsed.summary === "string" ? parsed.summary : "";
        const receipt: PlanScoutReceiptJson = {
          version: 1,
          kind,
          summary: summary.slice(0, 4_000),
          ok: parsed.ok !== false && summary.trim().length > 0,
          critical: parsed.critical === true,
          ...(typeof parsed.unitId === "string" ? { unitId: parsed.unitId } : {}),
          ...(typeof parsed.sourceId === "string" ? { sourceId: parsed.sourceId } : {}),
          ...(Array.isArray(parsed.openQuestions)
            ? {
                openQuestions: parsed.openQuestions
                  .filter((q): q is string => typeof q === "string")
                  .slice(0, 20),
              }
            : {}),
          ...(Array.isArray(parsed.paths)
            ? {
                paths: parsed.paths
                  .filter((p): p is string => typeof p === "string")
                  .slice(0, 30),
              }
            : {}),
          ...(typeof parsed.relPath === "string" ? { relPath: parsed.relPath } : {}),
          ...(typeof parsed.taskLabel === "string" ? { taskLabel: parsed.taskLabel } : {}),
        };
        // Prefer inputs/ over analysis/ (first dir wins unless empty).
        if (!byKind.has(kind) || dir.includes(`${path.sep}inputs${path.sep}`)) {
          byKind.set(kind, receipt);
        }
      } catch {
        // skip unreadable
      }
    }
  }

  return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * Multi-scout harness (tests / offline). Plan phase no longer calls this —
 * durable plan.scout Attempts own one task each.
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

  const receipts = await mapWithConcurrency(tasks, concurrency, input.abortSignal, async (task) => {
    const slug = scoutTaskFileSlug(task);
    const result = await runOnePlanScout({
      layout: input.layout,
      workspaceName: input.workspaceName,
      runtime: input.runtime,
      task,
      operatorNotes: input.operatorNotes,
      model: input.model,
      modelRuntime: input.modelRuntime,
      maxContextTokens: input.maxContextTokens,
      contextTargetTokens: input.contextTargetTokens,
      sourceIgnores: input.sourceIgnores,
      abortSignal: input.abortSignal,
      onProgress: input.onProgress,
      spanId: `plan@${runIndex}:scout-${slug}`,
      nodeKey: "plan",
      runIndex,
      softFail: true,
    });
    return result.receipt;
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

/**
 * Build a PlanScoutTask from sealed plan.scout node detail.
 * Fail-closed when scoutKind / required fields are missing or inconsistent.
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
    `plan.scout detail.scoutKind must be thematic (entry|layout|tests|risks), source, or surface; got ${JSON.stringify(kind)}`,
  );
}
