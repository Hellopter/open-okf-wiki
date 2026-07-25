/**
 * Append-only attempt journal for one Wiki Run (pure — no I/O, no Pi).
 * Run Graph observation model only; not an executor.
 */

import type {
  AttemptRole,
  GraphNodeDef,
  NodeAttempt,
  NodeAttemptStatus,
  RunGraphSnapshot,
} from "@okf-wiki/contract";
import { emptyRunGraphSnapshot } from "@okf-wiki/contract";

const MAX_ATTEMPTS = 256;

export type StartAttemptInput = {
  nodeKey: string;
  role?: AttemptRole;
  runIndex?: number;
  /** Defaults to `${nodeKey}@${runIndex}` or unique if collision. */
  attemptId?: string;
  summary?: string;
};

/**
 * Mutable journal: topology + append-only attempts with streaming upsert by attemptId.
 */
export class AttemptJournal {
  private graph: RunGraphSnapshot;
  private seq = 0;

  constructor(initial?: RunGraphSnapshot) {
    this.graph = initial
      ? {
          topologyVersion: initial.topologyVersion,
          topology: [...initial.topology],
          attempts: [...initial.attempts],
          ...(initial.playhead ? { playhead: { ...initial.playhead } } : {}),
        }
      : emptyRunGraphSnapshot(0);
  }

  setTopology(topology: GraphNodeDef[], topologyVersion?: number): void {
    this.graph = {
      topologyVersion:
        topologyVersion !== undefined ? topologyVersion : this.graph.topologyVersion || 1,
      topology: [...topology],
      attempts: this.graph.attempts,
      ...(this.graph.playhead ? { playhead: { ...this.graph.playhead } } : {}),
    };
  }

  /** Begin a running attempt; returns the attempt record (append or new id). */
  startAttempt(input: StartAttemptInput): NodeAttempt {
    const runIndex = input.runIndex ?? this.nextRunIndex(input.nodeKey);
    let attemptId = input.attemptId?.trim() || `${input.nodeKey}@${runIndex}`;
    if (this.graph.attempts.some((a) => a.attemptId === attemptId)) {
      this.seq += 1;
      attemptId = `${attemptId}#${this.seq}`;
    }
    const attempt: NodeAttempt = {
      attemptId,
      nodeKey: input.nodeKey,
      runIndex,
      status: "running",
      ...(input.role ? { role: input.role } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      startedAt: new Date().toISOString(),
    };
    this.upsert(attempt);
    return attempt;
  }

  completeAttempt(
    attemptId: string,
    patch: {
      status: Exclude<NodeAttemptStatus, "pending" | "running">;
      summary?: string;
      receiptPath?: string;
      errorClass?: NodeAttempt["errorClass"];
      items?: NodeAttempt["items"];
    },
  ): NodeAttempt | null {
    const prev = this.graph.attempts.find((a) => a.attemptId === attemptId);
    if (!prev) return null;
    const next: NodeAttempt = {
      ...prev,
      status: patch.status,
      endedAt: new Date().toISOString(),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.receiptPath !== undefined ? { receiptPath: patch.receiptPath } : {}),
      ...(patch.errorClass !== undefined ? { errorClass: patch.errorClass } : {}),
      ...(patch.items !== undefined ? { items: patch.items } : {}),
    };
    this.upsert(next);
    return next;
  }

  /** Streaming update or append by attemptId (never drops other attempts). */
  upsert(attempt: NodeAttempt): void {
    const attempts = [...this.graph.attempts];
    const idx = attempts.findIndex((a) => a.attemptId === attempt.attemptId);
    if (idx >= 0) attempts[idx] = attempt;
    else attempts.push(attempt);
    this.graph = {
      topologyVersion: this.graph.topologyVersion,
      topology: this.graph.topology,
      attempts: attempts.slice(-MAX_ATTEMPTS),
      playhead: { nodeKey: attempt.nodeKey, attemptId: attempt.attemptId },
    };
  }

  snapshot(): RunGraphSnapshot {
    return {
      topologyVersion: this.graph.topologyVersion,
      topology: [...this.graph.topology],
      attempts: [...this.graph.attempts],
      ...(this.graph.playhead ? { playhead: { ...this.graph.playhead } } : {}),
    };
  }

  private nextRunIndex(nodeKey: string): number {
    let max = -1;
    for (const a of this.graph.attempts) {
      if (a.nodeKey === nodeKey && a.runIndex > max) max = a.runIndex;
    }
    return max + 1;
  }
}
