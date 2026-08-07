/** Run-scoped persistent-session orchestrator for the v4 Markdown Wiki workflow. */

import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CoreAdapter, WikiRunPaths, WikiRunState } from "../core-adapter.js";
import {
  createPersistentPiAgentRunner,
  createPiAgentRunner,
  type PersistentPiAgentRunner,
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
import { runWikiPath, type WikiPathResult } from "./phase-graph.js";
import { WikiRunStore, type WikiRunStoreOptions } from "./store.js";
import {
  mergeOrchLimits,
  type OrchLimits,
  type OrchRunSummary,
  type WikiEvent,
  type WikiObservationEntry,
  type WikiProgressSnapshot,
} from "./types.js";

export interface SessionWikiOrchestratorOptions {
  workspaceRoot: string;
  core: CoreAdapter;
  getTools: (root: string, role: "main" | "discover" | "coverage-critic" | "reviewer") => ToolDefinition[];
  /** Test hook. Production uses a persisted main runner plus short-lived critics. */
  agentRunner?: WikiAgentRunner;
  limits?: Partial<OrchLimits>;
  mainModel?: string;
  modelRegistry?: unknown;
  getMainModel?: () => string | undefined;
  getModelRegistry?: () => unknown;
  storeFactory?: (opts: WikiRunStoreOptions) => WikiRunStore;
}

interface TrackedSessionRun {
  orchRunId: string;
  lockOwner: string;
  runId: string;
  store: WikiRunStore;
  workspaceRoot: string;
  paths: WikiRunPaths;
  controller: AbortController;
  pool: TaskPool;
  promise?: Promise<WikiPathResult>;
  unsubStore?: () => void;
}

function sessionPathForOpen(paths: WikiRunPaths, raw: string): string {
  return isAbsolute(raw) ? raw : resolve(dirname(paths.inputsDir), raw);
}

function startForState(state: WikiRunState | undefined): "planning" | "writing" {
  return state?.status === "writing" || state?.status === "validating" || state?.status === "approved"
    ? "writing"
    : "planning";
}

function startForCorePhase(value: unknown, fallback: WikiRunState | undefined): "planning" | "writing" {
  return value === "writing" || value === "validating" ? "writing" : startForState(fallback);
}

export class SessionWikiOrchestrator implements WikiOrchestrator {
  readonly backend = "session" as const;

  private readonly defaultWorkspaceRoot: string;
  private readonly core: CoreAdapter;
  private readonly getTools: (root: string, role: "main" | "discover" | "coverage-critic" | "reviewer") => ToolDefinition[];
  private readonly agentRunnerOption?: WikiAgentRunner;
  private readonly limits: OrchLimits;
  private readonly mainModel?: string;
  private readonly modelRegistry?: unknown;
  private readonly getMainModel?: () => string | undefined;
  private readonly getModelRegistry?: () => unknown;
  private readonly storeFactory: (opts: WikiRunStoreOptions) => WikiRunStore;
  private readonly runs = new Map<string, TrackedSessionRun>();
  private activeOrchRunId?: string;
  private readonly globalListeners = new Set<(s: WikiProgressSnapshot, e?: WikiEvent) => void>();
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
  }

  async start(input: WikiOrchestratorStartInput): Promise<WikiOrchestratorStartResult> {
    if (this.disposed) throw new Error("SessionWikiOrchestrator has been disposed");
    const workspaceRoot = input.workspaceRoot || this.defaultWorkspaceRoot;
    const orchRunId = `session-${randomUUID()}`;
    let prepared: Awaited<ReturnType<SessionWikiOrchestrator["openRun"]>> | undefined;
    let tracked: TrackedSessionRun | undefined;
    try {
      prepared = await this.openRun(workspaceRoot, input, orchRunId);
      const store = this.storeFactory({ workspaceRoot, runId: prepared.runId, orchRunId });
      store.createRun({
        orchRunId,
        runId: prepared.runId,
        backend: "session",
        mode: input.action,
        focus: input.focus,
        workspaceRoot,
      });
      const controller = new AbortController();
      const pool = createTaskPool({ concurrency: this.limits.concurrency });
      tracked = {
        orchRunId,
        lockOwner: orchRunId,
        runId: prepared.runId,
        store,
        workspaceRoot,
        paths: prepared.paths,
        controller,
        pool,
      };
      tracked.unsubStore = store.subscribe((snapshot, event) => {
        for (const listener of this.globalListeners) {
          try { listener(snapshot, event); } catch { /* observers cannot stop a run */ }
        }
      });
      this.runs.set(orchRunId, tracked);
      this.activeOrchRunId = orchRunId;
      store.setOverall("running");
      store.appendEvent("orch.started", { detail: { action: input.action, runId: prepared.runId } });

      const tools = this.getTools(workspaceRoot, "main");
      const mainAgent = this.mainRunner(workspaceRoot, tools, prepared.paths, prepared.state);
      const sessionPath = mainAgent.getSessionFile();
      if (!sessionPath) throw new Error("Pi did not create a persisted Wiki session file");
      await this.core.setRunStatus(workspaceRoot, {
        runId: prepared.runId,
        status: prepared.start === "planning" ? "planning" : "writing",
        sessionPath,
      });

      this.startBackground(tracked, {
        runId: prepared.runId,
        paths: prepared.paths,
        start: prepared.start,
        focus: input.focus,
        tools,
        mainAgent,
      });
      return { orchRunId, runId: prepared.runId };
    } catch (error) {
      tracked?.controller.abort(error);
      tracked?.pool.dispose();
      tracked?.unsubStore?.();
      this.runs.delete(orchRunId);
      if (this.activeOrchRunId === orchRunId) this.activeOrchRunId = undefined;
      if (prepared) await this.releaseRun(workspaceRoot, prepared.runId, orchRunId);
      throw error;
    }
  }

  async pause(id?: string): Promise<boolean> {
    const tracked = this.tracked(id);
    if (!tracked || isTerminalOverall(tracked.store.getSnapshot().overall)) return false;
    tracked.controller.abort(new Error("paused"));
    tracked.pool.dispose();
    await this.core.setRunStatus(tracked.workspaceRoot, {
      runId: tracked.runId,
      status: "paused",
      sessionPath: await this.persistedSessionPath(tracked),
    }).catch(() => undefined);
    tracked.store.setOverall("paused");
    tracked.store.appendEvent("orch.paused", { detail: { runId: tracked.runId } });
    return true;
  }

  async resume(id?: string): Promise<boolean> {
    if (this.disposed) return false;
    const tracked = this.tracked(id);
    const workspaceRoot = tracked?.workspaceRoot ?? this.defaultWorkspaceRoot;
    let runId = tracked?.runId ?? id;
    if (!runId) {
      const status = await this.core.getWorkspaceStatus(workspaceRoot).catch(() => undefined);
      runId = status?.activeRunId ?? status?.active?.runId;
    }
    if (!runId) return false;
    try {
      await this.start({ workspaceRoot, action: "resume", runId });
      return true;
    } catch {
      return false;
    }
  }

  async stop(id?: string): Promise<boolean> {
    const tracked = this.tracked(id);
    if (!tracked) return false;
    tracked.controller.abort(new Error("stopped"));
    tracked.pool.dispose();
    await this.core.setRunStatus(tracked.workspaceRoot, {
      runId: tracked.runId,
      status: "stopped",
      sessionPath: await this.persistedSessionPath(tracked),
      error: "Stopped by user",
    }).catch(() => undefined);
    if (!isTerminalOverall(tracked.store.getSnapshot().overall)) tracked.store.setOverall("cancelled");
    tracked.store.appendEvent("orch.stopped", { detail: { runId: tracked.runId } });
    return true;
  }

  list(): OrchRunSummary[] {
    return [...this.runs.values()].map((run) => summaryFromSnapshot(run.store.getSnapshot())).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSnapshot(id?: string): WikiProgressSnapshot | undefined {
    return this.tracked(id)?.store.getSnapshot();
  }

  getActiveSnapshot(): WikiProgressSnapshot | undefined { return this.getSnapshot(); }

  subscribe(listener: (s: WikiProgressSnapshot, e?: WikiEvent) => void, id?: string): () => void {
    if (id) return this.tracked(id)?.store.subscribe(listener) ?? (() => undefined);
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  async getTranscript(agentId: string, opts?: { tail?: number }, id?: string): Promise<WikiObservationEntry[]> {
    return this.tracked(id)?.store.readTranscript(agentId, opts) ?? [];
  }

  syncFromBackend(): void { /* core is queried directly for durable run state by the extension */ }

  updateSnapshot(mutator: (s: WikiProgressSnapshot) => void, id?: string): void {
    this.tracked(id)?.store.updateSnapshot(mutator);
  }

  async waitFor(id?: string): Promise<WikiPathResult | undefined> {
    return this.tracked(id)?.promise;
  }

  dispose(): void {
    this.disposed = true;
    for (const tracked of this.runs.values()) {
      tracked.controller.abort(new Error("disposed"));
      tracked.pool.dispose();
      void this.releaseRun(tracked.workspaceRoot, tracked.runId, tracked.lockOwner);
      tracked.unsubStore?.();
    }
    this.runs.clear();
    this.globalListeners.clear();
    this.activeOrchRunId = undefined;
  }

  private async openRun(
    workspaceRoot: string,
    input: WikiOrchestratorStartInput,
    lockOwner: string,
  ): Promise<{ runId: string; paths: WikiRunPaths; state?: WikiRunState; start: "planning" | "writing" }> {
    let runId = input.runId;
    let state: WikiRunState | undefined;
    let start: "planning" | "writing" = "planning";
    let generated: Awaited<ReturnType<CoreAdapter["prepareRun"]>> | undefined;
    let claimed = false;
    if (input.action === "generate") {
      generated = await this.core.prepareRun(workspaceRoot, { focus: input.focus });
      if (generated.status !== "ok") throw new Error(generated.summary ?? "Wiki run preparation failed");
      runId = generated.runId;
    } else {
      if (!runId) {
        const workspace = await this.core.getWorkspaceStatus(workspaceRoot);
        runId = workspace.activeRunId ?? workspace.active?.runId;
      }
      if (!runId) throw new Error("No active Wiki run is available.");
    }
    if (!runId) throw new Error("Wiki core did not return a run id");
    try {
      await this.core.claimRun(workspaceRoot, { runId, owner: lockOwner });
      claimed = true;
      if (input.action === "generate") {
        state = await this.core.getRunState(workspaceRoot, { runId });
        start = startForCorePhase(generated?.startAt, state);
      } else {
        const transition = input.action === "approve"
          ? await this.core.approveRun(workspaceRoot, { runId })
          : await this.core.resumeRun(workspaceRoot, { runId });
        const transitionState = (transition as { state?: WikiRunState }).state ?? transition;
        state = (await this.core.getRunState(workspaceRoot, { runId })) ?? transitionState;
        // The core returns a transient recovery point; retain it even after state reload.
        start = input.action === "approve"
          ? "writing"
          : startForCorePhase((transition as { startAt?: unknown }).startAt, transitionState);
      }
      const paths = await this.core.getRunPaths(workspaceRoot, { runId });
      if (!paths) throw new Error(`Wiki run ${runId} has no accessible run paths`);
      return { runId, paths, state, start };
    } catch (error) {
      if (claimed) await this.releaseRun(workspaceRoot, runId, lockOwner);
      throw error;
    }
  }

  private mainRunner(
    workspaceRoot: string,
    tools: ToolDefinition[],
    paths: WikiRunPaths,
    state: WikiRunState | undefined,
  ): PersistentPiAgentRunner {
    if (this.agentRunnerOption) {
      return { run: (request) => this.agentRunnerOption!.run(request), getSessionFile: () => state?.sessionPath ?? join(paths.sessionDir, "main.jsonl") };
    }
    const sessionManager = state?.sessionPath
      ? SessionManager.open(sessionPathForOpen(paths, state.sessionPath), paths.sessionDir, workspaceRoot)
      : SessionManager.create(workspaceRoot, paths.sessionDir);
    return createPersistentPiAgentRunner({
      cwd: workspaceRoot,
      tools,
      mainModel: this.getMainModel?.() ?? this.mainModel,
      modelRegistry: this.getModelRegistry?.() ?? this.modelRegistry,
      sessionManager,
    });
  }

  private ephemeralRunner(workspaceRoot: string, role: "discover" | "coverage-critic" | "reviewer"): WikiAgentRunner {
    if (this.agentRunnerOption) return this.agentRunnerOption;
    return createPiAgentRunner({
      cwd: workspaceRoot,
      tools: this.getTools(workspaceRoot, role),
      mainModel: this.getMainModel?.() ?? this.mainModel,
      modelRegistry: this.getModelRegistry?.() ?? this.modelRegistry,
    });
  }

  private startBackground(
    tracked: TrackedSessionRun,
    options: { runId: string; paths: WikiRunPaths; start: "planning" | "writing"; focus?: string; tools: ToolDefinition[]; mainAgent: PersistentPiAgentRunner },
  ): void {
    tracked.promise = runWikiPath({
      core: this.core,
      workspaceRoot: tracked.workspaceRoot,
      runId: options.runId,
      paths: options.paths,
      sessionPath: options.mainAgent.getSessionFile(),
      focus: options.focus,
      store: tracked.store,
      pool: tracked.pool,
      mainAgent: options.mainAgent,
      createEphemeralAgent: (role) => this.ephemeralRunner(tracked.workspaceRoot, role),
      toolsForRole: (role) => role === "main" ? options.tools : this.getTools(tracked.workspaceRoot, role),
      cwd: tracked.workspaceRoot,
      limits: this.limits,
      signal: tracked.controller.signal,
    }, { start: options.start }).then(async (result): Promise<WikiPathResult> => {
      const snapshot = tracked.store.getSnapshot();
      if (tracked.controller.signal.aborted || isTerminalOverall(snapshot.overall)) return result;
      if (result.status === "failed") {
        tracked.store.setOverall("failed");
        tracked.store.appendEvent("orch.failed", { detail: { error: result.error, runId: tracked.runId } });
      } else {
        // A proposed plan is a successful terminal state for the current command.
        tracked.store.setOverall("completed");
        tracked.store.appendEvent("orch.completed", { detail: { status: result.status, summary: result.summary, runId: tracked.runId } });
      }
      return result;
    }).catch(async (error: unknown): Promise<WikiPathResult> => {
      const message = error instanceof Error ? error.message : String(error);
      if (!tracked.controller.signal.aborted && !isTerminalOverall(tracked.store.getSnapshot().overall)) {
        await this.core.setRunStatus(tracked.workspaceRoot, {
          runId: tracked.runId,
          status: "failed",
          sessionPath: await this.persistedSessionPath(tracked),
          error: message,
        }).catch(() => undefined);
        tracked.store.setOverall("failed");
        tracked.store.appendEvent("orch.failed", { detail: { error: message, runId: tracked.runId } });
      }
      return { status: "failed", runId: tracked.runId, error: message };
    }).finally(async () => {
      try { tracked.pool.dispose(); } catch { /* ignore */ }
      await this.releaseRun(tracked.workspaceRoot, tracked.runId, tracked.lockOwner);
    });
    void tracked.promise!.catch(() => undefined);
  }

  private tracked(id?: string): TrackedSessionRun | undefined {
    const resolved = id ?? resolveActiveOrchRunId(this.list(), undefined) ?? this.activeOrchRunId;
    return resolved ? this.runs.get(resolved) : undefined;
  }

  private async persistedSessionPath(tracked: TrackedSessionRun): Promise<string | undefined> {
    return (await this.core.getRunState(tracked.workspaceRoot, { runId: tracked.runId }).catch(() => undefined))?.sessionPath;
  }

  private async releaseRun(workspaceRoot: string, runId: string, owner: string): Promise<void> {
    await this.core.releaseRun(workspaceRoot, { runId, owner }).catch(() => undefined);
  }
}

export function createSessionOrchestrator(options: SessionWikiOrchestratorOptions): SessionWikiOrchestrator {
  return new SessionWikiOrchestrator(options);
}
