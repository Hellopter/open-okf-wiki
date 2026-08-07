/**
 * Pure path orchestration.
 *
 * Plan path: Bootstrap → Survey → Plan → Gate (stop for interactive approval).
 * Full wiki path: plan path, then Write → Verify → Repair* → Validate when
 * prepareRun resumes past the gate (ready / write-sources / write / review-* / …).
 *
 * Host-direct: prepare / merge / publish / validate go through CoreAdapter.
 * LLM work goes through the injectable runAgent callback.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CoreAdapter, WikiRunMode } from "../core-adapter.js";
import type { WikiAgentRunRequest, WikiAgentRunResult } from "./agent-runner.js";
import { scanSurveyCoverage } from "./progress.js";
import type { TaskPool } from "./pool.js";
import type { WikiRunStore } from "./store.js";
import type { OrchLimits, WikiCoverageView, WikiPhaseStatus } from "./types.js";

/** Compact structured-output envelope shared by survey/plan agents. */
export const PLAN_PATH_ENVELOPE: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["ok", "failed", "blocked"] },
    summary: { type: "string", maxLength: 3000 },
  },
};

export interface CoverageUnit {
  id: string;
  kind?: string;
  sourceId?: string;
  path?: string;
  required?: boolean;
  [key: string]: unknown;
}

export interface LoadedInventory {
  units: CoverageUnit[];
  /** Limits from run-policy.json (and inventory.limits if present). */
  limits: Record<string, unknown>;
}

export interface PlanPathContext {
  core: CoreAdapter;
  workspaceRoot: string;
  mode: string;
  focus?: string;
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

export interface PlanPathResult {
  status: "ok" | "failed" | "blocked" | "completed";
  domainRunId?: string;
  workdir?: string;
  next?: string;
  summary?: string;
  error?: string;
}

interface SurveyMergeResult {
  status?: string;
  pass?: number;
  artifactsPath?: string;
  missingUnitIds?: string[];
  retryUnitIds?: string[];
  needsDomainLabels?: boolean;
  summary?: string;
  [key: string]: unknown;
}

interface PublishResult {
  status?: string;
  summary?: string;
  [key: string]: unknown;
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

/** Set phase status and emit the matching phase event. */
export function setPhaseStatus(
  store: WikiRunStore,
  name: string,
  status: WikiPhaseStatus,
  summary?: string,
): void {
  store.setPhase(name, status, summary);
  if (status === "active") {
    store.appendEvent("phase.started", { phase: name });
  } else if (status === "done") {
    store.appendEvent("phase.completed", {
      phase: name,
      detail: summary !== undefined ? { summary } : undefined,
    });
  } else if (status === "failed") {
    store.appendEvent("phase.failed", {
      phase: name,
      detail: summary !== undefined ? { summary } : undefined,
    });
  }
}

/** Round-robin shard of units into up to `laneCount` non-empty groups. */
export function shardUnits<T>(units: readonly T[], laneCount: number): T[][] {
  const n = Math.max(1, Math.floor(laneCount));
  const groups: T[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < units.length; i++) {
    groups[i % n]!.push(units[i]!);
  }
  return groups.filter((g) => g.length > 0);
}

/**
 * Adaptive survey lane count:
 * `clamp(1, maxLanes, ceil(units.length / targetUnitsPerLane))`.
 */
export function adaptiveLaneCount(
  unitCount: number,
  limits: Pick<OrchLimits, "maxSurveyLanes" | "targetUnitsPerLane">,
): number {
  const maxLanes = Math.max(1, Math.floor(limits.maxSurveyLanes));
  const target = Math.max(1, Math.floor(limits.targetUnitsPerLane));
  if (unitCount <= 0) return 1;
  const raw = Math.ceil(unitCount / target);
  return Math.min(maxLanes, Math.max(1, raw));
}

/** Host-read inventory.json + run-policy.json from a prepared workdir. */
export function loadInventory(workdir: string): LoadedInventory {
  const inventoryPath = join(workdir, "inputs", "inventory.json");
  const policyPath = join(workdir, "inputs", "run-policy.json");

  let units: CoverageUnit[] = [];
  let inventoryLimits: Record<string, unknown> = {};

  if (existsSync(inventoryPath)) {
    try {
      const raw = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
        coverageUnits?: CoverageUnit[];
        units?: CoverageUnit[];
        limits?: Record<string, unknown>;
      };
      // Kit inventory uses `coverageUnits` (not `units`).
      const list = Array.isArray(raw.coverageUnits)
        ? raw.coverageUnits
        : Array.isArray(raw.units)
          ? raw.units
          : [];
      units = list.filter((u) => u && typeof u.id === "string");
      if (raw.limits && typeof raw.limits === "object") {
        inventoryLimits = raw.limits;
      }
    } catch {
      units = [];
    }
  }

  let policyLimits: Record<string, unknown> = {};
  if (existsSync(policyPath)) {
    try {
      const policy = JSON.parse(readFileSync(policyPath, "utf8")) as {
        limits?: Record<string, unknown>;
        maxCoveragePasses?: number;
        [key: string]: unknown;
      };
      if (policy.limits && typeof policy.limits === "object") {
        policyLimits = policy.limits;
      } else {
        // Some policies flatten limit fields at the top level.
        const {
          maxCoveragePasses,
          batchConcurrency,
          perSourceConcurrency,
          maxRepairRounds,
        } = policy;
        policyLimits = {
          ...(maxCoveragePasses !== undefined ? { maxCoveragePasses } : {}),
          ...(batchConcurrency !== undefined ? { batchConcurrency } : {}),
          ...(perSourceConcurrency !== undefined ? { perSourceConcurrency } : {}),
          ...(maxRepairRounds !== undefined ? { maxRepairRounds } : {}),
        };
      }
    } catch {
      policyLimits = {};
    }
  }

  return {
    units,
    limits: { ...inventoryLimits, ...policyLimits },
  };
}

function combineSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([a, b]);
  }
  // Fallback for environments without AbortSignal.any (shouldn't hit on Node 22+).
  const controller = new AbortController();
  const onAbort = (): void => {
    try {
      controller.abort(a.reason ?? b.reason);
    } catch {
      // ignore
    }
  };
  if (a.aborted || b.aborted) {
    onAbort();
    return controller.signal;
  }
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

function maxCoveragePassesFrom(limits: Record<string, unknown>): number {
  const n = Number(limits.maxCoveragePasses);
  if (!Number.isFinite(n)) return 2;
  return Math.max(1, Math.min(4, Math.trunc(n)));
}

function applyCoverageToStore(
  store: WikiRunStore,
  coverage: WikiCoverageView | undefined,
  merge?: SurveyMergeResult,
): void {
  if (!coverage && !merge) return;
  store.updateSnapshot((s) => {
    const base: WikiCoverageView = coverage ?? {
      pass: merge?.pass ?? 1,
      unitsTotal: 0,
      unitsWithReceipt: 0,
      missingUnitIds: [],
      retryUnitIds: [],
    };
    s.coverage = {
      ...base,
      pass: merge?.pass ?? base.pass,
      missingUnitIds: Array.isArray(merge?.missingUnitIds)
        ? merge!.missingUnitIds!.map(String)
        : base.missingUnitIds,
      retryUnitIds: Array.isArray(merge?.retryUnitIds)
        ? merge!.retryUnitIds!.map(String)
        : base.retryUnitIds,
    };
  });
  store.appendEvent("coverage.updated", {
    detail: store.getSnapshot().coverage,
  });
}

/**
 * Run the plan path until Gate (or an early terminal edge).
 * Does not open the plan gate — approval is an interactive host action.
 */
export async function runPlanPath(ctx: PlanPathContext): Promise<PlanPathResult> {
  const {
    core,
    workspaceRoot,
    mode,
    focus,
    store,
    pool,
    runAgent,
    tools,
    cwd,
    limits,
    signal,
    log,
  } = ctx;

  const note = (msg: string): void => {
    log?.(msg);
  };

  try {
    throwIfAborted(signal);

    // ── Bootstrap ──────────────────────────────────────────────────────────
    setPhaseStatus(store, "Bootstrap", "active");

    const prepare = await core.prepareRun(workspaceRoot, {
      mode: mode as WikiRunMode,
      focus,
    });

    if (!prepare || prepare.status !== "ok") {
      const summary =
        (prepare && typeof prepare.summary === "string" && prepare.summary) ||
        "prepareRun failed";
      setPhaseStatus(store, "Bootstrap", "failed", summary);
      return {
        status: "failed",
        domainRunId: prepare?.runId,
        workdir: prepare?.workdir,
        summary,
        error: summary,
      };
    }

    const runId = prepare.runId;
    const workdir = prepare.workdir;
    store.bindDomain(runId, workdir);
    store.updateSnapshot((s) => {
      s.domainRunId = runId;
      s.workdir = workdir;
    });

    // Optional host row for observation (no LLM).
    store.upsertAgent({
      agentId: "host:prepare",
      label: "bootstrap-prepare",
      role: "host",
      phase: "Bootstrap",
      status: "succeeded",
      startedAt: Date.now(),
      endedAt: Date.now(),
      elapsedMs: 0,
      receiptsWritten: 0,
    });
    store.appendEvent("host.tool", {
      agentId: "host:prepare",
      phase: "Bootstrap",
      detail: { tool: "prepareRun", runId, workdir, startAt: prepare.startAt },
    });

    setPhaseStatus(store, "Bootstrap", "done", prepare.summary);
    let startAt = prepare.startAt;

    if (startAt === "sealed") {
      return {
        status: "completed",
        domainRunId: runId,
        workdir,
        next: "sealed",
        summary: prepare.summary ?? "Run is already sealed.",
      };
    }

    if (mode === "plan" && !["survey", "plan", "gate"].includes(startAt)) {
      return {
        status: "ok",
        domainRunId: runId,
        workdir,
        next: "/wiki --write",
        summary: "A gate-ready plan already exists.",
      };
    }

    if (mode === "write" && ["survey", "plan", "gate"].includes(startAt)) {
      return {
        status: "blocked",
        domainRunId: runId,
        workdir,
        summary: "--write requires an approved plan checkpoint.",
      };
    }

    // ── Survey + Plan ──────────────────────────────────────────────────────
    if (["survey", "plan"].includes(startAt)) {
      if (startAt === "survey") {
        setPhaseStatus(store, "Survey", "active");
        throwIfAborted(signal);

        const inventory = loadInventory(workdir);
        if (!inventory.units.length) {
          const summary = "No survey coverage units were available.";
          setPhaseStatus(store, "Survey", "failed", summary);
          return { status: "failed", domainRunId: runId, workdir, summary, error: summary };
        }

        const maxPasses = maxCoveragePassesFrom(inventory.limits);
        let pendingUnits = inventory.units;
        let merged: SurveyMergeResult | null = null;

        for (let pass = 1; pass <= maxPasses && pendingUnits.length; pass++) {
          throwIfAborted(signal);

          const laneCount = adaptiveLaneCount(pendingUnits.length, limits);
          const groups = shardUnits(pendingUnits, laneCount);
          note(
            `Survey pass ${pass}: ${pendingUnits.length} unit(s) across ${groups.length} lane(s)`,
          );

          const laneResults = await Promise.all(
            groups.map((units, lane) =>
              pool.run(
                async (taskSignal) => {
                  const agentId = `survey:${pass}:${lane + 1}`;
                  const unitIds = units.map((u) => String(u.id));
                  const combined = combineSignals(signal, taskSignal);
                  try {
                    return await runAgent({
                      agentId,
                      label: `survey:${pass}:${lane + 1}`,
                      phase: "Survey",
                      role: "survey",
                      unitIds,
                      prompt: [
                        `Survey lane ${lane + 1}, pass ${pass}, for Wiki run ${runId}.`,
                        `Read the survey method under ${workdir}/method and frozen evidence under ${workdir}/sources only.`,
                        `Survey exactly these coverage units: ${JSON.stringify(units)}.`,
                        `Write one schema-shaped receipt per unit beneath ${workdir}/analysis/receipts/survey/.`,
                        "Do not alter discovery-map, checkpoints, inventory, sources, or candidate pages.",
                        "Return status and a compact receipt summary.",
                      ].join("\n"),
                      schema: PLAN_PATH_ENVELOPE,
                      signal: combined,
                      tools,
                    });
                  } catch (err) {
                    if (isAbortError(err) || signal.aborted || taskSignal.aborted) throw err;
                    const message = err instanceof Error ? err.message : String(err);
                    note(`Survey lane ${lane + 1} threw: ${message}`);
                    return { status: "failed", summary: message } as WikiAgentRunResult;
                  }
                },
                {
                  timeoutMs: limits.agentTimeoutMs,
                  label: `survey:${pass}:${lane + 1}`,
                },
              ),
            ),
          );

          // Continue-and-merge: lane failures are logged; merge classifies receipts.
          if (laneResults.some((r) => !r || r.status !== "ok")) {
            note("Some survey lanes failed; the deterministic merge will classify all receipts.");
          }

          throwIfAborted(signal);
          const mergeRaw = (await core.mergeSurveyReceipts(workspaceRoot, {
            pass,
            runId,
          })) as SurveyMergeResult;

          merged = mergeRaw && typeof mergeRaw === "object" ? mergeRaw : null;
          if (!merged || merged.status !== "ok") {
            const summary =
              (merged && typeof merged.summary === "string" && merged.summary) ||
              "mergeSurveyReceipts failed";
            setPhaseStatus(store, "Survey", "failed", summary);
            return { status: "failed", domainRunId: runId, workdir, summary, error: summary };
          }

          const scanned = await scanSurveyCoverage(workdir, {
            pass,
            inventoryUnits: inventory.units,
          });
          applyCoverageToStore(store, scanned, merged);

          if (merged.needsDomainLabels) {
            throwIfAborted(signal);
            const labelsPath = `analysis/receipts/discovery-labels-pass-${pass}.json`;
            const labels = await runAgent({
              agentId: `discovery-labels:${pass}`,
              label: `discovery-labels:${pass}`,
              phase: "Survey",
              role: "survey",
              prompt: [
                `Read only ${workdir}/analysis/discovery-map.json.`,
                `Write ${labelsPath} as JSON {domains,flows}; every item needs id, summary, coverageUnitIds and flows may include crossSource.`,
                "Provide at least one domain when the method requires domain labels. Do not modify the Discovery Map or receipts.",
              ].join("\n"),
              schema: PLAN_PATH_ENVELOPE,
              signal,
              tools,
            });
            if (!labels || labels.status !== "ok") {
              const summary =
                (labels && typeof labels.summary === "string" && labels.summary) ||
                "discovery labels agent failed";
              setPhaseStatus(store, "Survey", "failed", summary);
              return { status: "failed", domainRunId: runId, workdir, summary, error: summary };
            }

            const remixed = (await core.mergeSurveyReceipts(workspaceRoot, {
              pass,
              runId,
              labelsPath,
            })) as SurveyMergeResult;
            merged = remixed && typeof remixed === "object" ? remixed : null;
            if (!merged || merged.status !== "ok") {
              const summary =
                (merged && typeof merged.summary === "string" && merged.summary) ||
                "mergeSurveyReceipts (labels) failed";
              setPhaseStatus(store, "Survey", "failed", summary);
              return { status: "failed", domainRunId: runId, workdir, summary, error: summary };
            }
            const rescanned = await scanSurveyCoverage(workdir, {
              pass,
              inventoryUnits: inventory.units,
            });
            applyCoverageToStore(store, rescanned, merged);
          }

          const retry = new Set((merged.retryUnitIds ?? []).map(String));
          pendingUnits = inventory.units.filter((unit) => retry.has(String(unit.id)));
        }

        if (!merged || (Array.isArray(merged.missingUnitIds) && merged.missingUnitIds.length > 0)) {
          const summary = "Survey coverage remains missing after its pass budget.";
          setPhaseStatus(store, "Survey", "failed", summary);
          return { status: "failed", domainRunId: runId, workdir, summary, error: summary };
        }

        throwIfAborted(signal);
        const artifactsPath =
          typeof merged.artifactsPath === "string" && merged.artifactsPath
            ? merged.artifactsPath
            : "analysis/receipts/discovery-artifacts-pass-1.json";
        const discover = (await core.publishCheckpoint(workspaceRoot, {
          phase: "discover",
          artifactsJsonPath: artifactsPath,
          runId,
        })) as PublishResult;

        if (!discover || discover.status !== "ok") {
          const summary =
            (discover && typeof discover.summary === "string" && discover.summary) ||
            "publish discover checkpoint failed";
          setPhaseStatus(store, "Survey", "failed", summary);
          return { status: "failed", domainRunId: runId, workdir, summary, error: summary };
        }

        store.appendEvent("host.tool", {
          phase: "Survey",
          detail: { tool: "publishCheckpoint", phase: "discover", artifactsPath },
        });
        setPhaseStatus(store, "Survey", "done", "Discovery checkpoint published");
      }

      // ── Plan ─────────────────────────────────────────────────────────────
      setPhaseStatus(store, "Plan", "active");
      throwIfAborted(signal);

      const planned = await runAgent({
        agentId: "plan-spec",
        label: "plan-spec",
        phase: "Plan",
        role: "plan",
        prompt: [
          `Plan the Wiki run ${runId}.`,
          `Read the plan method, discovery map, inventory, policy, and authoritative checkpoint in ${workdir}.`,
          "Write analysis/spec.json, analysis/page-assignments.json, and analysis/receipts/plan-artifacts.json.",
          "Every candidate page must have exactly one owner; record dependencies and coverage bindings.",
          "Do not write candidate pages or mutate checkpoints.",
        ].join("\n"),
        schema: PLAN_PATH_ENVELOPE,
        signal,
        tools,
      });

      if (!planned || planned.status !== "ok") {
        const summary =
          (planned && typeof planned.summary === "string" && planned.summary) ||
          "plan agent failed";
        setPhaseStatus(store, "Plan", "failed", summary);
        return { status: "failed", domainRunId: runId, workdir, summary, error: summary };
      }

      throwIfAborted(signal);
      const planPublish = (await core.publishCheckpoint(workspaceRoot, {
        phase: "plan",
        artifactsJsonPath: "analysis/receipts/plan-artifacts.json",
        runId,
      })) as PublishResult;

      if (!planPublish || planPublish.status !== "ok") {
        const summary =
          (planPublish && typeof planPublish.summary === "string" && planPublish.summary) ||
          "publish plan checkpoint failed";
        setPhaseStatus(store, "Plan", "failed", summary);
        return { status: "failed", domainRunId: runId, workdir, summary, error: summary };
      }

      store.appendEvent("host.tool", {
        phase: "Plan",
        detail: {
          tool: "publishCheckpoint",
          phase: "plan",
          artifactsPath: "analysis/receipts/plan-artifacts.json",
        },
      });
      setPhaseStatus(store, "Plan", "done", "Plan checkpoint published");
      startAt = "gate";
    }

    // ── Gate (stop — approval is interactive) ──────────────────────────────
    if (startAt === "gate") {
      // Mark active first so currentPhase advances to Gate, then complete.
      setPhaseStatus(store, "Gate", "active");
      setPhaseStatus(store, "Gate", "done", "Plan checkpointed and awaiting explicit approval.");
      return {
        status: "ok",
        domainRunId: runId,
        workdir,
        next: "/wiki --write",
        summary: "Plan checkpointed and awaiting explicit approval.",
      };
    }

    // Past plan gate — write/review/validate handled by runWikiPath via write-path.
    return {
      status: "ok",
      domainRunId: runId,
      workdir,
      next: startAt,
      summary: `Plan path complete; remaining work starts at ${startAt}.`,
    };
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      return {
        status: "failed",
        summary: "Cancelled",
        error: err instanceof Error ? err.message : "Aborted",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { status: "failed", summary: message, error: message };
  }
}

const WRITE_START =
  /^(ready|write-sources|write|validate|review-\d+|repair-\d+)$/;

/**
 * Full wiki production path for the session backend.
 * Stops at Gate for plan approval; continues through write/verify/validate when
 * prepareRun returns a post-gate startAt (e.g. after `/wiki --write`).
 */
export async function runWikiPath(ctx: PlanPathContext): Promise<PlanPathResult> {
  const planResult = await runPlanPath(ctx);
  if (planResult.status === "failed" || planResult.status === "blocked") {
    return planResult;
  }
  // Gate stop — interactive approval required.
  if (planResult.next === "/wiki --write" || planResult.next === "gate") {
    return planResult;
  }
  const startAt = planResult.next;
  if (!startAt || !WRITE_START.test(startAt)) {
    return planResult;
  }
  if (!planResult.domainRunId || !planResult.workdir) {
    return {
      status: "failed",
      summary: "Write path requires domainRunId and workdir from prepare",
      error: "missing domain context for write path",
    };
  }

  // Lazy import avoids circular init issues between phase-graph and write-path.
  const { runWritePath } = await import("./write-path.js");
  return runWritePath({
    core: ctx.core,
    workspaceRoot: ctx.workspaceRoot,
    runId: planResult.domainRunId,
    workdir: planResult.workdir,
    startAt,
    store: ctx.store,
    pool: ctx.pool,
    runAgent: ctx.runAgent,
    tools: ctx.tools,
    cwd: ctx.cwd,
    limits: ctx.limits,
    signal: ctx.signal,
    log: ctx.log,
  });
}
