import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AttemptMetrics,
  CancelRunCommandSchema,
  type PiAttemptArtifactDescriptor,
  type PiAttemptExecutor,
  type PiAttemptOutcome,
  RepositorySnapshotSchema,
  RerunNodeCommandSchema,
  ResolveGateCommandSchema,
  RetryFailedNodeCommandSchema,
  type RunCommand,
  type RunCommandContext,
  RunCommandContextSchema,
  type RunCommandReceipt,
  StartRunCommandSchema,
  type WikiRunEvent,
  WikiRunEventSchema,
  type WikiRunSnapshot,
  type WikiRunSpecRead,
  WikiRunSpecReadSchema,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import {
  type FreezeRunBoundaryInput,
  type FrozenRunBoundary,
  freezeRunBoundary,
  loadWorkspace,
} from "@okf-wiki/core";
import {
  type ArtifactsHost,
  bindAttemptInputs as bindAttemptInputsImpl,
  copyAttemptInputs as copyAttemptInputsImpl,
  orphanPreparedArtifacts as orphanPreparedArtifactsImpl,
  prepareUnsealedArtifact as prepareUnsealedArtifactImpl,
  sealPreparation as sealPreparationImpl,
  upstreamSealedOutputs as upstreamSealedOutputsImpl,
} from "./wiki-runs/artifacts.js";
import {
  type AttemptSuccessHost,
  commitSuccessfulAttempt as commitSuccessfulAttemptImpl,
  preparePlanExecutionPlan as preparePlanExecutionPlanImpl,
  recoverPreparedArtifacts as recoverPreparedArtifactsImpl,
} from "./wiki-runs/attempt-success.js";
import {
  applyCommand as applyCommandImpl,
  applyRerunAt as applyRerunAtImpl,
  type CommandsHost,
  recordCommand as recordCommandImpl,
  requeueFailedNode as requeueFailedNodeImpl,
} from "./wiki-runs/commands.js";
import type { WikiRunsCasCtx, WikiRunsDbCtx, WikiRunsTxCtx } from "./wiki-runs/ctx.js";
import { now } from "./wiki-runs/crypto-util.js";
import {
  loadSpecFromArtifact,
  upstreamsSucceeded as upstreamsSucceededImpl,
} from "./wiki-runs/dag.js";
import {
  cancelPreApplyEffects as cancelPreApplyEffectsImpl,
  cancelPreApplyEffectsForPublication as cancelPreApplyEffectsForPublicationImpl,
  type EffectsHost,
  reconcileApplyingEffect as reconcileApplyingEffectImpl,
  reconcileApplyingEffects as reconcileApplyingEffectsImpl,
} from "./wiki-runs/effects.js";
import {
  executeFreeze as runFreeze,
  type FreezeHost,
} from "./wiki-runs/freeze.js";
import {
  withdrawOpenGates as withdrawOpenGatesImpl,
  withdrawOpenGatesForNode as withdrawOpenGatesForNodeImpl,
} from "./wiki-runs/gate-open.js";
import {
  type GatesHost,
  expireStaleOpenGates as expireStaleOpenGatesImpl,
  resolveGate as resolveGateImpl,
} from "./wiki-runs/gate-resolve.js";
import {
  executeMechanical,
  type MechanicalHost,
} from "./wiki-runs/mechanical/index.js";
import { configureOwner, migrate } from "./wiki-runs/schema.js";
import {
  abortActiveAttempts as abortActiveAttemptsImpl,
  abortRunAttempts as abortRunAttemptsImpl,
  type SchedulerHost,
  runScheduler,
  waitForRunExecution as waitForRunExecutionImpl,
} from "./wiki-runs/scheduler.js";
import { buildSnapshot } from "./wiki-runs/snapshot.js";
import {
  asRow,
  asRows,
  parseJson,
  requiredNumber,
  requiredText,
  type SqlRow,
  sqliteBusy,
} from "./wiki-runs/sql.js";
import {
  readAttemptTranscript as readAttemptTranscriptImpl,
  type TranscriptHost,
} from "./wiki-runs/transcript.js";
import {
  type ArtifactPreparation,
  type ClaimedFreeze,
  type ClaimedNode,
  DATABASE_FILE_NAME,
  type OpenWikiRunsInput,
  type TrustedFrozenInputs,
  type WikiRunAttemptTranscript,
  type WikiRunListItem,
  type WikiRunRead,
  type WikiRuns,
  WorkflowInUseError,
} from "./wiki-runs/types.js";

// Re-export public surface for existing `from "./wiki-runs.js"` imports.
// ClaimedNode stays internal (type import only) — package index also omits it.
export type {
  OpenWikiRunsInput,
  PiAttemptExecutor,
  WikiRunAttemptTranscript,
  WikiRunListItem,
  WikiRunRead,
  WikiRuns,
} from "./wiki-runs/types.js";
export { CommandIdCollision, WorkflowInUseError } from "./wiki-runs/types.js";

function parseRunCommand(value: unknown): RunCommand {
  const type = (value as { type?: unknown } | null)?.type;
  switch (type) {
    case "start_run":
      return StartRunCommandSchema.parse(value);
    case "retry_failed_node":
      return RetryFailedNodeCommandSchema.parse(value);
    case "rerun_node":
      return RerunNodeCommandSchema.parse(value);
    case "cancel_run":
      return CancelRunCommandSchema.parse(value);
    case "resolve_gate":
      return ResolveGateCommandSchema.parse(value);
    default:
      throw new Error("unknown WikiRuns command type");
  }
}

class WikiRunsOwner implements WikiRuns {
  private closed = false;
  private closing: Promise<void> | undefined;
  private scheduler: Promise<void> | undefined;
  private readonly activeAttempts = new Map<string, AbortController>();
  private readonly activeExecutions = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DatabaseSync,
    private workspace: WorkspaceConfig,
    private readonly piAttemptExecutor?: PiAttemptExecutor,
    private readonly runBoundary: (
      input: FreezeRunBoundaryInput,
    ) => Promise<FrozenRunBoundary> = freezeRunBoundary,
  ) {}

  /** Hot-swap workspace config for subsequent StartRun / attempts (same SQLite owner). */
  replaceWorkspace(workspace: WorkspaceConfig): void {
    this.assertOpen();
    if (workspace.rootPath !== this.workspace.rootPath) {
      throw new Error("replaceWorkspace rootPath must match the open owner");
    }
    this.workspace = workspace;
  }

  async dispatch(command: RunCommand, context: RunCommandContext): Promise<RunCommandReceipt> {
    this.assertOpen();
    const parsedCommand = parseRunCommand(command);
    const parsedContext = RunCommandContextSchema.parse(context);
    if (parsedContext.workspaceId !== this.workspace.id) {
      throw new Error("command workspace does not match the opened workspace");
    }
    this.transaction(() => expireStaleOpenGatesImpl(this.gatesHost()));
    const receipt = this.transaction(() => this.applyCommand(parsedCommand, parsedContext));
    this.schedule();
    if (parsedCommand.type === "cancel_run") await this.waitForRunExecution(parsedCommand.runId);
    return receipt;
  }

  async read(input: {
    runId: string;
    afterEventId?: number;
    limit?: number;
  }): Promise<WikiRunRead> {
    this.assertOpen();
    const afterEventId = input.afterEventId ?? 0;
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(afterEventId) || afterEventId < 0)
      throw new Error("afterEventId must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error("limit must be between 1 and 1000");

    // Do not expire on read: hot poll paths (waitForRunState / Run SSE) must stay
    // non-blocking and avoid contending with in-flight attempt commits on the
    // single EXCLUSIVE SQLite connection. Expiry runs on dispatch + schedule.

    this.db.exec("BEGIN DEFERRED");
    try {
      const snapshot = this.snapshot(input.runId);
      const events = asRows(
        this.db
          .prepare(
            "SELECT event_json FROM run_events WHERE run_id = ? AND event_id > ? ORDER BY event_id LIMIT ?",
          )
          .all(input.runId, afterEventId, limit),
      ).map((row) => WikiRunEventSchema.parse(parseJson<unknown>(row.event_json)));
      const cursorRow = asRow(
        this.db
          .prepare("SELECT COALESCE(MAX(event_id), 0) AS cursor FROM run_events WHERE run_id = ?")
          .get(input.runId),
      );
      this.db.exec("COMMIT");
      return { snapshot, events, cursor: requiredNumber(cursorRow ?? {}, "cursor") };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  async list(): Promise<WikiRunListItem[]> {
    this.assertOpen();
    this.db.exec("BEGIN DEFERRED");
    try {
      const rows = asRows(
        this.db
          .prepare(
            "SELECT run_id, state, updated_at, revision FROM runs ORDER BY updated_at DESC, run_id DESC",
          )
          .all(),
      );
      this.db.exec("COMMIT");
      return rows.map((row) => ({
        runId: requiredText(row, "run_id"),
        state: requiredText(row, "state") as WikiRunSnapshot["state"],
        updatedAt: requiredText(row, "updated_at"),
        revision: requiredNumber(row, "revision"),
      }));
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  async readAttemptTranscript(input: {
    runId: string;
    attemptId: string;
  }): Promise<WikiRunAttemptTranscript> {
    this.assertOpen();
    return readAttemptTranscriptImpl(this.transcriptHost(), input);
  }

  async readPlanSpec(input: { runId: string }): Promise<WikiRunSpecRead> {
    this.assertOpen();
    const runId = input.runId;
    this.db.exec("BEGIN DEFERRED");
    try {
      const run = asRow(this.db.prepare("SELECT run_id FROM runs WHERE run_id = ?").get(runId));
      if (!run) throw new Error(`run not found: ${runId}`);
      // Prefer plan node output role=spec; fall back to any sealed spec artifact.
      const row =
        asRow(
          this.db
            .prepare(
              `SELECT artifacts.artifact_id, artifacts.digest, artifacts.relative_path
               FROM node_outputs
               JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
               JOIN (
                 SELECT node_key, MAX(generation) AS generation FROM nodes
                 WHERE run_id = ? AND node_key = 'plan' GROUP BY node_key
               ) cur ON cur.node_key = node_outputs.node_key
                    AND cur.generation = node_outputs.node_generation
               WHERE node_outputs.run_id = ?
                 AND node_outputs.node_key = 'plan'
                 AND (node_outputs.role = 'spec' OR artifacts.kind = 'spec')
               ORDER BY artifacts.sealed_at DESC
               LIMIT 1`,
            )
            .get(runId, runId),
        ) ??
        asRow(
          this.db
            .prepare(
              `SELECT artifact_id, digest, relative_path FROM artifacts
               WHERE run_id = ? AND kind = 'spec'
               ORDER BY sealed_at DESC LIMIT 1`,
            )
            .get(runId),
        );
      if (!row) throw new Error(`spec not found: ${runId}`);
      const relativePath = requiredText(row, "relative_path");
      const spec = loadSpecFromArtifact({ workspace: this.workspace }, runId, relativePath);
      if (!spec) throw new Error(`spec not found: ${runId}`);
      const result = WikiRunSpecReadSchema.parse({
        runId,
        artifactId: requiredText(row, "artifact_id"),
        digest: requiredText(row, "digest"),
        spec,
      });
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      this.abortActiveAttempts();
      this.transaction(() => this.interruptRunningAttempts());
      await this.scheduler;
      this.db.close();
    })();
    return this.closing;
  }

  async recover(): Promise<void> {
    // ADR 0035 recovery order: prepared CAS → applying effects → interrupt running.
    // Open gates are intentionally preserved (only Cancel/Rerun withdraw them).
    await this.recoverPreparedArtifacts();
    await this.reconcileApplyingEffects();
    this.transaction(() => {
      this.interruptRunningAttempts();
    });
    this.schedule();
  }

  private async recoverPreparedArtifacts(): Promise<void> {
    await recoverPreparedArtifactsImpl(this.attemptSuccessHost());
  }

  private applyCommand(command: RunCommand, context: RunCommandContext): RunCommandReceipt {
    return applyCommandImpl(this.commandsHost(), command, context);
  }

  /** Shared path for manual RetryFailedNode and research auto-retry. */
  private requeueFailedNode(
    runId: string,
    nodeKey: string,
    generation: number,
    lastAttemptId: string,
  ): void {
    requeueFailedNodeImpl({ db: this.db }, runId, nodeKey, generation, lastAttemptId);
  }

  private resolveGate(
    command: Extract<RunCommand, { type: "resolve_gate" }>,
    context: RunCommandContext,
    payloadDigest: string,
  ): RunCommandReceipt {
    return resolveGateImpl(this.gatesHost(), command, context, payloadDigest);
  }

  private upstreamsSucceeded(runId: string, nodeKey: string): boolean {
    return upstreamsSucceededImpl(
      {
        db: this.db,
        currentNodeGeneration: (id, key) => this.currentNodeGeneration(id, key),
      },
      runId,
      nodeKey,
    );
  }

  /**
   * Core RerunNode: generation++ on target + actual lineage consumers, withdraw
   * gates, cancel pre-apply effects, persist optional feedback on the new root gen.
   * Shared by the rerun_node command and publication-gate revise.
   */
  private applyRerunAt(
    runId: string,
    nodeKey: string,
    generation: number,
    feedback?: string,
    opts?: { selfOnly?: boolean; excludeConsumer?: (nodeKey: string) => boolean },
  ): void {
    applyRerunAtImpl(this.commandsHost(), runId, nodeKey, generation, feedback, opts);
  }

  private withdrawOpenGates(runId: string): void {
    withdrawOpenGatesImpl(this.gatesHost(), runId);
  }

  private withdrawOpenGatesForNode(runId: string, nodeKey: string, generation: number): void {
    withdrawOpenGatesForNodeImpl(this.gatesHost(), runId, nodeKey, generation);
  }

  private cancelPreApplyEffects(runId: string): void {
    cancelPreApplyEffectsImpl({ db: this.db }, runId);
  }

  private cancelPreApplyEffectsForPublication(
    runId: string,
    publicationNodeKey: string,
    publicationNodeGeneration: number,
  ): void {
    cancelPreApplyEffectsForPublicationImpl(
      this.effectsHost(),
      runId,
      publicationNodeKey,
      publicationNodeGeneration,
    );
  }

  private currentNodeGeneration(runId: string, nodeKey: string): number | undefined {
    const row = asRow(
      this.db
        .prepare(
          "SELECT MAX(generation) AS generation FROM nodes WHERE run_id = ? AND node_key = ?",
        )
        .get(runId, nodeKey),
    );
    if (!row || row.generation === null) return undefined;
    return requiredNumber(row, "generation");
  }

  private currentNodeRow(runId: string, nodeKey: string): SqlRow | undefined {
    const generation = this.currentNodeGeneration(runId, nodeKey);
    if (generation === undefined) return undefined;
    return asRow(
      this.db
        .prepare("SELECT * FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
        .get(runId, nodeKey, generation),
    );
  }

  private async reconcileApplyingEffects(): Promise<void> {
    return reconcileApplyingEffectsImpl(this.effectsHost());
  }

  private async reconcileApplyingEffect(input: {
    effectKey: string;
    runId: string;
    candidateArtifactId: string;
    candidateDigest: string;
    expectedLiveDigest: string;
  }): Promise<void> {
    return reconcileApplyingEffectImpl(this.effectsHost(), input);
  }

  /** Minimum host surface: workspace + db + emit (reads live workspace after replaceWorkspace). */
  private baseCtx(): WikiRunsDbCtx {
    return {
      workspace: this.workspace,
      db: this.db,
      emit: (runId, type) => this.emit(runId, type),
    };
  }

  /** baseCtx + owner IMMEDIATE transaction. */
  private txCtx(): WikiRunsTxCtx {
    return {
      ...this.baseCtx(),
      transaction: (work) => this.transaction(work),
    };
  }

  /** txCtx + isCurrent / currentNodeGeneration CAS checks. */
  private casCtx(): WikiRunsCasCtx {
    return {
      ...this.txCtx(),
      isCurrent: (claim) => this.isCurrent(claim),
      currentNodeGeneration: (runId, nodeKey) => this.currentNodeGeneration(runId, nodeKey),
    };
  }

  private effectsHost(): EffectsHost {
    const owner = this;
    return {
      ...this.txCtx(),
      get closed() {
        return owner.closed;
      },
    };
  }

  private gatesHost(): GatesHost {
    return {
      ...this.baseCtx(),
      currentNodeGeneration: (runId, nodeKey) => this.currentNodeGeneration(runId, nodeKey),
      currentNodeRow: (runId, nodeKey) => this.currentNodeRow(runId, nodeKey),
      abortRunAttempts: (runId) => this.abortRunAttempts(runId),
      cancelPreApplyEffects: (runId) => this.cancelPreApplyEffects(runId),
      applyRerunAt: (runId, nodeKey, generation, feedback, opts) =>
        this.applyRerunAt(runId, nodeKey, generation, feedback, opts),
      recordCommand: (command, context, payloadDigest, runId, revision) =>
        this.recordCommand(command, context, payloadDigest, runId, revision),
    };
  }

  private artifactsHost(): ArtifactsHost {
    return this.casCtx();
  }

  /** Shared success/recovery surface: CAS host + generation for gate open / unlock. */
  private attemptSuccessHost(): AttemptSuccessHost & { transaction<T>(work: () => T): T } {
    return {
      ...this.casCtx(),
      applyRerunAt: (runId, nodeKey, generation, feedback, opts) =>
        this.applyRerunAt(runId, nodeKey, generation, feedback, opts),
    };
  }

  private recordCommand(
    command: RunCommand,
    context: RunCommandContext,
    payloadDigest: string,
    runId: string,
    revision: number,
  ): void {
    recordCommandImpl(
      this.baseCtx(),
      command,
      context,
      payloadDigest,
      runId,
      revision,
    );
  }

  private commandsHost(): CommandsHost {
    return {
      ...this.baseCtx(),
      activeAttempts: this.activeAttempts,
      currentNodeGeneration: (runId, nodeKey) => this.currentNodeGeneration(runId, nodeKey),
      currentNodeRow: (runId, nodeKey) => this.currentNodeRow(runId, nodeKey),
      upstreamSealedOutputs: (runId, nodeKey) => this.upstreamSealedOutputs(runId, nodeKey),
      abortRunAttempts: (runId) => this.abortRunAttempts(runId),
      withdrawOpenGates: (runId) => this.withdrawOpenGates(runId),
      withdrawOpenGatesForNode: (runId, nodeKey, generation) =>
        this.withdrawOpenGatesForNode(runId, nodeKey, generation),
      cancelPreApplyEffects: (runId) => this.cancelPreApplyEffects(runId),
      cancelPreApplyEffectsForPublication: (runId, publicationNodeKey, publicationNodeGeneration) =>
        this.cancelPreApplyEffectsForPublication(
          runId,
          publicationNodeKey,
          publicationNodeGeneration,
        ),
      resolveGate: (command, context, payloadDigest) =>
        this.resolveGate(command, context, payloadDigest),
    };
  }

  private transcriptHost(): TranscriptHost {
    return this.baseCtx();
  }

  private schedulerHost(): SchedulerHost {
    const owner = this;
    return {
      ...this.casCtx(),
      get closed() {
        return owner.closed;
      },
      piAttemptExecutor: this.piAttemptExecutor,
      activeAttempts: this.activeAttempts,
      activeExecutions: this.activeExecutions,
      upstreamsSucceeded: (runId, nodeKey) => this.upstreamsSucceeded(runId, nodeKey),
      upstreamSealedOutputs: (runId, nodeKey) => this.upstreamSealedOutputs(runId, nodeKey),
      copyAttemptInputs: (attemptId, inputs) => this.copyAttemptInputs(attemptId, inputs),
      bindAttemptInputs: (attemptId, runId, nodeKey) =>
        this.bindAttemptInputs(attemptId, runId, nodeKey),
      executeFreeze: (claim) => this.executeFreeze(claim),
      executeMechanical: (claim, signal) => this.executeMechanical(claim, signal),
      prepareUnsealedArtifact: (claim, descriptor) =>
        this.prepareUnsealedArtifact(claim, descriptor),
      sealPreparation: (runId, preparation) => this.sealPreparation(runId, preparation),
      preparePlanExecutionPlan: (claim, preparations) =>
        this.preparePlanExecutionPlan(claim, preparations),
      commitSuccessfulAttempt: (claim, preparations, metrics) =>
        this.commitSuccessfulAttempt(claim, preparations, metrics),
      orphanPreparedArtifacts: (attemptId) => this.orphanPreparedArtifacts(attemptId),
      requeueFailedNode: (runId, nodeKey, generation, lastAttemptId) =>
        this.requeueFailedNode(runId, nodeKey, generation, lastAttemptId),
      trustedPinnedInputs: (runId) => this.trustedPinnedInputs(runId),
      attemptInputDigest: (attemptId) => this.attemptInputDigest(attemptId),
      applyRerunAt: (runId, nodeKey, generation, feedback, opts) =>
        this.applyRerunAt(runId, nodeKey, generation, feedback, opts),
    };
  }

  private schedule(): void {
    if (this.closed || this.scheduler) return;
    try {
      this.transaction(() => expireStaleOpenGatesImpl(this.gatesHost()));
    } catch {
      // Expiry best-effort; do not block the scheduler on a single bad gate.
    }
    this.scheduler = runScheduler(this.schedulerHost()).finally(() => {
      this.scheduler = undefined;
    });
  }

  private copyAttemptInputs(
    attemptId: string,
    inputs: Array<{ role: string; artifactId: string }>,
  ): void {
    copyAttemptInputsImpl(this.artifactsHost(), attemptId, inputs);
  }

  private bindAttemptInputs(attemptId: string, runId: string, nodeKey: string): void {
    bindAttemptInputsImpl(this.artifactsHost(), attemptId, runId, nodeKey);
  }

  private upstreamSealedOutputs(
    runId: string,
    nodeKey: string,
  ): Array<{ role: string; artifactId: string }> {
    return upstreamSealedOutputsImpl(this.artifactsHost(), runId, nodeKey);
  }

  private abortRunAttempts(runId: string): void {
    abortRunAttemptsImpl(this.schedulerHost(), runId);
  }

  private abortActiveAttempts(): void {
    abortActiveAttemptsImpl(this.schedulerHost());
  }

  private async waitForRunExecution(runId: string): Promise<void> {
    await waitForRunExecutionImpl(this.schedulerHost(), runId);
  }

  private mechanicalHost(): MechanicalHost {
    return {
      ...this.txCtx(),
      trustedPinnedInputs: (runId) => this.trustedPinnedInputs(runId),
      currentNodeGeneration: (runId, nodeKey) => this.currentNodeGeneration(runId, nodeKey),
      reconcileApplyingEffect: (input) => this.reconcileApplyingEffect(input),
    };
  }

  private freezeHost(): FreezeHost {
    const owner = this;
    return {
      ...this.casCtx(),
      get closed() {
        return owner.closed;
      },
      activeAttempts: this.activeAttempts,
      piAttemptExecutor: this.piAttemptExecutor,
      runBoundary: (input) => this.runBoundary(input),
      sealPreparation: (runId, preparation) => this.sealPreparation(runId, preparation),
      attemptInputDigest: (attemptId) => this.attemptInputDigest(attemptId),
      trustedPinnedInputs: (runId) => this.trustedPinnedInputs(runId),
      orphanPreparedArtifacts: (attemptId) => this.orphanPreparedArtifacts(attemptId),
    };
  }

  private async executeMechanical(
    claim: ClaimedNode,
    signal: AbortSignal,
  ): Promise<PiAttemptOutcome> {
    return executeMechanical(this.mechanicalHost(), claim, signal);
  }

  private async prepareUnsealedArtifact(
    claim: ClaimedNode,
    descriptor: PiAttemptArtifactDescriptor,
  ): Promise<ArtifactPreparation | undefined> {
    return prepareUnsealedArtifactImpl(this.artifactsHost(), claim, descriptor);
  }

  private async preparePlanExecutionPlan(
    claim: ClaimedNode,
    preparations: ArtifactPreparation[],
  ): Promise<ArtifactPreparation | undefined> {
    return preparePlanExecutionPlanImpl(this.artifactsHost(), claim, preparations);
  }

  private commitSuccessfulAttempt(
    claim: ClaimedNode,
    preparations: ArtifactPreparation[],
    metrics?: AttemptMetrics,
  ): void {
    commitSuccessfulAttemptImpl(this.attemptSuccessHost(), claim, preparations, metrics);
  }

  private async executeFreeze(claim: ClaimedFreeze): Promise<void> {
    return runFreeze(this.freezeHost(), claim);
  }

  private trustedPinnedInputs(runId: string): TrustedFrozenInputs | undefined {
    const run = asRow(
      this.db
        .prepare(
          "SELECT pinned_sources_json, skill_digest, pinned_digest FROM runs WHERE run_id = ?",
        )
        .get(runId),
    );
    if (
      !run ||
      run.pinned_digest === null ||
      run.pinned_sources_json === null ||
      run.skill_digest === null
    ) {
      return undefined;
    }
    try {
      return {
        sources: RepositorySnapshotSchema.array()
          .min(1)
          .parse(parseJson<unknown>(run.pinned_sources_json)),
        skillDigest: requiredText(run, "skill_digest"),
      };
    } catch {
      return undefined;
    }
  }

  private attemptInputDigest(attemptId: string): string {
    const attempt = asRow(
      this.db.prepare("SELECT input_digest FROM attempts WHERE attempt_id = ?").get(attemptId),
    );
    if (!attempt) throw new Error(`attempt not found: ${attemptId}`);
    return requiredText(attempt, "input_digest");
  }

  private async sealPreparation(runId: string, preparation: ArtifactPreparation): Promise<void> {
    await sealPreparationImpl(this.artifactsHost(), runId, preparation);
  }

  private orphanPreparedArtifacts(attemptId: string): void {
    orphanPreparedArtifactsImpl(this.artifactsHost(), attemptId);
  }

  private isCurrent(claim: ClaimedNode): boolean {
    const row = asRow(
      this.db
        .prepare(
          `SELECT 1 AS current
           FROM runs JOIN nodes ON nodes.run_id = runs.run_id
           JOIN attempts ON attempts.attempt_id = nodes.current_attempt_id
           WHERE runs.run_id = ? AND runs.cancel_requested = 0
             AND nodes.node_key = ? AND nodes.generation = ? AND nodes.current_attempt_id = ?
             AND nodes.state = 'running' AND attempts.node_generation = ? AND attempts.state = 'running'`,
        )
        .get(
          claim.runId,
          claim.nodeKey,
          claim.nodeGeneration,
          claim.attemptId,
          claim.nodeGeneration,
        ),
    );
    return row !== undefined;
  }

  private interruptRunningAttempts(): void {
    const attempts = asRows(
      this.db
        .prepare(
          "SELECT attempt_id, run_id, node_key, node_generation FROM attempts WHERE state = 'running'",
        )
        .all(),
    );
    for (const attempt of attempts) {
      const timestamp = now();
      const attemptId = requiredText(attempt, "attempt_id");
      const runId = requiredText(attempt, "run_id");
      const nodeKey = requiredText(attempt, "node_key");
      const generation = requiredNumber(attempt, "node_generation");
      this.db
        .prepare(
          "UPDATE attempts SET state = 'interrupted', error = 'owner stopped', ended_at = ? WHERE attempt_id = ? AND state = 'running'",
        )
        .run(timestamp, attemptId);
      this.db
        .prepare(
          `UPDATE nodes SET state = 'failed', current_attempt_id = NULL
           WHERE run_id = ? AND node_key = ? AND generation = ? AND current_attempt_id = ?`,
        )
        .run(runId, nodeKey, generation, attemptId);
      this.db
        .prepare("UPDATE runs SET state = 'failed', updated_at = ? WHERE run_id = ?")
        .run(timestamp, runId);
      this.emit(runId, "attempt.interrupted");
    }
  }

  private emit(runId: string, type: WikiRunEvent["type"]): number {
    const current = asRow(this.db.prepare("SELECT revision FROM runs WHERE run_id = ?").get(runId));
    const revision = requiredNumber(current ?? {}, "revision") + 1;
    const timestamp = now();
    this.db
      .prepare("UPDATE runs SET revision = ?, updated_at = ? WHERE run_id = ?")
      .run(revision, timestamp, runId);
    const eventId = requiredNumber(
      asRow(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(event_id), 0) + 1 AS event_id FROM run_events WHERE run_id = ?",
          )
          .get(runId),
      ) ?? {},
      "event_id",
    );
    const snapshot = this.snapshot(runId);
    const event = WikiRunEventSchema.parse({
      runId,
      eventId,
      revision,
      type,
      occurredAt: timestamp,
      snapshot,
    });
    this.db
      .prepare(
        "INSERT INTO run_events (run_id, event_id, revision, type, occurred_at, event_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(runId, eventId, revision, type, timestamp, JSON.stringify(event));
    return revision;
  }

  private snapshot(runId: string): WikiRunSnapshot {
    return buildSnapshot(this.db, runId);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  private rollback(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("workflow owner is closed");
  }
}

export async function openWikiRuns(input: OpenWikiRunsInput): Promise<WikiRuns> {
  const workspace = await loadWorkspace(input.rootPath);
  const dbPath = path.join(workspace.rootPath, ".okf-wiki", DATABASE_FILE_NAME);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    configureOwner(db);
    migrate(db);
    const owner = new WikiRunsOwner(
      db,
      workspace,
      input.piAttemptExecutor,
      input.freezeRunBoundary,
    );
    await owner.recover();
    return owner;
  } catch (error) {
    db?.close();
    if (sqliteBusy(error)) throw new WorkflowInUseError(workspace.rootPath, error);
    throw error;
  }
}
