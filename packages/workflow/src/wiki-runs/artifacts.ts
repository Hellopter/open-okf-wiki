/**
 * Artifact prepare / seal / commit (bytes + CAS) and orphan.
 * Attempt input binding lives in attempt-inputs.ts.
 * Control-flow after success/failure lives in attempt-finish.ts.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import type { PiAttemptArtifactDescriptor } from "@okf-wiki/contract/pi-attempt";
import {
  type AttemptMetrics,
  contractForNode,
  type MergedDefectReport,
  MergedDefectReportSchema,
  validateNodeOutputs,
} from "@okf-wiki/contract/wiki-runs";
import { EMPTY_PUBLICATION_DIGEST, runWorkDir } from "@okf-wiki/core";
import {
  graphRoleForNodeKind,
  mergeAttemptMetrics,
  wallTimeMsFromStarted,
  writeAttemptMetrics,
} from "./attempt-metrics.js";
import { artifactId, digest, now } from "./crypto-util.js";
import type { WikiRunsCasCtx } from "./ctx.js";
// Artifacts use CasCtx only (bytes + CAS); no separate WikiRunsCasCtx.
import {
  producedByForNode,
  registerWikiCandidate,
} from "./evaluation/candidate.js";
import { durableFsyncPath, manifestFor } from "./fs-util.js";
import { asRow, requiredText } from "./sql.js";
import type { ArtifactPreparation, ClaimedNode } from "./types.js";

type CandidateEvidenceMap = {
  version: 1;
  candidateDigest: string;
  pages: Array<{
    pagePath: string;
    contentDigest: string;
    evidence: Array<{ line: number; source: string }>;
  }>;
};

function contentDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function evidenceForPage(content: string): Array<{ line: number; source: string }> {
  const evidence: Array<{ line: number; source: string }> = [];
  for (const [index, line] of content.replace(/\r\n/g, "\n").split("\n").entries()) {
    for (const source of line.matchAll(/(?:repo:[^\s)\]]+|https?:\/\/[^\s)\]]+)/g)) {
      evidence.push({ line: index + 1, source: source[0] });
    }
  }
  return evidence;
}

function evidenceMapForCandidate(root: string, candidateDigest: string): CandidateEvidenceMap {
  const pages: CandidateEvidenceMap["pages"] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile() && relativePath.endsWith(".md")) {
        const content = readFileSync(path.join(directory, entry.name), "utf8");
        pages.push({
          pagePath: relativePath,
          contentDigest: contentDigest(content),
          evidence: evidenceForPage(content),
        });
        if (pages.length > 2_000) throw new Error("candidate tree exceeds page limit");
      }
    }
  };
  visit(root, "");
  return {
    version: 1,
    candidateDigest,
    pages: pages.sort((left, right) => left.pagePath.localeCompare(right.pagePath)),
  };
}


export async function prepareUnsealedArtifact(
  host: WikiRunsCasCtx,
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
        : descriptor.kind === "execution_plan"
          ? "execution-plan.json"
          : path.basename(descriptor.sourcePath) || `${descriptor.role}.json`;
    await cp(descriptor.sourcePath, path.join(stageDir, base), { dereference: false });
  }
  // Content-only identity: ignore any prior `.okf-artifact-manifest.json` that may
  // have been copied when repair/refresh seeded from an already-sealed wiki_tree.
  // Verify uses the same filter; including the sidecar here makes seal overwrite it
  // and then fail final verification ("sealed artifact verification failed").
  const manifest = await manifestFor(stageDir, true);
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
  host: Pick<WikiRunsCasCtx, "workspace">,
  runId: string,
  preparation: ArtifactPreparation | undefined,
): MergedDefectReport | undefined {
  if (!preparation) return undefined;
  const candidates: string[] = [];
  if (preparation.sourceDirectory) {
    candidates.push(path.join(preparation.sourceDirectory, "defects.json"));
    candidates.push(preparation.sourceDirectory);
  }
  const sealedRoot = path.join(
    runWorkDir(host.workspace.rootPath, runId),
    preparation.relativePath,
  );
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
 * (preparations orphaned). Does not open gates or unlock — see attempt-finish.
 * Optional metrics are best-effort and never block the commit.
 */
export function commitNodeArtifacts(
  host: Pick<WikiRunsCasCtx, "db" | "emit" | "isCurrent" | "workspace">,
  claim: ClaimedNode,
  preparations: ArtifactPreparation[],
  metrics?: AttemptMetrics,
): boolean {
  if (!host.isCurrent(claim)) {
    host.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(claim.attemptId);
    return false;
  }
  validateNodeOutputs(
    contractForNode(claim.kind, claim.nodeKey),
    preparations.map((preparation) => ({ role: preparation.role, kind: preparation.kind })),
  );
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
    // Always register WikiCandidate identity when a wiki_tree is committed (truth).
    // maxCandidates is enforced when scheduling repair, not here.
    if (preparation.role === "wiki_tree" || preparation.kind === "wiki_tree") {
      const candidate = registerWikiCandidate(host, {
        runId: claim.runId,
        digest: preparation.digest,
        artifactId: preparation.artifactId,
        producedBy: producedByForNode(claim.kind, claim.nodeKey),
        createdAt: timestamp,
        producerNodeKey: claim.nodeKey,
        producerAttemptId: claim.attemptId,
      });
      const parent = candidate.parentCandidateId
        ? asRow(
            host.db
              .prepare(
                `SELECT digest, artifact_id FROM wiki_candidates WHERE run_id = ? AND candidate_id = ?`,
              )
              .get(claim.runId, candidate.parentCandidateId),
          )
        : undefined;
      const candidateRoot = path.resolve(
        runWorkDir(host.workspace.rootPath, claim.runId),
        preparation.relativePath,
      );
      const evidenceMap = evidenceMapForCandidate(candidateRoot, candidate.digest);
      const evidenceDigest = digest(evidenceMap);
      const evidenceArtifactId = artifactId(claim.runId, "evidence_map", evidenceDigest);
      const evidenceRelativePath = `artifacts/evidence-map-${evidenceDigest}`;
      const evidenceDirectory = path.join(
        runWorkDir(host.workspace.rootPath, claim.runId),
        evidenceRelativePath,
      );
      mkdirSync(evidenceDirectory, { recursive: true });
      writeFileSync(
        path.join(evidenceDirectory, "evidence-map.json"),
        `${JSON.stringify(evidenceMap)}\n`,
        "utf8",
      );
      host.db
        .prepare(
          `INSERT INTO artifacts (artifact_id, run_id, kind, digest, relative_path, producer_attempt_id, sealed_at)
           VALUES (?, ?, 'evidence_map', ?, ?, ?, ?)
           ON CONFLICT(artifact_id) DO NOTHING`,
        )
        .run(
          evidenceArtifactId,
          claim.runId,
          evidenceDigest,
          evidenceRelativePath,
          claim.attemptId,
          timestamp,
        );
      // A parent wiki_tree is the baseline artifact. The initial candidate is
      // anchored to the empty published digest and therefore has no local baseline artifact.
      host.db
        .prepare(
          `INSERT INTO candidate_review_artifacts (
             run_id, candidate_digest, baseline_digest, baseline_artifact_id, evidence_digest, evidence_artifact_id
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, candidate_digest) DO NOTHING`,
        )
        .run(
          claim.runId,
          candidate.digest,
          parent ? requiredText(parent, "digest") : EMPTY_PUBLICATION_DIGEST,
          parent ? requiredText(parent, "artifact_id") : null,
          evidenceDigest,
          evidenceArtifactId,
        );
    }
  }
  host.db
    .prepare(
      "UPDATE attempts SET state = 'succeeded', ended_at = ? WHERE attempt_id = ? AND state = 'running'",
    )
    .run(timestamp, claim.attemptId);
  const resolved = mergeAttemptMetrics(metrics, {
    role: graphRoleForNodeKind(claim.kind),
    wallTimeMs: wallTimeMsFromStarted(host.db, claim.attemptId, timestamp),
    stopReason: "succeeded",
  });
  writeAttemptMetrics(host.db, claim.attemptId, resolved);
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

/**
 * Commit sealed evidence produced by a failed Attempt without changing its
 * terminal state. Validation reports are evidence, not successful validation.
 */
export function commitFailedAttemptArtifacts(
  host: Pick<WikiRunsCasCtx, "db" | "isCurrent">,
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
      "UPDATE artifact_preparations SET state = 'committed' WHERE attempt_id = ? AND state = 'prepared'",
    )
    .run(claim.attemptId);
  return true;
}

export async function sealPreparation(
  host: Pick<WikiRunsCasCtx, "workspace">,
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
      // Same content-only filter as prepare + verify (see prepareUnsealedArtifact).
      const manifest = await manifestFor(temporary, true);
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

export async function verifyArtifact(directory: string, expectedDigest: string): Promise<boolean> {
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

export function orphanPreparedArtifacts(host: Pick<WikiRunsCasCtx, "db">, attemptId: string): void {
  host.db
    .prepare(
      "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
    )
    .run(attemptId);
}
