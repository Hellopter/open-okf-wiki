/**
 * Single graph authority for one Wiki Run.
 * Owns AttemptJournal + optional GraphStore bind; workflow never dual-upserts.
 */

import type {
  GraphNodeDef,
  NodeAttempt,
  RunGraphSnapshot,
} from "@okf-wiki/contract";
import type { ProduceProgress } from "../ports/progress-sink.js";
import type { GraphStore } from "../ports/graph-store.js";
import { AttemptJournal } from "./journal.js";

export type RunGraphOwnerEvent =
  | { kind: "attempt"; attempt: NodeAttempt }
  | { kind: "topology"; topology: GraphNodeDef[]; topologyVersion?: number }
  | { kind: "graph"; graph: RunGraphSnapshot };

export type RunGraphOwner = {
  apply(event: RunGraphOwnerEvent): void;
  snapshot(): RunGraphSnapshot;
  persist(): Promise<void>;
  bind(runId: string, store: GraphStore): void;
};

/**
 * Fold graph-shaped ProduceProgress into the owner, best-effort persist, and
 * project a snapshot via onGraph. Returns true when progress was graph-shaped
 * (caller should not re-emit the raw event).
 */
export function applyGraphProgress(
  owner: RunGraphOwner,
  progress: ProduceProgress,
  onGraph: (graph: RunGraphSnapshot) => void,
): boolean {
  if (
    progress.kind !== "attempt" &&
    progress.kind !== "topology" &&
    progress.kind !== "graph"
  ) {
    return false;
  }
  owner.apply(progress);
  void owner.persist();
  onGraph(owner.snapshot());
  return true;
}

/** Create the sole mutator of live Run Graph state for a Wiki Run. */
export function createRunGraphOwner(initial?: RunGraphSnapshot): RunGraphOwner {
  const journal = new AttemptJournal(initial);
  let boundRunId: string | undefined;
  let boundStore: GraphStore | undefined;

  return {
    apply(event) {
      switch (event.kind) {
        case "attempt":
          journal.upsert(event.attempt);
          break;
        case "topology":
          journal.setTopology(
            event.topology,
            event.topologyVersion ?? Math.max(1, journal.snapshot().topologyVersion + 1),
          );
          break;
        case "graph":
          for (const a of event.graph.attempts) journal.upsert(a);
          if (event.graph.topology.length > 0) {
            journal.setTopology(event.graph.topology, event.graph.topologyVersion);
          }
          break;
      }
    },
    snapshot() {
      return journal.snapshot();
    },
    async persist() {
      if (!boundStore || !boundRunId) return;
      try {
        await boundStore.save(boundRunId, journal.snapshot());
      } catch {
        // Durable graph is best-effort; live projection already emitted.
      }
    },
    bind(runId, store) {
      boundRunId = runId;
      boundStore = store;
    },
  };
}
