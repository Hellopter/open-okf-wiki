import type { WikiWorkflowEngine } from "./engine.js";
import { allowedWikiRunActions } from "./run-view.js";
import type { WikiRunRequest, WikiRunSnapshot } from "./workflow-types.js";

export type WikiRunIntent =
  | { type: "start"; request: WikiRunRequest }
  | { type: "pause" }
  | { type: "resume"; runId?: string }
  | { type: "stop" }
  | { type: "cancel"; runId?: string }
  | { type: "retryNode"; runId: string; nodeId: string }
  | { type: "retryPhase"; runId: string; phaseId: string }
  | { type: "delete"; runId: string };

export interface WikiApplicationOwnership {
  /** True only when this dispatch acquired the underlying workspace lock. */
  readonly acquired: boolean;
  update(runId: string): Promise<void>;
  release(): Promise<void>;
}

export interface WikiApplicationDependencies {
  engine: WikiWorkflowEngine;
  acquire(runId?: string): Promise<WikiApplicationOwnership>;
  persist(snapshot: WikiRunSnapshot): Promise<void>;
  flush(): Promise<void>;
  loadRun(runId: string): Promise<WikiRunSnapshot | undefined>;
  listRecoverable(exceptRunId?: string): Promise<WikiRunSnapshot[]>;
  bindLatestRecoverable(): Promise<WikiRunSnapshot>;
  bindRecoverable(runId?: string): Promise<WikiRunSnapshot>;
  resume(runId?: string): Promise<WikiRunSnapshot | undefined>;
  deleteRun(runId: string): Promise<void>;
}

/**
 * Workspace-run application Module. It owns action ordering and workspace
 * ownership; Pi commands and the Navigator are adapters over dispatch().
 */
export class WikiWorkflowApplication {
  private ownership: WikiApplicationOwnership | undefined;
  private intentChain = Promise.resolve();
  private generation = 0;
  private readonly pendingSettles = new Set<Promise<void>>();

  constructor(private readonly dependencies: WikiApplicationDependencies) {}

  private snapshot(): WikiRunSnapshot | undefined {
    return this.dependencies.engine.getSnapshot();
  }

  async dispatch(intent: WikiRunIntent): Promise<WikiRunSnapshot | undefined> {
    const operation = this.intentChain.then(async () => await this.dispatchNow(intent));
    this.intentChain = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  private async dispatchNow(intent: WikiRunIntent): Promise<WikiRunSnapshot | undefined> {
    const generation = ++this.generation;
    const targetRunId = ("runId" in intent && intent.runId) ? intent.runId : this.snapshot()?.id;
    const ownership = await this.dependencies.acquire(targetRunId);
    this.ownership = ownership;
    try {
      const result = await this.apply(intent, ownership, generation);
      const current = this.snapshot();
      if (intent.type !== "pause" && (!current || current.status !== "running")) {
        await this.release(ownership);
      }
      return result ?? current;
    } catch (error) {
      if (ownership.acquired) await this.release(ownership);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    await this.intentChain;
    await Promise.all([...this.pendingSettles]);
    await this.dependencies.flush();
    if (this.ownership) await this.release(this.ownership);
  }

  private async apply(
    intent: WikiRunIntent,
    ownership: WikiApplicationOwnership,
    generation: number,
  ): Promise<WikiRunSnapshot | undefined> {
    const engine = this.dependencies.engine;
    switch (intent.type) {
      case "start": {
        const recoverable = await this.dependencies.listRecoverable();
        if (recoverable.length > 0) {
          const ids = recoverable.map((run) => run.id);
          throw new Error(`A recoverable Wiki run already exists. Resume ${ids.join(", ")} or cancel ${ids.join(", ")} before starting another run.`);
        }
        const snapshot = engine.start(intent.request);
        await ownership.update(snapshot.id);
        await this.dependencies.persist(snapshot);
        return snapshot;
      }
      case "pause": {
        if (!engine.getSnapshot()) await this.dependencies.bindLatestRecoverable();
        const current = requiredSnapshot(engine);
        if (current.status !== "paused") assertAllowed("pause", current, current.id);
        await ownership.update(current.id);
        if (current.status !== "paused") engine.pause();
        await this.dependencies.persist(requiredSnapshot(engine));
        const pausedRunId = current.id;
        const settle = (async () => {
          try {
            await engine.waitForIdle();
            if (this.generation !== generation) return;
            const settled = requiredSnapshot(engine);
            if (settled.id !== pausedRunId || settled.status !== "paused") return;
            await this.dependencies.persist(settled);
            await this.release(ownership);
          } catch {
            // A failed settled checkpoint retains ownership. A later action or
            // shutdown can retry persistence without another process entering.
          }
        })();
        this.pendingSettles.add(settle);
        void settle.finally(() => this.pendingSettles.delete(settle));
        return requiredSnapshot(engine);
      }
      case "resume": {
        if (!engine.getSnapshot() && !intent.runId) await this.dependencies.bindLatestRecoverable();
        const beforeResume = engine.getSnapshot();
        const target = beforeResume && (!intent.runId || beforeResume.id === intent.runId)
          ? beforeResume
          : intent.runId ? await this.dependencies.loadRun(intent.runId) : undefined;
        if (target) assertAllowed("resume", target, beforeResume && isActive(beforeResume.status) ? beforeResume.id : undefined);
        const resumed = await this.dependencies.resume(intent.runId);
        const current = resumed ?? requiredSnapshot(engine);
        await this.dependencies.persist(current);
        return current;
      }
      case "stop": {
        if (!engine.getSnapshot()) await this.dependencies.bindLatestRecoverable();
        assertAllowed("stop", requiredSnapshot(engine), requiredSnapshot(engine).id);
        await ownership.update(requiredSnapshot(engine).id);
        await engine.stop();
        await engine.waitForIdle();
        const stopped = requiredSnapshot(engine);
        await this.dependencies.persist(stopped);
        return stopped;
      }
      case "cancel": {
        const current = engine.getSnapshot();
        if (!current || (intent.runId && current.id !== intent.runId)) {
          await this.dependencies.bindRecoverable(intent.runId);
        }
        assertAllowed("cancel", requiredSnapshot(engine), requiredSnapshot(engine).id);
        await ownership.update(requiredSnapshot(engine).id);
        await engine.cancel();
        await engine.waitForIdle();
        const cancelled = requiredSnapshot(engine);
        await this.dependencies.persist(cancelled);
        return cancelled;
      }
      case "retryNode":
      case "retryPhase": {
        const current = engine.getSnapshot();
        if (current && current.id !== intent.runId && isRecoverable(current.status)) {
          throw new Error(`Wiki run ${current.id} is already active; cancel it before retrying ${intent.runId}`);
        }
        await this.dependencies.flush();
        const snapshot = current?.id === intent.runId ? current : await this.dependencies.loadRun(intent.runId);
        if (!snapshot) throw new Error("Wiki run history is unavailable");
        assertAllowed("retry", snapshot, current && isActive(current.status) ? current.id : undefined);
        const conflicts = await this.dependencies.listRecoverable(intent.runId);
        if (conflicts.length > 0) {
          throw new Error(`Another recoverable Wiki run already exists: ${conflicts.map((run) => run.id).join(", ")}`);
        }
        const retryCurrent = current?.id === intent.runId && isActive(current.status);
        const retried = intent.type === "retryNode"
          ? retryCurrent ? await engine.retryNode(intent.nodeId) : await engine.forkAndRetryNode(snapshot, intent.nodeId)
          : retryCurrent ? await engine.retryPhase(intent.phaseId) : await engine.forkAndRetryPhase(snapshot, intent.phaseId);
        if (retried) {
          await ownership.update(retried.id);
          await this.dependencies.persist(retried);
        }
        return retried;
      }
      case "delete": {
        if (intent.runId === engine.getSnapshot()?.id) throw new Error("The active Wiki run cannot be deleted");
        const snapshot = await this.dependencies.loadRun(intent.runId);
        if (!snapshot || snapshot.id !== intent.runId || !isTerminal(snapshot.status)) {
          throw new Error("Only completed Wiki history can be deleted");
        }
        const active = engine.getSnapshot();
        assertAllowed("delete", snapshot, active && isActive(active.status) ? active.id : undefined);
        await this.dependencies.deleteRun(intent.runId);
        return undefined;
      }
    }
  }

  private async release(ownership: WikiApplicationOwnership): Promise<void> {
    await ownership.release();
    if (this.ownership === ownership) this.ownership = undefined;
  }
}

function requiredSnapshot(engine: WikiWorkflowEngine): WikiRunSnapshot {
  const snapshot = engine.getSnapshot();
  if (!snapshot) throw new Error("No Wiki run is available");
  return snapshot;
}

function isActive(status: WikiRunSnapshot["status"]): boolean {
  return status === "running" || status === "paused";
}

function isRecoverable(status: WikiRunSnapshot["status"]): boolean {
  return status === "running" || status === "paused";
}

function isTerminal(status: WikiRunSnapshot["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "blocked" || status === "cancelled";
}

function assertAllowed(
  action: keyof ReturnType<typeof allowedWikiRunActions>,
  snapshot: Pick<WikiRunSnapshot, "id" | "status">,
  activeRunId?: string,
): void {
  if (!allowedWikiRunActions(snapshot, activeRunId)[action]) {
    throw new Error(`Wiki run ${snapshot.id} does not allow ${action} while ${snapshot.status}`);
  }
}
