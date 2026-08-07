/**
 * Write → Verify → Repair* → Validate path for session orchestration.
 *
 * Invoked when prepareRun returns startAt past the plan gate
 * (ready | write-sources | write | review-N | repair-N | validate).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CoreAdapter } from "../core-adapter.js";
import type { WikiAgentRunRequest, WikiAgentRunResult } from "./agent-runner.js";
import type { TaskPool } from "./pool.js";
import type { WikiRunStore } from "./store.js";
import type { OrchLimits } from "./types.js";
import { PLAN_PATH_ENVELOPE, setPhaseStatus, type PlanPathResult } from "./phase-graph.js";

export const ASSIGNMENTS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "shards", "limits"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    summary: { type: "string", maxLength: 3000 },
    limits: { type: "object" },
    shards: {
      type: "array",
      items: {
        type: "object",
        required: ["owner", "role", "pagePaths"],
        properties: {
          owner: { type: "string" },
          role: { type: "string", enum: ["domain", "integration"] },
          pagePaths: { type: "array", items: { type: "string" } },
          sourceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "clean", "blockingCount", "majorCount", "repairTargets"],
  properties: {
    status: { type: "string", enum: ["ok", "failed"] },
    summary: { type: "string", maxLength: 3000 },
    clean: { type: "boolean" },
    blockingCount: { type: "integer", minimum: 0 },
    majorCount: { type: "integer", minimum: 0 },
    defectFingerprint: { type: "string" },
    repairTargets: {
      type: "array",
      items: {
        type: "object",
        required: ["owner", "pagePaths"],
        properties: {
          owner: { type: "string" },
          pagePaths: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export interface PageShard {
  owner: string;
  role: "domain" | "integration" | string;
  pagePaths: string[];
  sourceIds?: string[];
}

export interface AssignmentsBundle {
  shards: PageShard[];
  limits: Record<string, unknown>;
}

export interface WritePathContext {
  core: CoreAdapter;
  workspaceRoot: string;
  runId: string;
  workdir: string;
  startAt: string;
  store: WikiRunStore;
  pool: TaskPool;
  runAgent: (
    req: Omit<WikiAgentRunRequest, "tools" | "cwd" | "signal"> & {
      signal?: AbortSignal;
      tools?: ToolDefinition[];
    },
  ) => Promise<WikiAgentRunResult | null>;
  tools: ToolDefinition[];
  cwd: string;
  limits: OrchLimits;
  signal: AbortSignal;
  log?: (msg: string) => void;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason;
    const err =
      reason instanceof Error
        ? reason
        : new Error(typeof reason === "string" ? reason : "Aborted");
    err.name = err.name === "Error" ? "AbortError" : err.name;
    throw err;
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function hostOk(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as { status?: unknown; ok?: unknown };
  return v.status === "ok" || v.ok === true;
}

/**
 * Group analysis/page-assignments.json rows into owner shards.
 * File is either a bare array or `{ pageAssignments: [...] }` / `{ assignments: [...] }`.
 */
export function loadAssignmentsFromDisk(workdir: string): AssignmentsBundle | null {
  const path = join(workdir, "analysis", "page-assignments.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const rows: unknown[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object"
        ? Array.isArray((raw as { pageAssignments?: unknown[] }).pageAssignments)
          ? (raw as { pageAssignments: unknown[] }).pageAssignments
          : Array.isArray((raw as { assignments?: unknown[] }).assignments)
            ? (raw as { assignments: unknown[] }).assignments
            : Array.isArray((raw as { shards?: unknown[] }).shards)
              ? (raw as { shards: unknown[] }).shards
              : []
        : [];
    if (rows.length === 0) return null;

    // Already shards shape?
    if (
      rows.every(
        (r) =>
          r &&
          typeof r === "object" &&
          typeof (r as PageShard).owner === "string" &&
          Array.isArray((r as PageShard).pagePaths),
      )
    ) {
      return {
        shards: rows as PageShard[],
        limits: loadPolicyLimits(workdir),
      };
    }

    const byOwner = new Map<string, PageShard>();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const a = row as {
        pagePath?: string;
        owner?: string;
        role?: string;
        sourceIds?: string[];
      };
      if (!a.owner || !a.pagePath) continue;
      let shard = byOwner.get(a.owner);
      if (!shard) {
        shard = {
          owner: a.owner,
          role: a.role === "integration" ? "integration" : "domain",
          pagePaths: [],
          sourceIds: [],
        };
        byOwner.set(a.owner, shard);
      }
      if (!shard.pagePaths.includes(a.pagePath)) shard.pagePaths.push(a.pagePath);
      if (Array.isArray(a.sourceIds)) {
        for (const s of a.sourceIds) {
          if (s && !shard.sourceIds!.includes(s)) shard.sourceIds!.push(s);
        }
      }
    }
    const shards = [...byOwner.values()];
    if (shards.length === 0) return null;
    return { shards, limits: loadPolicyLimits(workdir) };
  } catch {
    return null;
  }
}

function loadPolicyLimits(workdir: string): Record<string, unknown> {
  const policyPath = join(workdir, "inputs", "run-policy.json");
  if (!existsSync(policyPath)) return {};
  try {
    const policy = JSON.parse(readFileSync(policyPath, "utf8")) as {
      limits?: Record<string, unknown>;
      maxRepairRounds?: number;
    };
    if (policy.limits && typeof policy.limits === "object") return { ...policy.limits };
    return policy.maxRepairRounds !== undefined ? { maxRepairRounds: policy.maxRepairRounds } : {};
  } catch {
    return {};
  }
}

async function loadAssignments(
  ctx: WritePathContext,
): Promise<{ ok: true; bundle: AssignmentsBundle } | { ok: false; error: string }> {
  const fromDisk = loadAssignmentsFromDisk(ctx.workdir);
  if (fromDisk && fromDisk.shards.length > 0) {
    return { ok: true, bundle: fromDisk };
  }

  const loaded = await ctx.runAgent({
    agentId: "load-page-assignments",
    label: "load-page-assignments",
    phase: "Write",
    role: "other",
    prompt: [
      `Read analysis/spec.json, analysis/page-assignments.json, and inputs/run-policy.json in ${ctx.workdir}.`,
      "Return domain and integration ownership shards, dependencies, and page paths. Do not mutate files.",
    ].join("\n"),
    schema: ASSIGNMENTS_SCHEMA,
    signal: ctx.signal,
    tools: ctx.tools,
  });

  if (!loaded || loaded.status !== "ok" || !Array.isArray(loaded.shards)) {
    return {
      ok: false,
      error:
        (loaded && typeof loaded.summary === "string" && loaded.summary) ||
        "Page assignments could not be loaded.",
    };
  }
  return {
    ok: true,
    bundle: {
      shards: loaded.shards as PageShard[],
      limits:
        loaded.limits && typeof loaded.limits === "object"
          ? (loaded.limits as Record<string, unknown>)
          : loadPolicyLimits(ctx.workdir),
    },
  };
}

function reviewSnapshot(review: WikiAgentRunResult | null | undefined) {
  return {
    defectFingerprint: typeof review?.defectFingerprint === "string" ? review.defectFingerprint : "",
    blockingCount: Math.max(0, Number(review?.blockingCount) || 0),
    majorCount: Math.max(0, Number(review?.majorCount) || 0),
  };
}

function reviewProgress(
  previous: WikiAgentRunResult,
  current: WikiAgentRunResult,
): { ok: boolean; reason?: string } {
  const before = reviewSnapshot(previous);
  const after = reviewSnapshot(current);
  if (
    before.defectFingerprint &&
    after.defectFingerprint &&
    before.defectFingerprint === after.defectFingerprint
  ) {
    return { ok: false, reason: "defect fingerprint repeated" };
  }
  if (
    after.blockingCount < before.blockingCount ||
    (after.blockingCount === before.blockingCount && after.majorCount < before.majorCount)
  ) {
    return { ok: true };
  }
  return { ok: false, reason: "blocking/major defect counts did not decrease" };
}

/**
 * Run write/verify/repair/validate from a post-gate startAt.
 */
export async function runWritePath(ctx: WritePathContext): Promise<PlanPathResult> {
  const { core, workspaceRoot, runId, workdir, store, pool, runAgent, tools, signal, log } = ctx;
  let startAt = ctx.startAt;

  try {
    throwIfAborted(signal);

    if (startAt === "validate") {
      return await runValidate(ctx);
    }

    const loaded = await loadAssignments(ctx);
    if (!loaded.ok) {
      return { status: "failed", domainRunId: runId, workdir, summary: loaded.error, error: loaded.error };
    }
    const { shards, limits: assignmentLimits } = loaded.bundle;
    const repairBudget = Math.max(
      1,
      Math.min(2, Number(assignmentLimits.maxRepairRounds) || 2),
    );

    if (["ready", "write-sources", "write"].includes(startAt)) {
      setPhaseStatus(store, "Write", "active");
      const sourceShards = shards.filter((s) => s && s.role !== "integration");
      const integrationShards = shards.filter((s) => s && s.role === "integration");
      if (startAt === "ready") startAt = "write-sources";

      if (startAt === "write-sources") {
        throwIfAborted(signal);
        const writers = await Promise.all(
          sourceShards.map((shard, index) =>
            pool.run(
              (taskSignal) =>
                runAgent({
                  agentId: `write-sources:${index + 1}`,
                  label: `write-sources:${index + 1}`,
                  phase: "Write",
                  role: "write",
                  pagePaths: shard.pagePaths,
                  prompt: [
                    `Write source/domain candidate pages for the owned shard ${JSON.stringify(shard)} in Wiki run ${runId}.`,
                    `Read the generate method, authoritative plan, and frozen sources. Write only pages owned by this shard under ${workdir}/candidate/.`,
                    "Use source-grounded claims and local citations. Do not edit integration pages, analysis checkpoints, inputs, or sources.",
                  ].join("\n"),
                  schema: PLAN_PATH_ENVELOPE,
                  signal: taskSignal.aborted ? taskSignal : signal.aborted ? signal : taskSignal,
                  tools,
                }),
              { label: `write-sources:${index + 1}`, timeoutMs: ctx.limits.agentTimeoutMs },
            ),
          ),
        );
        if (writers.some((r) => !r || r.status !== "ok")) {
          setPhaseStatus(store, "Write", "failed", "source writers failed");
          return {
            status: "failed",
            domainRunId: runId,
            workdir,
            summary: "One or more source/domain writers failed.",
            error: "write-sources failed",
          };
        }

        const sourceReduce = await runAgent({
          agentId: "reduce-write-sources",
          label: "reduce-write-sources",
          phase: "Write",
          role: "write",
          prompt: [
            `Inspect completed source/domain candidate pages and assignments for run ${runId}.`,
            "Write analysis/receipts/write-sources-artifacts.json listing only source/domain candidate artifacts. Do not change pages or checkpoints.",
          ].join("\n"),
          schema: PLAN_PATH_ENVELOPE,
          signal,
          tools,
        });
        if (!sourceReduce || sourceReduce.status !== "ok") {
          setPhaseStatus(store, "Write", "failed", "reduce-write-sources failed");
          return {
            status: "failed",
            domainRunId: runId,
            workdir,
            summary: "reduce-write-sources failed",
            error: "reduce-write-sources failed",
          };
        }

        const published = await core.publishCheckpoint(workspaceRoot, {
          runId,
          phase: "write-sources",
          artifactsJsonPath: "analysis/receipts/write-sources-artifacts.json",
        });
        if (!hostOk(published)) {
          setPhaseStatus(store, "Write", "failed", "publish write-sources failed");
          return {
            status: "failed",
            domainRunId: runId,
            workdir,
            summary: "publish write-sources failed",
            error: "publish write-sources failed",
          };
        }
        store.appendEvent("host.tool", {
          phase: "Write",
          detail: { tool: "publishCheckpoint", phase: "write-sources" },
        });
        startAt = "write";
      }

      if (startAt === "write") {
        throwIfAborted(signal);
        if (integrationShards.length > 0) {
          const writers = await Promise.all(
            integrationShards.map((shard, index) =>
              pool.run(
                (taskSignal) =>
                  runAgent({
                    agentId: `write-integration:${index + 1}`,
                    label: `write-integration:${index + 1}`,
                    phase: "Write",
                    role: "write",
                    pagePaths: shard.pagePaths,
                    prompt: [
                      `Write integration candidate pages for the owned shard ${JSON.stringify(shard)} in Wiki run ${runId}.`,
                      "Read the generate method, authoritative plan, completed source/domain candidate pages, and frozen sources.",
                      `Write only pages owned by this integration shard under ${workdir}/candidate/ and retain local citations.`,
                    ].join("\n"),
                    schema: PLAN_PATH_ENVELOPE,
                    signal: taskSignal,
                    tools,
                  }),
                { label: `write-integration:${index + 1}`, timeoutMs: ctx.limits.agentTimeoutMs },
              ),
            ),
          );
          if (writers.some((r) => !r || r.status !== "ok")) {
            setPhaseStatus(store, "Write", "failed", "integration writers failed");
            return {
              status: "failed",
              domainRunId: runId,
              workdir,
              summary: "One or more integration writers failed.",
              error: "write-integration failed",
            };
          }
        }

        const reduce = await runAgent({
          agentId: "reduce-write",
          label: "reduce-write",
          phase: "Write",
          role: "write",
          prompt: [
            `Inspect all candidate pages and assignments for run ${runId}.`,
            "Write analysis/receipts/write-artifacts.json listing final candidate artifacts. Do not change pages or checkpoints.",
          ].join("\n"),
          schema: PLAN_PATH_ENVELOPE,
          signal,
          tools,
        });
        if (!reduce || reduce.status !== "ok") {
          setPhaseStatus(store, "Write", "failed", "reduce-write failed");
          return {
            status: "failed",
            domainRunId: runId,
            workdir,
            summary: "reduce-write failed",
            error: "reduce-write failed",
          };
        }

        const published = await core.publishCheckpoint(workspaceRoot, {
          runId,
          phase: "write",
          artifactsJsonPath: "analysis/receipts/write-artifacts.json",
        });
        if (!hostOk(published)) {
          setPhaseStatus(store, "Write", "failed", "publish write failed");
          return {
            status: "failed",
            domainRunId: runId,
            workdir,
            summary: "publish write failed",
            error: "publish write failed",
          };
        }
        store.appendEvent("host.tool", {
          phase: "Write",
          detail: { tool: "publishCheckpoint", phase: "write" },
        });
        setPhaseStatus(store, "Write", "done", "Candidate pages written");
        startAt = "review-1";
      }
    }

    // ── Review / repair loop ─────────────────────────────────────────────
    let finalReview: WikiAgentRunResult | null =
      startAt === "validate" ? ({ status: "ok", clean: true, resumed: true } as WikiAgentRunResult) : null;

    if (startAt !== "validate") {
      let reviewRound = Number(
        (/^review-(\d+)$/.exec(startAt) || /^repair-(\d+)$/.exec(startAt) || [])[1] || 1,
      );
      let resumeRepair = /^repair-\d+$/.test(startAt);
      let completedRepairRounds = Math.max(0, reviewRound - 1);
      let previousReview: WikiAgentRunResult | null = null;

      if (!resumeRepair && reviewRound > 1) {
        const baseline = await runAgent({
          agentId: `hydrate-review-baseline:${reviewRound - 1}`,
          label: `hydrate-review-baseline:${reviewRound - 1}`,
          phase: "Verify",
          role: "review",
          prompt: [
            `Resume review round ${reviewRound} for Wiki run ${runId}.`,
            "Read the current analysis/defects.json produced before repair and return its stable fingerprint, blocking/major counts, and repair targets without changing files.",
          ].join("\n"),
          schema: REVIEW_SCHEMA,
          signal,
          tools,
        });
        if (!baseline || baseline.status !== "ok" || baseline.clean) {
          return {
            status: "failed",
            domainRunId: runId,
            workdir,
            summary: "Could not hydrate review baseline",
            error: "hydrate-review-baseline failed",
          };
        }
        previousReview = baseline;
      }

      while (reviewRound <= repairBudget + 1) {
        throwIfAborted(signal);

        if (resumeRepair) {
          setPhaseStatus(store, "Repair", "active");
          const stored = await runAgent({
            agentId: `hydrate-repair:${reviewRound}`,
            label: `hydrate-repair:${reviewRound}`,
            phase: "Repair",
            role: "repair",
            prompt: [
              `Resume repair round ${reviewRound} for Wiki run ${runId}.`,
              "Read analysis/defects.json, page assignments, and the current review checkpoint. Return clean=false and exact repairTargets without changing files.",
            ].join("\n"),
            schema: REVIEW_SCHEMA,
            signal,
            tools,
          });
          if (!stored || stored.status !== "ok" || stored.clean) {
            setPhaseStatus(store, "Repair", "failed", "hydrate-repair failed");
            return {
              status: "failed",
              domainRunId: runId,
              workdir,
              summary: "hydrate-repair failed",
              error: "hydrate-repair failed",
            };
          }
          previousReview = stored;
          const targets = Array.isArray(stored.repairTargets)
            ? (stored.repairTargets as Array<{ owner: string; pagePaths: string[] }>)
            : [];
          const repairs = await Promise.all(
            targets.map((target, index) =>
              pool.run(
                (taskSignal) =>
                  runAgent({
                    agentId: `repair-resume:${reviewRound}:${index}`,
                    label: `repair-resume:${reviewRound}:${index}`,
                    phase: "Repair",
                    role: "repair",
                    pagePaths: target.pagePaths,
                    prompt: [
                      `Repair owner ${target.owner} for Wiki run ${runId}.`,
                      "Read analysis/defects.json, assigned Spec entries, page assignments, and frozen sources.",
                      `Modify only these candidate pages: ${JSON.stringify(target.pagePaths)}. Write no control-plane files.`,
                    ].join("\n"),
                    schema: PLAN_PATH_ENVELOPE,
                    signal: taskSignal,
                    tools,
                  }),
                {
                  label: `repair-resume:${reviewRound}:${index}`,
                  timeoutMs: ctx.limits.agentTimeoutMs,
                },
              ),
            ),
          );
          if (repairs.some((r) => !r || r.status !== "ok")) {
            setPhaseStatus(store, "Repair", "failed", "repair-resume failed");
            return {
              status: "failed",
              domainRunId: runId,
              workdir,
              summary: "repair-resume failed",
              error: "repair-resume failed",
            };
          }
          const reducedResume = await runAgent({
            agentId: `reduce-repair-resume:${reviewRound}`,
            label: `reduce-repair-resume:${reviewRound}`,
            phase: "Repair",
            role: "repair",
            prompt: `Write an immutable repair receipt under analysis/receipts/repair/ for round ${reviewRound}, then write analysis/receipts/repair-artifacts-round-${reviewRound}.json as a JSON array of {id,type,path} declaring only that receipt. Never declare candidate pages or analysis/defects.json because later rounds may change them.`,
            schema: PLAN_PATH_ENVELOPE,
            signal,
            tools,
          });
          if (!reducedResume || reducedResume.status !== "ok") {
            setPhaseStatus(store, "Repair", "failed", "reduce-repair-resume failed");
            return {
              status: "failed",
              domainRunId: runId,
              workdir,
              summary: "reduce-repair-resume failed",
              error: "reduce-repair-resume failed",
            };
          }
          const repairedResume = await core.publishCheckpoint(workspaceRoot, {
            runId,
            phase: `repair-${reviewRound}`,
            artifactsJsonPath: `analysis/receipts/repair-artifacts-round-${reviewRound}.json`,
          });
          if (!hostOk(repairedResume)) {
            setPhaseStatus(store, "Repair", "failed", "publish repair failed");
            return {
              status: "failed",
              domainRunId: runId,
              workdir,
              summary: "publish repair failed",
              error: "publish repair failed",
            };
          }
          setPhaseStatus(store, "Repair", "done");
          completedRepairRounds++;
          reviewRound++;
          resumeRepair = false;
          if (reviewRound > repairBudget + 1) {
            return {
              status: "failed",
              domainRunId: runId,
              workdir,
              summary: "repair budget exhausted",
              error: "repair budget exhausted",
            };
          }
        }

        setPhaseStatus(store, "Verify", "active");
        const lenses = ["source-claims", "coverage-and-ownership", "navigation-and-reader-utility"];
        const reviews = await Promise.all(
          lenses.map((lens) =>
            pool.run(
              (taskSignal) =>
                runAgent({
                  agentId: `review:${reviewRound}:${lens}`,
                  label: `review:${reviewRound}:${lens}`,
                  phase: "Verify",
                  role: "review",
                  prompt: [
                    `Independently review Wiki run ${runId}, round ${reviewRound}, through the ${lens} lens.`,
                    "Read frozen sources, candidate pages, Spec, assignments, and the review method.",
                    "Write one schema-shaped finding receipt beneath analysis/receipts/review/ for this round. Do not repair pages or alter control-plane artifacts.",
                  ].join("\n"),
                  schema: PLAN_PATH_ENVELOPE,
                  signal: taskSignal,
                  tools,
                }),
              { label: `review:${reviewRound}:${lens}`, timeoutMs: ctx.limits.agentTimeoutMs },
            ),
          ),
        );
        if (reviews.some((r) => !r || r.status !== "ok")) {
          setPhaseStatus(store, "Verify", "failed", "review lenses failed");
          return {
            status: "failed",
            domainRunId: runId,
            workdir,
            summary: "One or more review lenses failed.",
            error: "review failed",
          };
        }

        finalReview = await runAgent({
          agentId: `reduce-review:${reviewRound}`,
          label: `reduce-review:${reviewRound}`,
          phase: "Verify",
          role: "review",
          prompt: [
            `Defect reducer for review round ${reviewRound} in Wiki run ${runId}.`,
            "Read all receipts under analysis/receipts/review/ for this round, Spec, page assignments, and candidate pages.",
            `Write analysis/defects.json conforming to defects.schema.json version 2, and analysis/receipts/review-artifacts-round-${reviewRound}.json as a JSON array of {id,type,path}. The artifact list may include only immutable round receipt files; never include analysis/defects.json because it is mutable current state.`,
            "Every defect must identify pagePath, owner, severity, category, evidence, repairSuggestion, and a stable fingerprint. clean=true only with no defects.",
            "Return exact clean state, blocking/major counts, repairTargets grouped by owner, and defectFingerprint as a deterministic digest of active defect fingerprints.",
          ].join("\n"),
          schema: REVIEW_SCHEMA,
          signal,
          tools,
        });
        if (!finalReview || finalReview.status !== "ok") {
          setPhaseStatus(store, "Verify", "failed", "reduce-review failed");
          return {
            status: "failed",
            domainRunId: runId,
            workdir,
            summary: "reduce-review failed",
            error: "reduce-review failed",
          };
        }

        const reviewed = await core.publishCheckpoint(workspaceRoot, {
          runId,
          phase: `review-${reviewRound}`,
          artifactsJsonPath: `analysis/receipts/review-artifacts-round-${reviewRound}.json`,
        });
        if (!hostOk(reviewed)) {
          setPhaseStatus(store, "Verify", "failed", "publish review failed");
          return {
            status: "failed",
            domainRunId: runId,
            workdir,
            summary: "publish review failed",
            error: "publish review failed",
          };
        }
        store.appendEvent("host.tool", {
          phase: "Verify",
          detail: { tool: "publishCheckpoint", phase: `review-${reviewRound}` },
        });

        if (finalReview.clean) {
          setPhaseStatus(store, "Verify", "done", "Review clean");
          break;
        }

        if (previousReview) {
          const progress = reviewProgress(previousReview, finalReview);
          if (!progress.ok) {
            setPhaseStatus(store, "Verify", "failed", progress.reason);
            return {
              status: "failed",
              domainRunId: runId,
              workdir,
              summary: progress.reason,
              error: progress.reason,
            };
          }
        }
        if (completedRepairRounds >= repairBudget) {
          setPhaseStatus(store, "Verify", "failed", "repair budget exhausted");
          return {
            status: "failed",
            domainRunId: runId,
            workdir,
            summary: "repair budget exhausted with unresolved defects",
            error: "repair budget exhausted",
          };
        }

        setPhaseStatus(store, "Repair", "active");
        const targets = Array.isArray(finalReview.repairTargets)
          ? (finalReview.repairTargets as Array<{ owner: string; pagePaths: string[] }>)
          : [];
        const repairs = await Promise.all(
          targets.map((target, index) =>
            pool.run(
              (taskSignal) =>
                runAgent({
                  agentId: `repair:${reviewRound}:${index}`,
                  label: `repair:${reviewRound}:${index}`,
                  phase: "Repair",
                  role: "repair",
                  pagePaths: target.pagePaths,
                  prompt: [
                    `Repair owner ${target.owner} for Wiki run ${runId}, round ${reviewRound}.`,
                    "Read analysis/defects.json, assigned Spec entries, page assignments, and frozen sources.",
                    `Modify only these candidate pages: ${JSON.stringify(target.pagePaths)}. Do not write checkpoints, inputs, or source snapshots.`,
                  ].join("\n"),
                  schema: PLAN_PATH_ENVELOPE,
                  signal: taskSignal,
                  tools,
                }),
              { label: `repair:${reviewRound}:${index}`, timeoutMs: ctx.limits.agentTimeoutMs },
            ),
          ),
        );
        if (repairs.some((r) => !r || r.status !== "ok")) {
          setPhaseStatus(store, "Repair", "failed", "repair failed");
          return {
            status: "failed",
            domainRunId: runId,
            workdir,
            summary: "repair failed",
            error: "repair failed",
          };
        }
        const reduced = await runAgent({
          agentId: `reduce-repair:${reviewRound}`,
          label: `reduce-repair:${reviewRound}`,
          phase: "Repair",
          role: "repair",
          prompt: `Write an immutable repair receipt under analysis/receipts/repair/ for round ${reviewRound}, then write analysis/receipts/repair-artifacts-round-${reviewRound}.json as a JSON array of {id,type,path} declaring only that receipt. Never declare candidate pages or analysis/defects.json because later rounds may change them.`,
          schema: PLAN_PATH_ENVELOPE,
          signal,
          tools,
        });
        if (!reduced || reduced.status !== "ok") {
          setPhaseStatus(store, "Repair", "failed", "reduce-repair failed");
          return {
            status: "failed",
            domainRunId: runId,
            workdir,
            summary: "reduce-repair failed",
            error: "reduce-repair failed",
          };
        }
        const repaired = await core.publishCheckpoint(workspaceRoot, {
          runId,
          phase: `repair-${reviewRound}`,
          artifactsJsonPath: `analysis/receipts/repair-artifacts-round-${reviewRound}.json`,
        });
        if (!hostOk(repaired)) {
          setPhaseStatus(store, "Repair", "failed", "publish repair failed");
          return {
            status: "failed",
            domainRunId: runId,
            workdir,
            summary: "publish repair failed",
            error: "publish repair failed",
          };
        }
        setPhaseStatus(store, "Repair", "done");
        previousReview = finalReview;
        completedRepairRounds++;
        reviewRound++;
        log?.(`repair round complete; next review ${reviewRound}`);
      }
    }

    if (!finalReview?.clean) {
      return {
        status: "failed",
        domainRunId: runId,
        workdir,
        summary: "candidate has unresolved defects",
        error: "unresolved defects",
      };
    }

    return await runValidate(ctx);
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      return {
        status: "failed",
        domainRunId: runId,
        workdir,
        summary: "Cancelled",
        error: err instanceof Error ? err.message : "Aborted",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { status: "failed", domainRunId: runId, workdir, summary: message, error: message };
  }
}

async function runValidate(ctx: WritePathContext): Promise<PlanPathResult> {
  const { core, workspaceRoot, runId, workdir, store, signal } = ctx;
  throwIfAborted(signal);
  setPhaseStatus(store, "Validate", "active");

  const sealed = await core.validateCandidate(workspaceRoot, { runId });
  if (!hostOk(sealed)) {
    setPhaseStatus(store, "Validate", "failed", "validateCandidate failed");
    return {
      status: "failed",
      domainRunId: runId,
      workdir,
      summary: "validateCandidate failed",
      error: "validateCandidate failed",
    };
  }

  const artifactsJsonPath =
    sealed && typeof sealed === "object" && typeof (sealed as { artifactsJsonPath?: string }).artifactsJsonPath === "string"
      ? (sealed as { artifactsJsonPath: string }).artifactsJsonPath
      : "analysis/receipts/validate-artifacts.json";

  const published = await core.publishCheckpoint(workspaceRoot, {
    runId,
    phase: "validate",
    artifactsJsonPath,
  });
  if (!hostOk(published)) {
    setPhaseStatus(store, "Validate", "failed", "publish validate failed");
    return {
      status: "failed",
      domainRunId: runId,
      workdir,
      summary: "publish validate failed",
      error: "publish validate failed",
    };
  }

  setPhaseStatus(store, "Validate", "done", "Candidate sealed");
  store.appendEvent("host.tool", {
    phase: "Validate",
    detail: { tool: "validateCandidate+publish", artifactsJsonPath },
  });
  return {
    status: "completed",
    domainRunId: runId,
    workdir,
    next: "sealed",
    summary: "Wiki candidate validated and sealed.",
  };
}
