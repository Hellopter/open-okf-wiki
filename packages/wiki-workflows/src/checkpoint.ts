import type { WikiRunSession, WikiRunSnapshot } from "./workflow-types.js";
import { createWikiRunSession } from "./session.js";
import { clone, errorMessage } from "./util.js";

export interface CheckpointSinks {
  appendSession: (session: WikiRunSession) => void | Promise<void>;
  saveHistory: (snapshot: WikiRunSnapshot) => Promise<void>;
}

export interface CheckpointOptions {
  /** When true, await history save (critical events). */
  awaitHistory?: boolean;
}

/**
 * Serializes session + history checkpoints so concurrent engine events never
 * interleave durable writes. Each enqueue bumps a monotonic revision.
 *
 * Session entries are pointer-only; full snapshots go to the history store.
 */
export class WikiCheckpointCoordinator {
  private chain = Promise.resolve();
  private revision = 0;
  private lastError: unknown;

  constructor(private readonly sinks: CheckpointSinks) {}

  /** Current monotonic revision (last successfully enqueued bump). */
  get currentRevision(): number {
    return this.revision;
  }

  /** Last history/session write failure, if any. */
  get lastWriteError(): unknown {
    return this.lastError;
  }

  /**
   * Seed the revision counter after restore so subsequent checkpoints stay monotonic.
   */
  seedRevision(revision: number): void {
    if (Number.isInteger(revision) && revision >= 0) this.revision = revision;
  }

  /**
   * Clone snapshot, set `revision = ++this.revision`, build a pointer session,
   * then serialize `appendSession` (pointer) + `saveHistory` (full snapshot)
   * on a single promise chain.
   */
  enqueue(snapshot: WikiRunSnapshot, session: WikiRunSession, options?: CheckpointOptions): Promise<void> {
    const nextSnapshot = clone(snapshot);
    nextSnapshot.revision = ++this.revision;
    const nextSession = createWikiRunSession(nextSnapshot);
    // Keep the caller's session object in sync with the latest pointer.
    session.customType = nextSession.customType;
    session.workspace = nextSession.workspace;
    session.pointerVersion = nextSession.pointerVersion;
    session.runId = nextSession.runId;
    session.revision = nextSession.revision;
    session.status = nextSession.status;
    session.updatedAt = nextSession.updatedAt;

    const operation = this.chain.then(async () => {
      await this.sinks.appendSession({ ...nextSession });
      await this.sinks.saveHistory(nextSnapshot);
      this.lastError = undefined;
    });

    // Keep the chain alive after failures so later checkpoints still serialize.
    this.chain = operation.catch((error: unknown) => {
      this.lastError = error;
    });

    if (options?.awaitHistory) {
      return operation.catch((error: unknown) => {
        this.lastError = error;
        throw error instanceof Error ? error : new Error(errorMessage(error));
      });
    }

    return this.chain;
  }

  /** Drain pending writes (shutdown). */
  flush(): Promise<void> {
    return this.chain;
  }
}
