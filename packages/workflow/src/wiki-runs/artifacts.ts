/**
 * Artifact prepare / seal / commit / recovery and attempt input binding.
 * Owner binds db/workspace/transaction/emit — artifacts stay free of WikiRunsOwner.
 */

import { randomUUID } from "node:crypto";
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
import type { DatabaseSync } from "node:sqlite";
import type {
  PiAttemptArtifactDescriptor,
  WikiRunEvent,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import { runWorkDir } from "@okf-wiki/core";
import { artifactId, digest, now } from "./crypto-util.js";
import { commitFreezeArtifacts, type FreezeCommitHost, trustedFrozenInputs } from "./freeze.js";
import { durableFsyncPath, manifestFor } from "./fs-util.js";
import { materializeDefinitionV1Graph, upstreamKeys } from "./gates.js";
import { asRow, asRows, requiredNumber, requiredText, type SqlRow } from "./sql.js";
import type { ArtifactPreparation, ClaimedFreeze, ClaimedNode } from "./types.js";

export type ArtifactsHost = {
  workspace: WorkspaceConfig;
  db: DatabaseSync;
  transaction<T>(work: () => T): T;
  emit(runId: string, type: WikiRunEvent["type"]): number;
  isCurrent(claim: ClaimedNode): boolean;
  currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
  /** Bound from gates — commitNodeArtifacts opens plan/publication gates. */
  openPlanGate(claim: ClaimedNode, specPayloadDigest: string, timestamp: string): void;
  openPublicationGate(
    claim: ClaimedNode,
    candidate: ArtifactPreparation,
    expectedLiveDigest: string,
    timestamp: string,
  ): void;
  readPublicationBaseline(runId: string, preparations: ArtifactPreparation[]): string;
  unlockReadyNodes(runId: string): void;
};

/** ArtifactsHost already carries the freeze commit surface (db / isCurrent / emit). */
function freezeCommitHost(host: ArtifactsHost): FreezeCommitHost {
  return {
    db: host.db,
    isCurrent: (claim) => host.isCurrent(claim),
    emit: (runId, type) => host.emit(runId, type),
  };
}

function orphanPreparedGroup(host: ArtifactsHost, attemptId: string): void {
  host.transaction(() =>
    host.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(attemptId),
  );
}

/**
 * ADR 0035 recovery: replay only prepared, verified artifacts whose Attempt is
 * still current (`isCurrent` inside commit). Route by preparation `node_key`:
 * freeze → `commitFreezeArtifacts` (needs frozen_* inputs + attempt_output);
 * all other nodes → `commitNodeArtifacts` (plan/publication gates included).
 * Invalid seals or missing claim material orphan the group.
 */
export async function recoverPreparedArtifacts(host: ArtifactsHost): Promise<void> {
  const rows = asRows(
    host.db
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
    const nodeKey = requiredText(first, "node_key");
    const nodeGeneration = requiredNumber(first, "node_generation");
    const valid = await Promise.all(
      preparations.map((preparation) =>
        verifyArtifact(
          path.join(
            runWorkDir(host.workspace.rootPath, runId),
            requiredText(preparation, "relative_path"),
          ),
          requiredText(preparation, "manifest_digest"),
        ),
      ),
    );
    if (!valid.every(Boolean)) {
      orphanPreparedGroup(host, attemptId);
      continue;
    }
    const prepared: ArtifactPreparation[] = preparations.map((preparation) => ({
      artifactId: requiredText(preparation, "artifact_id"),
      digest: requiredText(preparation, "manifest_digest"),
      kind: requiredText(preparation, "kind") as ArtifactPreparation["kind"],
      preparationId: requiredText(preparation, "preparation_id"),
      relativePath: requiredText(preparation, "relative_path"),
      role: requiredText(preparation, "role"),
      sourceDirectory: "",
    }));

    if (nodeKey === "freeze") {
      // Freeze commit also pins frozen_* → pinned_*; require attempt_output + durable freeze inputs.
      const output = preparations.find(
        (preparation) => requiredText(preparation, "role") === "attempt_output",
      );
      if (!output) {
        orphanPreparedGroup(host, attemptId);
        continue;
      }
      const inputs = trustedFrozenInputs({ db: host.db }, runId);
      if (!inputs) {
        orphanPreparedGroup(host, attemptId);
        continue;
      }
      const claim: ClaimedFreeze = {
        attemptId,
        nodeGeneration,
        nodeKey: "freeze",
        kind: "freeze",
        runId,
      };
      host.transaction(() => commitFreezeArtifacts(freezeCommitHost(host), claim, prepared));
      continue;
    }

    // Non-freeze prepared groups: rebuild claim from the node row and commit via
    // the same CAS path as live execution. commitNodeArtifacts re-checks isCurrent
    // and orphans if the attempt is no longer the running current attempt.
    const node = asRow(
      host.db
        .prepare(
          "SELECT kind FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
        )
        .get(runId, nodeKey, nodeGeneration),
    );
    if (!node) {
      orphanPreparedGroup(host, attemptId);
      continue;
    }
    const claim: ClaimedNode = {
      attemptId,
      nodeGeneration,
      nodeKey,
      kind: requiredText(node, "kind"),
      runId,
    };
    host.transaction(() => commitNodeArtifacts(host, claim, prepared));
  }
}

export function copyAttemptInputs(
  host: Pick<ArtifactsHost, "db">,
  attemptId: string,
  inputs: Array<{ role: string; artifactId: string }>,
): void {
  for (const input of inputs) {
    host.db
      .prepare(
        `INSERT INTO attempt_inputs (attempt_id, role, artifact_id) VALUES (?, ?, ?)
         ON CONFLICT(attempt_id, role) DO NOTHING`,
      )
      .run(attemptId, input.role, input.artifactId);
  }
}

/**
 * In the claim transaction, freeze current-generation upstream outputs into
 * immutable attempt_inputs. Also bind ambient freeze sources/skill and plan
 * spec for post-plan nodes so each Attempt has a complete sealed envelope.
 */
export function bindAttemptInputs(
  host: Pick<ArtifactsHost, "db" | "currentNodeGeneration">,
  attemptId: string,
  runId: string,
  nodeKey: string,
): void {
  for (const input of upstreamSealedOutputs(host, runId, nodeKey)) {
    host.db
      .prepare(
        `INSERT INTO attempt_inputs (attempt_id, role, artifact_id) VALUES (?, ?, ?)
         ON CONFLICT(attempt_id, role) DO NOTHING`,
      )
      .run(attemptId, input.role, input.artifactId);
  }
}

/** Succeeded node outputs at a fixed generation (not necessarily current max). */
export function nodeOutputsAtGeneration(
  host: Pick<ArtifactsHost, "db">,
  runId: string,
  nodeKey: string,
  generation: number,
): Array<{ role: string; artifactId: string }> {
  const node = asRow(
    host.db
      .prepare("SELECT state FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
      .get(runId, nodeKey, generation),
  );
  if (!node || requiredText(node, "state") !== "succeeded") return [];
  return asRows(
    host.db
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

export function nodeOutputsAtCurrentGen(
  host: Pick<ArtifactsHost, "db" | "currentNodeGeneration">,
  runId: string,
  nodeKey: string,
): Array<{ role: string; artifactId: string }> {
  const generation = host.currentNodeGeneration(runId, nodeKey);
  if (generation === undefined) return [];
  return nodeOutputsAtGeneration(host, runId, nodeKey, generation);
}

/**
 * Whether write.root's current generation carries repair feedback (operator or
 * auto hard-validate) so we should bind a prior wiki_tree for repair mode.
 */
function writeRootNeedsPriorWiki(
  host: Pick<ArtifactsHost, "db" | "currentNodeGeneration">,
  runId: string,
  generation: number,
): boolean {
  if (generation > 0) return true;
  const row = asRow(
    host.db
      .prepare(
        "SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
      )
      .get(runId, "write.root", generation),
  );
  if (!row || row.detail_json == null || row.detail_json === "") return false;
  try {
    const parsed = JSON.parse(String(row.detail_json)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const feedback = (parsed as Record<string, unknown>).feedback;
    return typeof feedback === "string" && feedback.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Latest succeeded prior write.root / repair wiki_tree for repair reruns.
 * Walks write.root generations below `generation`, then repair current gen.
 */
function priorWriteWikiTree(
  host: Pick<ArtifactsHost, "db" | "currentNodeGeneration">,
  runId: string,
  generation: number,
): { role: string; artifactId: string } | undefined {
  for (let g = generation - 1; g >= 0; g -= 1) {
    for (const output of nodeOutputsAtGeneration(host, runId, "write.root", g)) {
      if (output.role === "wiki_tree") return output;
    }
  }
  for (const output of nodeOutputsAtCurrentGen(host, runId, "repair")) {
    if (output.role === "wiki_tree") return output;
  }
  return undefined;
}

export function upstreamSealedOutputs(
  host: Pick<ArtifactsHost, "db" | "currentNodeGeneration">,
  runId: string,
  nodeKey: string,
): Array<{ role: string; artifactId: string }> {
  if (nodeKey === "freeze") return [];

  const byRole = new Map<string, string>();
  const add = (role: string, artifactId: string) => {
    if (!byRole.has(role)) byRole.set(role, artifactId);
  };

  // Ambient freeze + plan pins for every post-freeze node (well-known roles only).
  for (const output of nodeOutputsAtCurrentGen(host, runId, "freeze")) {
    if (output.role === "sources" || output.role === "skill") {
      add(output.role, output.artifactId);
    }
  }
  if (nodeKey !== "plan") {
    for (const output of nodeOutputsAtCurrentGen(host, runId, "plan")) {
      if (output.role === "spec") add(output.role, output.artifactId);
    }
  }

  const edgeUps = upstreamKeys(host, runId, nodeKey);
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
    for (const output of nodeOutputsAtCurrentGen(host, runId, fromKey)) {
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
  // Prefer refined trees (repair.hv / validate) over the original write.root so
  // auto hard-validate repair is not lost when seats do not re-emit wiki_tree.
  if (!byRole.has("wiki_tree")) {
    const hvKeys = asRows(
      host.db
        .prepare(
          `SELECT DISTINCT node_key FROM nodes
           WHERE run_id = ? AND node_key LIKE 'repair.hv.%'
           ORDER BY node_key DESC`,
        )
        .all(runId),
    ).map((row) => requiredText(row, "node_key"));
    for (const key of [
      ...hvKeys,
      "repair",
      "validate.final",
      "validate.pre",
      "review.reduce",
      "write.root",
    ]) {
      for (const output of nodeOutputsAtCurrentGen(host, runId, key)) {
        if (output.role === "wiki_tree") add("wiki_tree", output.artifactId);
      }
      if (byRole.has("wiki_tree")) break;
    }
  }

  // repair.hv.*: always prefer write.root wiki as the dirty staging baseline
  // (edge write.root → repair.hv.N normally supplies this; force for safety).
  if (nodeKey.startsWith("repair.hv.")) {
    for (const output of nodeOutputsAtCurrentGen(host, runId, "write.root")) {
      if (output.role === "wiki_tree") {
        byRole.set("wiki_tree", output.artifactId);
        break;
      }
    }
  }

  // write.root repair reruns (gen>0 or detail.feedback): bind prior succeeded
  // wiki_tree so the writer can read existing staging (operator Rerun / legacy HV).
  if (nodeKey === "write.root" && !byRole.has("wiki_tree")) {
    const generation = host.currentNodeGeneration(runId, nodeKey);
    if (generation !== undefined && writeRootNeedsPriorWiki(host, runId, generation)) {
      const prior = priorWriteWikiTree(host, runId, generation);
      if (prior) add("wiki_tree", prior.artifactId);
    }
  }

  return [...byRole.entries()]
    .map(([role, artifactId]) => ({ role, artifactId }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

export async function prepareUnsealedArtifact(
  host: ArtifactsHost,
  claim: ClaimedNode,
  descriptor: PiAttemptArtifactDescriptor,
): Promise<ArtifactPreparation | undefined> {
  const stageParent = path.join(
    runWorkDir(host.workspace.rootPath, claim.runId),
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
  return host.transaction(() => {
    if (!host.isCurrent(claim)) return undefined;
    host.db
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

export function commitNodeArtifacts(
  host: ArtifactsHost,
  claim: ClaimedNode,
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
  host.db
    .prepare(
      "UPDATE attempts SET state = 'succeeded', ended_at = ? WHERE attempt_id = ? AND state = 'running'",
    )
    .run(timestamp, claim.attemptId);
  host.db
    .prepare(
      `UPDATE nodes SET state = 'succeeded', current_attempt_id = NULL
       WHERE run_id = ? AND node_key = ? AND generation = ? AND current_attempt_id = ?`,
    )
    .run(claim.runId, claim.nodeKey, claim.nodeGeneration, claim.attemptId);
  host.db
    .prepare(
      "UPDATE artifact_preparations SET state = 'committed' WHERE attempt_id = ? AND state = 'prepared'",
    )
    .run(claim.attemptId);
  host.emit(claim.runId, "attempt.succeeded");

  if (claim.kind === "plan") {
    const specPrep = preparations.find((item) => item.role === "spec" || item.kind === "spec");
    if (!specPrep) throw new Error("plan attempt succeeded without a Spec artifact");
    // planConfirm=false: auto-approve — materialize Definition v1 without operator gate.
    if (host.workspace.planConfirm === false) {
      materializeDefinitionV1Graph(host, claim.runId, specPrep.relativePath);
      host.db
        .prepare(
          "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
        )
        .run(timestamp, claim.runId);
      host.unlockReadyNodes(claim.runId);
      host.emit(claim.runId, "node.ready");
      return;
    }
    host.openPlanGate(claim, specPrep.digest, timestamp);
    return;
  }
  if (claim.kind === "prepare.publication") {
    const candidate = preparations.find(
      (item) => item.role === "publication_candidate" || item.kind === "publication_candidate",
    );
    if (!candidate) throw new Error("prepare.publication succeeded without a candidate");
    const expectedLiveDigest = host.readPublicationBaseline(claim.runId, preparations);
    host.openPublicationGate(claim, candidate, expectedLiveDigest, timestamp);
    return;
  }
  if (claim.kind === "publish") {
    host.db
      .prepare(
        "UPDATE runs SET state = 'published', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
    host.emit(claim.runId, "run.published");
    return;
  }

  host.unlockReadyNodes(claim.runId);
  const hasReady = asRow(
    host.db
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
  // Open gates table is the HITL authority — do not treat stale gate.* nodes
  // left in state='waiting' after Rerun/withdraw as operator waits (parallel
  // seat commits used to flip the run to waiting_for_operator and stall).
  const hasOpenGate = asRow(
    host.db
      .prepare(`SELECT 1 AS present FROM gates WHERE run_id = ? AND state = 'open' LIMIT 1`)
      .get(claim.runId),
  );
  if (hasReady) {
    // Ready work wins over a stale waiting_for_operator (e.g. withdrawn pub gate
    // node still marked waiting while review.reduce is ready).
    host.db
      .prepare(
        `UPDATE runs SET state = 'queued', updated_at = ?
         WHERE run_id = ? AND cancel_requested = 0
           AND state IN ('running', 'queued', 'waiting_for_operator')`,
      )
      .run(timestamp, claim.runId);
    host.emit(claim.runId, "node.ready");
  } else if (hasOpenGate) {
    host.db
      .prepare(
        "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
  } else {
    // Keep running if blocked work may unlock later; otherwise leave state as running
    // until a terminal transition (publish / completed_unpublished / failed).
    host.db
      .prepare(
        "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
  }
}

export async function sealPreparation(
  host: Pick<ArtifactsHost, "workspace">,
  runId: string,
  preparation: ArtifactPreparation,
): Promise<void> {
  const runDir = runWorkDir(host.workspace.rootPath, runId);
  const destination = path.join(runDir, preparation.relativePath);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  if (!(await verifyArtifact(destination, preparation.digest))) {
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
      await syncTree(temporary);
      await rename(temporary, destination);
      await syncDirectory(parent);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  if (!(await verifyArtifact(destination, preparation.digest))) {
    throw new Error(`sealed artifact verification failed: ${preparation.artifactId}`);
  }
}

export async function verifyArtifact(
  directory: string,
  expectedDigest: string,
): Promise<boolean> {
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

export async function syncTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(child);
    else if (entry.isFile()) await durableFsyncPath(child);
  }
  await syncDirectory(directory);
}

export async function syncDirectory(directory: string): Promise<void> {
  // Directory fsync is a POSIX durability hint; Windows often returns EPERM.
  if (process.platform === "win32") return;
  await durableFsyncPath(directory);
}

export function orphanPreparedArtifacts(
  host: Pick<ArtifactsHost, "db">,
  attemptId: string,
): void {
  host.db
    .prepare(
      "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
    )
    .run(attemptId);
}
