/** Run-scoped persistent-session orchestrator for the v5 Markdown Wiki workflow. */

import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OrchestrationCore, WikiRunPaths, WikiRunState } from "../core.js";
import { createPersistentPiAgentRunner, createPiAgentRunner, type WikiAgentRunner } from "./agent-runner.js";
import {
  isTerminalOverall,
  resolveActiveOrchestrationId,
  summaryFromSnapshot,
  type WikiOrchestrator,
  type WikiOrchestratorStartInput,
  type WikiOrchestratorStartResult,
} from "./orchestrator.js";
import { createTaskPool, type TaskPool } from "./pool.js";
import { runWikiPath, type WikiPathResult, type WikiPathStart } from "./phase-graph.js";
import { WikiRunStore } from "./store.js";
import {
  mergeOrchLimits,
  type OrchLimits,
  type OrchRunSummary,
  type WikiEvent,
  type WikiAgentRole,
  type WikiObservationEntry,
  type WikiProgressSnapshot,
} from "./types.js";

export interface SessionWikiOrchestratorOptions {
  workspaceRoot: string;
  core: OrchestrationCore;
  getTools: (root: string, role: WikiAgentRole) => ToolDefinition[];
  /** Test hook. Production uses a persisted main runner plus short-lived critics. */
  agentRunner?: WikiAgentRunner;
  limits?: Partial<OrchLimits>;
  mainModel?: string;
  modelRegistry?: unknown;
  getMainModel?: () => string | undefined;
  getModelRegistry?: () => unknown;
  now?: () => number;
}

interface TrackedSessionRun {
  orchestrationId: string;
  runId: string;
  store: WikiRunStore;
  workspaceRoot: string;
  paths: WikiRunPaths;
  controller: AbortController;
  pool: TaskPool;
  promise?: Promise<WikiPathResult>;
  unsubStore?: () => void;
}

interface MainSessionAgent {
  runner: WikiAgentRunner;
  mainSessionPath: string;
}

function resolveMainSessionPath(paths: WikiRunPaths, raw: string): string {
  return isAbsolute(raw) ? raw : resolve(dirname(paths.inputsDir), raw);
}

export class SessionWikiOrchestrator implements WikiOrchestrator {
  readonly backend = "session" as const;

  private readonly defaultWorkspaceRoot: string;
  private readonly core: OrchestrationCore;
  private readonly getTools: (root: string, role: WikiAgentRole) => ToolDefinition[];
  private readonly agentRunnerOption?: WikiAgentRunner;
  private readonly limits: OrchLimits;
  private readonly mainModel?: string;
  private readonly modelRegistry?: unknown;
  private readonly getMainModel?: () => string | undefined;
  private readonly getModelRegistry?: () => unknown;
  private readonly now: () => number;
  private readonly runs = new Map<string, TrackedSessionRun>();
  private readonly starting = new Set<Promise<WikiOrchestratorStartResult>>();
  private activeOrchestrationId?: string;
  private readonly globalListeners = new Set<(s: WikiProgressSnapshot, e?: WikiEvent) => void>();
  private disposed = false;
  private disposePromise?: Promise<void>;

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
    this.now = options.now ?? Date.now;
  }

  start(input: WikiOrchestratorStartInput): Promise<WikiOrchestratorStartResult> {
    if (this.disposed) return Promise.reject(new Error("SessionWikiOrchestrator has been disposed"));
    const starting = this.startInternal(input);
    this.starting.add(starting);
    starting.then(
      () => this.starting.delete(starting),
      () => this.starting.delete(starting),
    );
    return starting;
  }

  private async startInternal(input: WikiOrchestratorStartInput): Promise<WikiOrchestratorStartResult> {
    const workspaceRoot = input.workspaceRoot || this.defaultWorkspaceRoot;
    const orchestrationId = `session-${randomUUID()}`;
    let prepared: Awaited<ReturnType<SessionWikiOrchestrator["openRun"]>> | undefined;
    let tracked: TrackedSessionRun | undefined;
    try {
      prepared = await this.openRun(workspaceRoot, input, orchestrationId);
      if (this.disposed) throw new Error("SessionWikiOrchestrator has been disposed");
      const store = new WikiRunStore({ workspaceRoot, runId: prepared.runId, orchestrationId, now: this.now });
      store.createRun({
        orchestrationId,
        runId: prepared.runId,
        backend: "session",
        mode: input.action,
        focus: input.focus,
        workspaceRoot,
      });
      const controller = new AbortController();
      const pool = createTaskPool({ concurrency: this.limits.concurrency });
      tracked = {
        orchestrationId,
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
      this.runs.set(orchestrationId, tracked);
      this.activeOrchestrationId = orchestrationId;
      store.setOverall("running");
      store.appendEvent("orch.started", { detail: { action: input.action, runId: prepared.runId } });

      const tools = this.getTools(workspaceRoot, "main");
      const mainSession = this.mainRunner(workspaceRoot, tools, prepared.paths, prepared.state);
      await this.core.recordMainSession(workspaceRoot, {
        runId: prepared.runId,
        mainSessionPath: mainSession.mainSessionPath,
      });
      if (this.disposed) throw new Error("SessionWikiOrchestrator has been disposed");
      this.startBackground(tracked, {
        runId: prepared.runId,
        paths: prepared.paths,
        start: prepared.start,
        focus: input.focus,
        tools,
        mainSession,
      });
      return { orchestrationId, runId: prepared.runId };
    } catch (error) {
      tracked?.controller.abort(error);
      tracked?.pool.dispose();
      tracked?.unsubStore?.();
      this.runs.delete(orchestrationId);
      if (this.activeOrchestrationId === orchestrationId) this.activeOrchestrationId = undefined;
      if (prepared) await this.releaseRun(workspaceRoot, prepared.runId, orchestrationId);
      throw error;
    }
  }

  async pause(id?: string): Promise<boolean> {
    const tracked = this.tracked(id);
    if (!tracked || isTerminalOverall(tracked.store.getSnapshot().overall)) return false;
      tracked.controller.abort(new Error("paused"));
      tracked.pool.dispose();
    await this.core.reportRunStatus(tracked.workspaceRoot, {
      runId: tracked.runId,
      status: "paused",
    }).catch(() => undefined);
    tracked.store.setOverall("paused");
    tracked.store.appendEvent("orch.paused", { detail: { runId: tracked.runId } });
    await tracked.store.flush();
    // A resumed run must claim only after this aborted workflow releases its claim.
    await tracked.promise;
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
    await this.core.reportRunStatus(tracked.workspaceRoot, {
      runId: tracked.runId,
      status: "stopped",
      error: "Stopped by user",
    }).catch(() => undefined);
    if (!isTerminalOverall(tracked.store.getSnapshot().overall)) tracked.store.setOverall("cancelled");
    tracked.store.appendEvent("orch.stopped", { detail: { runId: tracked.runId } });
    await tracked.store.flush();
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

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const draining = [...this.runs.values()];
    const starting = [...this.starting];
    for (const tracked of draining) {
      tracked.controller.abort(new Error("disposed"));
      tracked.pool.dispose();
    }
    this.disposePromise = (async () => {
      await Promise.allSettled([
        ...draining.map((tracked) => tracked.promise ?? Promise.resolve()),
        ...starting,
      ]);
      await Promise.allSettled([...this.runs.values()].map((tracked) => tracked.promise ?? Promise.resolve()));
      for (const tracked of this.runs.values()) tracked.unsubStore?.();
      this.runs.clear();
      this.starting.clear();
      this.globalListeners.clear();
      this.activeOrchestrationId = undefined;
    })();
    return this.disposePromise;
  }

  private async openRun(
    workspaceRoot: string,
    input: WikiOrchestratorStartInput,
    orchestrationId: string,
  ): Promise<{ runId: string; paths: WikiRunPaths; state?: WikiRunState; start: WikiPathStart }> {
    let runId = input.runId;
    let state: WikiRunState | undefined;
    let start: WikiPathStart = "discover";
    let generated: Awaited<ReturnType<OrchestrationCore["prepareRun"]>> | undefined;
    let claimed = false;
    if (input.action === "generate") {
      generated = await this.core.prepareRun(workspaceRoot, { focus: input.focus });
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
      await this.core.claimRun(workspaceRoot, { runId, orchestrationId });
      claimed = true;
      if (input.action === "generate") {
        state = await this.core.getRunState(workspaceRoot, { runId });
        start = generated!.resumeAt;
      } else {
        const transition = input.action === "approve"
          ? await this.core.approveRun(workspaceRoot, { runId })
          : await this.core.resumeRun(workspaceRoot, { runId });
        state = transition.state;
        start = transition.resumeAt;
      }
      const paths = await this.core.getRunPaths(workspaceRoot, { runId });
      if (!paths) throw new Error(`Wiki run ${runId} has no accessible run paths`);
      return { runId, paths, state, start };
    } catch (error) {
      if (claimed) await this.releaseRun(workspaceRoot, runId, orchestrationId);
      throw error;
    }
  }

  private mainRunner(
    workspaceRoot: string,
    tools: ToolDefinition[],
    paths: WikiRunPaths,
    state: WikiRunState | undefined,
  ): MainSessionAgent {
    if (this.agentRunnerOption) {
      return {
        runner: this.agentRunnerOption,
        mainSessionPath: state?.mainSessionPath ?? join(paths.mainSessionDir, "main.jsonl"),
      };
    }
    const sessionManager = state?.mainSessionPath
      ? SessionManager.open(resolveMainSessionPath(paths, state.mainSessionPath), paths.mainSessionDir, workspaceRoot)
      : SessionManager.create(workspaceRoot, paths.mainSessionDir);
    const runner = createPersistentPiAgentRunner({
      cwd: workspaceRoot,
      tools,
      mainModel: this.getMainModel?.() ?? this.mainModel,
      modelRegistry: this.getModelRegistry?.() ?? this.modelRegistry,
      sessionManager,
    });
    const mainSessionPath = runner.getSessionFile();
    if (!mainSessionPath) throw new Error("Pi did not create a persisted Wiki session file");
    return { runner, mainSessionPath };
  }

  private ephemeralRunner(workspaceRoot: string, role: Exclude<WikiAgentRole, "main">): WikiAgentRunner {
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
    options: { runId: string; paths: WikiRunPaths; start: WikiPathStart; focus?: string; tools: ToolDefinition[]; mainSession: MainSessionAgent },
  ): void {
    tracked.promise = runWikiPath({
      core: this.core,
      workspaceRoot: tracked.workspaceRoot,
      runId: options.runId,
      paths: options.paths,
      focus: options.focus,
      store: tracked.store,
      pool: tracked.pool,
      mainAgent: options.mainSession.runner,
      createEphemeralAgent: (role) => this.ephemeralRunner(tracked.workspaceRoot, role),
      toolsForRole: (role) => role === "main" ? options.tools : this.getTools(tracked.workspaceRoot, role),
      cwd: tracked.workspaceRoot,
      limits: this.limits,
      signal: tracked.controller.signal,
      now: this.now,
    }, { start: options.start }).then(async (result): Promise<WikiPathResult> => {
      const snapshot = tracked.store.getSnapshot();
      if (tracked.controller.signal.aborted || isTerminalOverall(snapshot.overall)) return result;
      if (result.status === "proposed") {
        tracked.store.setOverall("proposed");
        tracked.store.appendEvent("orch.proposed", { detail: { status: result.status, summary: result.summary, runId: tracked.runId } });
      } else if (result.status === "quality_blocked") {
        tracked.store.setOverall("quality_blocked");
        tracked.store.appendEvent("orch.quality_blocked", { detail: { status: result.status, error: result.error, runId: tracked.runId } });
      } else if (result.status === "failed") {
        tracked.store.setOverall("failed");
        tracked.store.appendEvent("orch.failed", { detail: { error: result.error, runId: tracked.runId } });
      } else {
        // A proposed plan is a successful terminal state for the current command.
        tracked.store.setOverall("complete");
        tracked.store.appendEvent("orch.complete", { detail: { status: result.status, summary: result.summary, runId: tracked.runId } });
      }
      return result;
    }).catch(async (error: unknown): Promise<WikiPathResult> => {
      const message = error instanceof Error ? error.message : String(error);
      if (!tracked.controller.signal.aborted && !isTerminalOverall(tracked.store.getSnapshot().overall)) {
        await this.core.reportRunStatus(tracked.workspaceRoot, {
          runId: tracked.runId,
          status: "failed",
          error: message,
        }).catch(() => undefined);
        tracked.store.setOverall("failed");
        tracked.store.appendEvent("orch.failed", { detail: { error: message, runId: tracked.runId } });
      }
      return { status: "failed", runId: tracked.runId, error: message };
    }).finally(async () => {
      try { tracked.pool.dispose(); } catch { /* ignore */ }
      await this.releaseRun(tracked.workspaceRoot, tracked.runId, tracked.orchestrationId);
      await tracked.store.flush();
    });
    void tracked.promise!.catch(() => undefined);
  }

  private tracked(id?: string): TrackedSessionRun | undefined {
    const resolved = id ?? resolveActiveOrchestrationId(this.list(), undefined) ?? this.activeOrchestrationId;
    return resolved ? this.runs.get(resolved) : undefined;
  }

  private async releaseRun(workspaceRoot: string, runId: string, orchestrationId: string): Promise<void> {
    await this.core.releaseRun(workspaceRoot, { runId, orchestrationId }).catch(() => undefined);
  }
}

export function createSessionOrchestrator(options: SessionWikiOrchestratorOptions): SessionWikiOrchestrator {
  return new SessionWikiOrchestrator(options);
}
