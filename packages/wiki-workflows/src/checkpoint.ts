import type { WikiRunSession, WikiRunSnapshot } from "./workflow-types.js";
import { createWikiRunSession } from "./session.js";
import { clone, errorMessage } from "./util.js";

export interface CheckpointSinks {
  appendSession: (session: WikiRunSession) => void | Promise<void>;
  saveHistory: (snapshot: WikiRunSnapshot) => Promise<void>;
}

export interface CheckpointOptions {
  /** Propagate a write failure to the caller. Background checkpoints retain it in `lastError()`. */
  durable?: boolean;
}

/**
 * Serializes session + history checkpoints so concurrent engine events never
 * interleave durable writes. Each checkpoint bumps a monotonic revision.
 *
 * Session entries are pointer-only; full snapshots go to the history store.
 */
export class WikiCheckpointCoordinator {
  private chain = Promise.resolve();
  private revision = 0;
  private writeError: unknown;

  constructor(private readonly sinks: CheckpointSinks) {}

  /** Current monotonic revision (last assigned checkpoint revision). */
  get currentRevision(): number {
    return this.revision;
  }

  /** Last write failure, retained until a later checkpoint succeeds. */
  lastError(): unknown {
    return this.writeError;
  }

  /**
   * Seed the revision counter after restore so subsequent checkpoints stay monotonic.
   */
  seedRevision(revision: number): void {
    if (Number.isInteger(revision) && revision >= 0) this.revision = Math.max(this.revision, revision);
  }

  checkpoint(snapshot: WikiRunSnapshot, options: CheckpointOptions = {}): Promise<void> {
    const nextSnapshot = clone(snapshot);
    this.revision = Math.max(this.revision, nextSnapshot.revision ?? 0) + 1;
    nextSnapshot.revision = this.revision;
    const nextSession = createWikiRunSession(nextSnapshot);

    const operation = this.chain.then(async () => {
      await this.sinks.saveHistory(nextSnapshot);
      // Pi pointer is the commit marker: never publish a revision whose full body failed.
      await this.sinks.appendSession({ ...nextSession });
      this.writeError = undefined;
    });

    // Keep the chain alive after failures so later checkpoints still serialize.
    this.chain = operation.catch((error: unknown) => {
      this.writeError = error;
    });

    if (options.durable) {
      return operation.catch((error: unknown) => {
        this.writeError = error;
        throw error instanceof Error ? error : new Error(errorMessage(error));
      });
    }

    return this.chain;
  }

  /**
   * Adopt the restored revision and durably persist the recovered snapshot as
   * the next checkpoint. This keeps recovery writes on the same ordered path
   * as live engine writes.
   */
  restoreCheckpoint(snapshot: WikiRunSnapshot): Promise<void> {
    this.seedRevision(snapshot.revision ?? 0);
    return this.checkpoint(snapshot, { durable: true });
  }

  /** Drain pending writes (shutdown). */
  flush(): Promise<void> {
    return this.chain;
  }
}
