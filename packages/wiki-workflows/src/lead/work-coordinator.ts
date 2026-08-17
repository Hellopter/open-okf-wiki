import { projectWikiLeadSnapshot, WikiTaskPauseError, type WikiDelegateBatchSnapshot } from "../delegate-contracts.js";
import type { WikiTaskRuntime, WikiWritePathLease } from "../task-runtime.js";
import type { WikiDelegateCancelReasonCode } from "./host-tools.js";
import type { WikiActiveWave, WikiDiscoveryPlanEntry, WikiLeadRun, WikiQueuedWave } from "./run.js";

export interface WikiWorkCoordinatorRun {
  readonly taskRuntimeState: Pick<WikiLeadRun["taskRuntimeState"], "batches">;
  startNextReadyWave(discoveryPlan?: readonly WikiDiscoveryPlanEntry[]): Promise<WikiQueuedWave>;
  rollbackDelegateBatch(batchId: number): Promise<void>;
  currentActiveWave(): Promise<WikiActiveWave | undefined>;
  presentSnapshot(snapshot: WikiDelegateBatchSnapshot): Promise<WikiDelegateBatchSnapshot>;
}

export interface WikiWorkCoordinatorTasks {
  start: WikiTaskRuntime["start"];
  collect: WikiTaskRuntime["collect"];
  cancel: WikiTaskRuntime["cancel"];
}

export interface WikiWorkCoordinatorOptions {
  run: WikiWorkCoordinatorRun;
  tasks: WikiWorkCoordinatorTasks;
  writeLease: Pick<WikiWritePathLease, "assertReviewAllowed">;
  signal: AbortSignal;
  snapshotDiscoverySlots: () => Promise<readonly WikiDiscoveryPlanEntry[]>;
  onPause?: (pause: WikiTaskPauseError) => void;
}

export type WikiPresentedBatch = ReturnType<typeof projectWikiLeadSnapshot>;

/**
 * Transactional seam between model-facing controls, durable Run state, and the
 * asynchronous TaskRuntime. It is the sole owner of selecting and operating on
 * the current delegate wave.
 */
export class WikiWorkCoordinator {
  constructor(private readonly options: WikiWorkCoordinatorOptions) {}

  async startCurrent(): Promise<{ wave: WikiQueuedWave["wave"]; batchId: number }> {
    const firstWave = this.options.run.taskRuntimeState.batches.length === 0;
    const discoveryPlan = firstWave
      ? structuredClone(await this.options.snapshotDiscoverySlots())
      : [];
    const queued = await this.options.run.startNextReadyWave(discoveryPlan);
    try {
      if (queued.wave === "review") this.options.writeLease.assertReviewAllowed();
      const started = await this.options.tasks.start(queued.contracts, this.options.signal);
      if (started.batchId !== queued.batchId) {
        throw new Error(`TaskRuntime started batch ${started.batchId}, expected queued batch ${queued.batchId}`);
      }
      return { wave: queued.wave, batchId: started.batchId };
    } catch (error) {
      await this.options.run.rollbackDelegateBatch(queued.batchId);
      throw error;
    }
  }

  async collectCurrent(options: { until: "any" | "all"; timeoutSeconds: number }): Promise<WikiPresentedBatch> {
    const active = await this.requireCurrent("collect");
    try {
      return await this.present(await this.options.tasks.collect(active.batchId, options, this.options.signal));
    } catch (error) {
      if (error instanceof WikiTaskPauseError) this.options.onPause?.(error);
      throw error;
    }
  }

  async cancelCurrent(reasonCode?: WikiDelegateCancelReasonCode): Promise<WikiPresentedBatch> {
    const active = await this.requireCurrent("cancel");
    return await this.present(await this.options.tasks.cancel(active.batchId, undefined, reasonCode));
  }

  private async requireCurrent(operation: "collect" | "cancel"): Promise<WikiActiveWave> {
    const active = await this.options.run.currentActiveWave();
    if (!active) throw new Error(`No active Wiki wave to ${operation}`);
    return active;
  }

  private async present(snapshot: WikiDelegateBatchSnapshot): Promise<WikiPresentedBatch> {
    return projectWikiLeadSnapshot(await this.options.run.presentSnapshot(snapshot));
  }
}
