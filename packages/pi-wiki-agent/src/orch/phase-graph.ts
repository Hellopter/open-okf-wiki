/**
 * Deterministic, Markdown-first Wiki workflow.
 *
 * The host owns the phase graph, task budget, quality gates and recovery. Agents
 * only inspect the frozen data plane and write scoped Markdown artifacts. One
 * persistent main session is the only agent permitted to write the Wiki bundle.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CoreAdapter, WikiRunPaths } from "../core-adapter.js";
import type { WikiAgentRunRequest, WikiAgentRunResult, WikiAgentRunner } from "./agent-runner.js";
import type { TaskPool } from "./pool.js";
import type { WikiRunStore } from "./store.js";
import type {
  OrchLimits,
  WikiAgentActivity,
  WikiAgentRole,
  WikiContextUsage,
  WikiPhaseStatus,
  WikiQualitySummary,
  WikiTokenUsage,
} from "./types.js";

const MAX_SOURCE_SURVEY_TASKS = 5;
const MAX_EVIDENCE_TASKS = 4;

type EphemeralRole = Exclude<WikiAgentRole, "main">;

export interface CoverageUnit {
  id: string;
  sourceId?: string;
  path?: string;
  kind?: string;
  required?: boolean;
  [key: string]: unknown;
}

export interface InventorySource {
  id: string;
  fileCount?: number;
  surfaceCount?: number;
}

export interface LoadedInventory {
  units: CoverageUnit[];
  sourceRoots: number;
  sources: InventorySource[];
}

export interface SurveyTask {
  id: string;
  label: string;
  role: "source-researcher" | "integration-researcher";
  sourceIds: string[];
  unitIds: string[];
  outputRelativePath: string;
}

export interface EvidenceTask {
  id: string;
  label: string;
  sourceIds: string[];
  unitIds: string[];
  outputRelativePath: string;
}

export interface WikiPathContext {
  core: CoreAdapter;
  workspaceRoot: string;
  runId: string;
  paths: WikiRunPaths;
  sessionPath?: string;
  focus?: string;
  store: WikiRunStore;
  pool: TaskPool;
  mainAgent: WikiAgentRunner;
  createEphemeralAgent: (role: EphemeralRole) => WikiAgentRunner;
  toolsForRole: (role: WikiAgentRole) => ToolDefinition[];
  cwd: string;
  limits: OrchLimits;
  signal: AbortSignal;
}

export interface WikiPathResult {
  status: "completed" | "proposed" | "failed" | "blocked" | "quality_blocked";
  runId: string;
  summary?: string;
  error?: string;
}

interface QualityReport {
  id: string;
  path: string;
  verdict: "PASS" | "FAIL";
  findings: number;
  blocked: boolean;
  error?: string;
}

interface ReviewTask {
  id: "evidence" | "workflow" | "navigation";
  label: string;
  role: "reviewer-evidence" | "reviewer-workflow" | "reviewer-navigation";
  outputRelativePath: string;
  focus: string;
}

const REVIEW_TASKS: readonly ReviewTask[] = [
  {
    id: "evidence",
    label: "evidence-reviewer",
    role: "reviewer-evidence",
    outputRelativePath: "reviews/evidence.md",
    focus: "source evidence, inventory coverage, factual claims, and omissions",
  },
  {
    id: "workflow",
    label: "workflow-reviewer",
    role: "reviewer-workflow",
    outputRelativePath: "reviews/workflow.md",
    focus: "runtime flows, state transitions, failures, retries, and Mermaid fidelity",
  },
  {
    id: "navigation",
    label: "navigation-reviewer",
    role: "reviewer-navigation",
    outputRelativePath: "reviews/navigation.md",
    focus: "page hierarchy, links, change safety, configuration, and verification guidance",
  },
] as const;

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  const error = reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "Aborted");
  error.name = error.name === "Error" ? "AbortError" : error.name;
  throw error;
}

function hostOk(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as { ok?: unknown; status?: unknown };
  return result.ok === true || result.status === "ok" || result.status === "completed" || result.status === "complete";
}

/** Set phase status and emit the matching observation event. */
export function setPhaseStatus(store: WikiRunStore, name: string, status: WikiPhaseStatus, summary?: string): void {
  store.setPhase(name, status, summary);
  if (status === "active") store.appendEvent("phase.started", { phase: name });
  else if (status === "done") store.appendEvent("phase.completed", { phase: name, detail: summary ? { summary } : undefined });
  else if (status === "failed") store.appendEvent("phase.failed", { phase: name, detail: summary ? { summary } : undefined });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** Read only deterministic inventory data used to build the host-owned task graph. */
export function loadInventory(inputsDir: string): LoadedInventory {
  const inventoryPath = join(inputsDir, "inventory.json");
  if (!existsSync(inventoryPath)) return { units: [], sourceRoots: 0, sources: [] };
  try {
    const raw = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
      coverageUnits?: unknown;
      units?: unknown;
      sources?: unknown;
      sourceCount?: unknown;
    };
    const rawUnits = Array.isArray(raw.coverageUnits) ? raw.coverageUnits : Array.isArray(raw.units) ? raw.units : [];
    const units = rawUnits.filter(
      (item): item is CoverageUnit => Boolean(item && typeof item === "object" && typeof (item as CoverageUnit).id === "string"),
    );
    const sources = (Array.isArray(raw.sources) ? raw.sources : []).flatMap((item): InventorySource[] => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const id = typeof record.sourceId === "string" ? record.sourceId : typeof record.id === "string" ? record.id : undefined;
      if (!id) return [];
      const surfaces = Array.isArray(record.surfaces) ? record.surfaces.length : undefined;
      return [{ id, fileCount: nonNegativeInteger(record.fileCount), surfaceCount: surfaces }];
    });
    const sourceIds = new Set([...sources.map((source) => source.id), ...units.flatMap((unit) => unit.sourceId ? [unit.sourceId] : [])]);
    const declaredCount = nonNegativeInteger(raw.sourceCount);
    return { units, sourceRoots: declaredCount ?? sourceIds.size, sources };
  } catch {
    return { units: [], sourceRoots: 0, sources: [] };
  }
}

function taskSlug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "scope";
}

function unitsForSources(inventory: LoadedInventory, sourceIds: readonly string[]): CoverageUnit[] {
  const ids = new Set(sourceIds);
  return inventory.units.filter((unit) => unit.sourceId && ids.has(unit.sourceId));
}

function sourceIdsForInventory(inventory: LoadedInventory): string[] {
  const ids = new Set([...inventory.sources.map((source) => source.id), ...inventory.units.flatMap((unit) => unit.sourceId ? [unit.sourceId] : [])]);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * Build a two-wave survey graph from frozen inventory. Wave one keeps each
 * meaningful source cohesive; wave two is the one cross-source synthesis task.
 */
export function buildSurveyTaskGraph(inventory: LoadedInventory): { waveOne: SurveyTask[]; integration?: SurveyTask } {
  const sourceIds = sourceIdsForInventory(inventory);
  const sourceDetails = new Map(inventory.sources.map((source) => [source.id, source]));
  const ranked = sourceIds.map((sourceId) => {
    const units = unitsForSources(inventory, [sourceId]);
    const detail = sourceDetails.get(sourceId);
    const significant = units.some((unit) => unit.path && unit.path !== ".") || (detail?.fileCount ?? 0) >= 200;
    return { sourceId, units, significant, fileCount: detail?.fileCount ?? 0 };
  }).sort((a, b) => Number(b.significant) - Number(a.significant) || b.units.length - a.units.length || b.fileCount - a.fileCount || a.sourceId.localeCompare(b.sourceId));

  const significant = ranked.filter((entry) => entry.significant);
  // Reserve one source-survey slot for the deterministic shared group whenever
  // not every source fits its own lane.
  const needsSharedGroup = ranked.length > Math.min(significant.length, MAX_SOURCE_SURVEY_TASKS);
  const directCapacity = needsSharedGroup ? MAX_SOURCE_SURVEY_TASKS - 1 : MAX_SOURCE_SURVEY_TASKS;
  const selected = significant.slice(0, directCapacity);
  if (selected.length === 0 && ranked.length > 0) selected.push(ranked[0]!);
  const selectedIds = new Set(selected.map((entry) => entry.sourceId));
  const remaining = ranked.filter((entry) => !selectedIds.has(entry.sourceId));

  const waveOne = selected.map((entry) => ({
    id: `source:${taskSlug(entry.sourceId)}`,
    label: `source:${entry.sourceId}`,
    role: "source-researcher" as const,
    sourceIds: [entry.sourceId],
    unitIds: entry.units.map((unit) => unit.id),
    outputRelativePath: join("discovery", "sources", `${taskSlug(entry.sourceId)}.md`),
  }));

  if (remaining.length > 0) {
    const remainingIds = remaining.map((entry) => entry.sourceId).sort((a, b) => a.localeCompare(b));
    const remainingUnits = unitsForSources(inventory, remainingIds);
    waveOne.push({
      id: "source:shared",
      label: "source:shared",
      role: "source-researcher",
      sourceIds: remainingIds,
      unitIds: remainingUnits.map((unit) => unit.id),
      outputRelativePath: join("discovery", "sources", "shared.md"),
    });
  }

  if (waveOne.length === 0) {
    waveOne.push({
      id: "source:workspace",
      label: "source:workspace",
      role: "source-researcher",
      sourceIds: [],
      unitIds: inventory.units.map((unit) => unit.id),
      outputRelativePath: join("discovery", "sources", "workspace.md"),
    });
  }

  const allSources = sourceIds.length > 0 ? sourceIds : [];
  const integration = allSources.length >= 2
    ? {
        id: "integration",
        label: "cross-source-integration",
        role: "integration-researcher" as const,
        sourceIds: allSources,
        unitIds: inventory.units.map((unit) => unit.id),
        outputRelativePath: join("discovery", "integration.md"),
      }
    : undefined;
  return { waveOne, integration };
}

/** Deep research follows inventory surfaces/domains and remains bounded by host policy. */
export function buildEvidenceTasks(inventory: LoadedInventory): EvidenceTask[] {
  const candidates: Array<{ sourceIds: string[]; unitIds: string[]; label: string }> = [];
  for (const sourceId of sourceIdsForInventory(inventory)) {
    const units = unitsForSources(inventory, [sourceId]);
    const surfaces = units.filter((unit) => unit.path && unit.path !== ".");
    if (surfaces.length > 0) {
      for (const unit of surfaces) {
        candidates.push({ sourceIds: [sourceId], unitIds: [unit.id], label: `${sourceId}:${unit.path}` });
      }
    } else {
      candidates.push({ sourceIds: [sourceId], unitIds: units.map((unit) => unit.id), label: sourceId });
    }
  }
  if (candidates.length === 0) {
    candidates.push({ sourceIds: [], unitIds: inventory.units.map((unit) => unit.id), label: "workspace" });
  }
  candidates.sort((a, b) => a.label.localeCompare(b.label));
  const direct = candidates.slice(0, MAX_EVIDENCE_TASKS);
  const remaining = candidates.slice(MAX_EVIDENCE_TASKS);
  if (remaining.length > 0) {
    const finalDirect = direct[direct.length - 1]!;
    direct[direct.length - 1] = {
      sourceIds: [...new Set([finalDirect, ...remaining].flatMap((entry) => entry.sourceIds))].sort((a, b) => a.localeCompare(b)),
      unitIds: [finalDirect, ...remaining].flatMap((entry) => entry.unitIds),
      label: `shared-${taskSlug(finalDirect.label)}-and-remaining-scopes`,
    };
  }
  return direct.map((entry, index) => ({
    id: `evidence:${taskSlug(entry.label)}`,
    label: `evidence:${entry.label}`,
    sourceIds: entry.sourceIds,
    unitIds: entry.unitIds,
    outputRelativePath: join("evidence", `${String(index + 1).padStart(2, "0")}-${taskSlug(entry.label)}.md`),
  }));
}

function addUsage(left: WikiTokenUsage | undefined, right: WikiTokenUsage): WikiTokenUsage {
  return {
    input: (left?.input ?? 0) + right.input,
    output: (left?.output ?? 0) + right.output,
    cacheRead: (left?.cacheRead ?? 0) + right.cacheRead,
    cacheWrite: (left?.cacheWrite ?? 0) + right.cacheWrite,
    total: (left?.total ?? 0) + right.total,
  };
}

function updateObservationProjection(ctx: WikiPathContext, agentId: string, entry: Parameters<NonNullable<WikiAgentRunRequest["onHistory"]>>[0]): void {
  const existing = ctx.store.getSnapshot().agents.find((agent) => agent.agentId === agentId);
  const update: { agentId: string; lastHeartbeatAt: number; latestUsage?: WikiTokenUsage; tokenUsage?: WikiTokenUsage; context?: WikiContextUsage; lastTool?: { name: string; path?: string; at: number }; activity?: WikiAgentActivity; compactionCount?: number } = {
    agentId,
    lastHeartbeatAt: entry.timestamp,
  };
  if (entry.usage) {
    update.latestUsage = entry.usage;
    update.tokenUsage = addUsage(existing?.tokenUsage, entry.usage);
  }
  if (entry.context) update.context = entry.context;
  if (entry.kind === "tool_start" || entry.kind === "tool_end") {
    update.lastTool = { name: entry.toolName ?? "tool", path: entry.path, at: entry.timestamp };
  }
  if (entry.kind === "retry_start") {
    update.activity = { kind: "retrying", at: entry.timestamp, attempt: entry.attempt, maxAttempts: entry.maxAttempts, delayMs: entry.delayMs, message: entry.error };
  } else if (entry.kind === "compaction_start") {
    update.activity = { kind: "compacting", at: entry.timestamp, reason: entry.reason };
  } else if (entry.kind === "retry_end" || entry.kind === "compaction_end") {
    update.activity = undefined;
    if (entry.kind === "compaction_end" && !entry.aborted) update.compactionCount = (existing?.compactionCount ?? 0) + 1;
  }
  ctx.store.upsertAgent(update);
}

function runAgent(
  ctx: WikiPathContext,
  runner: WikiAgentRunner,
  details: Pick<WikiAgentRunRequest, "agentId" | "label" | "phase" | "role" | "prompt" | "unitIds">,
): Promise<WikiAgentRunResult | null> {
  const startedAt = Date.now();
  ctx.store.upsertAgent({
    ...details,
    status: "running",
    startedAt,
    lastHeartbeatAt: startedAt,
    sessionKey: details.role === "main" ? ctx.paths.sessionDir : undefined,
  });
  ctx.store.appendEvent("agent.started", { agentId: details.agentId, phase: details.phase });

  return runner.run({
    ...details,
    signal: ctx.signal,
    tools: ctx.toolsForRole(details.role),
    cwd: ctx.cwd,
    onHistory: (entry) => {
      ctx.store.appendTranscript(details.agentId, entry);
      updateObservationProjection(ctx, details.agentId, entry);
    },
  }).then(
    (result) => {
      if (ctx.signal.aborted) {
        const error = new Error("Agent run was cancelled");
        error.name = "AbortError";
        ctx.store.upsertAgent({ agentId: details.agentId, status: "cancelled", endedAt: Date.now(), elapsedMs: Date.now() - startedAt, lastError: error.message });
        ctx.store.appendEvent("agent.cancelled", { agentId: details.agentId, phase: details.phase });
        throw error;
      }
      const failed = !result || result.status === "failed" || result.status === "blocked";
      ctx.store.upsertAgent({
        agentId: details.agentId,
        status: failed ? "failed" : "succeeded",
        endedAt: Date.now(),
        elapsedMs: Date.now() - startedAt,
        lastError: failed ? result?.summary ?? "Agent returned no result" : undefined,
      });
      ctx.store.appendEvent(failed ? "agent.failed" : "agent.succeeded", { agentId: details.agentId, phase: details.phase, detail: { summary: result?.summary } });
      return result;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.store.upsertAgent({ agentId: details.agentId, status: ctx.signal.aborted ? "cancelled" : "failed", endedAt: Date.now(), elapsedMs: Date.now() - startedAt, lastError: message });
      ctx.store.appendEvent(ctx.signal.aborted ? "agent.cancelled" : "agent.failed", { agentId: details.agentId, phase: details.phase, detail: { error: message } });
      throw error;
    },
  );
}

function promptPaths(paths: WikiRunPaths): string {
  return [
    `Frozen sources: ${paths.sourcesDir}`,
    `Deterministic inventory: ${join(paths.inputsDir, "inventory.json")}`,
    `Analysis directory: ${paths.analysisDir}`,
    `Final OKF bundle: ${paths.bundleDir}`,
  ].join("\n");
}

function methodPath(paths: WikiRunPaths, file: "discover.md" | "plan.md" | "generate.md" | "review.md"): string {
  return join(paths.inputsDir, "..", "method", "references", file);
}

function methodContractPath(paths: WikiRunPaths): string {
  return join(paths.inputsDir, "..", "method", "METHOD.md");
}

function markdownAt(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function qualityContract(): string {
  return [
    "Write exactly one non-empty top-level line for each required field:",
    "Verdict: PASS|FAIL",
    "Affected pages: comma-separated paths, or none",
    "Findings: concise source-grounded findings, or none",
    "Required repair: concrete repair, or none",
    "PASS means no actionable defect remains. FAIL must give source-grounded, actionable repairs. Do not return JSON.",
  ].join("\n");
}

function parseQualityReport(id: string, path: string): QualityReport {
  const text = markdownAt(path);
  if (!text) return { id, path, verdict: "FAIL", findings: 1, blocked: true, error: "Required report was not written" };
  const verdict = /^Verdict:\s*(PASS|FAIL)\s*$/im.exec(text)?.[1] as "PASS" | "FAIL" | undefined;
  const affectedPages = /^Affected pages:\s*(.+?)\s*$/im.exec(text)?.[1];
  const findings = /^Findings:\s*(.+?)\s*$/im.exec(text)?.[1];
  const requiredRepair = /^Required repair:\s*(.+?)\s*$/im.exec(text)?.[1];
  if (!verdict || !affectedPages || !findings || !requiredRepair) {
    return { id, path, verdict: "FAIL", findings: 1, blocked: true, error: "Report does not satisfy the required quality-report format" };
  }
  const findingCount = /^none$/i.test(findings.trim()) ? 0 : findings.split(/[;|]/).filter((item) => item.trim().length > 0).length;
  return { id, path, verdict, findings: findingCount, blocked: false };
}

function qualitySummary(reports: readonly QualityReport[]): WikiQualitySummary {
  const passed = reports.filter((report) => report.verdict === "PASS").length;
  const failed = reports.length - passed;
  const blocked = reports.filter((report) => report.blocked).length;
  return {
    verdict: failed > 0 ? (blocked > 0 ? "blocked" : "failed") : "passed",
    passed,
    failed,
    blocked,
    findings: reports.reduce((total, report) => total + report.findings, 0),
  };
}

function setQualitySummary(ctx: WikiPathContext, reports: readonly QualityReport[], fallback: WikiQualitySummary["verdict"] = "pending"): void {
  ctx.store.updateSnapshot((snapshot) => {
    snapshot.qualitySummary = reports.length > 0 ? qualitySummary(reports) : { verdict: fallback, passed: 0, failed: 0, blocked: 0, findings: 0 };
  });
}

async function failQualityGate(ctx: WikiPathContext, phase: string, summary: string, reports: readonly QualityReport[]): Promise<WikiPathResult> {
  setPhaseStatus(ctx.store, phase, "failed", summary);
  setQualitySummary(ctx, reports);
  ctx.store.setOverall("quality_blocked");
  await ctx.core.setRunStatus(ctx.workspaceRoot, {
    runId: ctx.runId,
    status: "quality_blocked",
    sessionPath: ctx.sessionPath,
    error: summary,
  }).catch(() => undefined);
  return { status: "quality_blocked", runId: ctx.runId, summary, error: summary };
}

async function assertAgentOk(result: WikiAgentRunResult | null, error: string): Promise<void> {
  if (!result || result.status === "failed" || result.status === "blocked") throw new Error(result?.summary ?? error);
}

async function runSurvey(ctx: WikiPathContext, inventory: LoadedInventory): Promise<void> {
  const graph = buildSurveyTaskGraph(inventory);
  setPhaseStatus(ctx.store, "Survey", "active", `${graph.waveOne.length} source task(s) planned.`);
  const waveOne = graph.waveOne.map((task) => ctx.pool.run(async () => {
    throwIfAborted(ctx.signal);
    const output = join(ctx.paths.analysisDir, task.outputRelativePath);
    const result = await runAgent(ctx, ctx.createEphemeralAgent(task.role), {
      agentId: task.id,
      label: task.label,
      phase: "Survey",
      role: task.role,
      unitIds: task.unitIds,
      prompt: [
        "Act as an independent source-level repository researcher.",
        promptPaths(ctx.paths),
        `Before inspecting sources, read ${methodContractPath(ctx.paths)} and ${methodPath(ctx.paths, "discover.md")}.`,
        `Inspect the frozen source scope(s): ${task.sourceIds.join(", ") || "workspace"}; assigned coverage units: ${task.unitIds.join(", ") || "all available units"}.`,
        `Create parent directories if needed and write one concise source evidence brief to ${output}.`,
        "Include boundaries, entry points, runtime/data state, dependencies, tests, and candidate domain/concept relationships. Do not write the plan or bundle. Do not return JSON.",
      ].join("\n\n"),
    });
    await assertAgentOk(result, "Source survey agent failed");
  }, { timeoutMs: ctx.limits.agentTimeoutMs, label: task.label }));
  const firstWave = await Promise.allSettled(waveOne);
  const failures = firstWave.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    setPhaseStatus(ctx.store, "Survey", "failed", `${failures.length} source survey task(s) failed.`);
    throw new Error(failures.map((failure) => String(failure.reason)).join("; "));
  }

  if (graph.integration) {
    const task = graph.integration;
    const output = join(ctx.paths.analysisDir, task.outputRelativePath);
    const result = await ctx.pool.run(async () => {
      throwIfAborted(ctx.signal);
      return runAgent(ctx, ctx.createEphemeralAgent(task.role), {
        agentId: task.id,
        label: task.label,
        phase: "Survey",
        role: task.role,
        unitIds: task.unitIds,
        prompt: [
          "Act as the cross-source integration researcher. The source-level briefs are complete.",
          promptPaths(ctx.paths),
          `Read every source brief under ${join(ctx.paths.analysisDir, "discovery", "sources")}, the frozen sources, and ${methodContractPath(ctx.paths)}.`,
          `Analyze cross-source calls, data/configuration boundaries, deployment relationships, and ownership gaps for: ${task.sourceIds.join(", ")}.`,
          `Write one integration brief to ${output}. Do not write plan.md or bundle files. Do not return JSON.`,
        ].join("\n\n"),
      });
    }, { timeoutMs: ctx.limits.agentTimeoutMs, label: task.label });
    await assertAgentOk(result, "Cross-source integration research failed");
  }
  setPhaseStatus(ctx.store, "Survey", "done", `${graph.waveOne.length} source brief(s)${graph.integration ? " and one integration brief" : ""} written.`);
}

async function runEvidence(ctx: WikiPathContext, inventory: LoadedInventory): Promise<void> {
  const tasks = buildEvidenceTasks(inventory);
  setPhaseStatus(ctx.store, "Evidence", "active", `${tasks.length} deep-research scope(s) planned.`);
  const settled = await Promise.allSettled(tasks.map((task) => ctx.pool.run(async () => {
    throwIfAborted(ctx.signal);
    const output = join(ctx.paths.analysisDir, task.outputRelativePath);
    const result = await runAgent(ctx, ctx.createEphemeralAgent("evidence-researcher"), {
      agentId: task.id,
      label: task.label,
      phase: "Evidence",
      role: "evidence-researcher",
      unitIds: task.unitIds,
      prompt: [
        "Act as a read-only deep evidence researcher for the proposed repository Wiki.",
        promptPaths(ctx.paths),
        `Read ${join(ctx.paths.analysisDir, "plan.md")}, source discovery briefs, and frozen sources for source(s) ${task.sourceIds.join(", ") || "workspace"}, coverage units ${task.unitIds.join(", ") || "all"}.`,
        `Create parent directories if needed and write the evidence brief to ${output}.`,
        "For each relevant domain/concept, give source paths, entry points, state/data changes, failure/retry paths, upstream/downstream dependencies, focused tests, affected pages, and `diagram: required|useful|omitted` with a grounded Mermaid candidate when required. Do not edit the plan or bundle. Do not return JSON.",
      ].join("\n\n"),
    });
    await assertAgentOk(result, "Evidence researcher failed");
  }, { timeoutMs: ctx.limits.agentTimeoutMs, label: task.label })));
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    setPhaseStatus(ctx.store, "Evidence", "failed", `${failures.length} evidence task(s) failed.`);
    throw new Error(failures.map((failure) => String(failure.reason)).join("; "));
  }
  setPhaseStatus(ctx.store, "Evidence", "done", `${tasks.length} evidence brief(s) written.`);
}

async function runMain(ctx: WikiPathContext, phase: string, prompt: string): Promise<WikiAgentRunResult | null> {
  return runAgent(ctx, ctx.mainAgent, {
    agentId: "main",
    label: "main-agent",
    phase,
    role: "main",
    prompt,
  });
}

async function runCoverage(ctx: WikiPathContext): Promise<WikiPathResult | undefined> {
  const initialPath = join(ctx.paths.analysisDir, "coverage-review.md");
  const verificationPath = join(ctx.paths.analysisDir, "reviews", "coverage-rereview.md");
  setPhaseStatus(ctx.store, "Coverage initial", "active");
  const initial = await runAgent(ctx, ctx.createEphemeralAgent("coverage-critic"), {
    agentId: "coverage:initial",
    label: "coverage-critic:initial",
    phase: "Coverage initial",
    role: "coverage-critic",
    prompt: [
      "Independently map the frozen repository before auditing the proposed Wiki plan. Do not trust the plan's coverage claims.",
      promptPaths(ctx.paths),
      `Read ${methodContractPath(ctx.paths)}, ${methodPath(ctx.paths, "plan.md")}, ${join(ctx.paths.analysisDir, "plan.md")}, evidence briefs, inventory, and frozen sources.`,
      `Create parent directories if needed and write the report to ${initialPath}.`,
      qualityContract(),
      "Do not edit plan.md or bundle files.",
    ].join("\n\n"),
  });
  await assertAgentOk(initial, "Initial coverage critic failed");
  const initialReport = parseQualityReport("coverage-initial", initialPath);
  setQualitySummary(ctx, [initialReport]);
  setPhaseStatus(ctx.store, "Coverage initial", "done", initialReport.verdict === "PASS" ? "Initial coverage audit passed." : "Initial coverage findings require plan revision.");

  setPhaseStatus(ctx.store, "Coverage revision", "active");
  const revision = await runMain(ctx, "Coverage revision", [
    `Read ${initialPath}, all evidence briefs, and revise ${join(ctx.paths.analysisDir, "plan.md")} to address every justified coverage finding.`,
    `Keep ${methodContractPath(ctx.paths)} and ${methodPath(ctx.paths, "plan.md")} as controlling contracts.`,
    "The plan must include a source-grounded page matrix, evidence-brief references, cross-domain links, and an explicit diagram decision for each flow-heavy page. Do not write bundle pages.",
  ].join("\n\n"));
  await assertAgentOk(revision, "Coverage plan revision failed");
  setPhaseStatus(ctx.store, "Coverage revision", "done", revision?.summary ?? "Plan revised after initial coverage audit.");

  setPhaseStatus(ctx.store, "Coverage verification", "active");
  const verification = await runAgent(ctx, ctx.createEphemeralAgent("coverage-critic"), {
    agentId: "coverage:verification",
    label: "coverage-critic:verification",
    phase: "Coverage verification",
    role: "coverage-critic",
    prompt: [
      "Re-audit only unresolved or newly introduced gaps after the bounded plan revision. This is the final coverage pass; do not request another review loop.",
      promptPaths(ctx.paths),
      `Read ${initialPath}, ${join(ctx.paths.analysisDir, "plan.md")}, evidence briefs, inventory, and frozen sources.`,
      `Write the verification report to ${verificationPath}.`,
      qualityContract(),
      "Do not edit plan.md or bundle files.",
    ].join("\n\n"),
  });
  await assertAgentOk(verification, "Coverage verification critic failed");
  const verificationReport = parseQualityReport("coverage-verification", verificationPath);
  if (verificationReport.verdict === "FAIL") {
    setQualitySummary(ctx, [initialReport, verificationReport]);
    return failQualityGate(ctx, "Coverage verification", "Coverage verification failed after the bounded plan revision.", [initialReport, verificationReport]);
  }
  // The initial audit may intentionally find gaps. The proposal-facing verdict is
  // determined solely by the bounded verification after the main revision.
  setQualitySummary(ctx, [verificationReport]);
  setPhaseStatus(ctx.store, "Coverage verification", "done", "Coverage passed after one bounded revision.");
  const planPreview = markdownAt(join(ctx.paths.analysisDir, "plan.md"));
  ctx.store.updateSnapshot((snapshot) => {
    snapshot.planPreview = planPreview;
    snapshot.planSummary = "Plan, evidence matrix, and two-pass coverage review passed.";
  });
  return undefined;
}

async function runPlan(ctx: WikiPathContext): Promise<"proposed" | "writing" | WikiPathResult> {
  const inventory = loadInventory(ctx.paths.inputsDir);
  await runSurvey(ctx, inventory);
  setPhaseStatus(ctx.store, "Plan", "active");
  const planned = await runMain(ctx, "Plan", [
    "You are the persistent main agent for an OKF repository Wiki.",
    promptPaths(ctx.paths),
    `Before planning, read ${methodContractPath(ctx.paths)} and ${methodPath(ctx.paths, "plan.md")}.`,
    "Read the inventory, all source briefs, any integration brief, and relevant frozen sources.",
    `Write the authoritative Markdown plan to ${join(ctx.paths.analysisDir, "plan.md")}.`,
    "The plan must describe a domain -> concept hierarchy, source-grounded coverage, cross-domain flows, explicit exclusions, a page matrix, and a diagram decision for flow-heavy pages. Do not write bundle pages or JSON handoffs.",
    ctx.focus ? `Requested focus: ${ctx.focus}` : "",
  ].filter(Boolean).join("\n\n"));
  await assertAgentOk(planned, "Planning failed");
  setPhaseStatus(ctx.store, "Plan", "done", planned?.summary ?? "Initial plan written.");

  await runEvidence(ctx, inventory);
  setPhaseStatus(ctx.store, "Evidence synthesis", "active");
  const synthesis = await runMain(ctx, "Evidence synthesis", [
    `Read every evidence brief under ${join(ctx.paths.analysisDir, "evidence")} and integrate their verified source paths, tests, state transitions, cross-links, and diagram decisions into ${join(ctx.paths.analysisDir, "plan.md")}.`,
    "Retain only source-grounded claims. The revised plan is still a proposal; do not write bundle pages.",
  ].join("\n\n"));
  await assertAgentOk(synthesis, "Evidence synthesis failed");
  setPhaseStatus(ctx.store, "Evidence synthesis", "done", synthesis?.summary ?? "Evidence integrated into plan.");

  const coverageResult = await runCoverage(ctx);
  if (coverageResult) return coverageResult;
  const result = await ctx.core.completeRunPlanning(ctx.workspaceRoot, { runId: ctx.runId, sessionPath: ctx.sessionPath });
  if (!result || result.ok === false) throw new Error("The core rejected the completed Wiki plan");
  return result.requiresApproval ? "proposed" : "writing";
}

function reviewPath(ctx: WikiPathContext, task: ReviewTask): string {
  return join(ctx.paths.analysisDir, task.outputRelativePath);
}

async function runReviewTask(ctx: WikiPathContext, task: ReviewTask, phase: string, previous?: QualityReport): Promise<QualityReport> {
  const output = reviewPath(ctx, task);
  const result = await runAgent(ctx, ctx.createEphemeralAgent(task.role), {
    agentId: `review:${task.id}${previous ? ":verification" : ""}`,
    label: `${task.label}${previous ? ":verification" : ""}`,
    phase,
    role: task.role,
    prompt: [
      `Independently review this generated OKF Wiki for ${task.focus}.`,
      promptPaths(ctx.paths),
      `Read ${methodContractPath(ctx.paths)}, ${methodPath(ctx.paths, "review.md")}, frozen sources, and the complete bundle.`,
      previous ? `This is a bounded verification of the earlier failed report:\n${markdownAt(previous.path) ?? previous.error ?? "missing prior report"}` : "",
      `Create parent directories if needed and write the report to ${output}.`,
      qualityContract(),
      "Do not edit analysis, plan, or bundle files.",
    ].filter(Boolean).join("\n\n"),
  });
  await assertAgentOk(result, `${task.label} failed`);
  return parseQualityReport(`review-${task.id}`, output);
}

async function runQuestionFinder(ctx: WikiPathContext, phase: string, previous?: QualityReport): Promise<QualityReport> {
  const output = join(ctx.paths.analysisDir, "qa", "questions.md");
  const result = await runAgent(ctx, ctx.createEphemeralAgent("qa-question-finder"), {
    agentId: `qa:questions${previous ? ":verification" : ""}`,
    label: `qa-question-finder${previous ? ":verification" : ""}`,
    phase,
    role: "qa-question-finder",
    prompt: [
      "Generate realistic reader questions from the frozen repository and tests only. Do not inspect the generated Wiki.",
      promptPaths(ctx.paths),
      previous ? `The previous question-set report failed:\n${markdownAt(previous.path) ?? previous.error ?? "missing prior report"}` : "",
      `Create parent directories if needed and write 6-10 source-grounded questions, expected answer evidence, and the report fields to ${output}.`,
      qualityContract(),
      "Do not edit plan or bundle files.",
    ].filter(Boolean).join("\n\n"),
  });
  await assertAgentOk(result, "Question finder failed");
  return parseQualityReport("qa-questions", output);
}

async function runAnswerVerifier(ctx: WikiPathContext, phase: string, previous?: QualityReport): Promise<QualityReport> {
  const questionsPath = join(ctx.paths.analysisDir, "qa", "questions.md");
  const output = join(ctx.paths.analysisDir, "reviews", "reader-qa.md");
  const questions = markdownAt(questionsPath);
  if (!questions) return { id: "qa-answers", path: output, verdict: "FAIL", findings: 1, blocked: true, error: "Question set is unavailable" };
  const result = await runAgent(ctx, ctx.createEphemeralAgent("qa-answer-verifier"), {
    agentId: `qa:answers${previous ? ":verification" : ""}`,
    label: `qa-answer-verifier${previous ? ":verification" : ""}`,
    phase,
    role: "qa-answer-verifier",
    prompt: [
      "Answer and verify the supplied reader questions using only the generated Wiki bundle. Do not inspect frozen source files.",
      `Final OKF bundle: ${ctx.paths.bundleDir}`,
      `Reader questions:\n${questions}`,
      previous ? `Verify only prior failed answers where possible:\n${markdownAt(previous.path) ?? previous.error ?? "missing prior report"}` : "",
      `Create parent directories if needed and write the report to ${output}.`,
      qualityContract(),
      "Do not edit plan or bundle files.",
    ].filter(Boolean).join("\n\n"),
  });
  await assertAgentOk(result, "Answer verifier failed");
  return parseQualityReport("qa-answers", output);
}

async function runInitialReviews(ctx: WikiPathContext): Promise<QualityReport[]> {
  setPhaseStatus(ctx.store, "Review", "active");
  const reviewers = REVIEW_TASKS.map((task) => ctx.pool.run(() => runReviewTask(ctx, task, "Review"), { timeoutMs: ctx.limits.agentTimeoutMs, label: task.label }));
  const questionFinder = ctx.pool.run(() => runQuestionFinder(ctx, "Review"), { timeoutMs: ctx.limits.agentTimeoutMs, label: "qa-question-finder" });
  const settled = await Promise.allSettled([...reviewers, questionFinder]);
  const reports: QualityReport[] = [];
  const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected.length > 0) throw new Error(rejected.map((result) => String(result.reason)).join("; "));
  for (const result of settled.filter((entry): entry is PromiseFulfilledResult<QualityReport> => entry.status === "fulfilled")) {
    reports.push(result.value);
  }
  const questions = reports.find((report) => report.id === "qa-questions");
  if (questions?.verdict === "PASS") {
    reports.push(await ctx.pool.run(() => runAnswerVerifier(ctx, "Review"), { timeoutMs: ctx.limits.agentTimeoutMs, label: "qa-answer-verifier" }));
  } else {
    reports.push({ id: "qa-answers", path: join(ctx.paths.analysisDir, "reviews", "reader-qa.md"), verdict: "FAIL", findings: 1, blocked: true, error: "Question finder did not produce a valid question set" });
  }
  setQualitySummary(ctx, reports);
  setPhaseStatus(ctx.store, "Review", "done", `${reports.filter((report) => report.verdict === "FAIL").length} review/QA report(s) require repair.`);
  return reports;
}

async function runVerification(ctx: WikiPathContext, failed: readonly QualityReport[]): Promise<QualityReport[]> {
  setPhaseStatus(ctx.store, "Verification", "active", `Re-running ${failed.length} failed quality check(s) only.`);
  const byId = new Map(failed.map((report) => [report.id, report]));
  const reviewers = REVIEW_TASKS.filter((task) => byId.has(`review-${task.id}`)).map((task) => ctx.pool.run(
    () => runReviewTask(ctx, task, "Verification", byId.get(`review-${task.id}`)),
    { timeoutMs: ctx.limits.agentTimeoutMs, label: `${task.label}:verification` },
  ));
  const questionFailure = byId.get("qa-questions");
  const questions = questionFailure
    ? ctx.pool.run(() => runQuestionFinder(ctx, "Verification", questionFailure), { timeoutMs: ctx.limits.agentTimeoutMs, label: "qa-question-finder:verification" })
    : undefined;
  const settled = await Promise.allSettled([...reviewers, ...(questions ? [questions] : [])]);
  const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected.length > 0) throw new Error(rejected.map((result) => String(result.reason)).join("; "));
  const reports = settled
    .filter((entry): entry is PromiseFulfilledResult<QualityReport> => entry.status === "fulfilled")
    .map((entry) => entry.value);
  const answerFailure = byId.get("qa-answers");
  const refreshedQuestions = reports.find((report) => report.id === "qa-questions");
  if (answerFailure || refreshedQuestions) {
    reports.push(await ctx.pool.run(
      () => runAnswerVerifier(ctx, "Verification", answerFailure),
      { timeoutMs: ctx.limits.agentTimeoutMs, label: "qa-answer-verifier:verification" },
    ));
  }
  setQualitySummary(ctx, reports);
  const remaining = reports.filter((report) => report.verdict === "FAIL").length;
  setPhaseStatus(ctx.store, "Verification", remaining > 0 ? "failed" : "done", remaining > 0 ? `${remaining} bounded verification check(s) still failed.` : "All previously failed checks passed.");
  return reports;
}

async function runWriteReviewValidate(ctx: WikiPathContext): Promise<WikiPathResult> {
  setPhaseStatus(ctx.store, "Write", "active");
  const write = await runMain(ctx, "Write", [
    "Continue the same OKF Wiki run using the persisted, approved plan.",
    promptPaths(ctx.paths),
    `Before writing, read ${methodContractPath(ctx.paths)} and ${methodPath(ctx.paths, "generate.md")}.`,
    `Read ${join(ctx.paths.analysisDir, "plan.md")} and all evidence briefs. Write the complete source-grounded OKF bundle beneath ${ctx.paths.bundleDir}.`,
    "Implement every required diagram decision with grounded Mermaid. Use valid YAML frontmatter and Markdown links. Do not create JSON handoffs or agent-authored indexes.",
  ].join("\n\n"));
  await assertAgentOk(write, "Wiki writing failed");
  setPhaseStatus(ctx.store, "Write", "done", write?.summary ?? "Bundle drafted.");

  const initialReports = await runInitialReviews(ctx);
  const failed = initialReports.filter((report) => report.verdict === "FAIL");
  if (failed.length > 0) {
    setPhaseStatus(ctx.store, "Repair", "active");
    const repair = await runMain(ctx, "Repair", [
      `Read these independent review reports and repair every justified issue in ${ctx.paths.bundleDir}:`,
      ...failed.map((report) => `- ${report.path}`),
      `Use ${methodContractPath(ctx.paths)} and ${methodPath(ctx.paths, "generate.md")} while repairing.`,
      "Preserve hierarchy and source grounding. This is the one repair pass; do not create reports, JSON artifacts, or a new review loop.",
    ].join("\n\n"));
    await assertAgentOk(repair, "Bundle repair failed");
    setPhaseStatus(ctx.store, "Repair", "done", repair?.summary ?? "Bundle repaired after quality findings.");
    const verification = await runVerification(ctx, failed);
    if (verification.some((report) => report.verdict === "FAIL")) {
      return failQualityGate(ctx, "Verification", "Bounded verification still has failing quality checks; review reports before resuming.", verification);
    }
  } else {
    setPhaseStatus(ctx.store, "Repair", "skipped", "No quality findings required repair.");
    setPhaseStatus(ctx.store, "Verification", "skipped", "All initial quality checks passed.");
  }

  setPhaseStatus(ctx.store, "Validate", "active");
  await ctx.core.setRunStatus(ctx.workspaceRoot, { runId: ctx.runId, status: "validating", sessionPath: ctx.sessionPath });
  const validation = await ctx.core.validateRunBundle(ctx.workspaceRoot, { runId: ctx.runId });
  if (!hostOk(validation)) {
    const report: QualityReport = { id: "deterministic-validation", path: join(ctx.paths.bundleDir), verdict: "FAIL", findings: 1, blocked: true, error: (validation as { error?: string } | undefined)?.error ?? "Deterministic bundle validation failed" };
    return failQualityGate(ctx, "Validate", report.error!, [report]);
  }
  setQualitySummary(ctx, [] , "passed");
  setPhaseStatus(ctx.store, "Validate", "done", "Bundle validated and sealed.");
  return { status: "completed", runId: ctx.runId, summary: "OKF Wiki bundle validated and sealed." };
}

/** Execute planning, then either wait for approval or continue in the same main session. */
export async function runWikiPath(ctx: WikiPathContext, options: { start: "planning" | "writing" }): Promise<WikiPathResult> {
  try {
    throwIfAborted(ctx.signal);
    if (options.start === "planning") {
      const next = await runPlan(ctx);
      if (typeof next !== "string") return next;
      if (next === "proposed") return { status: "proposed", runId: ctx.runId, summary: "Plan proposed; review it in /wiki and approve when ready." };
    }
    return await runWriteReviewValidate(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!ctx.signal.aborted) {
      await ctx.core.setRunStatus(ctx.workspaceRoot, { runId: ctx.runId, status: "failed", sessionPath: ctx.sessionPath, error: message }).catch(() => undefined);
    }
    return { status: "failed", runId: ctx.runId, error: message, summary: message };
  }
}
