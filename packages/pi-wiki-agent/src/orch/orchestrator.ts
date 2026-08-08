/**
 * WikiOrchestrator interface and shared helpers for all backends.
 */
import type {
  OrchRunSummary,
  WikiEvent,
  WikiObservationEntry,
  WikiProgressSnapshot,
} from "./types.js";

export interface WikiOrchestratorStartInput {
  workspaceRoot: string;
  action: "generate" | "approve" | "resume";
  runId?: string;
  focus?: string;
}

export interface WikiOrchestratorStartResult {
  orchestrationId: string;
  runId?: string;
}

export interface WikiOrchestrator {
  readonly backend: "session";

  start(input: WikiOrchestratorStartInput): Promise<WikiOrchestratorStartResult>;
  pause(id?: string): Promise<boolean>;
  resume(id?: string): Promise<boolean>;
  stop(id?: string): Promise<boolean>;
  dispose(): Promise<void>;

  list(): OrchRunSummary[];
  getSnapshot(id?: string): WikiProgressSnapshot | undefined;
  getActiveSnapshot(): WikiProgressSnapshot | undefined;
  subscribe(
    listener: (s: WikiProgressSnapshot, e?: WikiEvent) => void,
    id?: string,
  ): () => void;

  getTranscript(
    agentId: string,
    opts?: { tail?: number },
    id?: string,
  ): Promise<WikiObservationEntry[]>;

  /** Synchronize local observation state when a backend supports it. */
  syncFromBackend(): void;

  /**
   * Best-effort mutate the active (or specified) observation snapshot.
   * Used by the extension to update observation state without exposing the backend store.
   */
  updateSnapshot?(mutator: (s: WikiProgressSnapshot) => void, id?: string): void;
}

const ACTIVE_OVERALL = new Set(["running", "paused", "proposed", "quality_blocked"]);

/**
 * Resolve which orchestration id to control when the caller omits one.
 * Prefers the most recently updated running/paused run, else the newest overall.
 */
export function resolveActiveOrchestrationId(
  runs: readonly OrchRunSummary[],
  id?: string,
): string | undefined {
  if (id) return id;
  if (runs.length === 0) return undefined;
  const byRecency = (a: OrchRunSummary, b: OrchRunSummary) => b.updatedAt - a.updatedAt;
  const active = runs.filter((r) => ACTIVE_OVERALL.has(r.overall)).sort(byRecency);
  if (active[0]) return active[0].orchestrationId;
  return [...runs].sort(byRecency)[0]?.orchestrationId;
}

export function isTerminalOverall(overall: WikiProgressSnapshot["overall"]): boolean {
  return overall === "complete" || overall === "failed" || overall === "cancelled";
}

export function summaryFromSnapshot(snap: WikiProgressSnapshot): OrchRunSummary {
  return {
    orchestrationId: snap.orchestrationId,
    runId: snap.runId,
    overall: snap.overall,
    backend: snap.backend,
    currentPhase: snap.currentPhase,
    updatedAt: snap.updatedAt,
    workspaceRoot: snap.workspaceRoot,
  };
}
