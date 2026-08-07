/**
 * SessionWikiOrchestrator — host-direct plan path with injectable agent runner.
 *
 * prepare / merge / publish go through CoreAdapter (no LLM).
 * survey / plan LLM work goes through WikiAgentRunner (default: WorkflowAgent).
 * Observation is always WikiRunStore; start() returns immediately and runs in background.
 */

import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CoreAdapter } from "../core-adapter.js";
import {
  createMockAgentRunner,
  createWorkflowAgentRunner,
  type WikiAgentRunRequest,
  type WikiAgentRunResult,
  type WikiAgentRunner,
} from "./agent-runner.js";
import {
  isTerminalOverall,
  resolveActiveOrchRunId,
  summaryFromSnapshot,
  type WikiOrchestrator,
  type WikiOrchestratorStartInput,
  type WikiOrchestratorStartResult,
} from "./orchestrator.js";
import { createTaskPool, type TaskPool } from "./pool.js";
import { runWikiPath, type PlanPathResult } from "./phase-graph.js";
import { WikiRunStore, type WikiRunStoreOptions } from "./store.js";
import {
  mergeOrchLimits,
  type OrchLimits,
  type OrchRunSummary,
  type WikiEvent,
  type WikiProgressSnapshot,
} from "./types.js";

export interface SessionWikiOrchestratorOptions {
  workspaceRoot: string;
  core: CoreAdapter;
  getTools: (root: string) => ToolDefinition[];
  /** Defaults to createWorkflowAgentRunner when omitted. */
  agentRunner?: WikiAgentRunner;
  limits?: Partial<OrchLimits>;
  /** Static fallback when getMainModel is not provided. */
  mainModel?: string;
  /** Static fallback when getModelRegistry is not provided. */
  modelRegistry?: unknown;
  /**
   * Live getters so the host can update the session model after extension
   * construction (session_start). Preferred over the static fields.
   */
  getMainModel?: () => string | undefined;
  getModelRegistry?: () => unknown;
  storeFactory?: (opts: WikiRunStoreOptions) => WikiRunStore;
  log?: (msg: string) => void;
}

interface TrackedSessionRun {
  orchRunId: string;
  store: WikiRunStore;
  workspaceRoot: string;
  mode: string;
  focus?: string;
  controller: AbortController;
  pool: TaskPool;
  promise?: Promise<PlanPathResult | undefined>;
  unsubStore?: () => void;
}

function mapPlanResultOverall(
  result: PlanPathResult,
): WikiProgressSnapshot["overall"] {
  switch (result.status) {
    case "ok":
    case "completed":
      return "completed";
    case "blocked":
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

export class SessionWikiOrchestrator implements WikiOrchestrator {
  readonly backend = "session" as const;

  private readonly defaultWorkspaceRoot: string;
  private readonly core: CoreAdapter;
  private readonly getTools: (root: string) => ToolDefinition[];
  private readonly agentRunnerOption?: WikiAgentRunner;
  private readonly limits: OrchLimits;
  private readonly mainModel?: string;
  private readonly modelRegistry?: unknown;
  private readonly getMainModel?: () => string | undefined;
  private readonly getModelRegistry?: () => unknown;
  private readonly storeFactory: (opts: WikiRunStoreOptions) => WikiRunStore;
  private readonly log?: (msg: string) => void;

  private readonly runs = new Map<string, TrackedSessionRun>();
  private activeOrchRunId?: string;
  private readonly globalListeners = new Set<
    (s: WikiProgressSnapshot, e?: WikiEvent) => void
  >();
  private disposed = false;

  constructor(options: SessionWikiOrchestratorOptions) {
    this.defaultWorkspaceRoot = options.workspaceRoot;
    this.core = options.core;
    this.getTools = options.getTools;
    this.agentRunnerOption = options.agentRunner;
    this.limits = mergeOrchLimits(options.limits);
    this.mainModel = options.mainModel;
    this.modelRegistry = options.modelRegistry;
    this.getMainModel = options.getMainModel;
    this.getModelRegistry = options.getModelRegistry;
    this.storeFactory = options.storeFactory ?? ((opts) => new WikiRunStore(opts));
    this.log = options.log;
  }

  async start(input: WikiOrchestratorStartInput): Promise<WikiOrchestratorStartResult> {
    if (this.disposed) {
      throw new Error("SessionWikiOrchestrator has been disposed");
    }

    const workspaceRoot = input.workspaceRoot || this.defaultWorkspaceRoot;
    const orchRunId = `session-${randomUUID()}`;
    const tools = this.getTools(workspaceRoot);
    const agentRunner =
      this.agentRunnerOption ??
      createWorkflowAgentRunner({
        cwd: workspaceRoot,
        tools,
        mainModel: this.getMainModel?.() ?? this.mainModel,
        modelRegistry: this.getModelRegistry?.() ?? this.modelRegistry,
      });

    const store = this.storeFactory({ workspaceRoot, orchRunId });
    store.createRun({
      orchRunId,
      backend: "session",
      mode: input.mode,
      focus: input.focus,
      workspaceRoot,
    });

    const controller = new AbortController();
    const pool = createTaskPool({ concurrency: this.limits.concurrency });

    const tracked: TrackedSessionRun = {
      orchRunId,
      store,
      workspaceRoot,
      mode: input.mode,
      focus: input.focus,
      controller,
      pool,
    };

    // Subscribe before orch.started so global listeners observe the full event stream.
    tracked.unsubStore = store.subscribe((snap, event) => {
      for (const listener of this.globalListeners) {
        try {
          listener(snap, event);
        } catch {
          // listeners must not break orchestration
        }
      }
    });

    this.runs.set(orchRunId, tracked);
    this.activeOrchRunId = orchRunId;

    store.setOverall("running");
    store.appendEvent("orch.started", {
      detail: {
        mode: input.mode,
        focus: input.focus,
        backend: "session",
      },
    });

    const runAgent = this.makeRunAgent(tracked, agentRunner, tools, workspaceRoot);

    // Fire-and-forget: start must return quickly (like DW startInBackground).
    tracked.promise = (async () => {
      try {
        const result = await runWikiPath({
          core: this.core,
          workspaceRoot,
          mode: input.mode,
          focus: input.focus,
          store,
          pool,
          runAgent,
          tools,
          cwd: workspaceRoot,
          limits: this.limits,
          signal: controller.signal,
          log: this.log,
        });

        const snap = store.getSnapshot();
        if (!isTerminalOverall(snap.overall)) {
          // Prefer cancelled when the controller aborted mid-flight.
          if (controller.signal.aborted && result.status === "failed") {
            // stop()/pause() may have already stamped overall; only fill if still running.
            if (snap.overall === "running") {
              store.setOverall("cancelled");
              store.appendEvent("orch.stopped", {
                detail: { reason: result.error ?? result.summary },
              });
            }
          } else {
            const overall = mapPlanResultOverall(result);
            store.setOverall(overall);
            if (overall === "completed") {
              store.appendEvent("orch.completed", {
                detail: {
                  status: result.status,
                  next: result.next,
                  summary: result.summary,
                  domainRunId: result.domainRunId,
                },
              });
            } else {
              store.appendEvent("orch.failed", {
                detail: {
                  status: result.status,
                  error: result.error ?? result.summary,
                  domainRunId: result.domainRunId,
                },
              });
            }
          }
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const snap = store.getSnapshot();
        if (!isTerminalOverall(snap.overall)) {
          if (controller.signal.aborted) {
            store.setOverall("cancelled");
            store.appendEvent("orch.stopped", { detail: { error: message } });
          } else {
            store.setOverall("failed");
            store.appendEvent("orch.failed", { detail: { error: message } });
          }
        }
        return undefined;
      } finally {
        try {
          pool.dispose();
        } catch {
          // ignore
        }
      }
    })();

    // Avoid unhandled rejection if nobody awaits the background promise.
    void tracked.promise.catch(() => undefined);

    return {
      orchRunId,
      domainRunId: store.getSnapshot().domainRunId,
    };
  }

  /**
   * Best-effort pause: abort in-flight agents and mark overall paused.
   * Domain checkpoints remain; resume() restarts from prepareRun startAt.
   */
  async pause(id?: string): Promise<boolean> {
    const orchRunId = this.resolveId(id);
    if (!orchRunId) return false;
    const tracked = this.runs.get(orchRunId);
    if (!tracked) return false;
    const snap = tracked.store.getSnapshot();
    if (isTerminalOverall(snap.overall) && snap.overall !== "paused") return false;

    try {
      tracked.controller.abort(new Error("paused"));
    } catch {
      // ignore
    }
    try {
      tracked.pool.dispose();
    } catch {
      // ignore
    }
    if (!isTerminalOverall(tracked.store.getSnapshot().overall) || tracked.store.getSnapshot().overall === "running") {
      tracked.store.setOverall("paused");
      tracked.store.appendEvent("orch.paused", { detail: { orchRunId } });
    }
    return true;
  }

  /**
   * Resume a paused run by starting a fresh background wiki path.
   * Domain state is recovered via core.prepareRun(startAt).
   */
  async resume(id?: string): Promise<boolean> {
    if (this.disposed) return false;
    const orchRunId = this.resolveId(id);
    if (!orchRunId) return false;
    const tracked = this.runs.get(orchRunId);
    if (!tracked) return false;
    const snap = tracked.store.getSnapshot();
    if (snap.overall !== "paused") return false;

    const workspaceRoot = tracked.workspaceRoot;
    const mode = tracked.mode;
    const focus = tracked.focus;
    const tools = this.getTools(workspaceRoot);
    const agentRunner =
      this.agentRunnerOption ??
      createWorkflowAgentRunner({
        cwd: workspaceRoot,
        tools,
        mainModel: this.getMainModel?.() ?? this.mainModel,
        modelRegistry: this.getModelRegistry?.() ?? this.modelRegistry,
      });

    // New controller + pool for the resumed attempt.
    tracked.controller = new AbortController();
    tracked.pool = createTaskPool({ concurrency: this.limits.concurrency });
    tracked.store.setOverall("running");
    tracked.store.appendEvent("orch.resumed", { detail: { orchRunId, mode } });

    const runAgent = this.makeRunAgent(tracked, agentRunner, tools, workspaceRoot);
    tracked.promise = (async () => {
      try {
        const result = await runWikiPath({
          core: this.core,
          workspaceRoot,
          mode,
          focus,
          store: tracked.store,
          pool: tracked.pool,
          runAgent,
          tools,
          cwd: workspaceRoot,
          limits: this.limits,
          signal: tracked.controller.signal,
          log: this.log,
        });
        const after = tracked.store.getSnapshot();
        if (!isTerminalOverall(after.overall)) {
          if (tracked.controller.signal.aborted && result.status === "failed") {
            if (after.overall === "running") {
              tracked.store.setOverall("cancelled");
              tracked.store.appendEvent("orch.stopped", {
                detail: { reason: result.error ?? result.summary },
              });
            }
          } else {
            const overall = mapPlanResultOverall(result);
            tracked.store.setOverall(overall);
            if (overall === "completed") {
              tracked.store.appendEvent("orch.completed", {
                detail: {
                  status: result.status,
                  next: result.next,
                  summary: result.summary,
                  domainRunId: result.domainRunId,
                },
              });
            } else {
              tracked.store.appendEvent("orch.failed", {
                detail: {
                  status: result.status,
                  error: result.error ?? result.summary,
                  domainRunId: result.domainRunId,
                },
              });
            }
          }
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const after = tracked.store.getSnapshot();
        if (!isTerminalOverall(after.overall)) {
          if (tracked.controller.signal.aborted) {
            tracked.store.setOverall("cancelled");
            tracked.store.appendEvent("orch.stopped", { detail: { error: message } });
          } else {
            tracked.store.setOverall("failed");
            tracked.store.appendEvent("orch.failed", { detail: { error: message } });
          }
        }
        return undefined;
      } finally {
        try {
          tracked.pool.dispose();
        } catch {
          // ignore
        }
      }
    })();
    void tracked.promise.catch(() => undefined);
    return true;
  }

  async stop(id?: string): Promise<boolean> {
    const orchRunId = this.resolveId(id);
    if (!orchRunId) return false;
    const tracked = this.runs.get(orchRunId);
    if (!tracked) return false;

    try {
      tracked.controller.abort(new Error("stopped"));
    } catch {
      // ignore
    }
    try {
      tracked.pool.dispose();
    } catch {
      // ignore
    }

    const snap = tracked.store.getSnapshot();
    if (!isTerminalOverall(snap.overall) || snap.overall === "paused") {
      tracked.store.setOverall("cancelled");
      tracked.store.appendEvent("orch.stopped", { detail: { orchRunId } });
    }
    return true;
  }

  list(): OrchRunSummary[] {
    return [...this.runs.values()]
      .map((t) => summaryFromSnapshot(t.store.getSnapshot()))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSnapshot(id?: string): WikiProgressSnapshot | undefined {
    const orchRunId = this.resolveId(id);
    if (!orchRunId) return undefined;
    return this.runs.get(orchRunId)?.store.getSnapshot();
  }

  getActiveSnapshot(): WikiProgressSnapshot | undefined {
    return this.getSnapshot();
  }

  subscribe(
    listener: (s: WikiProgressSnapshot, e?: WikiEvent) => void,
    id?: string,
  ): () => void {
    if (id) {
      const tracked = this.runs.get(id);
      if (!tracked) return () => undefined;
      return tracked.store.subscribe(listener);
    }
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  focusAgent(agentId: string | undefined, id?: string): void {
    const orchRunId = this.resolveId(id);
    if (!orchRunId) return;
    const tracked = this.runs.get(orchRunId);
    if (!tracked) return;
    tracked.store.setFocus(agentId);
    tracked.store.appendEvent("ui.focus_changed", {
      agentId,
      detail: { agentId },
    });
  }

  async getTranscript(
    agentId: string,
    opts?: { tail?: number },
    id?: string,
  ): Promise<unknown[]> {
    const orchRunId = this.resolveId(id);
    if (!orchRunId) return [];
    const tracked = this.runs.get(orchRunId);
    if (!tracked) return [];
    return tracked.store.readTranscript(agentId, opts);
  }

  syncFromBackend(): void {
    // Session backend is the source of truth; nothing to pull.
  }

  updateSnapshot(mutator: (s: WikiProgressSnapshot) => void, id?: string): void {
    const orchRunId = this.resolveId(id);
    if (!orchRunId) return;
    const tracked = this.runs.get(orchRunId);
    if (!tracked) return;
    tracked.store.updateSnapshot(mutator);
  }

  /** Wait for a background plan-path run (tests). */
  async waitFor(id?: string): Promise<PlanPathResult | undefined> {
    const orchRunId = this.resolveId(id);
    if (!orchRunId) return undefined;
    const tracked = this.runs.get(orchRunId);
    if (!tracked?.promise) return undefined;
    return tracked.promise;
  }

  dispose(): void {
    this.disposed = true;
    for (const tracked of this.runs.values()) {
      try {
        tracked.controller.abort(new Error("disposed"));
      } catch {
        // ignore
      }
      try {
        tracked.pool.dispose();
      } catch {
        // ignore
      }
      tracked.unsubStore?.();
    }
    this.runs.clear();
    this.globalListeners.clear();
    this.activeOrchRunId = undefined;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private resolveId(id?: string): string | undefined {
    if (id) return id;
    const fromList = resolveActiveOrchRunId(this.list(), undefined);
    return fromList ?? this.activeOrchRunId;
  }

  private makeRunAgent(
    tracked: TrackedSessionRun,
    agentRunner: WikiAgentRunner,
    defaultTools: ToolDefinition[],
    cwd: string,
  ): (
    req: Omit<WikiAgentRunRequest, "tools" | "cwd" | "signal"> & {
      signal?: AbortSignal;
      tools?: ToolDefinition[];
    },
  ) => Promise<WikiAgentRunResult | null> {
    const { store, controller } = tracked;
    const limits = this.limits;

    return async (req) => {
      const agentId = req.agentId;
      const startedAt = Date.now();
      store.upsertAgent({
        agentId,
        label: req.label,
        role: req.role,
        phase: req.phase,
        status: "running",
        unitIds: req.unitIds,
        pagePaths: req.pagePaths,
        startedAt,
        elapsedMs: 0,
        receiptsWritten: 0,
        lastHeartbeatAt: startedAt,
      });
      store.appendEvent("agent.started", {
        agentId,
        phase: req.phase,
        detail: { label: req.label, unitIds: req.unitIds, pagePaths: req.pagePaths },
      });

      const outer = req.signal ?? controller.signal;
      const combined =
        outer === controller.signal
          ? outer
          : typeof AbortSignal.any === "function"
            ? AbortSignal.any([outer, controller.signal])
            : outer;

      // Heartbeat while the agent is in flight (best-effort observation).
      const heartbeat = setInterval(() => {
        try {
          store.upsertAgent({
            agentId,
            lastHeartbeatAt: Date.now(),
            elapsedMs: Date.now() - startedAt,
          });
          store.appendEvent("agent.heartbeat", { agentId, phase: req.phase });
        } catch {
          // ignore
        }
      }, limits.heartbeatMs);
      heartbeat.unref?.();

      try {
        const result = await agentRunner.run({
          agentId: req.agentId,
          label: req.label,
          phase: req.phase,
          role: req.role,
          prompt: req.prompt,
          schema: req.schema,
          unitIds: req.unitIds,
          pagePaths: req.pagePaths,
          signal: combined,
          tools: req.tools ?? defaultTools,
          cwd,
          onHistory: (entry) => {
            store.appendTranscript(agentId, entry);
            // Tool observation when history looks like a tool call.
            const rec = entry as {
              kind?: string;
              toolName?: string;
              path?: string;
              role?: string;
            };
            if (rec.kind === "toolCall" || rec.toolName) {
              store.upsertAgent({
                agentId,
                status: "waiting_tool",
                lastTool: {
                  name: rec.toolName ?? "tool",
                  path: rec.path,
                  at: Date.now(),
                },
                lastHeartbeatAt: Date.now(),
              });
              store.appendEvent("agent.tool", {
                agentId,
                phase: req.phase,
                detail: entry,
              });
            }
          },
        });

        const endedAt = Date.now();
        const ok = result && result.status === "ok";
        store.upsertAgent({
          agentId,
          status: ok ? "succeeded" : combined.aborted ? "cancelled" : "failed",
          endedAt,
          elapsedMs: endedAt - startedAt,
          lastError: ok
            ? undefined
            : (result && typeof result.summary === "string" ? result.summary : "agent failed"),
          lastHeartbeatAt: endedAt,
        });
        store.appendEvent(ok ? "agent.succeeded" : "agent.failed", {
          agentId,
          phase: req.phase,
          detail: result ?? undefined,
        });
        return result;
      } catch (err) {
        const endedAt = Date.now();
        const message = err instanceof Error ? err.message : String(err);
        const cancelled = combined.aborted || (err as { name?: string })?.name === "AbortError";
        store.upsertAgent({
          agentId,
          status: cancelled ? "cancelled" : "failed",
          endedAt,
          elapsedMs: endedAt - startedAt,
          lastError: message,
          lastHeartbeatAt: endedAt,
        });
        store.appendEvent(cancelled ? "agent.cancelled" : "agent.failed", {
          agentId,
          phase: req.phase,
          detail: { error: message },
        });
        if (cancelled) throw err;
        return { status: "failed", summary: message };
      } finally {
        clearInterval(heartbeat);
      }
    };
  }
}

export function createSessionOrchestrator(
  options: SessionWikiOrchestratorOptions,
): SessionWikiOrchestrator {
  return new SessionWikiOrchestrator(options);
}

// Re-export mock helper for test ergonomics alongside the session factory.
export { createMockAgentRunner };
