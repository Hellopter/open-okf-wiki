/**
 * Markdown-first Wiki workflow.
 *
 * The main agent keeps one persisted Pi session. Discovery and reviews are
 * deliberately independent, short-lived agents; their only handoffs are small
 * Markdown files in `analysis/`. The core owns run state and deterministic
 * bundle validation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CoreAdapter, WikiRunPaths } from "../core-adapter.js";
import type { WikiAgentRunRequest, WikiAgentRunResult, WikiAgentRunner } from "./agent-runner.js";
import type { TaskPool } from "./pool.js";
import type { WikiRunStore } from "./store.js";
import type { OrchLimits, WikiPhaseStatus } from "./types.js";

export interface CoverageUnit {
  id: string;
  sourceId?: string;
  path?: string;
  required?: boolean;
  [key: string]: unknown;
}

export interface LoadedInventory {
  units: CoverageUnit[];
  sourceRoots: number;
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
  createEphemeralAgent: (role: "discover" | "coverage-critic" | "reviewer") => WikiAgentRunner;
  toolsForRole: (role: "main" | "discover" | "coverage-critic" | "reviewer") => ToolDefinition[];
  cwd: string;
  limits: OrchLimits;
  signal: AbortSignal;
}

export interface WikiPathResult {
  status: "completed" | "proposed" | "failed" | "blocked";
  runId: string;
  summary?: string;
  error?: string;
}

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
  return result.ok === true || result.status === "ok" || result.status === "completed";
}

/** Set phase status and emit the matching observation event. */
export function setPhaseStatus(store: WikiRunStore, name: string, status: WikiPhaseStatus, summary?: string): void {
  store.setPhase(name, status, summary);
  if (status === "active") store.appendEvent("phase.started", { phase: name });
  else if (status === "done") store.appendEvent("phase.completed", { phase: name, detail: summary ? { summary } : undefined });
  else if (status === "failed") store.appendEvent("phase.failed", { phase: name, detail: summary ? { summary } : undefined });
}

/** Read only the deterministic inventory needed to decide whether breadth research is useful. */
export function loadInventory(inputsDir: string): LoadedInventory {
  const inventoryPath = join(inputsDir, "inventory.json");
  if (!existsSync(inventoryPath)) return { units: [], sourceRoots: 0 };
  try {
    const raw = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
      coverageUnits?: unknown;
      units?: unknown;
      sources?: unknown;
    };
    const units = Array.isArray(raw.coverageUnits)
      ? raw.coverageUnits.filter((item): item is CoverageUnit => Boolean(item && typeof item === "object" && typeof (item as CoverageUnit).id === "string"))
      : Array.isArray(raw.units)
        ? raw.units.filter((item): item is CoverageUnit => Boolean(item && typeof item === "object" && typeof (item as CoverageUnit).id === "string"))
        : [];
    const sourceIds = new Set(units.map((unit) => unit.sourceId).filter((id): id is string => Boolean(id)));
    const sourceRoots = Array.isArray(raw.sources) ? raw.sources.length : sourceIds.size;
    return { units, sourceRoots };
  } catch {
    return { units: [], sourceRoots: 0 };
  }
}

/** Round-robin split keeps independent discovery scopes balanced without a planner JSON artifact. */
export function shardUnits<T>(units: readonly T[], laneCount: number): T[][] {
  const groups: T[][] = Array.from({ length: Math.max(1, laneCount) }, () => []);
  for (let index = 0; index < units.length; index += 1) groups[index % groups.length]!.push(units[index]!);
  return groups.filter((group) => group.length > 0);
}

/** Discovery is for independently inspectable breadth, never for repeated retries. */
export function adaptiveDiscoveryLaneCount(inventory: LoadedInventory): number {
  if (inventory.units.length <= 12 && inventory.sourceRoots <= 4) return 0;
  return Math.min(3, Math.max(1, Math.ceil(inventory.units.length / 12)));
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
      ctx.store.upsertAgent({ agentId: details.agentId, lastHeartbeatAt: entry.timestamp });
    },
  }).then(
    (result) => {
      if (ctx.signal.aborted) {
        const error = new Error("Agent run was cancelled");
        error.name = "AbortError";
        ctx.store.upsertAgent({
          agentId: details.agentId,
          status: "cancelled",
          endedAt: Date.now(),
          elapsedMs: Date.now() - startedAt,
          lastError: error.message,
        });
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
      ctx.store.appendEvent(failed ? "agent.failed" : "agent.succeeded", {
        agentId: details.agentId,
        phase: details.phase,
        detail: { summary: result?.summary },
      });
      return result;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.store.upsertAgent({
        agentId: details.agentId,
        status: ctx.signal.aborted ? "cancelled" : "failed",
        endedAt: Date.now(),
        elapsedMs: Date.now() - startedAt,
        lastError: message,
      });
      ctx.store.appendEvent(ctx.signal.aborted ? "agent.cancelled" : "agent.failed", {
        agentId: details.agentId,
        phase: details.phase,
        detail: { error: message },
      });
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

async function runDiscovery(ctx: WikiPathContext, inventory: LoadedInventory): Promise<void> {
  const laneCount = adaptiveDiscoveryLaneCount(inventory);
  if (laneCount === 0) {
    setPhaseStatus(ctx.store, "Discover", "skipped", "Repository size does not need independent breadth research.");
    return;
  }
  setPhaseStatus(ctx.store, "Discover", "active");
  const groups = shardUnits(inventory.units, laneCount);
  const jobs = groups.map((units, index) =>
    ctx.pool.run(
      async () => {
        throwIfAborted(ctx.signal);
        const result = await runAgent(ctx, ctx.createEphemeralAgent("discover"), {
          agentId: `discover:${index + 1}`,
          label: `discover:${index + 1}`,
          phase: "Discover",
          role: "discover",
          unitIds: units.map((unit) => unit.id),
          prompt: [
            "Act as an independent repository researcher.",
            promptPaths(ctx.paths),
            `Before inspecting sources, read ${methodContractPath(ctx.paths)} and ${methodPath(ctx.paths, "discover.md")}.`,
            `Read ${join(ctx.paths.analysisDir, "inventory.md")} and inspect only the assigned coverage units: ${units.map((unit) => unit.id).join(", ")}.`,
            `Write concise evidence and candidate domain/concept relationships to ${join(ctx.paths.analysisDir, "discovery", `lane-${index + 1}.md`)}.`,
            "Do not write the plan or bundle. Do not return JSON; finish only after the Markdown brief is useful to the main agent.",
          ].join("\n\n"),
        });
        if (!result || result.status === "failed" || result.status === "blocked") throw new Error(result?.summary ?? "Discovery agent failed");
      },
      { timeoutMs: ctx.limits.agentTimeoutMs, label: `discover:${index + 1}` },
    ),
  );
  const settled = await Promise.allSettled(jobs);
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    setPhaseStatus(ctx.store, "Discover", "failed", `${failures.length} independent discovery agents failed.`);
    throw new Error(failures.map((failure) => String(failure.reason)).join("; "));
  }
  setPhaseStatus(ctx.store, "Discover", "done", `${groups.length} independent discovery briefs written.`);
}

async function runPlan(ctx: WikiPathContext): Promise<"proposed" | "writing"> {
  await runDiscovery(ctx, loadInventory(ctx.paths.inputsDir));
  setPhaseStatus(ctx.store, "Plan", "active");
  const result = await runAgent(ctx, ctx.mainAgent, {
    agentId: "main",
    label: "main-agent",
    phase: "Plan",
    role: "main",
    prompt: [
      "You are the persistent main agent for an OKF repository Wiki.",
      promptPaths(ctx.paths),
      `Before planning, read ${methodContractPath(ctx.paths)} and ${methodPath(ctx.paths, "plan.md")}.`,
      "Read the inventory, all discovery briefs, and relevant frozen sources.",
      `Write the authoritative Markdown plan to ${join(ctx.paths.analysisDir, "plan.md")}.`,
      "The plan must describe a domain -> concept hierarchy, cross-domain concepts, source-grounded coverage, and explicit exclusions. It is external memory for later turns: keep it actionable and do not duplicate raw discovery output.",
      "Do not write bundle pages yet. Do not use a JSON handoff or structured output.",
      ctx.focus ? `Requested focus: ${ctx.focus}` : "",
    ].filter(Boolean).join("\n\n"),
  });
  if (!result || result.status === "failed" || result.status === "blocked") throw new Error(result?.summary ?? "Planning failed");
  setPhaseStatus(ctx.store, "Plan", "done", result.summary ?? "Plan written.");

  setPhaseStatus(ctx.store, "Coverage review", "active");
  const review = await runAgent(ctx, ctx.createEphemeralAgent("coverage-critic"), {
    agentId: "coverage-critic",
    label: "coverage-critic",
    phase: "Coverage review",
    role: "coverage-critic",
    prompt: [
      "Independently audit the proposed OKF Wiki plan for missing domains, concepts, cross-domain flows, incorrect hierarchy, and inventory coverage gaps.",
      promptPaths(ctx.paths),
      `Read ${methodContractPath(ctx.paths)} and ${methodPath(ctx.paths, "plan.md")} before reviewing.`,
      `Read ${join(ctx.paths.analysisDir, "plan.md")} and the frozen sources. Write concrete findings to ${join(ctx.paths.analysisDir, "coverage-review.md")}.`,
      "Do not alter plan.md or bundle files. Do not return JSON.",
    ].join("\n\n"),
  });
  if (!review || review.status === "failed" || review.status === "blocked") throw new Error(review?.summary ?? "Coverage review failed");
  setPhaseStatus(ctx.store, "Coverage review", "done", review.summary ?? "Coverage review written.");

  setPhaseStatus(ctx.store, "Plan revision", "active");
  const revision = await runAgent(ctx, ctx.mainAgent, {
    agentId: "main",
    label: "main-agent",
    phase: "Plan revision",
    role: "main",
    prompt: [
      `Read ${join(ctx.paths.analysisDir, "coverage-review.md")} and revise ${join(ctx.paths.analysisDir, "plan.md")} to address justified findings.`,
      `Keep ${methodContractPath(ctx.paths)} and ${methodPath(ctx.paths, "plan.md")} as the controlling format and source-grounding contract.`,
      "Keep the plan source-grounded, hierarchical, concise, and complete. Do not write bundle pages in this turn.",
    ].join("\n\n"),
  });
  if (!revision || revision.status === "failed" || revision.status === "blocked") throw new Error(revision?.summary ?? "Plan revision failed");
  setPhaseStatus(ctx.store, "Plan revision", "done", revision.summary ?? "Plan revised.");

  const planned = await ctx.core.completeRunPlanning(ctx.workspaceRoot, {
    runId: ctx.runId,
    sessionPath: ctx.sessionPath,
  });
  if (!planned || planned.ok === false) throw new Error("The core rejected the completed Wiki plan");
  return planned.requiresApproval ? "proposed" : "writing";
}

async function runWriteReviewValidate(ctx: WikiPathContext): Promise<WikiPathResult> {
  setPhaseStatus(ctx.store, "Write", "active");
  const write = await runAgent(ctx, ctx.mainAgent, {
    agentId: "main",
    label: "main-agent",
    phase: "Write",
    role: "main",
    prompt: [
      "Continue the same OKF Wiki run using the persisted plan.",
      promptPaths(ctx.paths),
      `Before writing, read ${methodContractPath(ctx.paths)} and ${methodPath(ctx.paths, "generate.md")}.`,
      `Read ${join(ctx.paths.analysisDir, "plan.md")} and write the complete source-grounded OKF bundle beneath ${ctx.paths.bundleDir}.`,
      "Use the required domain -> concept hierarchy, valid YAML frontmatter, `sources: [{id, resource}]` provenance, and Markdown links. Do not create JSON planning artifacts or agent-authored indexes.",
    ].join("\n\n"),
  });
  if (!write || write.status === "failed" || write.status === "blocked") throw new Error(write?.summary ?? "Wiki writing failed");
  setPhaseStatus(ctx.store, "Write", "done", write.summary ?? "Bundle drafted.");

  setPhaseStatus(ctx.store, "Review", "active");
  const review = await runAgent(ctx, ctx.createEphemeralAgent("reviewer"), {
    agentId: "bundle-reviewer",
    label: "bundle-reviewer",
    phase: "Review",
    role: "reviewer",
    prompt: [
      "Independently review this generated OKF Wiki against the frozen repository.",
      promptPaths(ctx.paths),
      `Before reviewing, read ${methodContractPath(ctx.paths)} and ${methodPath(ctx.paths, "review.md")}.`,
      `Read the bundle and write a concise, actionable fact/coverage/link/frontmatter review to ${join(ctx.paths.analysisDir, "review.md")}.`,
      "Do not edit bundle files. Do not return JSON.",
    ].join("\n\n"),
  });
  if (!review || review.status === "failed" || review.status === "blocked") throw new Error(review?.summary ?? "Bundle review failed");
  setPhaseStatus(ctx.store, "Review", "done", review.summary ?? "Bundle review written.");

  setPhaseStatus(ctx.store, "Repair", "active");
  const repair = await runAgent(ctx, ctx.mainAgent, {
    agentId: "main",
    label: "main-agent",
    phase: "Repair",
    role: "main",
    prompt: [
      `Read ${join(ctx.paths.analysisDir, "review.md")} and repair justified issues in ${ctx.paths.bundleDir}.`,
      `Use ${methodContractPath(ctx.paths)} and ${methodPath(ctx.paths, "generate.md")} as the bundle contract while repairing.`,
      "Preserve the domain/concept hierarchy and source grounding. Do not add JSON artifacts or a second review loop.",
    ].join("\n\n"),
  });
  if (!repair || repair.status === "failed" || repair.status === "blocked") throw new Error(repair?.summary ?? "Bundle repair failed");
  setPhaseStatus(ctx.store, "Repair", "done", repair.summary ?? "Bundle repaired.");

  setPhaseStatus(ctx.store, "Validate", "active");
  await ctx.core.setRunStatus(ctx.workspaceRoot, { runId: ctx.runId, status: "validating", sessionPath: ctx.sessionPath });
  const validation = await ctx.core.validateRunBundle(ctx.workspaceRoot, { runId: ctx.runId });
  if (!hostOk(validation)) throw new Error((validation as { error?: string } | undefined)?.error ?? "Deterministic bundle validation failed");
  setPhaseStatus(ctx.store, "Validate", "done", "Bundle validated and sealed.");
  return { status: "completed", runId: ctx.runId, summary: "OKF Wiki bundle validated and sealed." };
}

/** Execute planning, then either pause for approval or continue in the same main session. */
export async function runWikiPath(ctx: WikiPathContext, options: { start: "planning" | "writing" }): Promise<WikiPathResult> {
  try {
    throwIfAborted(ctx.signal);
    if (options.start === "planning") {
      const next = await runPlan(ctx);
      if (next === "proposed") return { status: "proposed", runId: ctx.runId, summary: "Plan proposed; waiting for /wiki approve." };
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
