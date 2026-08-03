/**
 * Shared WikiRuns control context layers (DIP surface for control-plane modules).
 *
 * Layers: DbCtx ⊂ TxCtx ⊂ CasCtx ⊂ WikiRunsControl.
 * Owner builds one WikiRunsControl; modules take Control or a narrower layer.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  PiAttemptArtifactDescriptor,
  PiAttemptExecutor,
  PiAttemptOutcome,
} from "@okf-wiki/contract/pi-attempt";
import type {
  AttemptMetrics,
  RunCommand,
  RunCommandContext,
  RunCommandReceipt,
  WikiRunEvent,
} from "@okf-wiki/contract/wiki-runs";
import type { WorkspaceConfig } from "@okf-wiki/contract/workspace";
import type { FreezeRunBoundaryInput, FrozenRunBoundary } from "@okf-wiki/core";
import type { SqlRow } from "./sql.js";
import type {
  ArtifactPreparation,
  ClaimedFreeze,
  ClaimedNode,
  TrustedFrozenInputs,
} from "./types.js";

/** Workspace + SQLite + event emit — minimum control-plane surface. */
export type WikiRunsDbCtx = {
  /** Latest Workspace config, used exclusively when accepting StartRun. */
  workspace: WorkspaceConfig;
  /** Immutable configuration snapshot captured by the given Run at StartRun. */
  workspaceForRun(runId: string): WorkspaceConfig;
  db: DatabaseSync;
  emit(runId: string, type: WikiRunEvent["type"]): number;
};

/** DbCtx plus owner-bound IMMEDIATE transactions. */
export type WikiRunsTxCtx = WikiRunsDbCtx & {
  transaction<T>(work: () => T): T;
};

/**
 * TxCtx plus CAS / generation checks used by attempt commit, seal, freeze.
 * `isCurrent` is the attemptId+generation lease predicate.
 */
export type WikiRunsCasCtx = WikiRunsTxCtx & {
  isCurrent(claim: ClaimedNode): boolean;
  currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
};

/** Options for durable RerunNode core (generation++ + lineage invalidation). */
export type ApplyRerunAtOptions = {
  selfOnly?: boolean;
  /**
   * Drop lineage consumers whose node_key matches this predicate.
   * Ignored when selfOnly is true.
   */
  excludeConsumer?: (nodeKey: string) => boolean;
};

/**
 * Single control-plane context. Replaces the former N `*Host` type zoo.
 *
 * Owner builds one object (see wiki-runs.ts). Modules accept `WikiRunsControl`
 * or a Pick/narrow layer when they only need db/CAS/applyRerunAt.
 *
 * Execution adapters (Pi, freeze boundary, mechanical reconcile) live here so
 * the scheduler/freeze/mechanical paths share the same object — not separate
 * host factories.
 */
export type WikiRunsControl = WikiRunsCasCtx & {
  /** True after owner close — scheduler drain, gate expiry, effects reconcile. */
  readonly closed: boolean;
  piAttemptExecutor?: PiAttemptExecutor;
  activeAttempts: Map<string, AbortController>;
  activeExecutions: Map<string, Promise<void>>;

  currentNodeRow(runId: string, nodeKey: string): SqlRow | undefined;

  /**
   * Durable RerunNode core: generation++ on target + lineage consumers,
   * withdraw gates, cancel pre-apply effects, optional feedback on new root gen.
   */
  applyRerunAt(
    runId: string,
    nodeKey: string,
    generation: number,
    feedback?: string,
    opts?: ApplyRerunAtOptions,
  ): void;

  abortRunAttempts(runId: string): void;
  withdrawOpenGates(runId: string): void;
  withdrawOpenGatesForNode(runId: string, nodeKey: string, generation: number): void;
  cancelPreApplyEffects(runId: string): void;
  cancelPreApplyEffectsForPublication(
    runId: string,
    publicationNodeKey: string,
    publicationNodeGeneration: number,
  ): void;

  resolveGate(
    command: Extract<RunCommand, { type: "resolve_gate" }>,
    context: RunCommandContext,
    payloadDigest: string,
  ): RunCommandReceipt;
  recordCommand(
    command: RunCommand,
    context: RunCommandContext,
    payloadDigest: string,
    runId: string,
    revision: number,
  ): void;

  upstreamsSucceeded(runId: string, nodeKey: string): boolean;
  upstreamSealedOutputs(
    runId: string,
    nodeKey: string,
  ): Array<{ role: string; artifactId: string }>;

  copyAttemptInputs(attemptId: string, inputs: Array<{ role: string; artifactId: string }>): void;
  bindAttemptInputs(attemptId: string, runId: string, nodeKey: string): void;

  executeFreeze(claim: ClaimedFreeze): Promise<void>;
  executeMechanical(claim: ClaimedNode, signal: AbortSignal): Promise<PiAttemptOutcome>;
  prepareUnsealedArtifact(
    claim: ClaimedNode,
    descriptor: PiAttemptArtifactDescriptor,
  ): Promise<ArtifactPreparation | undefined>;
  sealPreparation(runId: string, preparation: ArtifactPreparation): Promise<void>;
  preparePlanExecutionPlan(
    claim: ClaimedNode,
    preparations: ArtifactPreparation[],
  ): Promise<ArtifactPreparation | undefined>;
  commitSuccessfulAttempt(
    claim: ClaimedNode,
    preparations: ArtifactPreparation[],
    metrics?: AttemptMetrics,
  ): void;
  commitFailedAttemptArtifacts(claim: ClaimedNode, preparations: ArtifactPreparation[]): void;
  orphanPreparedArtifacts(attemptId: string): void;

  requeueFailedNode(
    runId: string,
    nodeKey: string,
    generation: number,
    lastAttemptId: string,
  ): void;
  trustedPinnedInputs(runId: string): TrustedFrozenInputs | undefined;
  attemptInputDigest(attemptId: string): string;

  runBoundary(input: FreezeRunBoundaryInput): Promise<FrozenRunBoundary>;
  reconcileApplyingEffect(input: {
    effectKey: string;
    runId: string;
    candidateArtifactId: string;
    candidateDigest: string;
    expectedLiveDigest: string;
  }): Promise<void>;
};
