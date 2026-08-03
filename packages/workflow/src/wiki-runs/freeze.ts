/**
 * Freeze execution (run boundary pin, seal, commit).
 * Owner binds db/workspace/transaction/emit — freeze stays free of WikiRunsOwner.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  contractForNode,
  FrozenRunManifestSchema,
  RepositorySnapshotSchema,
  RunIntentSchema,
  validateNodeOutputs,
  WorkspaceConfigSchema,
} from "@okf-wiki/contract";
import {
  buildBoundaryIndex,
  buildCoverageInventory,
  buildCoveragePlan,
  type FreezeRunBoundaryInput,
  type FrozenRunBoundary,
  listPublishedWikiPages,
  PublishedWikiError,
  runWorkDir,
} from "@okf-wiki/core";
import {
  BOUNDARY_INDEX_FILE,
  COVERAGE_INVENTORY_FILE,
  COVERAGE_PLAN_FILE,
} from "./coverage-bridge.js";
import {
  graphRoleForNodeKind,
  mergeAttemptMetrics,
  metricsOf,
  wallTimeMsFromStarted,
  writeAttemptMetrics,
} from "./attempt-metrics.js";
import { artifactId, digest, now } from "./crypto-util.js";
import type { WikiRunsCasCtx } from "./ctx.js";
import { makeOwnedTreeWritable, manifestFor } from "./fs-util.js";
import { asRow, asRows, parseJson, requiredText, type SqlRow } from "./sql.js";
import { writeConversationTranscript } from "./transcript-io.js";
import type {
  ArtifactPreparation,
  ClaimedFreeze,
  PreparedFreeze,
  PreparedFreezeArtifacts,
  TrustedFrozenInputs,
} from "./types.js";

export type FreezeHost = WikiRunsCasCtx & {
  closed: boolean;
  activeAttempts: Map<string, AbortController>;
  runBoundary(input: FreezeRunBoundaryInput): Promise<FrozenRunBoundary>;
  sealPreparation(runId: string, preparation: ArtifactPreparation): Promise<void>;
  trustedPinnedInputs(runId: string): TrustedFrozenInputs | undefined;
  orphanPreparedArtifacts(attemptId: string): void;
};

/**
 * Minimal surface for freeze CAS commit / recovery.
 * Intentionally excludes piAttemptExecutor, runBoundary, activeAttempts, seal, orphan —
 * those are execute-path only; prepared-artifact recovery must not pull them in.
 */
export type FreezeCommitHost = Pick<FreezeHost, "db" | "isCurrent" | "emit">;

export async function executeFreeze(host: FreezeHost, claim: ClaimedFreeze): Promise<void> {
  const controller = new AbortController();
  host.activeAttempts.set(claim.attemptId, controller);
  let materialized = false;
  try {
    const prepared = prepareFreeze(host, claim);
    if (prepared.reusePinned) {
      // Post-pin retry: reuse immutable pinned inputs and already-sealed artifacts.
      await executePinnedFreezeRetry(host, claim, controller.signal);
      return;
    }
    await clearUnpinnedFreezeWork(host, claim.runId);
    if (host.closed || !host.isCurrent(claim)) return;
    const frozen = await host.runBoundary({
      workspace: prepared.workspace,
      runId: claim.runId,
      signal: controller.signal,
    });
    materialized = true;
    const frozenInputs: TrustedFrozenInputs = {
      skillDigest: frozen.skillDigest,
      sources: frozen.sources.map(({ path: _path, ...source }) => source),
    };
    if (!host.transaction(() => recordTrustedFrozenInputs(host, claim, frozenInputs))) return;
    if (host.closed || !host.isCurrent(claim)) return;
    const workDir = path.join(frozen.runWorkDir, "attempts", claim.attemptId, "work");
    const sessionPath = path.join(frozen.runWorkDir, "attempts", claim.attemptId, "session.jsonl");
    await mkdir(workDir, { recursive: true });
    const sourceSummaries = frozen.sources.map(({ path: _path, ...source }) => source);
    await writeFile(
      path.join(workDir, "freeze-inputs.json"),
      `${JSON.stringify({
        skillDigest: frozen.skillDigest,
        sources: sourceSummaries,
      })}\n`,
      "utf8",
    );
    // Phase 1: seal FrozenRunManifest (intent + mode + digests) for plan/handler.
    const intent = loadRunIntent(host, claim.runId);
    const intentDigest = digest(intent);
    const frozenManifest = FrozenRunManifestSchema.parse({
      version: 2,
      intent,
      mode: intent.mode,
      intentDigest,
      skillDigest: frozen.skillDigest,
      sources: sourceSummaries.map((s) => ({
        id: s.id,
        ...(typeof s.revision === "string" ? { revision: s.revision } : {}),
      })),
    });
    const manifestDir = path.join(workDir, "frozen_run_manifest");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      path.join(manifestDir, "frozen-run-manifest.json"),
      `${JSON.stringify(frozenManifest, null, 2)}\n`,
      "utf8",
    );
    // Phase 2 refresh: freeze the current published wiki as prior_wiki (fail closed).
    const priorWikiCandidates: Array<{
      directory: string;
      kind: ArtifactPreparation["kind"];
      role: string;
    }> = [];
    if (intent.mode === "refresh") {
      const publicationPath = prepared.workspace.publicationPath;
      try {
        await listPublishedWikiPages(publicationPath);
      } catch (error) {
        if (error instanceof PublishedWikiError) {
          throw new Error(
            `refresh mode requires a non-empty published wiki at publicationPath ` +
              `(${publicationPath}): ${error.message}`,
          );
        }
        throw error;
      }
      priorWikiCandidates.push({
        directory: publicationPath,
        kind: "wiki_tree",
        role: "prior_wiki",
      });
    }

    // ADR 0040: seal CoverageInventory + CoveragePlan + BoundaryIndex from frozen mounts.
    const coverageCandidates = await materializeCoverageArtifacts(host, claim, frozen, workDir);
    if (coverageCandidates === null) return;

    const inputArtifacts = await prepareFreezeArtifacts(host, claim, [
      {
        directory: path.join(frozen.runWorkDir, "sources"),
        kind: "snapshot_set",
        role: "sources",
      },
      { directory: frozen.skillPath, kind: "skill", role: "skill" },
      {
        directory: manifestDir,
        kind: "manifest",
        role: "frozen_run_manifest",
      },
      ...priorWikiCandidates,
      ...coverageCandidates,
    ]);
    if (!inputArtifacts) return;
    for (const preparation of inputArtifacts.preparations)
      await host.sealPreparation(claim.runId, preparation);
    if (host.closed || !host.isCurrent(claim)) return;
    await writeConversationTranscript({
      sessionPath,
      nodeKey: "freeze",
      summary: "Freeze inputs sealed by WikiRuns",
      meta: { mode: "freeze_boundary" },
    });
    if (host.closed || !host.isCurrent(claim)) return;
    const outputArtifacts = await prepareFreezeArtifacts(host, claim, [
      { directory: workDir, kind: "manifest", role: "attempt_output" },
    ]);
    if (!outputArtifacts) return;
    for (const preparation of outputArtifacts.preparations)
      await host.sealPreparation(claim.runId, preparation);
    // Live session.jsonl is enough for GET transcript (readAttemptTranscript).
    // Do not seal transcript as a freeze node_output — recovery would re-bind it
    // into freeze outputs and pollute child attempt_inputs.
    if (host.closed || !host.isCurrent(claim)) return;
    host.transaction(() =>
      commitFreezeArtifacts(host, claim, [
        ...inputArtifacts.preparations,
        ...outputArtifacts.preparations,
      ]),
    );
  } catch (error) {
    if (host.closed) return;
    const message = error instanceof Error ? error.message.slice(0, 4_000) : "freeze failed";
    await writeConversationTranscript({
      sessionPath: path.join(
        runWorkDir(host.workspace.rootPath, claim.runId),
        "attempts",
        claim.attemptId,
        "session.jsonl",
      ),
      nodeKey: "freeze",
      summary: `Error: ${message}`,
      preserveExisting: true,
      meta: { mode: "failed", error: message },
    }).catch(() => undefined);
    host.transaction(() => failFreeze(host, claim, error));
  } finally {
    host.activeAttempts.delete(claim.attemptId);
    if (materialized) {
      host.transaction(() => host.orphanPreparedArtifacts(claim.attemptId));
      await clearUnpinnedFreezeWork(host, claim.runId);
    }
  }
}

/**
 * Post-pin freeze retry: do not re-resolve live Git/Skill selectors.
 * Re-seal attempt_output from pinned inputs and recommit node outputs.
 */
export async function executePinnedFreezeRetry(
  host: FreezeHost,
  claim: ClaimedFreeze,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (signal.aborted || host.closed || !host.isCurrent(claim)) return;
    const inputs = host.trustedPinnedInputs(claim.runId);
    if (!inputs) throw new Error("pinned freeze inputs are missing for retry");
    const runDir = runWorkDir(host.workspace.rootPath, claim.runId);
    const prior = asRows(
      host.db
        .prepare(
          `SELECT node_outputs.role, artifacts.relative_path, artifacts.kind, artifacts.digest, artifacts.artifact_id
           FROM node_outputs
           JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
           WHERE node_outputs.run_id = ?
             AND node_outputs.node_key = 'freeze'
             AND node_outputs.role IN (
               'sources', 'skill', 'frozen_run_manifest', 'prior_wiki',
               'coverage_inventory', 'coverage_plan', 'boundary_index'
             )
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
    const intentForPin = loadRunIntent(host, claim.runId);
    if (intentForPin.mode === "refresh" && !byRole.get("prior_wiki")) {
      throw new Error(
        "pinned freeze retry in refresh mode is missing sealed prior_wiki; start a new run",
      );
    }

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
    const intent = loadRunIntent(host, claim.runId);
    const intentDigest = digest(intent);
    const frozenManifest = FrozenRunManifestSchema.parse({
      version: 2,
      intent,
      mode: intent.mode,
      intentDigest,
      skillDigest: inputs.skillDigest,
      sources: (inputs.sources as Array<{ id: string; revision?: string }>).map((s) => ({
        id: s.id,
        ...(typeof s.revision === "string" ? { revision: s.revision } : {}),
      })),
    });
    const manifestDir = path.join(workDir, "frozen_run_manifest");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      path.join(manifestDir, "frozen-run-manifest.json"),
      `${JSON.stringify(frozenManifest, null, 2)}\n`,
      "utf8",
    );
    // Prefer already-sealed frozen_run_manifest when present on a prior freeze generation.
    const priorManifest = byRole.get("frozen_run_manifest");
    if (host.closed || !host.isCurrent(claim)) return;
    // Re-seal frozen_run_manifest when prior freeze lacked it (pre-Phase-1 pin).
    let manifestPrep: ArtifactPreparation | undefined;
    if (priorManifest) {
      manifestPrep = {
        artifactId: requiredText(priorManifest, "artifact_id"),
        digest: requiredText(priorManifest, "digest"),
        kind: requiredText(priorManifest, "kind") as ArtifactPreparation["kind"],
        preparationId: randomUUID(),
        relativePath: requiredText(priorManifest, "relative_path"),
        role: requiredText(priorManifest, "role"),
        sourceDirectory: "",
      };
    } else {
      const freshManifest = await prepareFreezeArtifacts(host, claim, [
        { directory: manifestDir, kind: "manifest", role: "frozen_run_manifest" },
      ]);
      if (!freshManifest) return;
      for (const preparation of freshManifest.preparations)
        await host.sealPreparation(claim.runId, preparation);
      manifestPrep = freshManifest.preparations[0];
    }
    const outputArtifacts = await prepareFreezeArtifacts(host, claim, [
      { directory: workDir, kind: "manifest", role: "attempt_output" },
    ]);
    if (!outputArtifacts) return;
    for (const preparation of outputArtifacts.preparations)
      await host.sealPreparation(claim.runId, preparation);
    if (host.closed || !host.isCurrent(claim)) return;
    const priorWikiPinned = byRole.get("prior_wiki");
    const optionalPinnedRoles = [
      priorWikiPinned,
      byRole.get("coverage_inventory"),
      byRole.get("coverage_plan"),
      byRole.get("boundary_index"),
    ].filter((row): row is SqlRow => row !== undefined);
    const inputPreparations: ArtifactPreparation[] = [
      ...[sources, skill, ...optionalPinnedRoles].map((row) => ({
        artifactId: requiredText(row, "artifact_id"),
        digest: requiredText(row, "digest"),
        kind: requiredText(row, "kind") as ArtifactPreparation["kind"],
        preparationId: randomUUID(),
        relativePath: requiredText(row, "relative_path"),
        role: requiredText(row, "role"),
        sourceDirectory: "",
      })),
      ...(manifestPrep ? [manifestPrep] : []),
    ];
    // Reuse already-sealed input artifacts; only the new attempt_output needs commit prep rows.
    host.transaction(() => {
      for (const preparation of inputPreparations) {
        host.db
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
      commitFreezeArtifacts(host, claim, [...inputPreparations, ...outputArtifacts.preparations]);
    });
  } catch (error) {
    if (host.closed) return;
    host.transaction(() => failFreeze(host, claim, error));
  } finally {
    host.activeAttempts.delete(claim.attemptId);
    host.transaction(() => host.orphanPreparedArtifacts(claim.attemptId));
  }
}

export function trustedFrozenInputs(
  host: Pick<FreezeHost, "db">,
  runId: string,
): TrustedFrozenInputs | undefined {
  const run = asRow(
    host.db
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

export function commitFreezeArtifacts(
  host: FreezeCommitHost,
  claim: ClaimedFreeze,
  preparations: ArtifactPreparation[],
): void {
  if (!host.isCurrent(claim)) {
    host.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(claim.attemptId);
    return;
  }
  const inputs = trustedFrozenInputs(host, claim.runId);
  if (!inputs) throw new Error("freeze inputs were not durably recorded");
  const outputs = preparations.map((preparation) => ({
    role: preparation.role,
    kind: preparation.kind,
  }));
  validateNodeOutputs(contractForNode("freeze", "freeze"), outputs);
  if (
    loadRunIntent(host, claim.runId).mode === "refresh" &&
    !outputs.some((output) => output.role === "prior_wiki" && output.kind === "wiki_tree")
  ) {
    throw new Error("refresh freeze is missing declared prior_wiki output");
  }
  const timestamp = now();
  for (const preparation of preparations) {
    host.db
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
    host.db
      .prepare(
        `INSERT INTO node_outputs (run_id, node_key, node_generation, role, artifact_id)
         VALUES (?, 'freeze', ?, ?, ?)
         ON CONFLICT(run_id, node_key, node_generation, role) DO NOTHING`,
      )
      .run(claim.runId, claim.nodeGeneration, preparation.role, preparation.artifactId);
  }
  const pinnedDigest = digest(inputs);
  host.db
    .prepare(
      `UPDATE runs SET pinned_sources_json = ?, skill_digest = ?, pinned_digest = ?, updated_at = ?
       WHERE run_id = ? AND cancel_requested = 0`,
    )
    .run(JSON.stringify(inputs.sources), inputs.skillDigest, pinnedDigest, timestamp, claim.runId);
  host.emit(claim.runId, "inputs.pinned");
  host.db
    .prepare(
      "UPDATE attempts SET state = 'succeeded', ended_at = ? WHERE attempt_id = ? AND state = 'running'",
    )
    .run(timestamp, claim.attemptId);
  writeAttemptMetrics(
    host.db,
    claim.attemptId,
    mergeAttemptMetrics(undefined, {
      role: graphRoleForNodeKind("freeze"),
      wallTimeMs: wallTimeMsFromStarted(host.db, claim.attemptId, timestamp),
      stopReason: "succeeded",
    }),
  );
  host.db
    .prepare(
      `UPDATE nodes SET state = 'succeeded', current_attempt_id = NULL
       WHERE run_id = ? AND node_key = 'freeze' AND generation = ? AND current_attempt_id = ?`,
    )
    .run(claim.runId, claim.nodeGeneration, claim.attemptId);
  host.db
    .prepare(
      "UPDATE artifact_preparations SET state = 'committed' WHERE attempt_id = ? AND state = 'prepared'",
    )
    .run(claim.attemptId);
  host.emit(claim.runId, "attempt.succeeded");
  // Advance freeze → plan: plan is ready for claim; run stays active (not terminal).
  const existingPlan = asRow(
    host.db
      .prepare(
        "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = 'plan' AND generation = 0",
      )
      .get(claim.runId),
  );
  if (!existingPlan) {
    contractForNode("plan", "plan");
    host.db
      .prepare(
        `INSERT INTO nodes (
          run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
        ) VALUES (?, 'plan', 'plan', 'ready', 0, NULL, NULL, NULL)`,
      )
      .run(claim.runId);
  } else {
    host.db
      .prepare(
        `UPDATE nodes SET state = 'ready', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = 'plan' AND generation = 0
           AND state IN ('blocked', 'invalidated', 'failed')`,
      )
      .run(claim.runId);
  }
  // This bootstrap dependency used to exist only in unlockReadyNodes. Persist
  // it so the operator snapshot remains the complete, actual DAG.
  host.db
    .prepare(
      `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, 'freeze', 'plan')
       ON CONFLICT(run_id, from_key, to_key) DO NOTHING`,
    )
    .run(claim.runId);
  host.db
    .prepare(
      "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(timestamp, claim.runId);
  host.emit(claim.runId, "node.ready");
}

export function failFreeze(host: FreezeHost, claim: ClaimedFreeze, error: unknown): void {
  if (!host.isCurrent(claim)) return;
  const timestamp = now();
  const message = error instanceof Error ? error.message.slice(0, 4_000) : "freeze failed";
  host.db
    .prepare(
      "UPDATE attempts SET state = 'failed', error = ?, ended_at = ? WHERE attempt_id = ? AND state = 'running'",
    )
    .run(message, timestamp, claim.attemptId);
  writeAttemptMetrics(
    host.db,
    claim.attemptId,
    mergeAttemptMetrics(metricsOf(error), {
      role: graphRoleForNodeKind("freeze"),
      wallTimeMs: wallTimeMsFromStarted(host.db, claim.attemptId, timestamp),
      stopReason: "failed",
    }),
  );
  host.db
    .prepare(
      `UPDATE nodes SET state = 'failed', current_attempt_id = NULL
       WHERE run_id = ? AND node_key = 'freeze' AND generation = ? AND current_attempt_id = ?`,
    )
    .run(claim.runId, claim.nodeGeneration, claim.attemptId);
  host.db
    .prepare(
      "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
    )
    .run(claim.attemptId);
  host.db
    .prepare("UPDATE runs SET state = 'failed', updated_at = ? WHERE run_id = ?")
    .run(timestamp, claim.runId);
  host.emit(claim.runId, "attempt.failed");
}

/**
 * Freeze reads the StartRun snapshot, never mutable workspace.json.
 * Post-pin retry reuses immutable pinned inputs (does not re-resolve live selectors).
 */
export function prepareFreeze(
  host: Pick<FreezeHost, "db">,
  claim: ClaimedFreeze,
): PreparedFreeze & { reusePinned: boolean } {
  const run = asRow(
    host.db
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
export async function clearUnpinnedFreezeWork(
  host: Pick<FreezeHost, "db" | "workspace">,
  runId: string,
): Promise<void> {
  const run = asRow(host.db.prepare("SELECT pinned_digest FROM runs WHERE run_id = ?").get(runId));
  if (!run) throw new Error(`run not found: ${runId}`);
  if (run.pinned_digest !== null) return;
  const work = runWorkDir(host.workspace.rootPath, runId);
  await makeOwnedTreeWritable(work);
  await rm(work, { recursive: true, force: true });
}

/** Inputs are trusted only after the Run Boundary returns, never from Pi output. */
export function recordTrustedFrozenInputs(
  host: FreezeHost,
  claim: ClaimedFreeze,
  inputs: TrustedFrozenInputs,
): boolean {
  const sources = RepositorySnapshotSchema.array().min(1).parse(inputs.sources);
  if (!host.isCurrent(claim)) return false;
  host.db
    .prepare(
      `UPDATE runs SET frozen_sources_json = ?, frozen_skill_digest = ?, updated_at = ?
       WHERE run_id = ? AND pinned_digest IS NULL`,
    )
    .run(JSON.stringify(sources), inputs.skillDigest, now(), claim.runId);
  return true;
}

export async function prepareFreezeArtifacts(
  host: FreezeHost,
  claim: ClaimedFreeze,
  candidates: Array<{
    directory: string;
    kind: ArtifactPreparation["kind"];
    role: string;
  }>,
): Promise<PreparedFreezeArtifacts | undefined> {
  const preparations = await Promise.all(
    candidates.map(async (candidate) => {
      // Content-only: ignore seal sidecar if a candidate tree was re-staged from a
      // previously sealed artifact (same contract as prepareUnsealedArtifact/verify).
      const manifest = await manifestFor(candidate.directory, true);
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
  return host.transaction(() => {
    if (!host.isCurrent(claim)) return undefined;
    for (const preparation of preparations) {
      host.db
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

/** Load the intent sealed when StartRun was accepted. */
export function loadRunIntent(
  host: Pick<FreezeHost, "db">,
  runId: string,
): ReturnType<typeof RunIntentSchema.parse> {
  const run = asRow(host.db.prepare("SELECT intent_json FROM runs WHERE run_id = ?").get(runId));
  if (!run || run.intent_json == null || run.intent_json === "") {
    throw new Error(`run ${runId} has no sealed intent`);
  }
  return RunIntentSchema.parse(parseJson<unknown>(String(run.intent_json)));
}

/**
 * Build and stage sealed CoverageInventory / CoveragePlan / BoundaryIndex under
 * freeze attempt work. Returns artifact candidates (empty array when sources empty —
 * should not happen after freezeRunBoundary). Returns null when claim is stale.
 */
async function materializeCoverageArtifacts(
  host: FreezeHost,
  claim: ClaimedFreeze,
  frozen: FrozenRunBoundary,
  workDir: string,
): Promise<
  | Array<{
      directory: string;
      kind: ArtifactPreparation["kind"];
      role: string;
    }>
  | null
> {
  if (host.closed || !host.isCurrent(claim)) return null;

  const inventorySources = frozen.sources.map((source) => ({
    id: source.id,
    path:
      frozen.sourcePathMap.get(source.id) ??
      source.path ??
      path.join(frozen.runWorkDir, "sources", source.id),
    effectiveIgnores: [
      ...(frozen.sourceIgnores.get(source.id) ?? source.effectiveIgnores ?? []),
    ],
  }));

  const orch = host.workspaceForRun(claim.runId).orchestration;
  const maxSurfacesRequired = orch?.maxSurfacesRequired ?? 12;
  const signal = host.activeAttempts.get(claim.attemptId)?.signal;
  const sourceCount = frozen.sources.length;
  const mustHaveCoverage =
    sourceCount >= 2 ||
    orch?.requireSourceCoverage === true ||
    orch?.requireSurfaceCoverage === true;

  let inventory: Awaited<ReturnType<typeof buildCoverageInventory>>;
  let coveragePlan: ReturnType<typeof buildCoveragePlan>;
  let boundaryIndex: Awaited<ReturnType<typeof buildBoundaryIndex>>;
  try {
    inventory = await buildCoverageInventory(inventorySources, { signal });
    coveragePlan = buildCoveragePlan(inventory, { maxSurfacesRequired });
    boundaryIndex = await buildBoundaryIndex(inventorySources, { signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (mustHaveCoverage) {
      throw new Error(
        `freeze coverage inventory/plan failed for multi-source or coverage-required run ` +
          `(sourceCount=${sourceCount}): ${detail}`,
      );
    }
    throw error;
  }

  // Fail-closed: multi-source (or explicit require flags) must not seal an empty
  // requiredUnits plan — plan claim / assertCoverage would otherwise soft-skip.
  if (mustHaveCoverage && coveragePlan.requiredUnits.length === 0) {
    throw new Error(
      `freeze coverage plan has empty requiredUnits for multi-source or coverage-required run ` +
        `(sourceCount=${sourceCount}); inventory/plan build incomplete`,
    );
  }

  // Also write under run analysis/ for operator/plan soft reads (not sealed identity).
  const analysisDir = path.join(frozen.runWorkDir, "analysis");
  await mkdir(analysisDir, { recursive: true });
  await writeFile(
    path.join(analysisDir, COVERAGE_INVENTORY_FILE),
    `${JSON.stringify(inventory, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(analysisDir, COVERAGE_PLAN_FILE),
    `${JSON.stringify(coveragePlan, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(analysisDir, BOUNDARY_INDEX_FILE),
    `${JSON.stringify(boundaryIndex, null, 2)}\n`,
    "utf8",
  );

  const inventoryDir = path.join(workDir, "coverage_inventory");
  const planDir = path.join(workDir, "coverage_plan");
  const boundaryDir = path.join(workDir, "boundary_index");
  await mkdir(inventoryDir, { recursive: true });
  await mkdir(planDir, { recursive: true });
  await mkdir(boundaryDir, { recursive: true });
  await writeFile(
    path.join(inventoryDir, COVERAGE_INVENTORY_FILE),
    `${JSON.stringify(inventory, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(planDir, COVERAGE_PLAN_FILE),
    `${JSON.stringify(coveragePlan, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(boundaryDir, BOUNDARY_INDEX_FILE),
    `${JSON.stringify(boundaryIndex, null, 2)}\n`,
    "utf8",
  );

  if (host.closed || !host.isCurrent(claim)) return null;
  return [
    { directory: inventoryDir, kind: "receipt", role: "coverage_inventory" },
    { directory: planDir, kind: "receipt", role: "coverage_plan" },
    { directory: boundaryDir, kind: "receipt", role: "boundary_index" },
  ];
}
