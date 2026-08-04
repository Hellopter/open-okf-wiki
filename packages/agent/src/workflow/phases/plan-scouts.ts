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
  SEMANTIC_SCOUT_KINDS,
  selectPlanScoutTasks,
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

export { planScoutTaskFromDetail, selectPlanScoutTasks } from "@okf-wiki/contract/wiki-runs";

function isSemanticScoutKind(kind: string): boolean {
  return (SEMANTIC_SCOUT_KINDS as readonly string[]).includes(kind);
}

/** Label for receipts / planner index — contract scoutTaskLabel owns semantic kinds. */
function taskLabel(task: PlanScoutTask): string {
  try {
    return scoutTaskLabel(task);
  } catch {
    return (task.kind as string) || "scout";
  }
}

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
  const label = taskLabel(input.task);
  const taskKind = input.task.kind as string;
  let kind: string;
  if (input.task.kind === "thematic") {
    kind = input.task.thematic;
  } else if (input.task.kind === "source") {
    kind = `source:${input.task.sourceId}`;
  } else if (input.task.kind === "surface") {
    kind = `surface:${input.task.unitId}`;
  } else if (isSemanticScoutKind(taskKind)) {
    // Prefer source-qualified / cross ids (domain:api, flow:cross) over bare kind.
    kind = input.task.id || taskKind;
  } else {
    kind = taskKind || label;
  }
  const openQuestions = openQuestionsFromScoutSummary(input.summary);
  const paths = pathsFromScoutSummary(input.summary);
  const semanticSourceId =
    isSemanticScoutKind(taskKind) && "sourceId" in input.task
      ? input.task.sourceId
      : undefined;
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
    ...(semanticSourceId ? { sourceId: semanticSourceId } : {}),
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
  const slug = (() => {
    try {
      return scoutTaskFileSlug(input.task);
    } catch {
      const k = input.task.kind as string;
      return isSemanticScoutKind(k) ? k : k.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "scout";
    }
  })();
  const label = taskLabel(input.task);
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
  const slug = (() => {
    try {
      return scoutTaskFileSlug(task);
    } catch {
      const k = task.kind as string;
      return isSemanticScoutKind(k) ? k : k.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "scout";
    }
  })();
  const label = taskLabel(task);
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
          "You are a read-only plan scout. Inspect sources/ for implementation evidence (not README-only). " +
          "Write a compact structured report as your final message (short ACK doctrine: prefer paths over prose; under ~800 words). " +
          "Do not write wiki pages. Do not submit a Spec.",
        preferFinalMessage: true,
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

/** Max chars for an optional one-line preview on the index card (not full body). */
const SCOUT_INDEX_PREVIEW_MAX = 120;

/** Paths the planner should `read` for sealed discovery / scout files. */
export const DISCOVERY_MAP_INPUT_REL = "inputs/discovery-map.json";
export const DISCOVERY_MAP_ANALYSIS_REL = "analysis/discovery-map.json";
export const PLAN_SCOUTS_INPUT_DIR = "inputs/plan-scouts";
export const PLAN_SCOUTS_ANALYSIS_DIR = "analysis/plan-scouts";

/**
 * Compact one-line preview from a scout summary (never multi-kB body paste).
 */
export function scoutIndexPreview(summary: string, max = SCOUT_INDEX_PREVIEW_MAX): string {
  const line = summary.replace(/\s+/g, " ").trim();
  if (!line) return "";
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

function scoutCardSection(
  heading: string,
  rows: readonly { id: string; status: string; path: string; preview?: string }[],
): string[] {
  if (rows.length === 0) return [];
  const lines = [`### ${heading}`];
  for (const r of rows) {
    const preview = r.preview?.trim() ? ` — ${r.preview.trim()}` : "";
    lines.push(`- **${r.id}** | ${r.status} | \`${r.path}\`${preview}`);
  }
  return lines;
}

/**
 * Build plannerContext as a compact **index card** (ids, status, paths).
 * Does NOT paste multi-kB scout bodies — planner must `read` sealed files.
 */
export function formatScoutPlannerContext(
  receipts: readonly PlanScoutReceipt[],
  options?: { discoveryMapPath?: string },
): string {
  if (receipts.length === 0 && !options?.discoveryMapPath) return "";

  const sources = receipts.filter((r) => r.task.kind === "source");
  const surfaces = receipts.filter((r) => r.task.kind === "surface");
  const thematic = receipts.filter((r) => r.task.kind === "thematic");
  // Semantic kinds (domain/flow/concept) when contract ships them — treat by id.
  const semantic = receipts.filter((r) => {
    const k = r.task.kind as string;
    return k === "domain" || k === "flow" || k === "concept" || k === "semantic";
  });
  const other = receipts.filter(
    (r) =>
      !sources.includes(r) &&
      !surfaces.includes(r) &&
      !thematic.includes(r) &&
      !semantic.includes(r),
  );

  const toRow = (r: PlanScoutReceipt, id: string) => ({
    id,
    status: r.ok ? "ok" : r.required ? "failed(required)" : "failed",
    path: r.relPath.startsWith("inputs/")
      ? r.relPath
      : r.receiptRelPath ?? r.relPath,
    preview: scoutIndexPreview(r.summary),
  });

  const sections: string[] = [
    "## Plan scout index (file handoff — do not rely on this card alone)",
    "Sealed scout bodies live under `inputs/plan-scouts/*` (and `analysis/plan-scouts/*` when present).",
    "Use the `read` tool on each path below before synthesizing the WikiRunSpec.",
    "Do **not** invent scout findings from this index; open the files.",
  ];

  if (options?.discoveryMapPath) {
    sections.push(
      `### Discovery map`,
      `- **discovery-map** | present | \`${options.discoveryMapPath}\``,
      "Prefer DiscoveryMap as the first synthesis input when present (merged scout evidence).",
    );
  } else {
    sections.push(
      "### Discovery map",
      `- (not projected) — check \`${DISCOVERY_MAP_INPUT_REL}\` / \`${DISCOVERY_MAP_ANALYSIS_REL}\` with \`ls\`/\`read\` if present.`,
    );
  }

  sections.push(
    ...scoutCardSection(
      "Source surveys",
      sources.map((r) =>
        toRow(r, r.task.kind === "source" ? r.task.sourceId : taskLabel(r.task)),
      ),
    ),
    ...scoutCardSection(
      "Surface surveys",
      surfaces.map((r) =>
        toRow(r, r.task.kind === "surface" ? r.task.unitId : taskLabel(r.task)),
      ),
    ),
    ...scoutCardSection(
      "Semantic scouts",
      semantic.map((r) => toRow(r, taskLabel(r.task))),
    ),
    ...scoutCardSection(
      "Thematic scouts",
      thematic.map((r) =>
        toRow(r, r.task.kind === "thematic" ? r.task.thematic : taskLabel(r.task)),
      ),
    ),
    ...scoutCardSection(
      "Other scouts",
      other.map((r) => toRow(r, taskLabel(r.task))),
    ),
  );

  sections.push(
    "### Rules",
    "- You remain the sole author of the WikiRunSpec — scouts do not submit specs.",
    "- Resolve conflicts from scout files explicitly in openQuestions.",
    "- Every required coverage unit must appear on critical pages (coverageUnitIds / sourceIds / surfaceIds) or be cancelled via sourceCoverage/surfaceCoverage (cancelled:true + notes).",
    "- Host gates: assertCoverage + assertSemanticSufficiency (when DiscoveryMap is present).",
  );

  return sections.filter(Boolean).join("\n");
}

/**
 * Format planner context from projected durable scout receipts (JSON files).
 * Index-card only — never paste multi-kB `summary` bodies into the planner task.
 */
export function formatScoutPlannerContextFromJson(
  receipts: readonly PlanScoutReceiptJson[],
  options?: { discoveryMapPath?: string },
): string {
  if (receipts.length === 0 && !options?.discoveryMapPath) return "";

  const sourceOnly = receipts.filter((r) => r.kind.startsWith("source:"));
  const surfaceOnly = receipts.filter((r) => r.kind.startsWith("surface:"));
  const semanticOnly = receipts.filter((r) => {
    const k = r.kind.replace(/^semantic:/, "");
    return (
      r.kind === "domain" ||
      r.kind === "flow" ||
      r.kind === "concept" ||
      r.kind.startsWith("domain") ||
      r.kind.startsWith("flow") ||
      r.kind.startsWith("concept") ||
      k === "domain" ||
      k === "flow" ||
      k === "concept"
    );
  });
  const thematicOnly = receipts.filter(
    (r) =>
      !sourceOnly.includes(r) &&
      !surfaceOnly.includes(r) &&
      !semanticOnly.includes(r),
  );

  const inputPathFor = (r: PlanScoutReceiptJson, fallbackSlug: string): string => {
    // Prefer projected inputs/ path; analysis/ is for local inspection.
    if (r.relPath?.startsWith("inputs/")) return r.relPath;
    if (r.relPath?.startsWith("analysis/plan-scouts/")) {
      const base = path.basename(r.relPath).replace(/\.md$/, ".json");
      return `${PLAN_SCOUTS_INPUT_DIR}/${base}`;
    }
    // kind may be "source:api" or "entry" — use filesystem-safe slug from kind.
    const slug =
      fallbackSlug
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "scout";
    return `${PLAN_SCOUTS_INPUT_DIR}/${slug}.json`;
  };

  const toRow = (r: PlanScoutReceiptJson, id: string, slug: string) => ({
    id,
    status: r.ok
      ? r.critical
        ? "ok(required)"
        : "ok"
      : r.critical
        ? "failed(required)"
        : "failed",
    path: inputPathFor(r, slug),
    preview: scoutIndexPreview(r.summary),
  });

  const sections: string[] = [
    "## Plan scout index (file handoff — do not rely on this card alone)",
    "Sealed scout receipts: `inputs/plan-scouts/*.json` (durable plan.scout Attempts).",
    "Markdown reports may also exist under `analysis/plan-scouts/*.md` — prefer JSON receipts.",
    "Use the `read` tool on each path before synthesizing. **Do not invent findings from this index.**",
  ];

  if (options?.discoveryMapPath) {
    sections.push(
      "### Discovery map",
      `- **discovery-map** | present | \`${options.discoveryMapPath}\``,
      "Read DiscoveryMap first when present — it is the merged discovery authority for synthesis.",
    );
  } else {
    sections.push(
      "### Discovery map",
      `- (not projected) — check \`${DISCOVERY_MAP_INPUT_REL}\` / \`${DISCOVERY_MAP_ANALYSIS_REL}\` with \`ls\`/\`read\` if present.`,
    );
  }

  sections.push(
    ...scoutCardSection(
      "Source surveys",
      sourceOnly.map((r) => {
        const sid = r.sourceId ?? r.kind.replace(/^source:/, "");
        return toRow(r, sid, `source-${sid}`);
      }),
    ),
    ...scoutCardSection(
      "Surface surveys",
      surfaceOnly.map((r) => {
        const label = r.unitId ?? r.kind.replace(/^surface:/, "");
        return toRow(r, label, `surface-${label}`);
      }),
    ),
    ...scoutCardSection(
      "Semantic scouts",
      semanticOnly.map((r) => toRow(r, r.taskLabel ?? r.kind, r.kind)),
    ),
    ...scoutCardSection(
      "Thematic / other scouts",
      thematicOnly.map((r) => toRow(r, r.taskLabel ?? r.kind, r.kind)),
    ),
  );

  sections.push(
    "### Rules",
    "- You remain the sole author of the WikiRunSpec — scouts do not submit specs.",
    "- Resolve conflicts from scout files explicitly in openQuestions.",
    "- Every required coverage unit must appear on critical pages (coverageUnitIds / sourceIds / surfaceIds) or be cancelled via sourceCoverage/surfaceCoverage (cancelled:true + notes).",
    "- Host gates: assertCoverage + assertSemanticSufficiency (when DiscoveryMap is present).",
  );

  return sections.filter(Boolean).join("\n");
}

/**
 * Soft-load sealed DiscoveryMap JSON from inputs/ then analysis/.
 * Returns path + raw object when present; does not require contract schema.
 */
export async function loadProjectedDiscoveryMap(
  layout: RunWorkdirLayoutPaths,
): Promise<{ path: string; data: unknown } | undefined> {
  const candidates = [
    path.join(layout.runWorkDir, DISCOVERY_MAP_INPUT_REL),
    path.join(layout.runWorkDir, DISCOVERY_MAP_ANALYSIS_REL),
  ];
  for (const abs of candidates) {
    try {
      const raw = await readFile(abs, "utf8");
      const data = JSON.parse(raw) as unknown;
      if (data && typeof data === "object") {
        const rel = path.relative(layout.runWorkDir, abs).replace(/\\/g, "/");
        return { path: rel, data };
      }
    } catch {
      // missing or unreadable — try next
    }
  }
  return undefined;
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
    const slug = (() => {
      try {
        return scoutTaskFileSlug(task);
      } catch {
        const k = task.kind as string;
        return isSemanticScoutKind(k) ? k : k.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "scout";
      }
    })();
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

