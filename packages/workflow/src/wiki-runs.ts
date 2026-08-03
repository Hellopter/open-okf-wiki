import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PiAttemptExecutor } from "@okf-wiki/contract/pi-attempt";
import { CancelRunCommandSchema, ContinueEvaluationCommandSchema, CreateReviewThreadCommandSchema, PauseRunCommandSchema, RepositorySnapshotSchema, RequestRepairCommandSchema, RerunNodeCommandSchema, ResolveGateCommandSchema, ResolveReviewThreadCommandSchema, ResumeRunCommandSchema, RetryFailedNodeCommandSchema, type RunCommand, type RunCommandContext, RunCommandContextSchema, type RunCommandReceipt, StartRunCommandSchema, SubmitRunRevisionCommandSchema, type WikiRunEvent, WikiRunEventSchema, type WikiRunSnapshot, type WikiRunPlanReview, type WikiRunSpecRead, WikiRunSpecReadSchema } from "@okf-wiki/contract/wiki-runs";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "@okf-wiki/contract/workspace";
import {
  type FreezeRunBoundaryInput,
  type FrozenRunBoundary,
  freezeRunBoundary,
  loadWorkspace,
} from "@okf-wiki/core";
import {
  commitFailedAttemptArtifacts as commitFailedAttemptArtifactsImpl,
  orphanPreparedArtifacts as orphanPreparedArtifactsImpl,
  prepareUnsealedArtifact as prepareUnsealedArtifactImpl,
  sealPreparation as sealPreparationImpl,
} from "./wiki-runs/artifacts.js";
import {
  bindAttemptInputs as bindAttemptInputsImpl,
  copyAttemptInputs as copyAttemptInputsImpl,
  upstreamSealedOutputs as upstreamSealedOutputsImpl,
} from "./wiki-runs/attempt-inputs.js";
import {
  commitSuccessfulAttempt as commitSuccessfulAttemptImpl,
  preparePlanExecutionPlan as preparePlanExecutionPlanImpl,
  recoverPreparedArtifacts as recoverPreparedArtifactsImpl,
} from "./wiki-runs/attempt-finish/index.js";
import { CandidateReview } from "./wiki-runs/candidate-review.js";
import {
  applyCommand as applyCommandImpl,
  applyRerunAt as applyRerunAtImpl,
  recordCommand as recordCommandImpl,
  requeueFailedNode as requeueFailedNodeImpl,
} from "./wiki-runs/commands.js";
import { now } from "./wiki-runs/crypto-util.js";
import type { WikiRunsControl } from "./wiki-runs/ctx.js";
import { upstreamsSucceeded as upstreamsSucceededImpl } from "./wiki-runs/dag.js";
import {
  cancelPreApplyEffectsForPublication as cancelPreApplyEffectsForPublicationImpl,
  cancelPreApplyEffects as cancelPreApplyEffectsImpl,
  reconcileApplyingEffect as reconcileApplyingEffectImpl,
  reconcileApplyingEffects as reconcileApplyingEffectsImpl,
} from "./wiki-runs/publication-effect.js";
import { executeFreeze as runFreeze } from "./wiki-runs/freeze.js";
import {
  withdrawOpenGatesForNode as withdrawOpenGatesForNodeImpl,
  withdrawOpenGates as withdrawOpenGatesImpl,
} from "./wiki-runs/gate-open.js";
import {
  expireStaleOpenGates as expireStaleOpenGatesImpl,
  resolveGate as resolveGateImpl,
} from "./wiki-runs/gate-resolve.js";
import { executeMechanical } from "./wiki-runs/mechanical/index.js";
import { readPlanReviewMaterials } from "./wiki-runs/plan-review.js";
import {
  abortActiveAttempts as abortActiveAttemptsImpl,
  abortRunAttempts as abortRunAttemptsImpl,
  runScheduler,
  waitForRunExecution as waitForRunExecutionImpl,
} from "./wiki-runs/scheduler.js";
import { configureOwner, migrate } from "./wiki-runs/schema.js";
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
import { readAttemptTranscript as readAttemptTranscriptImpl } from "./wiki-runs/transcript.js";
import {
  type ClaimedNode,
  DATABASE_FILE_NAME,
  type OpenWikiRunsInput,
  type TrustedFrozenInputs,
  type WikiRunAttemptTranscript,
  type WikiRunListItem,
  type WikiRunRead,
  type WikiRuns,
  WikiRunsRequestError,
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
export {
  CommandIdCollision,
  WikiRunsRequestError,
  type WikiRunsRequestErrorCode,
  WorkflowInUseError,
} from "./wiki-runs/types.js";

function parseRunCommand(value: unknown): RunCommand {
  const type = (value as { type?: unknown } | null)?.type;
  switch (type) {
    case "start_run":
      return StartRunCommandSchema.parse(value);
    case "retry_failed_node":
      return RetryFailedNodeCommandSchema.parse(value);
    case "rerun_node":
      return RerunNodeCommandSchema.parse(value);
    case "continue_evaluation":
      return ContinueEvaluationCommandSchema.parse(value);
    case "cancel_run":
      return CancelRunCommandSchema.parse(value);
    case "submit_run_revision":
      return SubmitRunRevisionCommandSchema.parse(value);
    case "pause_run":
      return PauseRunCommandSchema.parse(value);
    case "resume_run":
      return ResumeRunCommandSchema.parse(value);
    case "create_review_thread":
      return CreateReviewThreadCommandSchema.parse(value);
    case "resolve_review_thread":
      return ResolveReviewThreadCommandSchema.parse(value);
    case "request_repair":
      return RequestRepairCommandSchema.parse(value);
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
  private gateExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  private gateExpiryRefreshQueued = false;
  private readonly activeAttempts = new Map<string, AbortController>();
  private readonly activeExecutions = new Map<string, Promise<void>>();
  /** Cached single control-plane object (see {@link control}). */
  private _control: WikiRunsControl | undefined;

  constructor(
    private readonly db: DatabaseSync,
    private workspace: WorkspaceConfig,
    private readonly piAttemptExecutor?: PiAttemptExecutor,
    private readonly runBoundary: (
      input: FreezeRunBoundaryInput,
    ) => Promise<FrozenRunBoundary> = freezeRunBoundary,
  ) {}

  /** Update only the snapshot used by a later StartRun; existing Runs are immutable. */
  setWorkspaceForNewRuns(workspace: WorkspaceConfig): void {
    this.assertOpen();
    if (workspace.rootPath !== this.workspace.rootPath) {
      throw new Error("setWorkspaceForNewRuns rootPath must match the open owner");
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
    this.transaction(() => expireStaleOpenGatesImpl(this.control()));
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

  private async readRunIndexItems(): Promise<WikiRunListItem[]> {
    this.assertOpen();
    this.db.exec("BEGIN DEFERRED");
    try {
      const rows = asRows(
        this.db
          .prepare(
            `SELECT run_id, operator_session_id, state, updated_at, revision
             FROM runs
             ORDER BY updated_at DESC, run_id DESC`,
          )
          .all(),
      );
      this.db.exec("COMMIT");
      return rows.map((row) => {
        const runId = requiredText(row, "run_id");
        const progress = asRow(
          this.db
            .prepare(
              `SELECT
                 SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END) AS completed,
                 COUNT(*) AS total
               FROM nodes
               WHERE run_id = ?
                 AND generation = (
                   SELECT MAX(n2.generation) FROM nodes n2
                   WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
                 )`,
            )
            .get(runId),
        );
        const attentionRow = asRow(
          this.db
            .prepare("SELECT 1 AS present FROM gates WHERE run_id = ? AND state = 'open' LIMIT 1")
            .get(runId),
        );
        const reviewRow = asRow(
          this.db
            .prepare(
              "SELECT 1 AS present FROM review_threads WHERE run_id = ? AND state = 'open' LIMIT 1",
            )
            .get(runId),
        );
        const state = requiredText(row, "state") as WikiRunSnapshot["state"];
        const sessionId =
          typeof row.operator_session_id === "string" && row.operator_session_id.trim()
            ? row.operator_session_id
            : undefined;
        return {
          runId,
          ...(sessionId ? { sessionId } : {}),
          state,
          updatedAt: requiredText(row, "updated_at"),
          revision: requiredNumber(row, "revision"),
          attention:
            state === "paused"
              ? "paused"
              : attentionRow
                ? "gate"
                : reviewRow
                  ? "review"
                  : state === "failed"
                    ? "failure"
                    : "none",
          completedNodes: requiredNumber(progress ?? { completed: 0 }, "completed"),
          totalNodes: requiredNumber(progress ?? { total: 0 }, "total"),
        };
      });
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  async readIndex(input: { afterEventId?: number; limit?: number } = {}): Promise<{
    runs: WikiRunListItem[];
    cursor: number;
  }> {
    this.assertOpen();
    const afterEventId = input.afterEventId ?? 0;
    const limit = input.limit ?? 1_000;
    if (!Number.isSafeInteger(afterEventId) || afterEventId < 0)
      throw new Error("afterEventId must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error("limit must be between 1 and 1000");
    this.db.exec("BEGIN DEFERRED");
    try {
      const cursor = requiredNumber(
        asRow(
          this.db
            .prepare(
              "SELECT COALESCE(MAX(event_id), 0) AS cursor FROM run_index_events WHERE workspace_id = ?",
            )
            .get(this.workspace.id),
        ) ?? {},
        "cursor",
      );
      // The compact index is a projection. Its SSE cursor tells clients whether
      // it changed; consumers replace the full list rather than replay deltas.
      const changed = asRow(
        this.db
          .prepare(
            `SELECT 1 AS present FROM run_index_events
             WHERE workspace_id = ? AND event_id > ? ORDER BY event_id LIMIT ?`,
          )
          .get(this.workspace.id, afterEventId, limit),
      );
      this.db.exec("COMMIT");
      return { runs: changed || afterEventId === 0 ? await this.readRunIndexItems() : [], cursor };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  async readCandidatePage(input: { runId: string; candidateDigest: string; pagePath: string }) {
    this.assertOpen();
    return new CandidateReview(this.control()).readPage(input);
  }

  async readCandidateTree(input: { runId: string; candidateDigest: string }) {
    this.assertOpen();
    return new CandidateReview(this.control()).readTree(input);
  }

  async readCandidateDiff(input: { runId: string; candidateDigest: string; pagePath: string }) {
    this.assertOpen();
    return new CandidateReview(this.control()).readDiff(input);
  }

  async readAttemptTranscript(input: {
    runId: string;
    attemptId: string;
    beforeSequence?: number;
    afterSequence?: number;
    limit?: number;
  }): Promise<WikiRunAttemptTranscript> {
    this.assertOpen();
    return readAttemptTranscriptImpl(this.control(), input);
  }

  /**
   * Full plan-gate review materials (Spec + ExecutionPlan summary).
   * Prefer this over {@link readPlanSpec} for operator document review.
   */
  async readPlanReview(input: { runId: string }): Promise<WikiRunPlanReview> {
    this.assertOpen();
    const runId = input.runId;
    this.db.exec("BEGIN DEFERRED");
    try {
      const result = readPlanReviewMaterials(
        { db: this.db, workspace: this.workspace },
        runId,
      );
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  /** Thin Spec-only read; implemented via {@link readPlanReview} for one load path. */
  async readPlanSpec(input: { runId: string }): Promise<WikiRunSpecRead> {
    const review = await this.readPlanReview(input);
    return WikiRunSpecReadSchema.parse({
      runId: review.runId,
      artifactId: review.artifact.specArtifactId,
      digest: review.specDigest,
      spec: review.spec,
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.clearGateExpiryTimer();
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
    await recoverPreparedArtifactsImpl(this.control());
  }

  private applyCommand(command: RunCommand, context: RunCommandContext): RunCommandReceipt {
    return applyCommandImpl(this.control(), command, context);
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

  private workspaceForRun(runId: string): WorkspaceConfig {
    const row = asRow(
      this.db.prepare("SELECT freeze_config_json FROM runs WHERE run_id = ?").get(runId),
    );
    if (!row) throw new WikiRunsRequestError("not_found", `run not found: ${runId}`);
    return WorkspaceConfigSchema.parse(parseJson<unknown>(requiredText(row, "freeze_config_json")));
  }

  /**
   * Single control-plane object for all module entry points.
   * Built once; closed/workspace are live getters.
   */
  private control(): WikiRunsControl {
    if (this._control) return this._control;
    const self = this;
    const ctrl: WikiRunsControl = {
      get workspace() {
        return self.workspace;
      },
      workspaceForRun: (runId) => self.workspaceForRun(runId),
      db: self.db,
      emit: (runId, type) => self.emit(runId, type),
      transaction: (work) => self.transaction(work),
      isCurrent: (claim) => self.isCurrent(claim),
      currentNodeGeneration: (runId, nodeKey) => self.currentNodeGeneration(runId, nodeKey),
      get closed() {
        return self.closed;
      },
      get piAttemptExecutor() {
        return self.piAttemptExecutor;
      },
      activeAttempts: self.activeAttempts,
      activeExecutions: self.activeExecutions,
      currentNodeRow: (runId, nodeKey) => self.currentNodeRow(runId, nodeKey),
      applyRerunAt: (runId, nodeKey, generation, feedback, opts) =>
        applyRerunAtImpl(ctrl, runId, nodeKey, generation, feedback, opts),
      abortRunAttempts: (runId) => abortRunAttemptsImpl(ctrl, runId),
      withdrawOpenGates: (runId) => withdrawOpenGatesImpl(ctrl, runId),
      withdrawOpenGatesForNode: (runId, nodeKey, generation) =>
        withdrawOpenGatesForNodeImpl(ctrl, runId, nodeKey, generation),
      cancelPreApplyEffects: (runId) => cancelPreApplyEffectsImpl(ctrl, runId),
      cancelPreApplyEffectsForPublication: (runId, publicationNodeKey, publicationNodeGeneration) =>
        cancelPreApplyEffectsForPublicationImpl(
          ctrl,
          runId,
          publicationNodeKey,
          publicationNodeGeneration,
        ),
      resolveGate: (command, context, payloadDigest) =>
        resolveGateImpl(ctrl, command, context, payloadDigest),
      recordCommand: (command, context, payloadDigest, runId, revision) =>
        recordCommandImpl(ctrl, command, context, payloadDigest, runId, revision),
      upstreamsSucceeded: (runId, nodeKey) =>
        upstreamsSucceededImpl(
          {
            db: self.db,
            currentNodeGeneration: (id, key) => self.currentNodeGeneration(id, key),
          },
          runId,
          nodeKey,
        ),
      upstreamSealedOutputs: (runId, nodeKey) =>
        upstreamSealedOutputsImpl(ctrl, runId, nodeKey),
      copyAttemptInputs: (attemptId, inputs) => copyAttemptInputsImpl(ctrl, attemptId, inputs),
      bindAttemptInputs: (attemptId, runId, nodeKey) =>
        bindAttemptInputsImpl(ctrl, attemptId, runId, nodeKey),
      executeFreeze: (claim) => runFreeze(ctrl, claim),
      executeMechanical: (claim, signal) => executeMechanical(ctrl, claim, signal),
      prepareUnsealedArtifact: (claim, descriptor) =>
        prepareUnsealedArtifactImpl(ctrl, claim, descriptor),
      sealPreparation: (runId, preparation) => sealPreparationImpl(ctrl, runId, preparation),
      preparePlanExecutionPlan: (claim, preparations) =>
        preparePlanExecutionPlanImpl(ctrl, claim, preparations),
      commitSuccessfulAttempt: (claim, preparations, metrics) =>
        commitSuccessfulAttemptImpl(ctrl, claim, preparations, metrics),
      commitFailedAttemptArtifacts: (claim, preparations) =>
        commitFailedAttemptArtifactsImpl(ctrl, claim, preparations),
      orphanPreparedArtifacts: (attemptId) => orphanPreparedArtifactsImpl(ctrl, attemptId),
      requeueFailedNode: (runId, nodeKey, generation, lastAttemptId) =>
        requeueFailedNodeImpl(ctrl, runId, nodeKey, generation, lastAttemptId),
      trustedPinnedInputs: (runId) => self.trustedPinnedInputs(runId),
      attemptInputDigest: (attemptId) => self.attemptInputDigest(attemptId),
      runBoundary: (input) => self.runBoundary(input),
      reconcileApplyingEffect: (input) => reconcileApplyingEffectImpl(ctrl, input),
    };
    this._control = ctrl;
    return ctrl;
  }

  private schedule(): void {
    if (this.closed) return;
    try {
      this.transaction(() => {
        expireStaleOpenGatesImpl(this.control());
      });
    } catch {
      // Expiry best-effort; do not block the scheduler on a single bad gate.
    }
    this.refreshGateExpiryTimer();
    if (this.scheduler) return;
    this.scheduler = runScheduler(this.control()).finally(() => {
      this.scheduler = undefined;
      this.refreshGateExpiryTimer();
    });
  }

  private abortActiveAttempts(): void {
    abortActiveAttemptsImpl(this.control());
  }

  private async waitForRunExecution(runId: string): Promise<void> {
    await waitForRunExecutionImpl(this.control(), runId);
  }

  private async reconcileApplyingEffects(): Promise<void> {
    return reconcileApplyingEffectsImpl(this.control());
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
    this.db
      .prepare(
        `INSERT INTO run_index_events (workspace_id, occurred_at)
         SELECT workspace_id, ? FROM runs WHERE run_id = ?`,
      )
      .run(timestamp, runId);
    if (type === "gate.opened" || type === "gate.resolved" || type === "gate.withdrawn") {
      this.requestGateExpiryTimerRefresh();
    }
    return revision;
  }

  /** Re-arm after the enclosing transaction commits; gate state changes happen inside it. */
  private requestGateExpiryTimerRefresh(): void {
    if (this.closed || this.gateExpiryRefreshQueued) return;
    this.gateExpiryRefreshQueued = true;
    queueMicrotask(() => {
      this.gateExpiryRefreshQueued = false;
      this.refreshGateExpiryTimer();
    });
  }

  private clearGateExpiryTimer(): void {
    if (!this.gateExpiryTimer) return;
    clearTimeout(this.gateExpiryTimer);
    this.gateExpiryTimer = undefined;
  }

  /** Keep one unref'd wake-up for the earliest auto-expiring gate. */
  private refreshGateExpiryTimer(): void {
    this.clearGateExpiryTimer();
    if (this.closed) return;

    const rows = asRows(
      this.db
        .prepare(
          `SELECT gates.run_id, gates.opened_at FROM gates
           WHERE gates.state = 'open' AND gates.kind IN ('plan', 'publication', 'fix')
           ORDER BY gates.opened_at, gates.gate_id`,
        )
        .all(),
    );
    let delayMs: number | undefined;
    for (const row of rows) {
      const timeoutSec =
        this.workspaceForRun(requiredText(row, "run_id")).limits?.gateTimeoutSeconds ?? 0;
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) continue;
      const openedMs = Date.parse(requiredText(row, "opened_at"));
      if (!Number.isFinite(openedMs)) continue;
      const candidate = Math.max(0, openedMs + timeoutSec * 1_000 - Date.now());
      delayMs = delayMs === undefined ? candidate : Math.min(delayMs, candidate);
    }
    if (delayMs === undefined) return;
    this.gateExpiryTimer = setTimeout(() => {
      this.gateExpiryTimer = undefined;
      if (!this.closed) this.schedule();
    }, delayMs);
    this.gateExpiryTimer.unref();
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
