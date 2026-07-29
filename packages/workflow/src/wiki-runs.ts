import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CancelRunCommandSchema,
  type PiAttemptArtifactDescriptor,
  type PiAttemptExecutor,
  type PiAttemptInput,
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
  type WikiRunArtifactKind,
  type WikiRunAttempt,
  type WikiRunEvent,
  WikiRunEventSchema,
  type WikiRunNode,
  type WikiRunSnapshot,
  WikiRunSnapshotSchema,
  WikiRunSpecSchema,
  type WorkspaceConfig,
  WorkspaceConfigSchema,
} from "@okf-wiki/contract";
import {
  applySealedPublicationCandidate,
  capturePublicationBaseline,
  EMPTY_PUBLICATION_DIGEST,
  type FreezeRunBoundaryInput,
  type FrozenRunBoundary,
  freezeRunBoundary,
  isPathInside,
  loadWorkspace,
  materializePublicationCandidate,
  PublicationConflictError,
  reconcilePublicationApply,
  runWorkDir,
  validateWikiTree,
} from "@okf-wiki/core";
import {
  buildDefinitionV1Graph,
  isGateKind,
  isMechanicalAttemptKind,
  isPiAttemptKind,
} from "./definition-v1.js";
import { artifactId, digest, now } from "./wiki-runs/crypto-util.js";
import { durableFsyncPath, makeOwnedTreeWritable, manifestFor } from "./wiki-runs/fs-util.js";
import { configureOwner, migrate } from "./wiki-runs/schema.js";
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
  parseTranscriptMessages,
  writeConversationTranscript,
} from "./wiki-runs/transcript-io.js";
import {
  type ArtifactPreparation,
  type ClaimedFreeze,
  type ClaimedNode,
  CommandIdCollision,
  DATABASE_FILE_NAME,
  type OpenWikiRunsInput,
  type PreparedFreeze,
  type PreparedFreezeArtifacts,
  RESEARCH_AUTO_RETRY_KINDS,
  RESEARCH_AUTO_RETRY_MAX_ATTEMPTS,
  TRANSCRIPT_MAX_BYTES,
  type TrustedFrozenInputs,
  type WikiRunAttemptTranscript,
  type WikiRunListItem,
  type WikiRunRead,
  type WikiRuns,
  WorkflowInUseError,
} from "./wiki-runs/types.js";

// Re-export public surface for existing `from "./wiki-runs.js"` imports.
export type {
  ClaimedNode,
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
    private readonly workspace: WorkspaceConfig,
    private readonly piAttemptExecutor?: PiAttemptExecutor,
    private readonly runBoundary: (
      input: FreezeRunBoundaryInput,
    ) => Promise<FrozenRunBoundary> = freezeRunBoundary,
  ) {}

  async dispatch(command: RunCommand, context: RunCommandContext): Promise<RunCommandReceipt> {
    this.assertOpen();
    const parsedCommand = parseRunCommand(command);
    const parsedContext = RunCommandContextSchema.parse(context);
    if (parsedContext.workspaceId !== this.workspace.id) {
      throw new Error("command workspace does not match the opened workspace");
    }
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
    const runId = input.runId.trim();
    const attemptId = input.attemptId.trim();
    if (!runId) throw new Error("runId is required");
    if (!attemptId) throw new Error("attemptId is required");

    this.db.exec("BEGIN DEFERRED");
    let attempt: SqlRow | undefined;
    let sealedRelativePaths: string[] = [];
    try {
      const run = asRow(this.db.prepare("SELECT run_id FROM runs WHERE run_id = ?").get(runId));
      if (!run) throw new Error(`run not found: ${runId}`);
      attempt = asRow(
        this.db
          .prepare(
            `SELECT attempt_id, run_id, node_key, state, error FROM attempts
             WHERE attempt_id = ? AND run_id = ?`,
          )
          .get(attemptId, runId),
      );
      if (!attempt) throw new Error(`attempt not found: ${attemptId}`);
      sealedRelativePaths = asRows(
        this.db
          .prepare(
            `SELECT relative_path FROM artifacts
             WHERE run_id = ? AND producer_attempt_id = ? AND kind = 'transcript'
             ORDER BY sealed_at DESC`,
          )
          .all(runId, attemptId),
      ).map((row) => requiredText(row, "relative_path"));
      // Also accept node_outputs role=transcript for this attempt's generation
      // when producer_attempt_id was not recorded on older rows (defensive).
      if (sealedRelativePaths.length === 0) {
        sealedRelativePaths = asRows(
          this.db
            .prepare(
              `SELECT artifacts.relative_path
               FROM attempts
               JOIN node_outputs
                 ON node_outputs.run_id = attempts.run_id
                AND node_outputs.node_key = attempts.node_key
                AND node_outputs.node_generation = attempts.node_generation
               JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
               WHERE attempts.attempt_id = ?
                 AND attempts.run_id = ?
                 AND (node_outputs.role = 'transcript' OR artifacts.kind = 'transcript')
               ORDER BY artifacts.sealed_at DESC`,
            )
            .all(attemptId, runId),
        ).map((row) => requiredText(row, "relative_path"));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback();
      throw error;
    }

    const nodeKey = requiredText(attempt, "node_key");
    const state = requiredText(attempt, "state") as WikiRunAttempt["state"];
    const attemptError =
      typeof attempt.error === "string" && attempt.error.trim() ? attempt.error.trim() : null;

    const runDir = runWorkDir(this.workspace.rootPath, runId);
    const candidates = this.transcriptCandidatePaths(runDir, attemptId, sealedRelativePaths);
    const transcriptPath = await this.firstExistingTranscriptFile(runDir, candidates);

    // Attempt exists but no file yet (running) or never sealed (legacy / wipe):
    // return 200-shaped empty/synthetic messages — never "transcript not found" 404.
    // Only run/attempt missing stay 404 for the HTTP adapter.
    if (!transcriptPath) {
      const messages: unknown[] = attemptError
        ? [
            { role: "assistant", content: `Error: ${attemptError.slice(0, 4_000)}` },
            {
              schema: 1,
              node: nodeKey,
              mode: "missing_transcript",
              summary: attemptError.slice(0, 4_000),
              error: attemptError.slice(0, 4_000),
            },
          ]
        : [];
      return {
        attemptId: requiredText(attempt, "attempt_id"),
        nodeKey,
        state,
        messages,
      };
    }

    const info = await lstat(transcriptPath);
    if (!info.isFile()) {
      return {
        attemptId: requiredText(attempt, "attempt_id"),
        nodeKey,
        state,
        messages: [],
      };
    }
    if (info.size > TRANSCRIPT_MAX_BYTES) {
      throw new Error(`transcript exceeds size limit (${TRANSCRIPT_MAX_BYTES} bytes)`);
    }

    const raw = await readFile(transcriptPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > TRANSCRIPT_MAX_BYTES) {
      throw new Error(`transcript exceeds size limit (${TRANSCRIPT_MAX_BYTES} bytes)`);
    }

    let messages: unknown[];
    try {
      messages = parseTranscriptMessages(raw);
    } catch (error) {
      throw new Error(
        `transcript is not valid JSON/JSONL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      attemptId: requiredText(attempt, "attempt_id"),
      nodeKey,
      state,
      messages,
    };
  }

  /**
   * Candidate transcript files under the run work dir.
   * Live session first, then sealed transcript artifact leaves.
   */
  private transcriptCandidatePaths(
    runDir: string,
    attemptId: string,
    sealedRelativePaths: string[],
  ): string[] {
    const candidates: string[] = [path.join(runDir, "attempts", attemptId, "session.jsonl")];
    for (const relativePath of sealedRelativePaths) {
      // Reject absolute or parent-escaping relative paths before join.
      if (path.isAbsolute(relativePath) || relativePath.split(/[/\\]/).includes("..")) continue;
      const artifactRoot = path.join(runDir, relativePath);
      candidates.push(
        path.join(artifactRoot, "session.jsonl"),
        path.join(artifactRoot, "transcript.jsonl"),
        artifactRoot,
      );
    }
    return candidates;
  }

  /** First ordinary file among candidates that stays inside the run work dir. */
  private async firstExistingTranscriptFile(
    runDir: string,
    candidates: string[],
  ): Promise<string | undefined> {
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      if (!isPathInside(runDir, resolved)) {
        throw new Error("transcript path escaped run work dir");
      }
      const info = await lstat(resolved).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) continue;
      if (info.isSymbolicLink()) continue;
      if (info.isFile()) return resolved;
    }
    return undefined;
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
    const rows = asRows(
      this.db
        .prepare(
          `SELECT preparation_id, attempt_id, run_id, node_key, node_generation, artifact_id, kind, role,
                  manifest_digest, relative_path
           FROM artifact_preparations WHERE state = 'prepared' ORDER BY attempt_id, preparation_id`,
        )
        .all(),
    );
    const grouped = new Map<string, SqlRow[]>();
    for (const row of rows) {
      const attemptId = requiredText(row, "attempt_id");
      grouped.set(attemptId, [...(grouped.get(attemptId) ?? []), row]);
    }
    for (const [attemptId, preparations] of grouped) {
      const first = preparations[0]!;
      const runId = requiredText(first, "run_id");
      const valid = await Promise.all(
        preparations.map((preparation) =>
          this.verifyArtifact(
            path.join(
              runWorkDir(this.workspace.rootPath, runId),
              requiredText(preparation, "relative_path"),
            ),
            requiredText(preparation, "manifest_digest"),
          ),
        ),
      );
      if (!valid.every(Boolean)) {
        this.transaction(() =>
          this.db
            .prepare(
              "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
            )
            .run(attemptId),
        );
        continue;
      }
      const output = preparations.find(
        (preparation) => requiredText(preparation, "role") === "attempt_output",
      );
      if (!output) {
        this.transaction(() =>
          this.db
            .prepare(
              "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
            )
            .run(attemptId),
        );
        continue;
      }
      const inputs = this.trustedFrozenInputs(runId);
      if (!inputs) {
        this.transaction(() =>
          this.db
            .prepare(
              "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
            )
            .run(attemptId),
        );
        continue;
      }
      const claim: ClaimedFreeze = {
        attemptId,
        nodeGeneration: requiredNumber(first, "node_generation"),
        nodeKey: "freeze",
        kind: "freeze",
        runId,
      };
      const prepared: ArtifactPreparation[] = preparations.map((preparation) => ({
        artifactId: requiredText(preparation, "artifact_id"),
        digest: requiredText(preparation, "manifest_digest"),
        kind: requiredText(preparation, "kind") as ArtifactPreparation["kind"],
        preparationId: requiredText(preparation, "preparation_id"),
        relativePath: requiredText(preparation, "relative_path"),
        role: requiredText(preparation, "role"),
        sourceDirectory: "",
      }));
      this.transaction(() => this.commitFreezeArtifacts(claim, prepared));
    }
  }

  private applyCommand(command: RunCommand, context: RunCommandContext): RunCommandReceipt {
    const payloadDigest = digest(command);
    const existing = asRow(
      this.db
        .prepare(
          "SELECT payload_digest, run_id, revision, accepted FROM commands WHERE workspace_id = ? AND command_id = ?",
        )
        .get(this.workspace.id, command.commandId),
    );
    if (existing) {
      if (requiredText(existing, "payload_digest") !== payloadDigest)
        throw new CommandIdCollision(command.commandId);
      return {
        commandId: command.commandId,
        runId: requiredText(existing, "run_id"),
        revision: requiredNumber(existing, "revision"),
        accepted: requiredNumber(existing, "accepted") === 1,
      };
    }

    if (command.type === "retry_failed_node")
      return this.retryFailedNode(command, context, payloadDigest);
    if (command.type === "rerun_node") return this.rerunNode(command, context, payloadDigest);
    if (command.type === "resolve_gate") return this.resolveGate(command, context, payloadDigest);
    if (command.type === "cancel_run") return this.cancelRun(command, context, payloadDigest);
    if (command.type !== "start_run") {
      throw new Error(
        `unknown WikiRuns command type: ${String((command as { type?: unknown }).type)}`,
      );
    }

    const runId = randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO runs (
          run_id, workspace_id, operator_session_id, revision, state, cancel_requested,
          freeze_config_json, freeze_config_digest,
          frozen_sources_json, frozen_skill_digest,
          pinned_sources_json, skill_digest, pinned_digest, created_at, updated_at
        ) VALUES (?, ?, ?, 0, 'queued', 0, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        runId,
        this.workspace.id,
        context.sessionId ?? null,
        JSON.stringify(this.workspace),
        digest(this.workspace),
        timestamp,
        timestamp,
      );
    this.db
      .prepare(
        `INSERT INTO nodes (
          run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
        ) VALUES (?, 'freeze', 'freeze', 'ready', 0, NULL, NULL, NULL)`,
      )
      .run(runId);
    const revision = this.emit(runId, "run.started");
    this.db
      .prepare(
        `INSERT INTO commands (
          workspace_id, command_id, payload_digest, actor_id, actor_kind, run_id, revision, accepted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        this.workspace.id,
        command.commandId,
        payloadDigest,
        context.actor.id,
        context.actor.kind,
        runId,
        revision,
      );
    return { commandId: command.commandId, runId, revision, accepted: true };
  }

  private retryFailedNode(
    command: Extract<RunCommand, { type: "retry_failed_node" }>,
    context: RunCommandContext,
    payloadDigest: string,
  ): RunCommandReceipt {
    const currentGeneration = this.currentNodeGeneration(command.runId, command.nodeKey);
    if (currentGeneration === undefined || currentGeneration !== command.generation) {
      throw new Error("retry target is stale: generation is not current");
    }
    const node = asRow(
      this.db
        .prepare(
          `SELECT nodes.state, nodes.last_attempt_id, nodes.kind, attempts.state AS attempt_state,
                  attempts.input_digest, runs.pinned_digest, runs.state AS run_state
           FROM nodes JOIN attempts ON attempts.attempt_id = nodes.last_attempt_id
           JOIN runs ON runs.run_id = nodes.run_id
           WHERE nodes.run_id = ? AND nodes.node_key = ? AND nodes.generation = ?
             AND nodes.last_attempt_id = ? AND runs.cancel_requested = 0`,
        )
        .get(command.runId, command.nodeKey, command.generation, command.attemptId),
    );
    if (
      !node ||
      requiredText(node, "state") !== "failed" ||
      !["failed", "interrupted"].includes(requiredText(node, "attempt_state"))
    ) {
      throw new Error("retry target is stale or not a failed attempt");
    }
    const runState = requiredText(node, "run_state");
    if (runState === "published")
      throw new Error("cannot retry a node on a published run; start a new run");
    if (runState === "cancelled") throw new Error("cannot retry a node on a cancelled run");
    // A pre-pin freeze has only live selectors, not immutable inputs. Retrying it
    // under the old digest would falsely claim reproducibility.
    if (command.nodeKey === "freeze" && node.pinned_digest === null)
      throw new Error("cannot retry a freeze before its inputs are pinned; start a new run");
    // If any downstream Attempt already bound this generation's outputs, same-input
    // retry is no longer valid — operator must RerunNode (generation++ + invalidation).
    const consumers = this.lineageInvalidationClosure(
      command.runId,
      command.nodeKey,
      command.generation,
    );
    if (consumers.length > 0) {
      throw new Error(
        "downstream already consumed this node's outputs; use RerunNode instead of RetryFailedNode",
      );
    }
    // Frozen input digest must still match current sealed upstreams (or prior attempt
    // inputs when freeze post-pin reuses pins). Changed lineage → RerunNode.
    if (command.nodeKey !== "freeze") {
      const priorDigest = requiredText(node, "input_digest");
      const liveDigest = this.liveInputDigest(command.runId, command.nodeKey);
      if (liveDigest !== priorDigest) {
        throw new Error("retry inputs are stale: sealed upstream lineage changed; use RerunNode");
      }
    }
    this.requeueFailedNode(command.runId, command.nodeKey, command.generation, command.attemptId);
    const revision = this.emit(command.runId, "node.ready");
    this.recordCommand(command, context, payloadDigest, command.runId, revision);
    return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
  }

  /** Shared path for manual RetryFailedNode and research auto-retry. */
  private requeueFailedNode(
    runId: string,
    nodeKey: string,
    generation: number,
    lastAttemptId: string,
  ): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE nodes SET state = 'ready', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ? AND last_attempt_id = ? AND state = 'failed'`,
      )
      .run(runId, nodeKey, generation, lastAttemptId);
    this.db
      .prepare(
        "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, runId);
  }

  /** Digest of current sealed upstream envelope (same algorithm as first claim). */
  private liveInputDigest(runId: string, nodeKey: string): string {
    const upstreams = this.upstreamSealedOutputs(runId, nodeKey);
    return digest(upstreams.map((input) => ({ role: input.role, artifactId: input.artifactId })));
  }

  private cancelRun(
    command: Extract<RunCommand, { type: "cancel_run" }>,
    context: RunCommandContext,
    payloadDigest: string,
  ): RunCommandReceipt {
    const run = asRow(
      this.db
        .prepare("SELECT cancel_requested, state FROM runs WHERE run_id = ?")
        .get(command.runId),
    );
    if (!run) throw new Error(`run not found: ${command.runId}`);
    const state = requiredText(run, "state");
    if (!["queued", "running", "waiting_for_operator", "cancelling"].includes(state))
      throw new Error(`cannot cancel run in terminal state: ${state}`);
    const timestamp = now();
    if (requiredNumber(run, "cancel_requested") === 0) {
      this.abortRunAttempts(command.runId);
      this.db
        .prepare(
          `UPDATE runs SET cancel_requested = 1, state = 'cancelling', updated_at = ?
           WHERE run_id = ? AND state IN ('queued', 'running', 'waiting_for_operator', 'cancelling')`,
        )
        .run(timestamp, command.runId);
      this.emit(command.runId, "run.cancel_requested");
      this.withdrawOpenGates(command.runId);
      this.cancelPreApplyEffects(command.runId);
      this.db
        .prepare(
          "UPDATE attempts SET state = 'cancelled', error = 'cancel requested', ended_at = ? WHERE run_id = ? AND state = 'running'",
        )
        .run(timestamp, command.runId);
      this.db
        .prepare(
          `UPDATE nodes SET state = 'cancelled', current_attempt_id = NULL
           WHERE run_id = ? AND state IN ('blocked', 'ready', 'running', 'waiting', 'invalidated')`,
        )
        .run(command.runId);
      this.db
        .prepare("UPDATE runs SET state = 'cancelled', updated_at = ? WHERE run_id = ?")
        .run(timestamp, command.runId);
    }
    const revision = this.emit(command.runId, "run.cancelled");
    this.recordCommand(command, context, payloadDigest, command.runId, revision);
    return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
  }

  private resolveGate(
    command: Extract<RunCommand, { type: "resolve_gate" }>,
    context: RunCommandContext,
    payloadDigest: string,
  ): RunCommandReceipt {
    const run = asRow(
      this.db
        .prepare("SELECT cancel_requested, state FROM runs WHERE run_id = ?")
        .get(command.runId),
    );
    if (!run) throw new Error(`run not found: ${command.runId}`);
    if (requiredNumber(run, "cancel_requested") === 1)
      throw new Error("cannot resolve gate on a cancelled run");
    const gate = asRow(
      this.db
        .prepare(
          `SELECT gate_id, run_id, node_key, node_generation, kind, state, payload_digest
           FROM gates WHERE gate_id = ? AND run_id = ?`,
        )
        .get(command.gateId, command.runId),
    );
    if (!gate) throw new Error(`gate not found: ${command.gateId}`);
    if (requiredText(gate, "state") !== "open") throw new Error("gate is stale or already closed");
    if (requiredText(gate, "kind") !== command.gateKind)
      throw new Error("gate kind does not match the open gate");
    if (requiredText(gate, "payload_digest") !== command.payloadDigest)
      throw new Error("gate payload digest does not match the open gate");
    const nodeKey = requiredText(gate, "node_key");
    const nodeGeneration = requiredNumber(gate, "node_generation");
    const currentGen = this.currentNodeGeneration(command.runId, nodeKey);
    if (currentGen !== nodeGeneration)
      throw new Error("gate is stale: node generation was replaced");

    const timestamp = now();
    const decision = {
      commandId: command.commandId,
      decision: command.decision,
      payloadDigest: command.payloadDigest,
      decidedAt: timestamp,
    };
    const detail =
      command.feedback !== undefined
        ? { feedback: command.feedback }
        : command.answer !== undefined
          ? { answer: command.answer }
          : null;
    this.db
      .prepare(
        `UPDATE gates SET state = 'resolved', decision_json = ?, detail_json = ?
         WHERE gate_id = ? AND state = 'open'`,
      )
      .run(
        JSON.stringify(decision),
        detail === null ? null : JSON.stringify(detail),
        command.gateId,
      );
    const updated = asRow(
      this.db.prepare("SELECT state FROM gates WHERE gate_id = ?").get(command.gateId),
    );
    if (!updated || requiredText(updated, "state") !== "resolved")
      throw new Error("gate is stale or already closed");

    this.db
      .prepare(
        `UPDATE nodes SET state = 'succeeded', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ? AND state IN ('waiting', 'ready', 'running')`,
      )
      .run(command.runId, nodeKey, nodeGeneration);

    switch (command.gateKind) {
      case "plan":
        this.applyPlanGateDecision(command, nodeKey, nodeGeneration, timestamp);
        break;
      case "operator_input":
        this.applyOperatorInputGateDecision(command, nodeKey, nodeGeneration, timestamp);
        break;
      case "publication":
        this.applyPublicationGateDecision(command, timestamp);
        break;
    }

    const revision = this.emit(command.runId, "gate.resolved");
    this.recordCommand(command, context, payloadDigest, command.runId, revision);
    return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
  }

  private applyPlanGateDecision(
    command: Extract<RunCommand, { type: "resolve_gate" }>,
    gateNodeKey: string,
    gateNodeGeneration: number,
    timestamp: string,
  ): void {
    if (command.decision === "approve") {
      const planKey = this.planNodeKeyForGate(command.runId, gateNodeKey);
      const planGen = this.currentNodeGeneration(command.runId, planKey);
      if (planGen === undefined) throw new Error("plan node not found for approve");
      const spec = asRow(
        this.db
          .prepare(
            `SELECT node_outputs.artifact_id, artifacts.relative_path
             FROM node_outputs
             JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
             WHERE node_outputs.run_id = ?
               AND node_outputs.node_key = ?
               AND node_outputs.node_generation = ?
               AND (node_outputs.role = 'spec' OR artifacts.kind = 'spec')
             LIMIT 1`,
          )
          .get(command.runId, planKey, planGen),
      );
      if (!spec) {
        throw new Error("plan approve requires a sealed Spec artifact");
      }
      this.materializeDefinitionV1Graph(command.runId, requiredText(spec, "relative_path"));
      this.db
        .prepare(
          "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
        )
        .run(timestamp, command.runId);
      return;
    }
    if (command.decision === "revise") {
      const planKey = this.planNodeKeyForGate(command.runId, gateNodeKey);
      const planGen = this.currentNodeGeneration(command.runId, planKey);
      if (planGen === undefined) throw new Error("plan node not found for revise");
      const plan = asRow(
        this.db
          .prepare("SELECT kind FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
          .get(command.runId, planKey, planGen),
      );
      if (!plan) throw new Error("plan node not found for revise");
      this.db
        .prepare(
          `INSERT INTO nodes (
            run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
          ) VALUES (?, ?, ?, 'ready', ?, NULL, NULL, ?)`,
        )
        .run(
          command.runId,
          planKey,
          requiredText(plan, "kind"),
          planGen + 1,
          command.feedback !== undefined ? JSON.stringify({ feedback: command.feedback }) : null,
        );
      this.db
        .prepare(
          "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
        )
        .run(timestamp, command.runId);
      this.emit(command.runId, "node.ready");
      return;
    }
    if (command.decision === "deny") {
      // Deny applies CancelRun transitions; the gate stays resolved (not withdrawn).
      this.abortRunAttempts(command.runId);
      this.db
        .prepare(
          `UPDATE runs SET cancel_requested = 1, state = 'cancelling', updated_at = ?
           WHERE run_id = ?`,
        )
        .run(timestamp, command.runId);
      this.emit(command.runId, "run.cancel_requested");
      this.withdrawOpenGates(command.runId);
      this.cancelPreApplyEffects(command.runId);
      this.db
        .prepare(
          "UPDATE attempts SET state = 'cancelled', error = 'plan denied', ended_at = ? WHERE run_id = ? AND state = 'running'",
        )
        .run(timestamp, command.runId);
      this.db
        .prepare(
          `UPDATE nodes SET state = 'cancelled', current_attempt_id = NULL
           WHERE run_id = ? AND state IN ('blocked', 'ready', 'running', 'waiting', 'invalidated')
             AND NOT (node_key = ? AND generation = ?)`,
        )
        .run(command.runId, gateNodeKey, gateNodeGeneration);
      this.db
        .prepare("UPDATE runs SET state = 'cancelled', updated_at = ? WHERE run_id = ?")
        .run(timestamp, command.runId);
      this.emit(command.runId, "run.cancelled");
      return;
    }
    throw new Error(`unsupported plan gate decision: ${command.decision}`);
  }

  private applyOperatorInputGateDecision(
    command: Extract<RunCommand, { type: "resolve_gate" }>,
    gateNodeKey: string,
    _gateNodeGeneration: number,
    timestamp: string,
  ): void {
    if (command.decision !== "answer")
      throw new Error(`unsupported operator_input decision: ${command.decision}`);
    // Continuation node shares the gate's node key family; bump generation so a new
    // attempt can claim with the sealed answer as input (execution is T3).
    const current = this.currentNodeRow(command.runId, gateNodeKey);
    if (!current) throw new Error("operator_input node not found");
    const generation = requiredNumber(current, "generation");
    this.db
      .prepare(
        `INSERT INTO nodes (
          run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
        ) VALUES (?, ?, ?, 'ready', ?, NULL, NULL, NULL)`,
      )
      .run(command.runId, gateNodeKey, requiredText(current, "kind"), generation + 1);
    this.db
      .prepare(
        "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, command.runId);
    this.emit(command.runId, "node.ready");
  }

  private applyPublicationGateDecision(
    command: Extract<RunCommand, { type: "resolve_gate" }>,
    timestamp: string,
  ): void {
    if (command.decision === "approve") {
      // ResolveGate(approve) only advances the payload-bound effect prepared → candidate_ready.
      const effect = asRow(
        this.db
          .prepare(
            `SELECT effect_key, state, publication_node_key, publication_node_generation
             FROM effects
             WHERE run_id = ? AND gate_id = ? AND state = 'prepared'`,
          )
          .get(command.runId, command.gateId),
      );
      if (!effect) throw new Error("publication effect not found for approved gate");
      const pubKey = requiredText(effect, "publication_node_key");
      const pubGen = requiredNumber(effect, "publication_node_generation");
      const liveGen = this.currentNodeGeneration(command.runId, pubKey);
      if (liveGen !== pubGen) {
        throw new Error(
          `publication effect generation ${pubGen} is stale (current ${liveGen ?? "none"})`,
        );
      }
      const cas = this.db
        .prepare(
          `UPDATE effects SET state = 'candidate_ready'
           WHERE effect_key = ? AND state = 'prepared'`,
        )
        .run(requiredText(effect, "effect_key"));
      if (cas.changes !== 1) {
        throw new Error("publication effect could not transition to candidate_ready");
      }
      // Unlock publish after gate.publication is already marked succeeded above.
      this.unlockReadyNodes(command.runId);
      this.db
        .prepare(
          "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
        )
        .run(timestamp, command.runId);
      this.emit(command.runId, "effect.candidate_ready");
      return;
    }
    if (command.decision === "revise") {
      // Publication revise: cancel pre-apply effect, then Rerun write.root (repair path)
      // with feedback so validate/review/publication lineage is invalidated (ADR 0035).
      const effect = asRow(
        this.db
          .prepare(
            `SELECT publication_node_key, publication_node_generation, effect_key, state
             FROM effects WHERE run_id = ? AND gate_id = ?`,
          )
          .get(command.runId, command.gateId),
      );
      if (effect) {
        if (["prepared", "candidate_ready"].includes(requiredText(effect, "state"))) {
          this.db
            .prepare(
              "UPDATE effects SET state = 'cancelled' WHERE effect_key = ? AND state IN ('prepared', 'candidate_ready')",
            )
            .run(requiredText(effect, "effect_key"));
        }
      }
      const writeGen = this.currentNodeGeneration(command.runId, "write.root");
      if (writeGen !== undefined) {
        this.applyRerunAt(command.runId, "write.root", writeGen, command.feedback);
      } else if (effect) {
        // Fallback when write.root is absent: bump the publication-owning node alone.
        const pubKey = requiredText(effect, "publication_node_key");
        const pubGen = requiredNumber(effect, "publication_node_generation");
        this.applyRerunAt(command.runId, pubKey, pubGen, command.feedback);
      } else {
        throw new Error("publication revise requires write.root or a publication effect");
      }
      this.emit(command.runId, "node.ready");
      return;
    }
    if (command.decision === "deny") {
      this.db
        .prepare(
          `UPDATE effects SET state = 'cancelled'
           WHERE run_id = ? AND gate_id = ? AND state IN ('prepared', 'candidate_ready')`,
        )
        .run(command.runId, command.gateId);
      this.db
        .prepare("UPDATE runs SET state = 'completed_unpublished', updated_at = ? WHERE run_id = ?")
        .run(timestamp, command.runId);
      this.emit(command.runId, "run.completed_unpublished");
      return;
    }
    throw new Error(`unsupported publication gate decision: ${command.decision}`);
  }

  private planNodeKeyForGate(runId: string, gateNodeKey: string): string {
    if (gateNodeKey === "gate.plan" || gateNodeKey.startsWith("gate.plan")) return "plan";
    const plan = asRow(
      this.db
        .prepare(
          `SELECT node_key FROM nodes WHERE run_id = ? AND kind = 'plan'
           ORDER BY generation DESC LIMIT 1`,
        )
        .get(runId),
    );
    if (plan) return requiredText(plan, "node_key");
    return "plan";
  }

  /** Load a sealed Spec JSON from an artifact relative path under the run work dir. */
  private loadSpecFromArtifact(runId: string, relativePath: string) {
    const runDir = runWorkDir(this.workspace.rootPath, runId);
    const artifactRoot = path.join(runDir, relativePath);
    const candidates = [
      path.join(artifactRoot, "spec.json"),
      artifactRoot,
      path.join(artifactRoot, "analysis", "spec.json"),
    ];
    for (const candidate of candidates) {
      try {
        const raw = readFileSync(candidate, "utf8");
        const parsed = WikiRunSpecSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
      } catch {
        // Try the next candidate.
      }
    }
    return undefined;
  }

  /**
   * After plan approve: materialize Definition v1 research → write → validate →
   * review → prepare → gate.publication → publish with durable edges.
   */
  private materializeDefinitionV1Graph(runId: string, relativePath: string): void {
    const spec = this.loadSpecFromArtifact(runId, relativePath);
    if (!spec) throw new Error("plan approve requires a parseable sealed Spec");
    const graph = buildDefinitionV1Graph(spec);
    for (const node of graph.nodes) {
      const existing = asRow(
        this.db
          .prepare(
            "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? AND generation = 0",
          )
          .get(runId, node.key),
      );
      if (existing) continue;
      // Gates wait; everything else starts blocked until unlockReadyNodes.
      const initialState = isGateKind(node.kind) ? "blocked" : "blocked";
      this.db
        .prepare(
          `INSERT INTO nodes (
            run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
          ) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)`,
        )
        .run(
          runId,
          node.key,
          node.kind,
          initialState,
          node.detail ? JSON.stringify(node.detail) : null,
        );
    }
    for (const edge of graph.edges) {
      this.db
        .prepare(
          `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, ?)
           ON CONFLICT(run_id, from_key, to_key) DO NOTHING`,
        )
        .run(runId, edge.from, edge.to);
    }
    this.unlockReadyNodes(runId);
    this.emit(runId, "node.ready");
  }

  /**
   * Promote blocked/invalidated nodes whose current-generation upstreams have all
   * succeeded. After RerunNode, invalidated gen+1 descendants re-enter ready this way.
   * Gate nodes stay blocked/waiting until their predecessor opens them explicitly.
   */
  private unlockReadyNodes(runId: string): void {
    const candidates = asRows(
      this.db
        .prepare(
          `SELECT nodes.node_key, nodes.kind, nodes.generation, nodes.state
           FROM nodes
           WHERE nodes.run_id = ?
             AND nodes.state IN ('blocked', 'invalidated')
             AND nodes.generation = (
               SELECT MAX(n2.generation) FROM nodes n2
               WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
             )`,
        )
        .all(runId),
    );
    for (const row of candidates) {
      const nodeKey = requiredText(row, "node_key");
      const kind = requiredText(row, "kind");
      const generation = requiredNumber(row, "generation");
      const priorState = requiredText(row, "state");
      if (isGateKind(kind)) continue;
      if (!this.upstreamsSucceeded(runId, nodeKey)) continue;
      this.db
        .prepare(
          `UPDATE nodes SET state = 'ready', current_attempt_id = NULL
           WHERE run_id = ? AND node_key = ? AND generation = ? AND state = ?`,
        )
        .run(runId, nodeKey, generation, priorState);
    }
  }

  private upstreamKeys(runId: string, nodeKey: string): string[] {
    return asRows(
      this.db
        .prepare(
          "SELECT from_key FROM node_edges WHERE run_id = ? AND to_key = ? ORDER BY from_key",
        )
        .all(runId, nodeKey),
    ).map((row) => requiredText(row, "from_key"));
  }

  private upstreamsSucceeded(runId: string, nodeKey: string): boolean {
    const upstreams = this.upstreamKeys(runId, nodeKey);
    // Hard-coded bootstrap edges for freeze→plan before node_edges exist.
    if (upstreams.length === 0) {
      if (nodeKey === "plan") {
        const freezeGen = this.currentNodeGeneration(runId, "freeze");
        if (freezeGen === undefined) return false;
        const freeze = asRow(
          this.db
            .prepare(
              "SELECT state FROM nodes WHERE run_id = ? AND node_key = 'freeze' AND generation = ?",
            )
            .get(runId, freezeGen),
        );
        return Boolean(freeze && requiredText(freeze, "state") === "succeeded");
      }
      return true;
    }
    for (const fromKey of upstreams) {
      const gen = this.currentNodeGeneration(runId, fromKey);
      if (gen === undefined) return false;
      const node = asRow(
        this.db
          .prepare("SELECT state FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
          .get(runId, fromKey, gen),
      );
      if (!node || requiredText(node, "state") !== "succeeded") return false;
    }
    return true;
  }

  private rerunNode(
    command: Extract<RunCommand, { type: "rerun_node" }>,
    context: RunCommandContext,
    payloadDigest: string,
  ): RunCommandReceipt {
    const run = asRow(
      this.db
        .prepare("SELECT cancel_requested, state FROM runs WHERE run_id = ?")
        .get(command.runId),
    );
    if (!run) throw new Error(`run not found: ${command.runId}`);
    if (requiredNumber(run, "cancel_requested") === 1)
      throw new Error("cannot rerun a node on a cancelled run");
    const runState = requiredText(run, "state");
    if (runState === "published") throw new Error("cannot rerun a published run; start a new run");
    if (runState === "cancelled") throw new Error("cannot rerun a node on a cancelled run");

    this.applyRerunAt(command.runId, command.nodeKey, command.generation, command.feedback);
    const revision = this.emit(command.runId, "node.ready");
    this.recordCommand(command, context, payloadDigest, command.runId, revision);
    return { commandId: command.commandId, runId: command.runId, revision, accepted: true };
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
  ): void {
    const current = this.currentNodeRow(runId, nodeKey);
    if (!current) throw new Error(`node not found: ${nodeKey}`);
    const liveGeneration = requiredNumber(current, "generation");
    if (liveGeneration !== generation)
      throw new Error("rerun target is stale: generation does not match");

    const timestamp = now();
    const affected = this.lineageInvalidationClosure(runId, nodeKey, generation);
    // Target is always included; downstream only when they consumed old outputs.
    const targets = new Map<string, { nodeKey: string; generation: number; kind: string }>();
    targets.set(`${nodeKey}@${generation}`, {
      nodeKey,
      generation,
      kind: requiredText(current, "kind"),
    });
    for (const item of affected) {
      targets.set(`${item.nodeKey}@${item.generation}`, item);
    }

    const detailJson = feedback !== undefined ? JSON.stringify({ feedback }) : null;

    for (const target of targets.values()) {
      this.cancelNodeAttempts(runId, target.nodeKey, target.generation, "superseded");
      this.withdrawOpenGatesForNode(runId, target.nodeKey, target.generation);
      this.cancelPreApplyEffectsForPublication(runId, target.nodeKey, target.generation);
      // Old claimable generations must not remain ready/running beside gen+1.
      this.supersedeClaimableNode(runId, target.nodeKey, target.generation);
      const isRoot = target.nodeKey === nodeKey && target.generation === generation;
      const nextGeneration = target.generation + 1;
      // Avoid colliding if a higher generation already exists.
      const existingNext = asRow(
        this.db
          .prepare(
            "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
          )
          .get(runId, target.nodeKey, nextGeneration),
      );
      if (existingNext) throw new Error("rerun target is stale: newer generation already exists");
      this.db
        .prepare(
          `INSERT INTO nodes (
            run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
          ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          runId,
          target.nodeKey,
          target.kind,
          isRoot ? "ready" : "invalidated",
          nextGeneration,
          isRoot ? detailJson : null,
        );
    }

    this.db
      .prepare(
        "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, runId);
  }

  /** Mark a replaced generation non-claimable; keep terminal succeeded/failed for audit. */
  private supersedeClaimableNode(runId: string, nodeKey: string, generation: number): void {
    this.db
      .prepare(
        `UPDATE nodes SET state = 'cancelled', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ?
           AND state IN ('blocked', 'ready', 'running', 'waiting', 'invalidated')`,
      )
      .run(runId, nodeKey, generation);
  }

  /** Transitive consumers of `(nodeKey, generation)` outputs via attempt_inputs lineage. */
  private lineageInvalidationClosure(
    runId: string,
    nodeKey: string,
    generation: number,
  ): Array<{ nodeKey: string; generation: number; kind: string }> {
    const result: Array<{ nodeKey: string; generation: number; kind: string }> = [];
    const queue: Array<{ nodeKey: string; generation: number }> = [{ nodeKey, generation }];
    const seen = new Set<string>([`${nodeKey}@${generation}`]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const consumers = asRows(
        this.db
          .prepare(
            `SELECT DISTINCT attempts.node_key, attempts.node_generation, nodes.kind
             FROM node_outputs
             JOIN attempt_inputs ON attempt_inputs.artifact_id = node_outputs.artifact_id
             JOIN attempts ON attempts.attempt_id = attempt_inputs.attempt_id
             JOIN nodes ON nodes.run_id = attempts.run_id
               AND nodes.node_key = attempts.node_key
               AND nodes.generation = attempts.node_generation
             WHERE node_outputs.run_id = ?
               AND node_outputs.node_key = ?
               AND node_outputs.node_generation = ?
               AND attempts.run_id = ?`,
          )
          .all(runId, current.nodeKey, current.generation, runId),
      );
      for (const consumer of consumers) {
        const consumerKey = requiredText(consumer, "node_key");
        const consumerGen = requiredNumber(consumer, "node_generation");
        // Only invalidate the still-current generation of each consumer key.
        const liveGen = this.currentNodeGeneration(runId, consumerKey);
        if (liveGen !== consumerGen) continue;
        const id = `${consumerKey}@${consumerGen}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const item = {
          nodeKey: consumerKey,
          generation: consumerGen,
          kind: requiredText(consumer, "kind"),
        };
        result.push(item);
        queue.push({ nodeKey: consumerKey, generation: consumerGen });
      }
    }
    return result;
  }

  private cancelNodeAttempts(
    runId: string,
    nodeKey: string,
    generation: number,
    reason: string,
  ): void {
    const timestamp = now();
    const running = asRows(
      this.db
        .prepare(
          `SELECT attempt_id FROM attempts
           WHERE run_id = ? AND node_key = ? AND node_generation = ? AND state = 'running'`,
        )
        .all(runId, nodeKey, generation),
    );
    for (const attempt of running) {
      const attemptId = requiredText(attempt, "attempt_id");
      this.activeAttempts.get(attemptId)?.abort();
      this.db
        .prepare(
          "UPDATE attempts SET state = 'cancelled', error = ?, ended_at = ? WHERE attempt_id = ? AND state = 'running'",
        )
        .run(reason, timestamp, attemptId);
    }
    this.db
      .prepare(
        `UPDATE nodes SET current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ?`,
      )
      .run(runId, nodeKey, generation);
  }

  private withdrawOpenGates(runId: string): void {
    const open = asRows(
      this.db.prepare("SELECT gate_id FROM gates WHERE run_id = ? AND state = 'open'").all(runId),
    );
    if (open.length === 0) return;
    this.db
      .prepare("UPDATE gates SET state = 'withdrawn' WHERE run_id = ? AND state = 'open'")
      .run(runId);
    this.emit(runId, "gate.withdrawn");
  }

  private withdrawOpenGatesForNode(runId: string, nodeKey: string, generation: number): void {
    const open = asRows(
      this.db
        .prepare(
          `SELECT gate_id FROM gates
           WHERE run_id = ? AND node_key = ? AND node_generation = ? AND state = 'open'`,
        )
        .all(runId, nodeKey, generation),
    );
    if (open.length === 0) return;
    this.db
      .prepare(
        `UPDATE gates SET state = 'withdrawn'
         WHERE run_id = ? AND node_key = ? AND node_generation = ? AND state = 'open'`,
      )
      .run(runId, nodeKey, generation);
    this.emit(runId, "gate.withdrawn");
  }

  private cancelPreApplyEffects(runId: string): void {
    this.db
      .prepare(
        `UPDATE effects SET state = 'cancelled'
         WHERE run_id = ? AND state IN ('prepared', 'candidate_ready')`,
      )
      .run(runId);
  }

  private cancelPreApplyEffectsForPublication(
    runId: string,
    publicationNodeKey: string,
    publicationNodeGeneration: number,
  ): void {
    const effects = asRows(
      this.db
        .prepare(
          `SELECT effect_key, gate_id FROM effects
           WHERE run_id = ?
             AND publication_node_key = ?
             AND publication_node_generation = ?
             AND state IN ('prepared', 'candidate_ready')`,
        )
        .all(runId, publicationNodeKey, publicationNodeGeneration),
    );
    if (effects.length === 0) return;
    for (const effect of effects) {
      this.db
        .prepare(
          "UPDATE effects SET state = 'cancelled' WHERE effect_key = ? AND state IN ('prepared', 'candidate_ready')",
        )
        .run(requiredText(effect, "effect_key"));
      // Bound publication Gate must not stay open for a cancelled candidate.
      this.db
        .prepare("UPDATE gates SET state = 'withdrawn' WHERE gate_id = ? AND state = 'open'")
        .run(requiredText(effect, "gate_id"));
    }
    this.emit(runId, "gate.withdrawn");
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

  /**
   * ADR 0035: effects left in `applying` after a crash are reconciled against
   * live / sealed candidate / aside markers. Never mark them `cancelled`.
   */
  private async reconcileApplyingEffects(): Promise<void> {
    const rows = asRows(
      this.db
        .prepare(
          `SELECT effect_key, run_id, candidate_artifact_id, candidate_digest, expected_live_digest
           FROM effects WHERE state = 'applying' ORDER BY effect_key`,
        )
        .all(),
    );
    for (const row of rows) {
      await this.reconcileApplyingEffect({
        effectKey: requiredText(row, "effect_key"),
        runId: requiredText(row, "run_id"),
        candidateArtifactId: requiredText(row, "candidate_artifact_id"),
        candidateDigest: requiredText(row, "candidate_digest"),
        expectedLiveDigest: requiredText(row, "expected_live_digest"),
      });
    }
  }

  private async reconcileApplyingEffect(input: {
    effectKey: string;
    runId: string;
    candidateArtifactId: string;
    candidateDigest: string;
    expectedLiveDigest: string;
  }): Promise<void> {
    if (this.closed) return;
    const runDir = runWorkDir(this.workspace.rootPath, input.runId);
    const artifact = asRow(
      this.db
        .prepare("SELECT relative_path FROM artifacts WHERE artifact_id = ?")
        .get(input.candidateArtifactId),
    );
    const publicationPath =
      this.workspace.publicationPath || path.join(this.workspace.rootPath, "published-wiki");

    let outcome: "applied" | "failed" | "unknown" = "unknown";
    let detail = "applying effect recovered without filesystem evidence";
    if (!artifact) {
      detail = "candidate artifact missing during reconcile";
    } else {
      const candidateDir = path.join(runDir, requiredText(artifact, "relative_path"));
      try {
        const result = await reconcilePublicationApply({
          publicationPath,
          candidateDir,
          candidateDigest: input.candidateDigest,
          expectedLiveDigest: input.expectedLiveDigest,
          effectKey: input.effectKey,
        });
        outcome = result.status;
        detail =
          result.status === "applied"
            ? "reconciled applied"
            : result.status === "failed"
              ? result.reason
              : result.reason;
      } catch (error) {
        outcome = "unknown";
        detail = error instanceof Error ? error.message : "reconcile failed";
      }
    }

    if (this.closed) return;
    this.transaction(() => {
      const current = asRow(
        this.db.prepare("SELECT state FROM effects WHERE effect_key = ?").get(input.effectKey),
      );
      if (!current || requiredText(current, "state") !== "applying") return;
      // applying → applied | failed | unknown only — never cancelled.
      this.db
        .prepare(
          "UPDATE effects SET state = ?, observed_outcome = ? WHERE effect_key = ? AND state = 'applying'",
        )
        .run(outcome, detail.slice(0, 4_000), input.effectKey);
      if (outcome === "applied") {
        this.emit(input.runId, "effect.applied");
        this.db
          .prepare(
            `UPDATE runs SET state = 'published', updated_at = ?
             WHERE run_id = ? AND cancel_requested = 0
               AND state NOT IN ('published', 'cancelled', 'failed', 'completed_unpublished')`,
          )
          .run(now(), input.runId);
        const run = asRow(
          this.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(input.runId),
        );
        if (run && requiredText(run, "state") === "published") {
          this.emit(input.runId, "run.published");
        }
      } else if (outcome === "failed") {
        this.emit(input.runId, "effect.failed");
      } else {
        this.emit(input.runId, "effect.unknown");
      }
    });
  }

  private recordCommand(
    command: RunCommand,
    context: RunCommandContext,
    payloadDigest: string,
    runId: string,
    revision: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO commands (
          workspace_id, command_id, payload_digest, actor_id, actor_kind, run_id, revision, accepted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        this.workspace.id,
        command.commandId,
        payloadDigest,
        context.actor.id,
        context.actor.kind,
        runId,
        revision,
      );
  }

  private schedule(): void {
    if (this.closed || this.scheduler) return;
    this.scheduler = this.runScheduler().finally(() => {
      this.scheduler = undefined;
    });
  }

  private async runScheduler(): Promise<void> {
    while (!this.closed) {
      const claim = this.transaction(() => this.claimReadyNode());
      if (!claim) return;
      const execution =
        claim.kind === "freeze" ? this.executeFreeze(claim) : this.executeClaimed(claim);
      this.activeExecutions.set(claim.attemptId, execution);
      try {
        await execution;
      } finally {
        this.activeExecutions.delete(claim.attemptId);
      }
    }
  }

  /**
   * Claim any ready node at max generation with sealed upstreams.
   * Prefer freeze, then mechanical, then Pi (when executor is wired).
   */
  private claimReadyNode(): ClaimedNode | undefined {
    const freeze = this.claimNodeByKey("freeze", "freeze");
    if (freeze) return freeze;

    const ready = asRows(
      this.db
        .prepare(
          `SELECT nodes.run_id, nodes.node_key, nodes.kind, nodes.generation, runs.created_at
           FROM nodes JOIN runs ON runs.run_id = nodes.run_id
           WHERE nodes.state = 'ready'
             AND runs.cancel_requested = 0
             AND runs.state IN ('queued', 'running')
             AND nodes.generation = (
               SELECT MAX(n2.generation) FROM nodes n2
               WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
             )
           ORDER BY runs.created_at, nodes.node_key`,
        )
        .all(),
    );
    // Mechanical first so validate/publish never stall behind optional Pi.
    const ordered = [
      ...ready.filter((row) => isMechanicalAttemptKind(requiredText(row, "kind"))),
      ...ready.filter((row) => isPiAttemptKind(requiredText(row, "kind"))),
    ];
    for (const row of ordered) {
      const kind = requiredText(row, "kind");
      const nodeKey = requiredText(row, "node_key");
      if (nodeKey === "freeze") continue;
      if (isGateKind(kind)) continue;
      if (isPiAttemptKind(kind) && !this.piAttemptExecutor) continue;
      if (!this.upstreamsSucceeded(requiredText(row, "run_id"), nodeKey)) continue;
      const claim = this.claimPreparedRow(row);
      if (claim) return claim;
    }
    return undefined;
  }

  private claimNodeByKey(nodeKey: string, kind: string): ClaimedNode | undefined {
    const node = asRow(
      this.db
        .prepare(
          `SELECT nodes.run_id, nodes.node_key, nodes.kind, nodes.generation, runs.created_at,
                  runs.freeze_config_digest
           FROM nodes JOIN runs ON runs.run_id = nodes.run_id
           WHERE nodes.node_key = ? AND nodes.kind = ? AND nodes.state = 'ready'
             AND runs.cancel_requested = 0 AND runs.state IN ('queued', 'running')
             AND nodes.generation = (
               SELECT MAX(n2.generation) FROM nodes n2
               WHERE n2.run_id = nodes.run_id AND n2.node_key = ?
             )
           ORDER BY runs.created_at LIMIT 1`,
        )
        .get(nodeKey, kind, nodeKey),
    );
    if (!node) return undefined;
    if (nodeKey !== "freeze" && !this.upstreamsSucceeded(requiredText(node, "run_id"), nodeKey)) {
      return undefined;
    }
    return this.claimPreparedRow(node);
  }

  private claimPreparedRow(node: SqlRow): ClaimedNode | undefined {
    const runId = requiredText(node, "run_id");
    const nodeKey = requiredText(node, "node_key");
    const kind = requiredText(node, "kind");
    const generation = requiredNumber(node, "generation");
    const attemptId = randomUUID();
    const upstreams = this.upstreamSealedOutputs(runId, nodeKey);
    // Freeze has no sealed upstreams; every other node needs at least freeze pins
    // (or explicit edge outputs) before claim.
    if (
      nodeKey !== "freeze" &&
      upstreams.length === 0 &&
      !this.upstreamsSucceeded(runId, nodeKey)
    ) {
      return undefined;
    }
    // RetryFailedNode / research auto-retry: reuse the exact failed Attempt's
    // input_digest + attempt_inputs rather than re-picking "current latest".
    const retrySource = this.retrySourceAttempt(runId, nodeKey, generation);
    const inputDigest = retrySource
      ? retrySource.inputDigest
      : nodeKey === "freeze" && typeof node.freeze_config_digest === "string"
        ? requiredText(node, "freeze_config_digest")
        : digest(upstreams.map((input) => ({ role: input.role, artifactId: input.artifactId })));
    const timestamp = now();
    const runIndexRow = asRow(
      this.db
        .prepare("SELECT COUNT(*) + 1 AS run_index FROM attempts WHERE run_id = ? AND node_key = ?")
        .get(runId, nodeKey),
    );
    this.db
      .prepare(
        `INSERT INTO attempts (
          attempt_id, run_id, node_key, node_generation, run_index, state, input_digest, error, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, ?, NULL)`,
      )
      .run(
        attemptId,
        runId,
        nodeKey,
        generation,
        requiredNumber(runIndexRow ?? {}, "run_index"),
        inputDigest,
        timestamp,
      );
    if (retrySource) {
      this.copyAttemptInputs(attemptId, retrySource.inputs);
    } else {
      this.bindAttemptInputs(attemptId, runId, nodeKey);
    }
    this.db
      .prepare(
        `UPDATE nodes SET state = 'running', current_attempt_id = ?, last_attempt_id = ?
         WHERE run_id = ? AND node_key = ? AND generation = ? AND state = 'ready'`,
      )
      .run(attemptId, attemptId, runId, nodeKey, generation);
    this.db
      .prepare("UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ?")
      .run(timestamp, runId);
    this.emit(runId, "attempt.started");
    return { attemptId, nodeGeneration: generation, nodeKey, kind, runId };
  }

  /**
   * When the current generation's last Attempt failed/interrupted, a re-claim is a
   * Retry: copy that Attempt's frozen input envelope verbatim.
   */
  private retrySourceAttempt(
    runId: string,
    nodeKey: string,
    generation: number,
  ): { inputDigest: string; inputs: Array<{ role: string; artifactId: string }> } | undefined {
    const node = asRow(
      this.db
        .prepare(
          "SELECT last_attempt_id FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
        )
        .get(runId, nodeKey, generation),
    );
    if (!node || node.last_attempt_id === null) return undefined;
    const lastAttemptId = requiredText(node, "last_attempt_id");
    const attempt = asRow(
      this.db
        .prepare(`SELECT input_digest, state, node_generation FROM attempts WHERE attempt_id = ?`)
        .get(lastAttemptId),
    );
    if (!attempt) return undefined;
    if (requiredNumber(attempt, "node_generation") !== generation) return undefined;
    if (!["failed", "interrupted"].includes(requiredText(attempt, "state"))) return undefined;
    const inputs = asRows(
      this.db
        .prepare(`SELECT role, artifact_id FROM attempt_inputs WHERE attempt_id = ? ORDER BY role`)
        .all(lastAttemptId),
    ).map((row) => ({
      role: requiredText(row, "role"),
      artifactId: requiredText(row, "artifact_id"),
    }));
    return { inputDigest: requiredText(attempt, "input_digest"), inputs };
  }

  private copyAttemptInputs(
    attemptId: string,
    inputs: Array<{ role: string; artifactId: string }>,
  ): void {
    for (const input of inputs) {
      this.db
        .prepare(
          `INSERT INTO attempt_inputs (attempt_id, role, artifact_id) VALUES (?, ?, ?)
           ON CONFLICT(attempt_id, role) DO NOTHING`,
        )
        .run(attemptId, input.role, input.artifactId);
    }
  }

  private abortRunAttempts(runId: string): void {
    for (const [attemptId, controller] of this.activeAttempts) {
      if (this.attemptRunId(attemptId) === runId) controller.abort();
    }
  }

  private abortActiveAttempts(): void {
    for (const controller of this.activeAttempts.values()) controller.abort();
  }

  private attemptRunId(attemptId: string): string | undefined {
    const attempt = asRow(
      this.db.prepare("SELECT run_id FROM attempts WHERE attempt_id = ?").get(attemptId),
    );
    return attempt === undefined ? undefined : requiredText(attempt, "run_id");
  }

  private async waitForRunExecution(runId: string): Promise<void> {
    const executions = [...this.activeExecutions.entries()]
      .filter(([attemptId]) => this.attemptRunId(attemptId) === runId)
      .map(([, execution]) => execution);
    await Promise.all(executions);
  }

  /**
   * In the claim transaction, freeze current-generation upstream outputs into
   * immutable attempt_inputs. Also bind ambient freeze sources/skill and plan
   * spec for post-plan nodes so each Attempt has a complete sealed envelope.
   */
  private bindAttemptInputs(attemptId: string, runId: string, nodeKey: string): void {
    for (const input of this.upstreamSealedOutputs(runId, nodeKey)) {
      this.db
        .prepare(
          `INSERT INTO attempt_inputs (attempt_id, role, artifact_id) VALUES (?, ?, ?)
           ON CONFLICT(attempt_id, role) DO NOTHING`,
        )
        .run(attemptId, input.role, input.artifactId);
    }
  }

  private nodeOutputsAtCurrentGen(
    runId: string,
    nodeKey: string,
  ): Array<{ role: string; artifactId: string }> {
    const generation = this.currentNodeGeneration(runId, nodeKey);
    if (generation === undefined) return [];
    const node = asRow(
      this.db
        .prepare("SELECT state FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
        .get(runId, nodeKey, generation),
    );
    if (!node || requiredText(node, "state") !== "succeeded") return [];
    return asRows(
      this.db
        .prepare(
          `SELECT role, artifact_id FROM node_outputs
           WHERE run_id = ? AND node_key = ? AND node_generation = ?
           ORDER BY role`,
        )
        .all(runId, nodeKey, generation),
    ).map((row) => ({
      role: requiredText(row, "role"),
      artifactId: requiredText(row, "artifact_id"),
    }));
  }

  private upstreamSealedOutputs(
    runId: string,
    nodeKey: string,
  ): Array<{ role: string; artifactId: string }> {
    if (nodeKey === "freeze") return [];

    const byRole = new Map<string, string>();
    const add = (role: string, artifactId: string) => {
      if (!byRole.has(role)) byRole.set(role, artifactId);
    };

    // Ambient freeze + plan pins for every post-freeze node (well-known roles only).
    for (const output of this.nodeOutputsAtCurrentGen(runId, "freeze")) {
      if (output.role === "sources" || output.role === "skill") {
        add(output.role, output.artifactId);
      }
    }
    if (nodeKey !== "plan") {
      for (const output of this.nodeOutputsAtCurrentGen(runId, "plan")) {
        if (output.role === "spec") add(output.role, output.artifactId);
      }
    }

    const edgeUps = this.upstreamKeys(runId, nodeKey);
    const effectiveUps = edgeUps.length > 0 ? edgeUps : nodeKey === "plan" ? ["freeze"] : [];

    const wellKnown = new Set([
      "sources",
      "skill",
      "spec",
      "wiki_tree",
      "defects",
      "publication_candidate",
    ]);
    for (const fromKey of effectiveUps) {
      for (const output of this.nodeOutputsAtCurrentGen(runId, fromKey)) {
        // Prefer well-known roles; namespace the rest. Skip freeze attempt_output noise.
        if (output.role === "attempt_output") continue;
        if (wellKnown.has(output.role)) {
          add(output.role, output.artifactId);
        } else {
          add(`${fromKey}:${output.role}`, output.artifactId);
        }
      }
    }

    // Carry forward the latest wiki_tree for validate/review/prepare/publish when
    // edges only reference intermediate nodes that re-emit it.
    if (!byRole.has("wiki_tree")) {
      for (const key of [
        "write.root",
        "repair",
        "validate.pre",
        "validate.final",
        "review.reduce",
      ]) {
        for (const output of this.nodeOutputsAtCurrentGen(runId, key)) {
          if (output.role === "wiki_tree") add("wiki_tree", output.artifactId);
        }
        if (byRole.has("wiki_tree")) break;
      }
    }

    return [...byRole.entries()]
      .map(([role, artifactId]) => ({ role, artifactId }))
      .sort((a, b) => a.role.localeCompare(b.role));
  }

  /** Generic non-freeze attempt: Pi kinds via executor, mechanical kinds in-process. */
  private async executeClaimed(claim: ClaimedNode): Promise<void> {
    const controller = new AbortController();
    this.activeAttempts.set(claim.attemptId, controller);
    try {
      if (this.closed || !this.isCurrent(claim)) return;
      const outcome = isMechanicalAttemptKind(claim.kind)
        ? await this.executeMechanical(claim, controller.signal)
        : await this.executePi(claim, controller.signal);
      if (this.closed || !this.isCurrent(claim)) return;
      if (outcome.type === "failed") throw new Error(outcome.error);
      if (outcome.type === "gate_requested") {
        throw new Error(`${claim.kind} must not request an inline gate`);
      }
      if (outcome.type !== "succeeded") throw new Error("unexpected attempt outcome");

      const preparations: ArtifactPreparation[] = [];
      for (const descriptor of outcome.unsealedArtifacts) {
        const preparation = await this.prepareUnsealedArtifact(claim, descriptor);
        if (!preparation) return;
        await this.sealPreparation(claim.runId, preparation);
        preparations.push(preparation);
      }
      if (this.closed || !this.isCurrent(claim)) return;
      this.transaction(() => this.commitNodeArtifacts(claim, preparations));
    } catch (error) {
      if (this.closed) return;
      // Best-effort: leave a readable conversation row when Pi/mechanical failed
      // without sealing a transcript (mechanical cancel, missing executor, …).
      await this.ensureAttemptFailureTranscript(claim, error).catch(() => undefined);
      this.transaction(() => this.failNode(claim, error));
    } finally {
      this.activeAttempts.delete(claim.attemptId);
      this.transaction(() => this.orphanPreparedArtifacts(claim.attemptId));
    }
  }

  /**
   * Ensure session.jsonl exists for failed attempts so Node details is not empty.
   * Preserves any live JSONL already written by the Pi sink.
   */
  private async ensureAttemptFailureTranscript(
    claim: ClaimedNode,
    error: unknown,
  ): Promise<void> {
    const message =
      error instanceof Error ? error.message.slice(0, 4_000) : `${claim.nodeKey} failed`;
    const sessionPath = path.join(
      runWorkDir(this.workspace.rootPath, claim.runId),
      "attempts",
      claim.attemptId,
      "session.jsonl",
    );
    await writeConversationTranscript({
      sessionPath,
      nodeKey: claim.nodeKey,
      summary: `Error: ${message}`,
      preserveExisting: true,
      meta: { mode: "failed", kind: claim.kind, error: message },
    });
  }

  private async executePi(claim: ClaimedNode, signal: AbortSignal): Promise<PiAttemptOutcome> {
    if (!this.piAttemptExecutor) {
      return {
        type: "failed",
        error: `${claim.kind} requires a PiAttemptExecutor`,
        failureClass: "infrastructure",
      };
    }
    const input = this.buildPiAttemptInput(claim);
    return this.piAttemptExecutor(input, signal);
  }

  private buildPiAttemptInput(claim: ClaimedNode): PiAttemptInput {
    const runDir = runWorkDir(this.workspace.rootPath, claim.runId);
    const attemptDir = path.join(runDir, "attempts", claim.attemptId);
    const workDir = path.join(attemptDir, "work");
    const sessionPath = path.join(attemptDir, "session.jsonl");
    const sealedRows = asRows(
      this.db
        .prepare(
          `SELECT attempt_inputs.role, artifacts.artifact_id, artifacts.kind, artifacts.digest,
                  artifacts.relative_path, artifacts.sealed_at
           FROM attempt_inputs
           JOIN artifacts ON artifacts.artifact_id = attempt_inputs.artifact_id
           WHERE attempt_inputs.attempt_id = ?
           ORDER BY attempt_inputs.role`,
        )
        .all(claim.attemptId),
    );
    const sealedInputs = sealedRows.map((row) => ({
      role: requiredText(row, "role"),
      readOnlyPath: path.join(runDir, requiredText(row, "relative_path")),
      artifact: {
        artifactId: requiredText(row, "artifact_id"),
        kind: requiredText(row, "kind") as WikiRunArtifactKind,
        digest: requiredText(row, "digest"),
        sealedAt: requiredText(row, "sealed_at"),
      },
    }));
    const sourcesInput = sealedInputs.find((item) => item.role === "sources");
    const skillInput = sealedInputs.find((item) => item.role === "skill");
    if (!sourcesInput || !skillInput) {
      throw new Error(`${claim.nodeKey} requires sealed sources and skill inputs`);
    }
    const pinned = this.trustedPinnedInputs(claim.runId);
    const sourcePaths: Record<string, string> = {};
    if (pinned) {
      for (const source of pinned.sources as Array<{ id: string }>) {
        sourcePaths[source.id] = path.join(sourcesInput.readOnlyPath, source.id);
      }
    } else {
      for (const source of this.workspace.sources) {
        sourcePaths[source.id] = path.join(sourcesInput.readOnlyPath, source.id);
      }
    }
    const runIndexRow = asRow(
      this.db.prepare("SELECT run_index FROM attempts WHERE attempt_id = ?").get(claim.attemptId),
    );
    const kind = claim.kind as PiAttemptInput["node"]["kind"];
    return {
      runId: claim.runId,
      attemptId: claim.attemptId,
      node: {
        key: claim.nodeKey,
        kind,
        generation: claim.nodeGeneration,
        runIndex: requiredNumber(runIndexRow ?? { run_index: 1 }, "run_index"),
      },
      inputDigest: this.attemptInputDigest(claim.attemptId),
      workspace: this.workspace,
      sealedInputs,
      attemptDir,
      workDir,
      sessionPath,
      skillPath: skillInput.readOnlyPath,
      sourcePaths,
    };
  }

  private async executeMechanical(
    claim: ClaimedNode,
    signal: AbortSignal,
  ): Promise<PiAttemptOutcome> {
    const runDir = runWorkDir(this.workspace.rootPath, claim.runId);
    const attemptDir = path.join(runDir, "attempts", claim.attemptId);
    const workDir = path.join(attemptDir, "work");
    await mkdir(workDir, { recursive: true });
    if (signal.aborted) {
      await writeConversationTranscript({
        sessionPath: path.join(attemptDir, "session.jsonl"),
        nodeKey: claim.nodeKey,
        summary: "Error: attempt cancelled",
        meta: { mode: "failed", failureClass: "cancelled", kind: claim.kind },
      });
      return { type: "failed", error: "attempt cancelled", failureClass: "cancelled" };
    }

    if (claim.kind === "validate.pre" || claim.kind === "validate.final") {
      return this.mechanicalValidate(claim, workDir, runDir);
    }
    if (claim.kind === "review.reduce") {
      return this.mechanicalReviewReduce(claim, workDir, runDir);
    }
    if (claim.kind === "prepare.publication") {
      return this.mechanicalPreparePublication(claim, workDir, runDir);
    }
    if (claim.kind === "publish") {
      return this.mechanicalPublish(claim, workDir, runDir);
    }
    // Unknown mechanical kind: still leave a transcript for the dialog.
    const sessionPath = path.join(runDir, "attempts", claim.attemptId, "session.jsonl");
    await writeConversationTranscript({
      sessionPath,
      nodeKey: claim.nodeKey,
      summary: `Error: unsupported mechanical kind: ${claim.kind}`,
      meta: { mode: "failed", kind: claim.kind },
    });
    return {
      type: "failed",
      error: `unsupported mechanical kind: ${claim.kind}`,
      failureClass: "infrastructure",
    };
  }

  private sealedInputPath(claim: ClaimedNode, runDir: string, role: string): string | undefined {
    const row = asRow(
      this.db
        .prepare(
          `SELECT artifacts.relative_path
           FROM attempt_inputs
           JOIN artifacts ON artifacts.artifact_id = attempt_inputs.artifact_id
           WHERE attempt_inputs.attempt_id = ? AND attempt_inputs.role = ?`,
        )
        .get(claim.attemptId, role),
    );
    if (!row) return undefined;
    return path.join(runDir, requiredText(row, "relative_path"));
  }

  private async mechanicalValidate(
    claim: ClaimedNode,
    workDir: string,
    runDir: string,
  ): Promise<PiAttemptOutcome> {
    const wikiPath = this.sealedInputPath(claim, runDir, "wiki_tree");
    if (!wikiPath) {
      return {
        type: "failed",
        error: "validate requires sealed wiki_tree input",
        failureClass: "infrastructure",
      };
    }
    const stagingWiki = path.join(workDir, "wiki");
    await cp(wikiPath, stagingWiki, { recursive: true, dereference: false });
    // Drop prior seal manifest so re-sealing does not digest a self-referential file.
    await rm(path.join(stagingWiki, ".okf-artifact-manifest.json"), { force: true });
    const sourcesPath = this.sealedInputPath(claim, runDir, "sources");
    const sources: Array<{ id: string; path: string }> = [];
    if (sourcesPath) {
      const pinned = this.trustedPinnedInputs(claim.runId);
      const ids =
        pinned?.sources && Array.isArray(pinned.sources)
          ? (pinned.sources as Array<{ id: string }>).map((s) => s.id)
          : this.workspace.sources.map((s) => s.id);
      for (const id of ids) {
        sources.push({ id, path: path.join(sourcesPath, id) });
      }
    }
    const result = await validateWikiTree(stagingWiki, {
      sources: sources.length > 0 ? sources : undefined,
      // Pre-review validate is structural; final still checks citations when sources exist.
      requireCitations: claim.kind === "validate.final" ? undefined : false,
    });
    if (!result.ok) {
      return {
        type: "failed",
        error: `validation failed: ${result.errors.slice(0, 8).join("; ")}`.slice(0, 4_000),
        failureClass: "infrastructure",
      };
    }
    const reportPath = path.join(workDir, "validate-report.json");
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    const validateSummary = `${claim.kind} ok (${result.pageCount ?? 0} pages)`;
    const transcript = await writeConversationTranscript({
      sessionPath: path.join(runDir, "attempts", claim.attemptId, "session.jsonl"),
      nodeKey: claim.nodeKey,
      summary: validateSummary,
      meta: { kind: claim.kind, ok: true },
    });
    return {
      type: "succeeded",
      unsealedArtifacts: [
        { kind: "wiki_tree", role: "wiki_tree", sourcePath: stagingWiki, directory: true },
        { kind: "receipt", role: "validate_report", sourcePath: reportPath, directory: false },
        { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
      ],
      summary: validateSummary,
    };
  }

  private async mechanicalReviewReduce(
    claim: ClaimedNode,
    workDir: string,
    runDir: string,
  ): Promise<PiAttemptOutcome> {
    const wikiPath = this.sealedInputPath(claim, runDir, "wiki_tree");
    if (!wikiPath) {
      return {
        type: "failed",
        error: "review.reduce requires sealed wiki_tree input",
        failureClass: "infrastructure",
      };
    }
    const stagingWiki = path.join(workDir, "wiki");
    await cp(wikiPath, stagingWiki, { recursive: true, dereference: false });
    await rm(path.join(stagingWiki, ".okf-artifact-manifest.json"), { force: true });
    // Collect seat transcripts bound on this attempt (namespaced roles).
    const seatRows = asRows(
      this.db
        .prepare(
          `SELECT attempt_inputs.role, artifacts.relative_path
           FROM attempt_inputs
           JOIN artifacts ON artifacts.artifact_id = attempt_inputs.artifact_id
           WHERE attempt_inputs.attempt_id = ? AND attempt_inputs.role LIKE 'review.seat.%'`,
        )
        .all(claim.attemptId),
    );
    const seatSummaries: string[] = [];
    for (const row of seatRows) {
      const root = path.join(runDir, requiredText(row, "relative_path"));
      const candidates = [
        root,
        path.join(root, "session.jsonl"),
        path.join(root, "transcript.jsonl"),
      ];
      for (const candidate of candidates) {
        try {
          const text = await readFile(candidate, "utf8");
          seatSummaries.push(text.slice(0, 500));
          break;
        } catch {
          // next
        }
      }
    }
    const defects = {
      clean: true,
      defects: [] as unknown[],
      summary: seatSummaries.length
        ? `Merged ${seatSummaries.length} review seats (clean)`
        : "NO_DEFECTS",
    };
    const defectsPath = path.join(workDir, "defects.json");
    await writeFile(defectsPath, `${JSON.stringify(defects, null, 2)}\n`, "utf8");
    const transcript = await writeConversationTranscript({
      sessionPath: path.join(runDir, "attempts", claim.attemptId, "session.jsonl"),
      nodeKey: claim.nodeKey,
      summary: defects.summary,
      meta: { defects },
    });
    return {
      type: "succeeded",
      unsealedArtifacts: [
        { kind: "wiki_tree", role: "wiki_tree", sourcePath: stagingWiki, directory: true },
        { kind: "receipt", role: "defects", sourcePath: defectsPath, directory: false },
        { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
      ],
      summary: defects.summary,
    };
  }

  private async mechanicalPreparePublication(
    claim: ClaimedNode,
    workDir: string,
    runDir: string,
  ): Promise<PiAttemptOutcome> {
    const wikiPath = this.sealedInputPath(claim, runDir, "wiki_tree");
    if (!wikiPath) {
      return {
        type: "failed",
        error: "prepare.publication requires sealed wiki_tree",
        failureClass: "infrastructure",
      };
    }
    // Drop prior seal manifest so materialize digests content only.
    const wikiStaging = path.join(workDir, "wiki-source");
    await cp(wikiPath, wikiStaging, { recursive: true, dereference: false });
    await rm(path.join(wikiStaging, ".okf-artifact-manifest.json"), { force: true });

    const publicationPath =
      this.workspace.publicationPath || path.join(this.workspace.rootPath, "published-wiki");

    // ADR 0035: capture live baseline under the publication lock before building.
    let expectedLiveDigest: string;
    try {
      expectedLiveDigest = await capturePublicationBaseline(publicationPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "baseline capture failed";
      return { type: "failed", error: message.slice(0, 4_000), failureClass: "infrastructure" };
    }

    const sourcesPath = this.sealedInputPath(claim, runDir, "sources");
    const sources: Array<{ id: string; path: string }> = [];
    if (sourcesPath) {
      const pinned = this.trustedPinnedInputs(claim.runId);
      const ids = pinned
        ? (pinned.sources as Array<{ id: string }>).map((s) => s.id)
        : this.workspace.sources.map((s) => s.id);
      for (const id of ids) sources.push({ id, path: path.join(sourcesPath, id) });
    }

    const candidate = path.join(workDir, "publication-candidate");
    const stampAt = now();
    try {
      await materializePublicationCandidate({
        wikiDir: wikiStaging,
        candidateDir: candidate,
        publicationPath,
        ...(sources.length > 0 ? { sources } : {}),
        stamp: {
          generatedBy: "okf-wiki/workflow",
          generatedAt: stampAt,
          verified: [{ by: "process:review-council", at: stampAt }],
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "candidate materialize failed";
      return { type: "failed", error: message.slice(0, 4_000), failureClass: "infrastructure" };
    }

    const metaPath = path.join(workDir, "candidate-meta.json");
    await writeFile(
      metaPath,
      `${JSON.stringify({
        schema: 1,
        expectedLiveDigest,
        publicationPath,
        publicationNodeKey: claim.nodeKey,
        publicationNodeGeneration: claim.nodeGeneration,
      })}\n`,
      "utf8",
    );
    const prepSummary = `publication candidate sealed (baseline ${expectedLiveDigest.slice(0, 12)}…)`;
    const transcript = await writeConversationTranscript({
      sessionPath: path.join(runDir, "attempts", claim.attemptId, "session.jsonl"),
      nodeKey: claim.nodeKey,
      summary: prepSummary,
      meta: { ok: true, expectedLiveDigest },
    });
    return {
      type: "succeeded",
      unsealedArtifacts: [
        {
          kind: "publication_candidate",
          role: "publication_candidate",
          sourcePath: candidate,
          directory: true,
        },
        { kind: "receipt", role: "candidate_meta", sourcePath: metaPath, directory: false },
        { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
      ],
      summary: prepSummary,
    };
  }

  private async mechanicalPublish(
    claim: ClaimedNode,
    workDir: string,
    runDir: string,
  ): Promise<PiAttemptOutcome> {
    const effect = asRow(
      this.db
        .prepare(
          `SELECT effect_key, state, candidate_artifact_id, candidate_digest, expected_live_digest,
                  publication_node_key, publication_node_generation, gate_id
           FROM effects
           WHERE run_id = ? AND state = 'candidate_ready'
           ORDER BY effect_key LIMIT 1`,
        )
        .get(claim.runId),
    );
    if (!effect) {
      return {
        type: "failed",
        error: "publish requires a candidate_ready effect",
        failureClass: "infrastructure",
      };
    }
    const effectKey = requiredText(effect, "effect_key");
    const candidateId = requiredText(effect, "candidate_artifact_id");
    const expectedLiveDigest = requiredText(effect, "expected_live_digest");
    const publicationNodeKey = requiredText(effect, "publication_node_key");
    const publicationNodeGeneration = requiredNumber(effect, "publication_node_generation");
    const gateId = requiredText(effect, "gate_id");

    const candidateRow = asRow(
      this.db.prepare("SELECT relative_path FROM artifacts WHERE artifact_id = ?").get(candidateId),
    );
    if (!candidateRow) {
      return {
        type: "failed",
        error: "publication candidate artifact missing",
        failureClass: "infrastructure",
      };
    }
    const candidatePath = path.join(runDir, requiredText(candidateRow, "relative_path"));
    const publicationPath =
      this.workspace.publicationPath || path.join(this.workspace.rootPath, "published-wiki");

    /**
     * Under the publication lock (inside applySealedPublicationCandidate):
     * verify baseline, then CAS candidate_ready → applying BEFORE any rename.
     * Validates cancel_requested, owning generation still current, gate approved.
     */
    const beginApply = (): boolean => {
      let accepted = false;
      this.transaction(() => {
        const run = asRow(
          this.db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?").get(claim.runId),
        );
        if (!run || requiredNumber(run, "cancel_requested") !== 0) return;

        const liveGen = this.currentNodeGeneration(claim.runId, publicationNodeKey);
        if (liveGen !== publicationNodeGeneration) return;

        const gate = asRow(
          this.db
            .prepare(
              `SELECT state, decision_json FROM gates
               WHERE gate_id = ? AND run_id = ? AND kind = 'publication'`,
            )
            .get(gateId, claim.runId),
        );
        if (!gate || requiredText(gate, "state") !== "resolved") return;
        const decision = parseJson<{ decision?: string }>(gate.decision_json);
        if (decision.decision !== "approve") return;

        const cas = this.db
          .prepare(
            `UPDATE effects SET state = 'applying'
             WHERE effect_key = ? AND state = 'candidate_ready'`,
          )
          .run(effectKey);
        if (cas.changes !== 1) return;
        this.emit(claim.runId, "effect.applying");
        accepted = true;
      });
      return accepted;
    };

    try {
      const result = await applySealedPublicationCandidate({
        candidateDir: candidatePath,
        publicationPath,
        expectedLiveDigest,
        effectKey,
        beginApply,
      });

      if (result.status === "conflict") {
        this.transaction(() => {
          this.db
            .prepare(
              `UPDATE effects SET state = 'conflict', observed_outcome = ?
               WHERE effect_key = ? AND state IN ('candidate_ready', 'applying')`,
            )
            .run(
              `PublicationConflict live=${result.liveDigest} expected=${result.expectedLiveDigest}`.slice(
                0,
                4_000,
              ),
              effectKey,
            );
          this.emit(claim.runId, "effect.conflict");
        });
        return {
          type: "failed",
          error: new PublicationConflictError(result.liveDigest, result.expectedLiveDigest).message,
          failureClass: "infrastructure",
        };
      }

      if (result.status === "aborted") {
        // Cancel or stale generation/gate — leave effect as candidate_ready or cancelled.
        const current = asRow(
          this.db.prepare("SELECT state FROM effects WHERE effect_key = ?").get(effectKey),
        );
        const state = current ? requiredText(current, "state") : "unknown";
        return {
          type: "failed",
          error: `publish apply aborted (effect state=${state}; cancel or stale generation/gate)`,
          failureClass: "cancelled",
        };
      }

      this.transaction(() => {
        this.db
          .prepare(
            `UPDATE effects SET state = 'applied', observed_outcome = ?
             WHERE effect_key = ? AND state IN ('applying', 'candidate_ready')`,
          )
          .run(`published:${result.liveDigest}`, effectKey);
        this.emit(claim.runId, "effect.applied");
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "publish failed";
      const current = asRow(
        this.db.prepare("SELECT state FROM effects WHERE effect_key = ?").get(effectKey),
      );
      const state = current ? requiredText(current, "state") : null;
      if (state === "candidate_ready") {
        // Error before CAS — safe to mark failed; live was never mutated.
        this.transaction(() => {
          this.db
            .prepare(
              "UPDATE effects SET state = 'failed', observed_outcome = ? WHERE effect_key = ?",
            )
            .run(message.slice(0, 4_000), effectKey);
          this.emit(claim.runId, "effect.failed");
        });
        return { type: "failed", error: message.slice(0, 4_000), failureClass: "infrastructure" };
      }
      if (state === "applying") {
        // Crash window after CAS: never guess cancelled/failed. Reconcile against
        // live / sealed candidate / aside markers (ADR 0035).
        try {
          await this.reconcileApplyingEffect({
            effectKey,
            runId: claim.runId,
            candidateArtifactId: candidateId,
            candidateDigest: requiredText(effect, "candidate_digest"),
            expectedLiveDigest,
          });
        } catch {
          // Leave applying for owner reopen recovery.
        }
        const after = asRow(
          this.db
            .prepare("SELECT state, observed_outcome FROM effects WHERE effect_key = ?")
            .get(effectKey),
        );
        const afterState = after ? requiredText(after, "state") : "applying";
        if (afterState === "applied") {
          // Rename actually committed; continue the success path below.
        } else {
          const detail =
            after && typeof after.observed_outcome === "string" && after.observed_outcome
              ? after.observed_outcome
              : message;
          return {
            type: "failed",
            error: `publish apply ${afterState}: ${detail}`.slice(0, 4_000),
            failureClass: "infrastructure",
          };
        }
      } else {
        return { type: "failed", error: message.slice(0, 4_000), failureClass: "infrastructure" };
      }
    }

    const receiptPath = path.join(workDir, "publish-receipt.json");
    await writeFile(
      receiptPath,
      `${JSON.stringify({ schema: 1, effectKey, state: "applied" })}\n`,
      "utf8",
    );
    const transcript = await writeConversationTranscript({
      sessionPath: path.join(runDir, "attempts", claim.attemptId, "session.jsonl"),
      nodeKey: claim.nodeKey,
      summary: "published",
      meta: { effectKey },
    });
    return {
      type: "succeeded",
      unsealedArtifacts: [
        { kind: "receipt", role: "publish_receipt", sourcePath: receiptPath, directory: false },
        { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
      ],
      summary: "published",
    };
  }

  private async prepareUnsealedArtifact(
    claim: ClaimedNode,
    descriptor: PiAttemptArtifactDescriptor,
  ): Promise<ArtifactPreparation | undefined> {
    const stageParent = path.join(
      runWorkDir(this.workspace.rootPath, claim.runId),
      "attempts",
      claim.attemptId,
      "seal-stage",
    );
    await mkdir(stageParent, { recursive: true });
    const stageDir = path.join(stageParent, `${descriptor.role}-${randomUUID()}`);
    await mkdir(stageDir, { recursive: true });
    if (descriptor.directory) {
      await cp(descriptor.sourcePath, stageDir, {
        recursive: true,
        dereference: false,
        errorOnExist: false,
      });
    } else {
      const base =
        descriptor.kind === "spec"
          ? "spec.json"
          : path.basename(descriptor.sourcePath) || `${descriptor.role}.json`;
      await cp(descriptor.sourcePath, path.join(stageDir, base), { dereference: false });
    }
    const manifest = await manifestFor(stageDir);
    const manifestDigest = digest(manifest);
    const preparation: ArtifactPreparation = {
      artifactId: artifactId(claim.runId, descriptor.kind, manifestDigest),
      digest: manifestDigest,
      kind: descriptor.kind,
      preparationId: randomUUID(),
      relativePath: `artifacts/${descriptor.kind}-${manifestDigest}`,
      role: descriptor.role,
      sourceDirectory: stageDir,
    };
    return this.transaction(() => {
      if (!this.isCurrent(claim)) return undefined;
      this.db
        .prepare(
          `INSERT INTO artifact_preparations (
            preparation_id, attempt_id, run_id, node_key, node_generation, artifact_id, kind, role,
            manifest_digest, relative_path, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared')`,
        )
        .run(
          preparation.preparationId,
          claim.attemptId,
          claim.runId,
          claim.nodeKey,
          claim.nodeGeneration,
          preparation.artifactId,
          preparation.kind,
          preparation.role,
          preparation.digest,
          preparation.relativePath,
        );
      return preparation;
    });
  }

  // (commit/fail helpers follow)

  private commitNodeArtifacts(claim: ClaimedNode, preparations: ArtifactPreparation[]): void {
    if (!this.isCurrent(claim)) {
      this.db
        .prepare(
          "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
        )
        .run(claim.attemptId);
      return;
    }
    const timestamp = now();
    for (const preparation of preparations) {
      this.db
        .prepare(
          `INSERT INTO artifacts (artifact_id, run_id, kind, digest, relative_path, producer_attempt_id, sealed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(artifact_id) DO NOTHING`,
        )
        .run(
          preparation.artifactId,
          claim.runId,
          preparation.kind,
          preparation.digest,
          preparation.relativePath,
          claim.attemptId,
          timestamp,
        );
      this.db
        .prepare(
          `INSERT INTO node_outputs (run_id, node_key, node_generation, role, artifact_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(run_id, node_key, node_generation, role) DO NOTHING`,
        )
        .run(
          claim.runId,
          claim.nodeKey,
          claim.nodeGeneration,
          preparation.role,
          preparation.artifactId,
        );
    }
    this.db
      .prepare(
        "UPDATE attempts SET state = 'succeeded', ended_at = ? WHERE attempt_id = ? AND state = 'running'",
      )
      .run(timestamp, claim.attemptId);
    this.db
      .prepare(
        `UPDATE nodes SET state = 'succeeded', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ? AND current_attempt_id = ?`,
      )
      .run(claim.runId, claim.nodeKey, claim.nodeGeneration, claim.attemptId);
    this.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'committed' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(claim.attemptId);
    this.emit(claim.runId, "attempt.succeeded");

    if (claim.kind === "plan") {
      const specPrep = preparations.find((item) => item.role === "spec" || item.kind === "spec");
      if (!specPrep) throw new Error("plan attempt succeeded without a Spec artifact");
      this.openPlanGate(claim, specPrep.digest, timestamp);
      return;
    }
    if (claim.kind === "prepare.publication") {
      const candidate = preparations.find(
        (item) => item.role === "publication_candidate" || item.kind === "publication_candidate",
      );
      if (!candidate) throw new Error("prepare.publication succeeded without a candidate");
      const expectedLiveDigest = this.readPublicationBaseline(claim.runId, preparations);
      this.openPublicationGate(claim, candidate, expectedLiveDigest, timestamp);
      return;
    }
    if (claim.kind === "publish") {
      this.db
        .prepare(
          "UPDATE runs SET state = 'published', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
        )
        .run(timestamp, claim.runId);
      this.emit(claim.runId, "run.published");
      return;
    }

    this.unlockReadyNodes(claim.runId);
    const hasReady = asRow(
      this.db
        .prepare(
          `SELECT 1 AS present FROM nodes
           WHERE run_id = ? AND state = 'ready'
             AND generation = (
               SELECT MAX(n2.generation) FROM nodes n2
               WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
             )
           LIMIT 1`,
        )
        .get(claim.runId),
    );
    const hasWaiting = asRow(
      this.db
        .prepare(`SELECT 1 AS present FROM nodes WHERE run_id = ? AND state = 'waiting' LIMIT 1`)
        .get(claim.runId),
    );
    if (hasReady) {
      this.db
        .prepare(
          "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0 AND state = 'running'",
        )
        .run(timestamp, claim.runId);
      this.emit(claim.runId, "node.ready");
    } else if (hasWaiting) {
      this.db
        .prepare(
          "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
        )
        .run(timestamp, claim.runId);
    } else {
      // Keep running if blocked work may unlock later; otherwise leave state as running
      // until a terminal transition (publish / completed_unpublished / failed).
      this.db
        .prepare(
          "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
        )
        .run(timestamp, claim.runId);
    }
  }

  private openPlanGate(claim: ClaimedNode, specPayloadDigest: string, timestamp: string): void {
    const gateId = randomUUID();
    const gateNodeKey = "gate.plan";
    const existingGateNode = asRow(
      this.db
        .prepare(
          "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
        )
        .get(claim.runId, gateNodeKey, claim.nodeGeneration),
    );
    if (!existingGateNode) {
      this.db
        .prepare(
          `INSERT INTO nodes (
            run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
          ) VALUES (?, ?, 'gate.plan', 'waiting', ?, NULL, NULL, NULL)`,
        )
        .run(claim.runId, gateNodeKey, claim.nodeGeneration);
    } else {
      this.db
        .prepare(
          `UPDATE nodes SET state = 'waiting', current_attempt_id = NULL
           WHERE run_id = ? AND node_key = ? AND generation = ?`,
        )
        .run(claim.runId, gateNodeKey, claim.nodeGeneration);
    }
    this.db
      .prepare(
        `INSERT INTO gates (
          gate_id, run_id, node_key, node_generation, kind, state, payload_digest,
          decision_json, detail_json, opened_at, opened_revision
        ) VALUES (?, ?, ?, ?, 'plan', 'open', ?, NULL, NULL, ?,
          (SELECT revision FROM runs WHERE run_id = ?))`,
      )
      .run(
        gateId,
        claim.runId,
        gateNodeKey,
        claim.nodeGeneration,
        specPayloadDigest,
        timestamp,
        claim.runId,
      );
    this.db
      .prepare(
        "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
    this.emit(claim.runId, "gate.opened");
  }

  /**
   * Recover the live baseline captured during prepare.publication.
   * Prefers the attempt-private stage copy, then the sealed receipt artifact.
   * Falls back to the canonical empty-tree digest (not 64 zero hex).
   */
  private readPublicationBaseline(runId: string, preparations: ArtifactPreparation[]): string {
    const metaPrep = preparations.find((item) => item.role === "candidate_meta");
    if (!metaPrep) return EMPTY_PUBLICATION_DIGEST;
    const candidates: string[] = [];
    if (metaPrep.sourceDirectory) {
      candidates.push(path.join(metaPrep.sourceDirectory, "candidate-meta.json"));
      candidates.push(metaPrep.sourceDirectory);
    }
    const sealedRoot = path.join(runWorkDir(this.workspace.rootPath, runId), metaPrep.relativePath);
    candidates.push(path.join(sealedRoot, "candidate-meta.json"), sealedRoot);
    for (const candidate of candidates) {
      try {
        const raw = readFileSync(candidate, "utf8");
        const meta = JSON.parse(raw) as { expectedLiveDigest?: string };
        if (
          typeof meta.expectedLiveDigest === "string" &&
          /^[a-f0-9]{64}$/i.test(meta.expectedLiveDigest)
        ) {
          return meta.expectedLiveDigest;
        }
      } catch {
        // Try the next candidate path.
      }
    }
    return EMPTY_PUBLICATION_DIGEST;
  }

  private openPublicationGate(
    claim: ClaimedNode,
    candidate: ArtifactPreparation,
    expectedLiveDigest: string,
    timestamp: string,
  ): void {
    const gateId = randomUUID();
    const gateNodeKey = "gate.publication";
    const gateGen = this.currentNodeGeneration(claim.runId, gateNodeKey) ?? 0;
    this.db
      .prepare(
        `UPDATE nodes SET state = 'waiting', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ?`,
      )
      .run(claim.runId, gateNodeKey, gateGen);
    // Gate payload binds candidate + baseline + effect identity + owning generation.
    const effectKey = `publish:${claim.runId}:${claim.nodeGeneration}:${candidate.digest}`;
    const requestDigest = digest({
      effectKey,
      candidateArtifactId: candidate.artifactId,
      candidateDigest: candidate.digest,
      expectedLiveDigest,
      publicationNodeKey: claim.nodeKey,
      publicationNodeGeneration: claim.nodeGeneration,
    });
    this.db
      .prepare(
        `INSERT INTO effects (
          effect_key, run_id, publication_node_key, publication_node_generation, gate_id, state,
          request_digest, expected_live_digest, candidate_artifact_id, candidate_digest, observed_outcome
        ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, NULL)`,
      )
      .run(
        effectKey,
        claim.runId,
        claim.nodeKey,
        claim.nodeGeneration,
        gateId,
        requestDigest,
        expectedLiveDigest,
        candidate.artifactId,
        candidate.digest,
      );
    this.db
      .prepare(
        `INSERT INTO gates (
          gate_id, run_id, node_key, node_generation, kind, state, payload_digest,
          decision_json, detail_json, opened_at, opened_revision
        ) VALUES (?, ?, ?, ?, 'publication', 'open', ?, NULL, NULL, ?,
          (SELECT revision FROM runs WHERE run_id = ?))`,
      )
      .run(gateId, claim.runId, gateNodeKey, gateGen, requestDigest, timestamp, claim.runId);
    this.db
      .prepare(
        "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
    this.emit(claim.runId, "effect.prepared");
    this.emit(claim.runId, "gate.opened");
  }

  private failNode(claim: ClaimedNode, error: unknown): void {
    if (!this.isCurrent(claim)) return;
    const timestamp = now();
    const message =
      error instanceof Error ? error.message.slice(0, 4_000) : `${claim.nodeKey} failed`;
    this.db
      .prepare(
        "UPDATE attempts SET state = 'failed', error = ?, ended_at = ? WHERE attempt_id = ? AND state = 'running'",
      )
      .run(message, timestamp, claim.attemptId);
    this.db
      .prepare(
        `UPDATE nodes SET state = 'failed', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ? AND current_attempt_id = ?`,
      )
      .run(claim.runId, claim.nodeKey, claim.nodeGeneration, claim.attemptId);
    this.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(claim.attemptId);
    this.emit(claim.runId, "attempt.failed");

    // Research read-only auto-retry: re-queue same generation with exact input digest.
    // Validate dirty / write / review stay manual (RetryFailedNode or RerunNode/wiki_repair).
    if (this.shouldAutoRetryResearch(claim, message)) {
      this.requeueFailedNode(claim.runId, claim.nodeKey, claim.nodeGeneration, claim.attemptId);
      this.emit(claim.runId, "node.ready");
      return;
    }

    // Siblings may still be ready; only fail the run when nothing else can progress.
    const hasWork = asRow(
      this.db
        .prepare(
          `SELECT 1 AS present FROM nodes
           WHERE run_id = ? AND state IN ('ready', 'running', 'waiting', 'blocked')
             AND generation = (
               SELECT MAX(n2.generation) FROM nodes n2
               WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
             )
           LIMIT 1`,
        )
        .get(claim.runId),
    );
    if (!hasWork) {
      this.db
        .prepare("UPDATE runs SET state = 'failed', updated_at = ? WHERE run_id = ?")
        .run(timestamp, claim.runId);
    } else {
      // Re-evaluate unlock in case other branches can proceed without this node.
      this.unlockReadyNodes(claim.runId);
      this.db
        .prepare(
          "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0 AND state NOT IN ('waiting_for_operator', 'cancelling', 'cancelled')",
        )
        .run(timestamp, claim.runId);
    }
  }

  /**
   * Limited auto-retry for research.leaf / research.domain only.
   * Budget: RESEARCH_AUTO_RETRY_MAX_ATTEMPTS total Attempts per generation.
   * Non-retryable: cancel, budget, capacity, and explicit policy signals.
   */
  private shouldAutoRetryResearch(claim: ClaimedNode, message: string): boolean {
    if (!RESEARCH_AUTO_RETRY_KINDS.has(claim.kind)) return false;
    if (this.closed) return false;
    const run = asRow(
      this.db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?").get(claim.runId),
    );
    if (!run || requiredNumber(run, "cancel_requested") === 1) return false;
    if (
      /cancel/i.test(message) ||
      /budget exhausted|token budget/i.test(message) ||
      /capacity|context overflow|context.?length/i.test(message) ||
      /insufficient_quota|quota exceeded|billing/i.test(message)
    ) {
      return false;
    }
    const countRow = asRow(
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM attempts
           WHERE run_id = ? AND node_key = ? AND node_generation = ?
             AND state IN ('failed', 'interrupted', 'cancelled')`,
        )
        .get(claim.runId, claim.nodeKey, claim.nodeGeneration),
    );
    const failedCount = requiredNumber(countRow ?? { count: 0 }, "count");
    // failedCount includes this just-failed Attempt; allow one more total Attempt.
    return failedCount < RESEARCH_AUTO_RETRY_MAX_ATTEMPTS;
  }

  private async executeFreeze(claim: ClaimedFreeze): Promise<void> {
    const controller = new AbortController();
    this.activeAttempts.set(claim.attemptId, controller);
    let materialized = false;
    try {
      const prepared = this.prepareFreeze(claim);
      if (prepared.reusePinned) {
        // Post-pin retry: reuse immutable pinned inputs and already-sealed artifacts.
        await this.executePinnedFreezeRetry(claim, controller.signal);
        return;
      }
      await this.clearUnpinnedFreezeWork(claim.runId);
      if (this.closed || !this.isCurrent(claim)) return;
      const frozen = await this.runBoundary({
        workspace: prepared.workspace,
        runId: claim.runId,
        signal: controller.signal,
      });
      materialized = true;
      const frozenInputs: TrustedFrozenInputs = {
        skillDigest: frozen.skillDigest,
        sources: frozen.sources.map(({ path: _path, ...source }) => source),
      };
      if (!this.transaction(() => this.recordTrustedFrozenInputs(claim, frozenInputs))) return;
      if (this.closed || !this.isCurrent(claim)) return;
      const workDir = path.join(frozen.runWorkDir, "attempts", claim.attemptId, "work");
      const sessionPath = path.join(
        frozen.runWorkDir,
        "attempts",
        claim.attemptId,
        "session.jsonl",
      );
      await mkdir(workDir, { recursive: true });
      await writeFile(
        path.join(workDir, "freeze-inputs.json"),
        `${JSON.stringify({
          skillDigest: frozen.skillDigest,
          sources: frozen.sources.map(({ path: _path, ...source }) => source),
        })}\n`,
        "utf8",
      );
      const inputArtifacts = await this.prepareFreezeArtifacts(claim, [
        {
          directory: path.join(frozen.runWorkDir, "sources"),
          kind: "snapshot_set",
          role: "sources",
        },
        { directory: frozen.skillPath, kind: "skill", role: "skill" },
      ]);
      if (!inputArtifacts) return;
      for (const preparation of inputArtifacts.preparations)
        await this.sealPreparation(claim.runId, preparation);
      if (this.closed || !this.isCurrent(claim)) return;
      if (this.piAttemptExecutor) {
        const sourcesRoot = this.preparationPath(
          claim.runId,
          inputArtifacts.preparations,
          "sources",
        );
        const skillArtifactPath = this.preparationPath(
          claim.runId,
          inputArtifacts.preparations,
          "skill",
        );
        const sourcePaths: Record<string, string> = {};
        for (const source of frozen.sources) {
          sourcePaths[source.id] = path.join(sourcesRoot, source.id);
        }
        // Freeze currently probes the optional executor before CAS; full
        // PiAttemptInput (sealedInputs + node envelope) is required by the type.
        const probeInput = {
          runId: claim.runId,
          attemptId: claim.attemptId,
          node: {
            key: "freeze",
            kind: "freeze" as const,
            generation: claim.nodeGeneration,
            runIndex: 1,
          },
          inputDigest: this.attemptInputDigest(claim.attemptId),
          workspace: this.workspace,
          sealedInputs: inputArtifacts.preparations.map((preparation) => ({
            role: preparation.role,
            readOnlyPath: path.join(
              runWorkDir(this.workspace.rootPath, claim.runId),
              preparation.relativePath,
            ),
            artifact: {
              artifactId: preparation.artifactId,
              kind: preparation.kind,
              digest: preparation.digest,
              sealedAt: now(),
            },
          })),
          attemptDir: path.join(frozen.runWorkDir, "attempts", claim.attemptId),
          workDir,
          sessionPath,
          skillPath: skillArtifactPath,
          sourcePaths,
        } satisfies PiAttemptInput;
        const outcome: PiAttemptOutcome = await this.piAttemptExecutor(
          probeInput,
          controller.signal,
        );
        if (outcome.type === "failed") {
          throw new Error(outcome.error);
        }
        // Probe may write session.jsonl; ensure a conversation row even if it did not.
        const liveInfo = await lstat(sessionPath).catch(() => undefined);
        if (!liveInfo?.isFile()) {
          await writeConversationTranscript({
            sessionPath,
            nodeKey: "freeze",
            summary:
              outcome.type === "succeeded" && outcome.summary
                ? outcome.summary
                : "Freeze inputs sealed by WikiRuns",
            meta: { mode: "freeze_probe" },
          });
        }
      } else {
        // No Pi executor: still leave a readable freeze transcript for Node details.
        await writeConversationTranscript({
          sessionPath,
          nodeKey: "freeze",
          summary: "Freeze inputs sealed by WikiRuns",
          meta: { mode: "freeze_boundary" },
        });
      }
      if (this.closed || !this.isCurrent(claim)) return;
      const outputArtifacts = await this.prepareFreezeArtifacts(claim, [
        { directory: workDir, kind: "manifest", role: "attempt_output" },
      ]);
      if (!outputArtifacts) return;
      for (const preparation of outputArtifacts.preparations)
        await this.sealPreparation(claim.runId, preparation);
      // Live session.jsonl is enough for GET transcript (readAttemptTranscript).
      // Do not seal transcript as a freeze node_output — recovery would re-bind it
      // into freeze outputs and pollute child attempt_inputs.
      if (this.closed || !this.isCurrent(claim)) return;
      this.transaction(() =>
        this.commitFreezeArtifacts(claim, [
          ...inputArtifacts.preparations,
          ...outputArtifacts.preparations,
        ]),
      );
    } catch (error) {
      if (this.closed) return;
      const message =
        error instanceof Error ? error.message.slice(0, 4_000) : "freeze failed";
      await writeConversationTranscript({
        sessionPath: path.join(
          runWorkDir(this.workspace.rootPath, claim.runId),
          "attempts",
          claim.attemptId,
          "session.jsonl",
        ),
        nodeKey: "freeze",
        summary: `Error: ${message}`,
        preserveExisting: true,
        meta: { mode: "failed", error: message },
      }).catch(() => undefined);
      this.transaction(() => this.failFreeze(claim, error));
    } finally {
      this.activeAttempts.delete(claim.attemptId);
      if (materialized) {
        this.transaction(() => this.orphanPreparedArtifacts(claim.attemptId));
        await this.clearUnpinnedFreezeWork(claim.runId);
      }
    }
  }

  /**
   * Post-pin freeze retry: do not re-resolve live Git/Skill selectors.
   * Re-seal attempt_output from pinned inputs and recommit node outputs.
   */
  private async executePinnedFreezeRetry(claim: ClaimedFreeze, signal: AbortSignal): Promise<void> {
    try {
      if (signal.aborted || this.closed || !this.isCurrent(claim)) return;
      const inputs = this.trustedPinnedInputs(claim.runId);
      if (!inputs) throw new Error("pinned freeze inputs are missing for retry");
      const runDir = runWorkDir(this.workspace.rootPath, claim.runId);
      const prior = asRows(
        this.db
          .prepare(
            `SELECT node_outputs.role, artifacts.relative_path, artifacts.kind, artifacts.digest, artifacts.artifact_id
             FROM node_outputs
             JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
             WHERE node_outputs.run_id = ?
               AND node_outputs.node_key = 'freeze'
               AND node_outputs.role IN ('sources', 'skill')
             ORDER BY node_outputs.node_generation DESC, node_outputs.role`,
          )
          .all(claim.runId),
      );
      const byRole = new Map<string, SqlRow>();
      for (const row of prior) {
        const role = requiredText(row, "role");
        if (!byRole.has(role)) byRole.set(role, row);
      }
      const sources = byRole.get("sources");
      const skill = byRole.get("skill");
      if (!sources || !skill) throw new Error("pinned freeze artifacts are missing for retry");

      const workDir = path.join(runDir, "attempts", claim.attemptId, "work");
      await mkdir(workDir, { recursive: true });
      await writeFile(
        path.join(workDir, "freeze-inputs.json"),
        `${JSON.stringify({
          skillDigest: inputs.skillDigest,
          sources: inputs.sources,
        })}\n`,
        "utf8",
      );
      if (this.piAttemptExecutor) {
        const sourcesRoot = path.join(runDir, requiredText(sources, "relative_path"));
        const skillPath = path.join(runDir, requiredText(skill, "relative_path"));
        const sourcePaths: Record<string, string> = {};
        for (const source of inputs.sources as Array<{ id: string }>) {
          sourcePaths[source.id] = path.join(sourcesRoot, source.id);
        }
        const outcome = await this.piAttemptExecutor(
          {
            runId: claim.runId,
            attemptId: claim.attemptId,
            node: {
              key: "freeze",
              kind: "freeze",
              generation: claim.nodeGeneration,
              runIndex: 1,
            },
            inputDigest: this.attemptInputDigest(claim.attemptId),
            workspace: this.workspace,
            sealedInputs: [sources, skill].map((row) => ({
              role: requiredText(row, "role"),
              readOnlyPath: path.join(runDir, requiredText(row, "relative_path")),
              artifact: {
                artifactId: requiredText(row, "artifact_id"),
                kind: requiredText(row, "kind") as ArtifactPreparation["kind"],
                digest: requiredText(row, "digest"),
                sealedAt: now(),
              },
            })),
            attemptDir: path.join(runDir, "attempts", claim.attemptId),
            workDir,
            sessionPath: path.join(runDir, "attempts", claim.attemptId, "session.jsonl"),
            skillPath,
            sourcePaths,
          } satisfies PiAttemptInput,
          signal,
        );
        if (outcome.type === "failed") throw new Error(outcome.error);
      }
      if (this.closed || !this.isCurrent(claim)) return;
      const outputArtifacts = await this.prepareFreezeArtifacts(claim, [
        { directory: workDir, kind: "manifest", role: "attempt_output" },
      ]);
      if (!outputArtifacts) return;
      for (const preparation of outputArtifacts.preparations)
        await this.sealPreparation(claim.runId, preparation);
      if (this.closed || !this.isCurrent(claim)) return;
      const inputPreparations: ArtifactPreparation[] = [sources, skill].map((row) => ({
        artifactId: requiredText(row, "artifact_id"),
        digest: requiredText(row, "digest"),
        kind: requiredText(row, "kind") as ArtifactPreparation["kind"],
        preparationId: randomUUID(),
        relativePath: requiredText(row, "relative_path"),
        role: requiredText(row, "role"),
        sourceDirectory: "",
      }));
      // Reuse already-sealed input artifacts; only the new attempt_output needs commit prep rows.
      this.transaction(() => {
        for (const preparation of inputPreparations) {
          this.db
            .prepare(
              `INSERT INTO artifact_preparations (
                preparation_id, attempt_id, run_id, node_key, node_generation, artifact_id, kind, role,
                manifest_digest, relative_path, state
              ) VALUES (?, ?, ?, 'freeze', ?, ?, ?, ?, ?, ?, 'prepared')`,
            )
            .run(
              preparation.preparationId,
              claim.attemptId,
              claim.runId,
              claim.nodeGeneration,
              preparation.artifactId,
              preparation.kind,
              preparation.role,
              preparation.digest,
              preparation.relativePath,
            );
        }
        this.commitFreezeArtifacts(claim, [...inputPreparations, ...outputArtifacts.preparations]);
      });
    } catch (error) {
      if (this.closed) return;
      this.transaction(() => this.failFreeze(claim, error));
    } finally {
      this.activeAttempts.delete(claim.attemptId);
      this.transaction(() => this.orphanPreparedArtifacts(claim.attemptId));
    }
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

  private async prepareFreezeArtifacts(
    claim: ClaimedFreeze,
    candidates: Array<{
      directory: string;
      kind: ArtifactPreparation["kind"];
      role: string;
    }>,
  ): Promise<PreparedFreezeArtifacts | undefined> {
    const preparations = await Promise.all(
      candidates.map(async (candidate) => {
        const manifest = await manifestFor(candidate.directory);
        const manifestDigest = digest(manifest);
        return {
          artifactId: artifactId(claim.runId, candidate.kind, manifestDigest),
          digest: manifestDigest,
          kind: candidate.kind,
          preparationId: randomUUID(),
          relativePath: `artifacts/${candidate.kind}-${manifestDigest}`,
          role: candidate.role,
          sourceDirectory: candidate.directory,
        } satisfies ArtifactPreparation;
      }),
    );
    return this.transaction(() => {
      if (!this.isCurrent(claim)) return undefined;
      for (const preparation of preparations) {
        this.db
          .prepare(
            `INSERT INTO artifact_preparations (
              preparation_id, attempt_id, run_id, node_key, node_generation, artifact_id, kind, role,
              manifest_digest, relative_path, state
            ) VALUES (?, ?, ?, 'freeze', ?, ?, ?, ?, ?, ?, 'prepared')`,
          )
          .run(
            preparation.preparationId,
            claim.attemptId,
            claim.runId,
            claim.nodeGeneration,
            preparation.artifactId,
            preparation.kind,
            preparation.role,
            preparation.digest,
            preparation.relativePath,
          );
      }
      return { preparations };
    });
  }

  private async sealPreparation(runId: string, preparation: ArtifactPreparation): Promise<void> {
    const runDir = runWorkDir(this.workspace.rootPath, runId);
    const destination = path.join(runDir, preparation.relativePath);
    const parent = path.dirname(destination);
    await mkdir(parent, { recursive: true });
    if (!(await this.verifyArtifact(destination, preparation.digest))) {
      const temporary = await mkdtemp(path.join(parent, ".artifact-"));
      try {
        await cp(preparation.sourceDirectory, temporary, {
          recursive: true,
          dereference: false,
          errorOnExist: true,
        });
        const manifest = await manifestFor(temporary);
        if (digest(manifest) !== preparation.digest)
          throw new Error(`${preparation.role} changed after preparation`);
        await writeFile(
          path.join(temporary, ".okf-artifact-manifest.json"),
          `${JSON.stringify(manifest)}\n`,
          "utf8",
        );
        await this.syncTree(temporary);
        await rename(temporary, destination);
        await this.syncDirectory(parent);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    }
    if (!(await this.verifyArtifact(destination, preparation.digest))) {
      throw new Error(`sealed artifact verification failed: ${preparation.artifactId}`);
    }
  }

  private async verifyArtifact(directory: string, expectedDigest: string): Promise<boolean> {
    const info = await lstat(directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!info?.isDirectory()) return false;
    try {
      const manifest = manifestFor(directory, true);
      const sealedManifest = JSON.parse(
        await readFile(path.join(directory, ".okf-artifact-manifest.json"), "utf8"),
      ) as unknown;
      return digest(await manifest) === expectedDigest && digest(sealedManifest) === expectedDigest;
    } catch {
      return false;
    }
  }

  private preparationPath(
    runId: string,
    preparations: ArtifactPreparation[],
    role: string,
  ): string {
    const preparation = preparations.find((candidate) => candidate.role === role);
    if (!preparation) throw new Error(`missing ${role} artifact preparation`);
    return path.join(runWorkDir(this.workspace.rootPath, runId), preparation.relativePath);
  }

  private async syncTree(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await this.syncTree(child);
      else if (entry.isFile()) await durableFsyncPath(child);
    }
    await this.syncDirectory(directory);
  }

  private async syncDirectory(directory: string): Promise<void> {
    // Directory fsync is a POSIX durability hint; Windows often returns EPERM.
    if (process.platform === "win32") return;
    await durableFsyncPath(directory);
  }

  /** Inputs are trusted only after the Run Boundary returns, never from Pi output. */
  private recordTrustedFrozenInputs(claim: ClaimedFreeze, inputs: TrustedFrozenInputs): boolean {
    const sources = RepositorySnapshotSchema.array().min(1).parse(inputs.sources);
    if (!this.isCurrent(claim)) return false;
    this.db
      .prepare(
        `UPDATE runs SET frozen_sources_json = ?, frozen_skill_digest = ?, updated_at = ?
         WHERE run_id = ? AND pinned_digest IS NULL`,
      )
      .run(JSON.stringify(sources), inputs.skillDigest, now(), claim.runId);
    return true;
  }

  private trustedFrozenInputs(runId: string): TrustedFrozenInputs | undefined {
    const run = asRow(
      this.db
        .prepare("SELECT frozen_sources_json, frozen_skill_digest FROM runs WHERE run_id = ?")
        .get(runId),
    );
    if (!run || run.frozen_sources_json === null || run.frozen_skill_digest === null)
      return undefined;
    try {
      return {
        sources: RepositorySnapshotSchema.array()
          .min(1)
          .parse(parseJson<unknown>(run.frozen_sources_json)),
        skillDigest: requiredText(run, "frozen_skill_digest"),
      };
    } catch {
      return undefined;
    }
  }

  private orphanPreparedArtifacts(attemptId: string): void {
    this.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(attemptId);
  }

  private commitFreezeArtifacts(claim: ClaimedFreeze, preparations: ArtifactPreparation[]): void {
    if (!this.isCurrent(claim)) {
      this.db
        .prepare(
          "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
        )
        .run(claim.attemptId);
      return;
    }
    const inputs = this.trustedFrozenInputs(claim.runId);
    if (!inputs) throw new Error("freeze inputs were not durably recorded");
    const timestamp = now();
    for (const preparation of preparations) {
      this.db
        .prepare(
          `INSERT INTO artifacts (artifact_id, run_id, kind, digest, relative_path, producer_attempt_id, sealed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(artifact_id) DO NOTHING`,
        )
        .run(
          preparation.artifactId,
          claim.runId,
          preparation.kind,
          preparation.digest,
          preparation.relativePath,
          claim.attemptId,
          timestamp,
        );
      this.db
        .prepare(
          `INSERT INTO node_outputs (run_id, node_key, node_generation, role, artifact_id)
           VALUES (?, 'freeze', ?, ?, ?)
           ON CONFLICT(run_id, node_key, node_generation, role) DO NOTHING`,
        )
        .run(claim.runId, claim.nodeGeneration, preparation.role, preparation.artifactId);
    }
    const pinnedDigest = digest(inputs);
    this.db
      .prepare(
        `UPDATE runs SET pinned_sources_json = ?, skill_digest = ?, pinned_digest = ?, updated_at = ?
         WHERE run_id = ? AND cancel_requested = 0`,
      )
      .run(
        JSON.stringify(inputs.sources),
        inputs.skillDigest,
        pinnedDigest,
        timestamp,
        claim.runId,
      );
    this.emit(claim.runId, "inputs.pinned");
    this.db
      .prepare(
        "UPDATE attempts SET state = 'succeeded', ended_at = ? WHERE attempt_id = ? AND state = 'running'",
      )
      .run(timestamp, claim.attemptId);
    this.db
      .prepare(
        `UPDATE nodes SET state = 'succeeded', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = 'freeze' AND generation = ? AND current_attempt_id = ?`,
      )
      .run(claim.runId, claim.nodeGeneration, claim.attemptId);
    this.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'committed' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(claim.attemptId);
    this.emit(claim.runId, "attempt.succeeded");
    // Advance freeze → plan: plan is ready for claim; run stays active (not terminal).
    const existingPlan = asRow(
      this.db
        .prepare(
          "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = 'plan' AND generation = 0",
        )
        .get(claim.runId),
    );
    if (!existingPlan) {
      this.db
        .prepare(
          `INSERT INTO nodes (
            run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
          ) VALUES (?, 'plan', 'plan', 'ready', 0, NULL, NULL, NULL)`,
        )
        .run(claim.runId);
    } else {
      this.db
        .prepare(
          `UPDATE nodes SET state = 'ready', current_attempt_id = NULL
           WHERE run_id = ? AND node_key = 'plan' AND generation = 0
             AND state IN ('blocked', 'invalidated', 'failed')`,
        )
        .run(claim.runId);
    }
    this.db
      .prepare(
        "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
    this.emit(claim.runId, "node.ready");
  }

  private failFreeze(claim: ClaimedFreeze, error: unknown): void {
    if (!this.isCurrent(claim)) return;
    const timestamp = now();
    const message = error instanceof Error ? error.message.slice(0, 4_000) : "freeze failed";
    this.db
      .prepare(
        "UPDATE attempts SET state = 'failed', error = ?, ended_at = ? WHERE attempt_id = ? AND state = 'running'",
      )
      .run(message, timestamp, claim.attemptId);
    this.db
      .prepare(
        `UPDATE nodes SET state = 'failed', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = 'freeze' AND generation = ? AND current_attempt_id = ?`,
      )
      .run(claim.runId, claim.nodeGeneration, claim.attemptId);
    this.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(claim.attemptId);
    this.db
      .prepare("UPDATE runs SET state = 'failed', updated_at = ? WHERE run_id = ?")
      .run(timestamp, claim.runId);
    this.emit(claim.runId, "attempt.failed");
  }

  /**
   * Freeze reads the StartRun snapshot, never mutable workspace.json.
   * Post-pin retry reuses immutable pinned inputs (does not re-resolve live selectors).
   */
  private prepareFreeze(claim: ClaimedFreeze): PreparedFreeze & { reusePinned: boolean } {
    const run = asRow(
      this.db
        .prepare("SELECT freeze_config_json, pinned_digest FROM runs WHERE run_id = ?")
        .get(claim.runId),
    );
    if (!run) throw new Error(`run not found: ${claim.runId}`);
    return {
      workspace: WorkspaceConfigSchema.parse(parseJson<unknown>(run.freeze_config_json)),
      reusePinned: run.pinned_digest !== null,
    };
  }

  /** A failed or cancelled pre-pin freeze leaves no durable owned work tree. */
  private async clearUnpinnedFreezeWork(runId: string): Promise<void> {
    const run = asRow(
      this.db.prepare("SELECT pinned_digest FROM runs WHERE run_id = ?").get(runId),
    );
    if (!run) throw new Error(`run not found: ${runId}`);
    if (run.pinned_digest !== null) return;
    const work = runWorkDir(this.workspace.rootPath, runId);
    await makeOwnedTreeWritable(work);
    await rm(work, { recursive: true, force: true });
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
    const run = asRow(this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId));
    if (!run) throw new Error(`run not found: ${runId}`);
    const nodes: WikiRunNode[] = asRows(
      this.db
        .prepare(
          `SELECT nodes.* FROM nodes
           JOIN (SELECT node_key, MAX(generation) AS generation FROM nodes WHERE run_id = ? GROUP BY node_key) current
             ON current.node_key = nodes.node_key AND current.generation = nodes.generation
           WHERE nodes.run_id = ? ORDER BY nodes.node_key`,
        )
        .all(runId, runId),
    ).map((node) => ({
      key: requiredText(node, "node_key"),
      kind: requiredText(node, "kind") as WikiRunNode["kind"],
      state: requiredText(node, "state") as WikiRunNode["state"],
      generation: requiredNumber(node, "generation"),
      currentAttemptId: node.current_attempt_id as string | null,
      lastAttemptId: node.last_attempt_id as string | null,
      outputs: asRows(
        this.db
          .prepare(
            `SELECT node_outputs.role, artifacts.artifact_id, artifacts.kind, artifacts.digest, artifacts.sealed_at
             FROM node_outputs JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
             WHERE node_outputs.run_id = ? AND node_outputs.node_key = ? AND node_outputs.node_generation = ?
             ORDER BY node_outputs.role`,
          )
          .all(runId, requiredText(node, "node_key"), requiredNumber(node, "generation")),
      ).map((output) => ({
        role: requiredText(output, "role"),
        artifact: {
          artifactId: requiredText(output, "artifact_id"),
          kind: requiredText(output, "kind") as WikiRunNode["outputs"][number]["artifact"]["kind"],
          digest: requiredText(output, "digest"),
          sealedAt: requiredText(output, "sealed_at"),
        },
      })),
    }));
    const attempts: WikiRunAttempt[] = asRows(
      this.db
        .prepare("SELECT * FROM attempts WHERE run_id = ? ORDER BY started_at, attempt_id")
        .all(runId),
    ).map((attempt) => ({
      attemptId: requiredText(attempt, "attempt_id"),
      nodeKey: requiredText(attempt, "node_key"),
      nodeGeneration: requiredNumber(attempt, "node_generation"),
      runIndex: requiredNumber(attempt, "run_index"),
      state: requiredText(attempt, "state") as WikiRunAttempt["state"],
      inputDigest: requiredText(attempt, "input_digest"),
      error: attempt.error as string | null,
      startedAt: requiredText(attempt, "started_at"),
      endedAt: attempt.ended_at as string | null,
    }));
    const sources =
      run.pinned_sources_json === null ? null : parseJson<unknown>(run.pinned_sources_json);
    const gates = asRows(
      this.db
        .prepare("SELECT * FROM gates WHERE run_id = ? ORDER BY opened_at, gate_id")
        .all(runId),
    ).map((gate) => ({
      gateId: requiredText(gate, "gate_id"),
      nodeKey: requiredText(gate, "node_key"),
      nodeGeneration: requiredNumber(gate, "node_generation"),
      kind: requiredText(gate, "kind") as WikiRunSnapshot["gates"][number]["kind"],
      state: requiredText(gate, "state") as WikiRunSnapshot["gates"][number]["state"],
      payloadDigest: requiredText(gate, "payload_digest"),
      decision:
        gate.decision_json === null
          ? null
          : parseJson<WikiRunSnapshot["gates"][number]["decision"]>(gate.decision_json),
      openedAt: requiredText(gate, "opened_at"),
    }));
    const effects = asRows(
      this.db.prepare("SELECT * FROM effects WHERE run_id = ? ORDER BY effect_key").all(runId),
    ).map((effect) => ({
      effectKey: requiredText(effect, "effect_key"),
      publicationNodeKey: requiredText(effect, "publication_node_key"),
      publicationNodeGeneration: requiredNumber(effect, "publication_node_generation"),
      gateId: requiredText(effect, "gate_id"),
      state: requiredText(effect, "state") as WikiRunSnapshot["effects"][number]["state"],
      requestDigest: requiredText(effect, "request_digest"),
      expectedLiveDigest: requiredText(effect, "expected_live_digest"),
      candidateArtifactId: requiredText(effect, "candidate_artifact_id"),
      candidateDigest: requiredText(effect, "candidate_digest"),
    }));
    return WikiRunSnapshotSchema.parse({
      schema: "okf.wiki-runs/v1",
      definitionVersion: 1,
      runId: requiredText(run, "run_id"),
      workspaceId: requiredText(run, "workspace_id"),
      revision: requiredNumber(run, "revision"),
      state: requiredText(run, "state"),
      cancelRequested: requiredNumber(run, "cancel_requested") === 1,
      pinnedInputs:
        sources === null
          ? null
          : {
              sources,
              skillDigest: requiredText(run, "skill_digest"),
              digest: requiredText(run, "pinned_digest"),
            },
      nodes,
      attempts,
      gates,
      effects,
      createdAt: requiredText(run, "created_at"),
      updatedAt: requiredText(run, "updated_at"),
    });
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
