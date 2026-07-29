/**
 * Artifact prepare / seal / commit (bytes + CAS) and attempt input binding.
 * Control-flow after success (gates, unlock, plan accept) lives in attempt-success.ts.
 */

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
import type { DatabaseSync } from "node:sqlite";
import {
  type MergedDefectReport,
  MergedDefectReportSchema,
  type PiAttemptArtifactDescriptor,
  type WikiRunEvent,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { runWorkDir } from "@okf-wiki/core";
import { artifactId, digest, now } from "./crypto-util.js";
import { upstreamKeys } from "./dag.js";
import { durableFsyncPath, manifestFor } from "./fs-util.js";
import { asRow, asRows, requiredText } from "./sql.js";
import type { ArtifactPreparation, ClaimedNode } from "./types.js";

/** Bytes/CAS surface — no gate open or unlock callbacks. */
export type ArtifactsHost = {
  workspace: WorkspaceConfig;
  db: DatabaseSync;
  transaction<T>(work: () => T): T;
  emit(runId: string, type: WikiRunEvent["type"]): number;
  isCurrent(claim: ClaimedNode): boolean;
  currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
};

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
  // Prefer refined trees (repair.review / repair.hv / validate) over write.root so
  // auto hard-validate / review repair is not lost when seats do not re-emit wiki_tree.
  if (!byRole.has("wiki_tree")) {
    const reviewRepairKeys = asRows(
      host.db
        .prepare(
          `SELECT DISTINCT node_key FROM nodes
           WHERE run_id = ? AND node_key LIKE 'repair.review.%'
           ORDER BY node_key DESC`,
        )
        .all(runId),
    ).map((row) => requiredText(row, "node_key"));
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
      ...reviewRepairKeys,
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

  // repair.review.*: prefer review.reduce wiki (+ defects already via edge).
  if (nodeKey.startsWith("repair.review.")) {
    for (const output of nodeOutputsAtCurrentGen(host, runId, "review.reduce")) {
      if (output.role === "wiki_tree") {
        byRole.set("wiki_tree", output.artifactId);
      }
      if (output.role === "defects" && !byRole.has("defects")) {
        byRole.set("defects", output.artifactId);
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

/**
 * Load a sealed MergedDefectReport from a review.reduce defects preparation.
 * Prefers sourceDirectory (still present at commit), then sealed relative path.
 */
export function loadSealedDefectsReport(
  host: Pick<ArtifactsHost, "workspace">,
  runId: string,
  preparation: ArtifactPreparation | undefined,
): MergedDefectReport | undefined {
  if (!preparation) return undefined;
  const candidates: string[] = [];
  if (preparation.sourceDirectory) {
    candidates.push(path.join(preparation.sourceDirectory, "defects.json"));
    candidates.push(preparation.sourceDirectory);
  }
  const sealedRoot = path.join(runWorkDir(host.workspace.rootPath, runId), preparation.relativePath);
  candidates.push(path.join(sealedRoot, "defects.json"), sealedRoot);
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const report = MergedDefectReportSchema.safeParse(parsed);
      if (report.success) return report.data;
    } catch {
      // Try next path.
    }
  }
  return undefined;
}

/**
 * CAS commit of sealed artifact bytes into artifacts/node_outputs and mark
 * attempt + node succeeded. Returns false when the claim is no longer current
 * (preparations orphaned). Does not open gates or unlock — see attempt-success.
 */
export function commitNodeArtifacts(
  host: Pick<ArtifactsHost, "db" | "emit" | "isCurrent">,
  claim: ClaimedNode,
  preparations: ArtifactPreparation[],
): boolean {
  if (!host.isCurrent(claim)) {
    host.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(claim.attemptId);
    return false;
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
  return true;
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
