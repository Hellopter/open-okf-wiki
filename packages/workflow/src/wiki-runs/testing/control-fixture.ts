/**
 * Lightweight WikiRunsControl fixture for unit tests without full openWikiRuns/Pi.
 *
 * Opens a temp SQLite control store (schema migrate), builds one ctrl object with
 * real durable helpers (applyRerunAt, gate withdraw, effects cancel) and no-op
 * execution adapters. Enough for applyRerunAt / run-state / policy helpers.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkspaceConfig } from "@okf-wiki/contract/workspace";
import {
  applyRerunAt,
  recordCommand as recordCommandImpl,
  requeueFailedNode as requeueFailedNodeImpl,
} from "../commands.js";
import type { ApplyRerunAtOptions, WikiRunsControl } from "../ctx.js";
import {
  cancelPreApplyEffects,
  cancelPreApplyEffectsForPublication,
} from "../publication-effect.js";
import {
  withdrawOpenGates,
  withdrawOpenGatesForNode,
} from "../gate-open.js";
import { resolveGate as resolveGateImpl } from "../gate-resolve.js";
import { configureOwner, migrate } from "../schema.js";
import { asRow, requiredNumber, requiredText, type SqlRow } from "../sql.js";
import type { ClaimedNode } from "../types.js";

export type ControlFixture = {
  root: string;
  db: DatabaseSync;
  workspace: WorkspaceConfig;
  ctrl: WikiRunsControl;
  /** Close db and remove temp root. */
  close(): Promise<void>;
};

/** Minimal workspace stub — pure control tests rarely need full sources/skill. */
export function fixtureWorkspace(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  const rootPath = overrides.rootPath ?? "/tmp/okf-control-fixture";
  return {
    version: 3,
    id: "ws-fixture",
    name: "Control fixture",
    rootPath,
    sources: [],
    model: { id: "fixture/model" },
    publicationPath: path.join(rootPath, "published"),
    orchestration: {
      maxActiveRuns: 2,
      maxConcurrentAttempts: 4,
    },
    limits: { retry: { enabled: true } },
    createdAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  } as WorkspaceConfig;
}

export type OpenControlFixtureOptions = {
  workspace?: Partial<WorkspaceConfig>;
  /** When true, skip EXCLUSIVE locking (shared :memory: / concurrent test helpers). */
  shared?: boolean;
};

/**
 * Open a temp-dir SQLite store + WikiRunsControl for control-plane unit tests.
 * Prefer this over casting partial host mocks.
 */
export async function openControlFixture(
  options: OpenControlFixtureOptions = {},
): Promise<ControlFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-control-"));
  const workspace = fixtureWorkspace({
    ...options.workspace,
    rootPath: options.workspace?.rootPath ?? root,
    publicationPath:
      options.workspace?.publicationPath ??
      path.join(options.workspace?.rootPath ?? root, "published"),
  });

  const dbPath = path.join(root, "control.sqlite");
  const db = new DatabaseSync(dbPath);
  if (!options.shared) {
    configureOwner(db);
  } else {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
  }
  migrate(db);

  const activeAttempts = new Map<string, AbortController>();
  const activeExecutions = new Map<string, Promise<void>>();
  let closed = false;

  const currentNodeGeneration = (runId: string, nodeKey: string): number | undefined => {
    const row = asRow(
      db
        .prepare(
          "SELECT MAX(generation) AS generation FROM nodes WHERE run_id = ? AND node_key = ?",
        )
        .get(runId, nodeKey),
    );
    if (!row || row.generation === null) return undefined;
    return requiredNumber(row, "generation");
  };

  const currentNodeRow = (runId: string, nodeKey: string): SqlRow | undefined => {
    const generation = currentNodeGeneration(runId, nodeKey);
    if (generation === undefined) return undefined;
    return asRow(
      db
        .prepare("SELECT * FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
        .get(runId, nodeKey, generation),
    );
  };

  const isCurrent = (claim: ClaimedNode): boolean => {
    const row = asRow(
      db
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
  };

  const emit = (_runId: string, _type: Parameters<WikiRunsControl["emit"]>[1]): number => {
    const current = asRow(db.prepare("SELECT revision FROM runs WHERE run_id = ?").get(_runId));
    if (!current) return 0;
    const revision = requiredNumber(current, "revision") + 1;
    db.prepare("UPDATE runs SET revision = ?, updated_at = ? WHERE run_id = ?").run(
      revision,
      new Date().toISOString(),
      _runId,
    );
    return revision;
  };

  const transaction = <T>(work: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw error;
    }
  };

  // Mutable shell then assign methods that close over `ctrl` (avoids self-ref inference issues).
  const ctrl = {} as WikiRunsControl;
  Object.assign(ctrl, {
    get workspace() {
      return workspace;
    },
    workspaceForRun: (_runId: string) => workspace,
    db,
    emit,
    transaction,
    isCurrent,
    currentNodeGeneration,
    get closed() {
      return closed;
    },
    piAttemptExecutor: undefined,
    activeAttempts,
    activeExecutions,
    currentNodeRow,
    applyRerunAt(
      runId: string,
      nodeKey: string,
      generation: number,
      feedback?: string,
      opts?: ApplyRerunAtOptions,
    ): void {
      applyRerunAt(ctrl, runId, nodeKey, generation, feedback, opts);
    },
    abortRunAttempts(runId: string): void {
      for (const [attemptId, controller] of activeAttempts) {
        const row = asRow(
          db.prepare("SELECT run_id FROM attempts WHERE attempt_id = ?").get(attemptId),
        );
        if (row && requiredText(row, "run_id") === runId) controller.abort();
      }
    },
    withdrawOpenGates(runId: string): void {
      withdrawOpenGates(ctrl, runId);
    },
    withdrawOpenGatesForNode(runId: string, nodeKey: string, generation: number): void {
      withdrawOpenGatesForNode(ctrl, runId, nodeKey, generation);
    },
    cancelPreApplyEffects(runId: string): void {
      cancelPreApplyEffects(ctrl, runId);
    },
    cancelPreApplyEffectsForPublication(
      runId: string,
      publicationNodeKey: string,
      publicationNodeGeneration: number,
    ): void {
      cancelPreApplyEffectsForPublication(
        ctrl,
        runId,
        publicationNodeKey,
        publicationNodeGeneration,
      );
    },
    resolveGate(
      command: Parameters<WikiRunsControl["resolveGate"]>[0],
      context: Parameters<WikiRunsControl["resolveGate"]>[1],
      payloadDigest: string,
    ) {
      return resolveGateImpl(ctrl, command, context, payloadDigest);
    },
    recordCommand(
      command: Parameters<WikiRunsControl["recordCommand"]>[0],
      context: Parameters<WikiRunsControl["recordCommand"]>[1],
      payloadDigest: string,
      runId: string,
      revision: number,
    ) {
      recordCommandImpl(ctrl, command, context, payloadDigest, runId, revision);
    },
    upstreamsSucceeded: () => true,
    upstreamSealedOutputs: () => [],
    copyAttemptInputs: () => undefined,
    bindAttemptInputs: () => undefined,
    executeFreeze: async () => undefined,
    executeMechanical: async () => ({
      type: "failed" as const,
      error: "control fixture has no mechanical executor",
      failureClass: "infrastructure" as const,
    }),
    prepareUnsealedArtifact: async () => undefined,
    sealPreparation: async () => undefined,
    preparePlanExecutionPlan: async () => undefined,
    commitSuccessfulAttempt: () => undefined,
    commitFailedAttemptArtifacts: () => undefined,
    orphanPreparedArtifacts: () => undefined,
    requeueFailedNode(
      runId: string,
      nodeKey: string,
      generation: number,
      lastAttemptId: string,
    ) {
      requeueFailedNodeImpl(ctrl, runId, nodeKey, generation, lastAttemptId);
    },
    trustedPinnedInputs: () => undefined,
    attemptInputDigest: () => "fixture-input-digest",
    runBoundary: async () => {
      throw new Error("control fixture has no runBoundary");
    },
    reconcileApplyingEffect: async () => undefined,
  } satisfies WikiRunsControl);

  return {
    root,
    db,
    workspace,
    ctrl,
    async close() {
      closed = true;
      try {
        db.close();
      } catch {
        // already closed
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    },
  };
}

/**
 * Partial control for pure policy helpers that only read db/workspace/closed.
 * Prefer openControlFixture when durable mutations (applyRerunAt) are exercised.
 */
export function partialControl(
  overrides: Partial<WikiRunsControl> &
    Pick<WikiRunsControl, "db" | "workspace"> & { closed?: boolean },
): WikiRunsControl {
  const workspace = overrides.workspace;
  return {
    workspace,
    workspaceForRun: overrides.workspaceForRun ?? (() => workspace),
    db: overrides.db,
    emit: overrides.emit ?? (() => 0),
    transaction: overrides.transaction ?? (<T>(work: () => T) => work()),
    isCurrent: overrides.isCurrent ?? (() => false),
    currentNodeGeneration: overrides.currentNodeGeneration ?? (() => undefined),
    closed: overrides.closed ?? false,
    activeAttempts: overrides.activeAttempts ?? new Map(),
    activeExecutions: overrides.activeExecutions ?? new Map(),
    currentNodeRow: overrides.currentNodeRow ?? (() => undefined),
    applyRerunAt: overrides.applyRerunAt ?? (() => undefined),
    abortRunAttempts: overrides.abortRunAttempts ?? (() => undefined),
    withdrawOpenGates: overrides.withdrawOpenGates ?? (() => undefined),
    withdrawOpenGatesForNode: overrides.withdrawOpenGatesForNode ?? (() => undefined),
    cancelPreApplyEffects: overrides.cancelPreApplyEffects ?? (() => undefined),
    cancelPreApplyEffectsForPublication:
      overrides.cancelPreApplyEffectsForPublication ?? (() => undefined),
    resolveGate:
      overrides.resolveGate ??
      (() => {
        throw new Error("resolveGate not stubbed");
      }),
    recordCommand: overrides.recordCommand ?? (() => undefined),
    upstreamsSucceeded: overrides.upstreamsSucceeded ?? (() => true),
    upstreamSealedOutputs: overrides.upstreamSealedOutputs ?? (() => []),
    copyAttemptInputs: overrides.copyAttemptInputs ?? (() => undefined),
    bindAttemptInputs: overrides.bindAttemptInputs ?? (() => undefined),
    executeFreeze: overrides.executeFreeze ?? (async () => undefined),
    executeMechanical:
      overrides.executeMechanical ??
      (async () => ({
        type: "failed" as const,
        error: "not stubbed",
        failureClass: "infrastructure" as const,
      })),
    prepareUnsealedArtifact: overrides.prepareUnsealedArtifact ?? (async () => undefined),
    sealPreparation: overrides.sealPreparation ?? (async () => undefined),
    preparePlanExecutionPlan: overrides.preparePlanExecutionPlan ?? (async () => undefined),
    commitSuccessfulAttempt: overrides.commitSuccessfulAttempt ?? (() => undefined),
    commitFailedAttemptArtifacts: overrides.commitFailedAttemptArtifacts ?? (() => undefined),
    orphanPreparedArtifacts: overrides.orphanPreparedArtifacts ?? (() => undefined),
    requeueFailedNode: overrides.requeueFailedNode ?? (() => undefined),
    trustedPinnedInputs: overrides.trustedPinnedInputs ?? (() => undefined),
    attemptInputDigest: overrides.attemptInputDigest ?? (() => "stub"),
    runBoundary:
      overrides.runBoundary ??
      (async () => {
        throw new Error("runBoundary not stubbed");
      }),
    reconcileApplyingEffect: overrides.reconcileApplyingEffect ?? (async () => undefined),
    piAttemptExecutor: overrides.piAttemptExecutor,
  };
}
