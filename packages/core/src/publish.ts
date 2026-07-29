import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { withLockedDir, withPerKeyMutex } from "./atomicity.js";
import { rewriteRepoCitationsToRelative } from "./citation-rewrite.js";
import { type OkfStamp, stampWikiTreeForPublish } from "./okf-stamp.js";
import { assertAbsolutePath, assertNoSymlinkComponents } from "./paths.js";
import { validateWikiTree } from "./validate-wiki.js";
import { regenerateWikiIndexes, validateWikiIndexes } from "./wiki-index.js";
import { updateWikiLogForPublish } from "./wiki-log.js";
import { countMarkdownFiles, scanWikiTree } from "./wiki-tree.js";

export type PublishStagingInput = {
  stagingDir: string;
  publicationPath: string;
  /** Optional run id for diagnostics / future release naming. */
  runId?: string;
  /**
   * Pinned Snapshot sources for mechanical Source Citation resolve (ADR 0008).
   * When set, validateWikiTree checks citations against these roots.
   * Also used to rewrite `repo:` citations to portable relative `sources/<id>/…` links.
   */
  sources?: Array<{ id: string; path: string }>;
  /**
   * OKF v0.2 provenance stamp (generated / verified / okf_version), applied to
   * the candidate tree only. Run Boundary-owned facts, never model-authored.
   */
  stamp?: OkfStamp;
};

export type PublishStagingResult = {
  publicationPath: string;
  pageCount: number;
  /** Pages whose repo: citations were rewritten for portability. */
  rewrittenCitationPages?: number;
  /** Concept pages stamped with OKF provenance frontmatter. */
  stampedPages?: number;
  /** log.md change entries recorded for this publish. */
  logChanges?: number;
  /** Number of directory index.md files regenerated on the candidate. */
  regeneratedIndexes?: number;
};

export type PublicationTreeManifest = {
  schema: 1;
  files: Array<{ path: string; digest: string; size: number }>;
};

/** Live publication baseline no longer matches the approved effect expectation. */
export class PublicationConflictError extends Error {
  readonly code = "PUBLICATION_CONFLICT" as const;
  readonly liveDigest: string;
  readonly expectedLiveDigest: string;

  constructor(liveDigest: string, expectedLiveDigest: string) {
    super(
      `PublicationConflict: live digest ${liveDigest.slice(0, 12)}… ≠ expected ${expectedLiveDigest.slice(0, 12)}…`,
    );
    this.name = "PublicationConflictError";
    this.liveDigest = liveDigest;
    this.expectedLiveDigest = expectedLiveDigest;
  }
}

/**
 * Publish a staging Wiki tree to the stable Published Wiki path.
 *
 * Portable MVP (ADR 0017): materialize a complete tree under a sibling temp
 * directory, then expose it via same-parent renames so readers never see a
 * half-written publication path.
 *
 * WikiRuns (ADR 0035) prefers the split primitives:
 * {@link capturePublicationBaseline}, {@link materializePublicationCandidate},
 * {@link applySealedPublicationCandidate}, {@link reconcilePublicationApply}.
 * This combined helper remains for mechanical core tests and one-shot tools.
 */

/** In-process serialization per publication path (same-process publishers). */
const publishTails = new Map<string, Promise<unknown>>();

/** A held lock dir older than this is treated as crash residue. */
const PUBLISH_LOCK_STALE_MS = 10 * 60 * 1000;

const EMPTY_MANIFEST: PublicationTreeManifest = { schema: 1, files: [] };

/** Canonical digest of an empty publication tree (first-publish baseline). */
export const EMPTY_PUBLICATION_DIGEST = digestJson(EMPTY_MANIFEST);

type ApplyMarker = {
  schema: 1;
  effectKey: string;
  candidateDigest: string;
  expectedLiveDigest: string;
  nextPath: string;
  prevPath: string;
  phase: "begin" | "aside" | "swapped";
};

/**
 * Exclusive publication lock (ADR 0017 / 0035): in-process mutex + on-disk lock
 * dir so concurrent Wiki Runs targeting the same Published Wiki path fail closed
 * instead of interleaving renames or baseline captures.
 */
export function withPublicationLock<T>(publicationPath: string, fn: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(assertAbsolutePath(publicationPath, "publicationPath"));
  return withPerKeyMutex(publishTails, resolved, () =>
    withLockedDir(`${resolved}.publish-lock`, { staleMs: PUBLISH_LOCK_STALE_MS }, fn),
  );
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function fileDigest(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/**
 * Canonical content-addressed manifest of a publication tree (or empty when
 * the path is missing). Symlinks and non-ordinary entries fail closed.
 */
export async function manifestPublicationTree(
  directory: string | null | undefined,
): Promise<PublicationTreeManifest> {
  if (!directory) return { ...EMPTY_MANIFEST, files: [] };
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { ...EMPTY_MANIFEST, files: [] };
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`publication tree is a symlink: ${directory}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`publication tree is not a directory: ${directory}`);
  }

  const files: PublicationTreeManifest["files"] = [];
  const visit = async (absolute: string, relative: string): Promise<void> => {
    for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = path.join(absolute, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childInfo = await lstat(child);
      if (childInfo.isSymbolicLink() || (!childInfo.isDirectory() && !childInfo.isFile())) {
        throw new Error(`publication tree contains a non-ordinary entry: ${child}`);
      }
      if (childInfo.isDirectory()) await visit(child, childRelative);
      else {
        files.push({
          path: childRelative,
          digest: await fileDigest(child),
          size: childInfo.size,
        });
      }
    }
  };
  await visit(directory, "");
  return { schema: 1, files };
}

/** Digest of a live or candidate publication tree; missing path → empty digest. */
export async function digestPublicationTree(directory: string | null | undefined): Promise<string> {
  return digestJson(await manifestPublicationTree(directory));
}

/**
 * Content-only publication digest that ignores the Artifact seal sidecar.
 * WikiRuns seals candidates with `.okf-artifact-manifest.json`; effect identity
 * uses the content digest, while apply swaps the sealed directory as-is.
 */
export async function digestPublicationTreeContentOnly(
  directory: string | null | undefined,
): Promise<string> {
  const manifest = await manifestPublicationTree(directory);
  return digestJson({
    schema: 1,
    files: manifest.files.filter((file) => file.path !== ".okf-artifact-manifest.json"),
  });
}

/**
 * Capture the live baseline digest under the publication lock (ADR 0035).
 * Empty / missing publication yields {@link EMPTY_PUBLICATION_DIGEST}.
 */
export async function capturePublicationBaseline(publicationPath: string): Promise<string> {
  const resolved = path.resolve(assertAbsolutePath(publicationPath, "publicationPath"));
  await assertNoSymlinkComponents(path.dirname(resolved), "publicationPath parent");
  await mkdir(path.dirname(resolved), { recursive: true });
  return withPublicationLock(resolved, async () => digestPublicationTree(resolved));
}

/** Remove `.next.*` / `.prev.*` residue of a previously crashed one-shot publish. */
async function sweepPublishResidue(publicationPath: string): Promise<void> {
  const parent = path.dirname(publicationPath);
  const base = path.basename(publicationPath);
  const entries = await readdir(parent).catch(() => [] as string[]);
  for (const name of entries) {
    if (name.startsWith(`${base}.next.`) || name.startsWith(`${base}.prev.`)) {
      await rm(path.join(parent, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** True when `child` equals or lives under `parent`. */
function isSameOrInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function effectFsToken(effectKey: string): string {
  return createHash("sha256").update(effectKey).digest("hex").slice(0, 16);
}

function applyMarkerPath(publicationPath: string, effectKey: string): string {
  return `${publicationPath}.okf-apply-${effectFsToken(effectKey)}.json`;
}

async function readApplyMarker(
  publicationPath: string,
  effectKey: string,
): Promise<ApplyMarker | null> {
  const markerFile = applyMarkerPath(publicationPath, effectKey);
  try {
    const raw = await readFile(markerFile, "utf8");
    const parsed = JSON.parse(raw) as ApplyMarker;
    if (parsed?.schema !== 1 || parsed.effectKey !== effectKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeApplyMarkerFor(publicationPath: string, marker: ApplyMarker): Promise<void> {
  await writeFile(
    applyMarkerPath(publicationPath, marker.effectKey),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
}

async function removeApplyMarker(publicationPath: string, effectKey: string): Promise<void> {
  await rm(applyMarkerPath(publicationPath, effectKey), { force: true }).catch(() => undefined);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Rewrite Skill-form repo: citations on every markdown file under `wikiRoot`. */
export async function rewriteWikiTreeCitationsForPublish(
  wikiRoot: string,
  sources: Array<{ id: string }>,
): Promise<number> {
  if (sources.length === 0) return 0;
  const scan = await scanWikiTree(wikiRoot);
  let rewritten = 0;
  for (const file of scan.files) {
    if (!file.relativePath.toLowerCase().endsWith(".md")) continue;
    const raw = await readFile(file.absolutePath, "utf8");
    const next = rewriteRepoCitationsToRelative(raw, {
      pageRelPath: file.relativePath.replace(/\\/g, "/"),
      sources,
    });
    if (next !== raw) {
      await writeFile(file.absolutePath, next, "utf8");
      rewritten += 1;
    }
  }
  return rewritten;
}

/**
 * Build the exact publication candidate (rewrite / index / log / stamp) into
 * `candidateDir`. Does not take the publication lock or touch live bytes beyond
 * a read-only log diff against the current publication path when present.
 *
 * ADR 0035: prepare.publication seals this tree; apply only swaps it.
 */
export async function materializePublicationCandidate(input: {
  wikiDir: string;
  candidateDir: string;
  publicationPath: string;
  sources?: Array<{ id: string; path: string }>;
  stamp?: OkfStamp;
}): Promise<Omit<PublishStagingResult, "publicationPath"> & { candidateDir: string }> {
  const wikiDir = path.resolve(assertAbsolutePath(input.wikiDir, "wikiDir"));
  const candidateDir = path.resolve(assertAbsolutePath(input.candidateDir, "candidateDir"));
  const publicationPath = path.resolve(
    assertAbsolutePath(input.publicationPath, "publicationPath"),
  );

  if (isSameOrInside(wikiDir, candidateDir) || isSameOrInside(candidateDir, wikiDir)) {
    throw new Error(`wikiDir and candidateDir must not overlap: ${wikiDir} vs ${candidateDir}`);
  }
  if (
    isSameOrInside(wikiDir, publicationPath) ||
    isSameOrInside(publicationPath, wikiDir) ||
    isSameOrInside(candidateDir, publicationPath) ||
    isSameOrInside(publicationPath, candidateDir)
  ) {
    throw new Error(`candidate/wiki paths must not overlap publicationPath: ${publicationPath}`);
  }

  let wikiInfo;
  try {
    wikiInfo = await lstat(wikiDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") throw new Error(`wiki directory does not exist: ${wikiDir}`);
    throw error;
  }
  if (wikiInfo.isSymbolicLink()) throw new Error(`wikiDir is a symlink: ${wikiDir}`);
  if (!wikiInfo.isDirectory()) throw new Error(`wikiDir is not a directory: ${wikiDir}`);

  await assertNoSymlinkComponents(wikiDir, "wikiDir");
  await assertNoSymlinkComponents(candidateDir, "candidateDir");
  await assertNoSymlinkComponents(publicationPath, "publicationPath");

  const validation = await validateWikiTree(wikiDir, {
    ...(input.sources?.length ? { sources: input.sources } : {}),
  });
  if (!validation.ok) {
    throw new Error(`wiki failed validation before materialize: ${validation.errors.join("; ")}`);
  }
  const pageCount = validation.pageCount ?? (await countMarkdownFiles(wikiDir));
  if (pageCount < 1) {
    throw new Error(`wiki has no markdown pages: ${wikiDir}`);
  }

  await rm(candidateDir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(path.dirname(candidateDir), { recursive: true });
  await cp(wikiDir, candidateDir, { recursive: true, force: true, errorOnExist: false });

  const candidateInfo = await lstat(candidateDir);
  if (candidateInfo.isSymbolicLink() || !candidateInfo.isDirectory()) {
    await rm(candidateDir, { recursive: true, force: true });
    throw new Error(`candidate is not a directory: ${candidateDir}`);
  }

  let rewrittenCitationPages = 0;
  if (input.sources?.length) {
    try {
      rewrittenCitationPages = await rewriteWikiTreeCitationsForPublish(
        candidateDir,
        input.sources.map((s) => ({ id: s.id })),
      );
    } catch (error) {
      await rm(candidateDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  let stampedPages = 0;
  let logChanges = 0;
  let regeneratedIndexes: number;
  try {
    if (input.stamp) {
      let previousDir: string | undefined;
      try {
        const info = await stat(publicationPath);
        if (info.isDirectory()) previousDir = publicationPath;
      } catch {
        // First publish: no live tree to diff against.
      }
      const log = await updateWikiLogForPublish({
        candidateDir,
        ...(previousDir ? { previousDir } : {}),
        date: input.stamp.generatedAt.slice(0, 10),
      });
      logChanges = log.changes;
    }
    const indexes = await regenerateWikiIndexes(candidateDir);
    regeneratedIndexes = indexes.written.length;
    const indexValidation = await validateWikiIndexes(candidateDir);
    if (!indexValidation.ok) {
      throw new Error(
        `candidate failed wiki index validation: ${indexValidation.errors.join("; ")}`,
      );
    }
    if (input.stamp) {
      const stamped = await stampWikiTreeForPublish(candidateDir, input.stamp);
      stampedPages = stamped.stampedPages;
    }
  } catch (error) {
    await rm(candidateDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  // Final structural validation on the exact bytes that will be sealed/swapped.
  const finalValidation = await validateWikiTree(candidateDir, {
    // After rewrite, citations are relative sources/ links — do not require repo: form.
    requireCitations: false,
  });
  if (!finalValidation.ok) {
    await rm(candidateDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(
      `materialized candidate failed validation: ${finalValidation.errors.join("; ")}`,
    );
  }

  return {
    candidateDir,
    // Report pre-index concept page count (indexes are navigation, not knowledge pages).
    pageCount,
    ...(rewrittenCitationPages > 0 ? { rewrittenCitationPages } : {}),
    ...(stampedPages > 0 ? { stampedPages } : {}),
    ...(logChanges > 0 ? { logChanges } : {}),
    ...(regeneratedIndexes > 0 ? { regeneratedIndexes } : {}),
  };
}

export type ApplySealedPublicationInput = {
  candidateDir: string;
  publicationPath: string;
  expectedLiveDigest: string;
  effectKey: string;
  /**
   * Called under the publication lock after the live baseline matches
   * `expectedLiveDigest` and **before** any rename. Return false to abort
   * without mutating live (e.g. CAS to `applying` failed / cancel requested).
   */
  beginApply?: () => boolean | Promise<boolean>;
};

export type ApplySealedPublicationResult =
  | { status: "applied"; pageCount: number; liveDigest: string }
  | { status: "conflict"; liveDigest: string; expectedLiveDigest: string }
  | { status: "aborted" };

/**
 * Swap a sealed publication candidate onto the live path (ADR 0035).
 *
 * Never rewrites, stamps, indexes, or otherwise changes candidate bytes.
 * Under the publication lock:
 * 1. verify live baseline digest
 * 2. optional beginApply CAS hook
 * 3. copy candidate → `.next.<token>`, rename live → `.prev.<token>`, rename next → live
 * 4. drop aside + marker on success
 */
export async function applySealedPublicationCandidate(
  input: ApplySealedPublicationInput,
): Promise<ApplySealedPublicationResult> {
  const candidateDir = path.resolve(assertAbsolutePath(input.candidateDir, "candidateDir"));
  const publicationPath = path.resolve(
    assertAbsolutePath(input.publicationPath, "publicationPath"),
  );
  if (!input.effectKey.trim()) throw new Error("effectKey is required for sealed apply");
  if (!/^[a-f0-9]{64}$/i.test(input.expectedLiveDigest)) {
    throw new Error(`expectedLiveDigest must be sha256 hex, got: ${input.expectedLiveDigest}`);
  }

  if (
    isSameOrInside(candidateDir, publicationPath) ||
    isSameOrInside(publicationPath, candidateDir)
  ) {
    throw new Error(
      `candidateDir and publicationPath must not overlap: ${candidateDir} vs ${publicationPath}`,
    );
  }

  let candidateInfo;
  try {
    candidateInfo = await lstat(candidateDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") throw new Error(`candidate directory does not exist: ${candidateDir}`);
    throw error;
  }
  if (candidateInfo.isSymbolicLink()) {
    throw new Error(`candidateDir is a symlink: ${candidateDir}`);
  }
  if (!candidateInfo.isDirectory()) {
    throw new Error(`candidateDir is not a directory: ${candidateDir}`);
  }
  await assertNoSymlinkComponents(candidateDir, "candidateDir");
  await assertNoSymlinkComponents(publicationPath, "publicationPath");

  const pageCount = await countMarkdownFiles(candidateDir);
  if (pageCount < 1) {
    throw new Error(`candidate has no markdown pages: ${candidateDir}`);
  }

  const parent = path.dirname(publicationPath);
  await mkdir(parent, { recursive: true });
  await assertNoSymlinkComponents(parent, "publicationPath parent");

  const token = effectFsToken(input.effectKey);
  const nextPath = `${publicationPath}.next.${token}`;
  const prevPath = `${publicationPath}.prev.${token}`;

  return withPublicationLock(publicationPath, async () => {
    const liveDigest = await digestPublicationTree(publicationPath);
    if (liveDigest !== input.expectedLiveDigest) {
      return {
        status: "conflict" as const,
        liveDigest,
        expectedLiveDigest: input.expectedLiveDigest,
      };
    }

    if (input.beginApply) {
      const ok = await input.beginApply();
      if (!ok) return { status: "aborted" as const };
    }

    const marker: ApplyMarker = {
      schema: 1,
      effectKey: input.effectKey,
      candidateDigest: await digestPublicationTree(candidateDir),
      expectedLiveDigest: input.expectedLiveDigest,
      nextPath,
      prevPath,
      phase: "begin",
    };
    await writeApplyMarkerFor(publicationPath, marker);

    // Drop only this effect's prior next/prev (never blind-sweep unrelated residue).
    await rm(nextPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(prevPath, { recursive: true, force: true }).catch(() => undefined);

    await cp(candidateDir, nextPath, { recursive: true, force: true, errorOnExist: false });
    const nextInfo = await lstat(nextPath);
    if (nextInfo.isSymbolicLink() || !nextInfo.isDirectory()) {
      await rm(nextPath, { recursive: true, force: true }).catch(() => undefined);
      await removeApplyMarker(publicationPath, input.effectKey);
      throw new Error(`apply next path is not a directory: ${nextPath}`);
    }

    let movedAside = false;
    try {
      await stat(publicationPath);
      await rename(publicationPath, prevPath);
      movedAside = true;
      marker.phase = "aside";
      await writeApplyMarkerFor(publicationPath, marker);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        await rm(nextPath, { recursive: true, force: true }).catch(() => undefined);
        await removeApplyMarker(publicationPath, input.effectKey);
        throw error;
      }
    }

    try {
      await rename(nextPath, publicationPath);
      marker.phase = "swapped";
      await writeApplyMarkerFor(publicationPath, marker);
    } catch (error) {
      if (movedAside) {
        try {
          await rename(prevPath, publicationPath);
        } catch {
          // Leave prev + next for reconcile.
        }
      }
      await rm(nextPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    const finalInfo = await lstat(publicationPath);
    if (finalInfo.isSymbolicLink()) {
      throw new Error(`publicationPath became a symlink after publish: ${publicationPath}`);
    }
    if (!finalInfo.isDirectory()) {
      throw new Error(`publicationPath is not a directory after publish: ${publicationPath}`);
    }

    if (movedAside) {
      await rm(prevPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await removeApplyMarker(publicationPath, input.effectKey);

    const appliedLiveDigest = await digestPublicationTree(publicationPath);
    return {
      status: "applied" as const,
      pageCount,
      liveDigest: appliedLiveDigest,
    };
  });
}

export type ReconcilePublicationApplyInput = {
  publicationPath: string;
  candidateDir: string;
  candidateDigest: string;
  expectedLiveDigest: string;
  effectKey: string;
};

export type ReconcilePublicationApplyResult =
  | { status: "applied"; liveDigest: string }
  | { status: "failed"; reason: string; liveDigest: string }
  | { status: "unknown"; reason: string; liveDigest: string | null };

/**
 * Reconcile an effect left in `applying` after a crash (ADR 0035).
 * Never reports `cancelled`. Uses live tree, sealed candidate, aside/next, and
 * apply marker — does not blind-delete residue without intent.
 */
export async function reconcilePublicationApply(
  input: ReconcilePublicationApplyInput,
): Promise<ReconcilePublicationApplyResult> {
  const publicationPath = path.resolve(
    assertAbsolutePath(input.publicationPath, "publicationPath"),
  );
  const candidateDir = path.resolve(assertAbsolutePath(input.candidateDir, "candidateDir"));
  const token = effectFsToken(input.effectKey);
  const nextPath = `${publicationPath}.next.${token}`;
  const prevPath = `${publicationPath}.prev.${token}`;

  return withPublicationLock(publicationPath, async () => {
    let liveDigest: string;
    try {
      liveDigest = await digestPublicationTree(publicationPath);
    } catch (error) {
      return {
        status: "unknown" as const,
        reason: error instanceof Error ? error.message : "live digest failed",
        liveDigest: null,
      };
    }

    const cleanupResidue = async (): Promise<void> => {
      await rm(nextPath, { recursive: true, force: true }).catch(() => undefined);
      await rm(prevPath, { recursive: true, force: true }).catch(() => undefined);
      await removeApplyMarker(publicationPath, input.effectKey);
    };

    const liveMatchesCandidate = async (digest: string | null): Promise<boolean> => {
      if (!digest) return false;
      if (digest === input.candidateDigest) return true;
      // Live may still hold the sealed tree (with .okf-artifact-manifest.json)
      // while effect identity is the content-only Artifact digest.
      try {
        const contentOnly = await digestPublicationTreeContentOnly(publicationPath);
        return contentOnly === input.candidateDigest;
      } catch {
        return false;
      }
    };

    // Live already matches the recorded candidate → apply completed (or equivalent).
    if (await liveMatchesCandidate(liveDigest)) {
      await cleanupResidue();
      return { status: "applied" as const, liveDigest };
    }

    let sealedCandidateDigest: string | null = null;
    try {
      sealedCandidateDigest = await digestPublicationTree(candidateDir);
    } catch {
      sealedCandidateDigest = null;
    }
    // Apply swaps the sealed candidate directory as-is. Live matching that tree
    // means the rename committed even when candidateDigest is content-only.
    if (sealedCandidateDigest !== null && liveDigest === sealedCandidateDigest) {
      await cleanupResidue();
      return { status: "applied" as const, liveDigest };
    }

    const marker = await readApplyMarker(publicationPath, input.effectKey);
    const nextExists = await pathExists(nextPath);
    const prevExists = await pathExists(prevPath);
    const liveExists = await pathExists(publicationPath);

    const nextIsCandidate = async (nextDigest: string): Promise<boolean> => {
      if (nextDigest === input.candidateDigest) return true;
      if (sealedCandidateDigest !== null && nextDigest === sealedCandidateDigest) return true;
      try {
        const contentOnly = await digestPublicationTreeContentOnly(nextPath);
        return contentOnly === input.candidateDigest;
      } catch {
        return false;
      }
    };

    // Swap completed marker but digest mismatch → corruption / external change.
    if (marker?.phase === "swapped" && !(await liveMatchesCandidate(liveDigest))) {
      if (sealedCandidateDigest !== null && liveDigest === sealedCandidateDigest) {
        await cleanupResidue();
        return { status: "applied" as const, liveDigest };
      }
      return {
        status: "unknown" as const,
        reason: "apply marker phase=swapped but live digest ≠ candidate",
        liveDigest,
      };
    }

    // Live missing, next holds candidate — complete the swap.
    // Check before the baseline-failed path: first publish uses the empty-tree
    // digest for a missing live path, which would otherwise look like "still baseline".
    if (!liveExists && nextExists) {
      try {
        const nextDigest = await digestPublicationTree(nextPath);
        if (await nextIsCandidate(nextDigest)) {
          await rename(nextPath, publicationPath);
          if (prevExists) {
            await rm(prevPath, { recursive: true, force: true }).catch(() => undefined);
          }
          await removeApplyMarker(publicationPath, input.effectKey);
          const applied = await digestPublicationTree(publicationPath);
          return { status: "applied" as const, liveDigest: applied };
        }
      } catch (error) {
        return {
          status: "unknown" as const,
          reason: error instanceof Error ? error.message : "next promote failed",
          liveDigest: null,
        };
      }
    }

    // Live missing but prev holds old baseline — restore and fail.
    if (!liveExists && prevExists) {
      try {
        await rename(prevPath, publicationPath);
        const restored = await digestPublicationTree(publicationPath);
        await rm(nextPath, { recursive: true, force: true }).catch(() => undefined);
        await removeApplyMarker(publicationPath, input.effectKey);
        return {
          status: "failed" as const,
          reason: "restored previous live from aside after incomplete swap",
          liveDigest: restored,
        };
      } catch (error) {
        return {
          status: "unknown" as const,
          reason: error instanceof Error ? error.message : "aside restore failed",
          liveDigest: null,
        };
      }
    }

    // Live still at baseline: rename never landed (or was rolled back).
    if (liveDigest === input.expectedLiveDigest) {
      // Best-effort cleanup of this effect's next residue only.
      if (nextExists) {
        await rm(nextPath, { recursive: true, force: true }).catch(() => undefined);
      }
      if (prevExists && liveExists) {
        // Aside left behind after successful restore or failed cleanup.
        await rm(prevPath, { recursive: true, force: true }).catch(() => undefined);
      }
      await removeApplyMarker(publicationPath, input.effectKey);
      return {
        status: "failed" as const,
        reason: "live still matches expected baseline; apply did not commit",
        liveDigest,
      };
    }

    // Live is neither baseline nor candidate.
    return {
      status: "unknown" as const,
      reason: "live digest matches neither expected baseline nor sealed candidate",
      liveDigest,
    };
  });
}

/**
 * One-shot publish: materialize transforms under the lock, then swap.
 * Prefer the split ADR 0035 primitives for WikiRuns effect protocol.
 */
export async function publishStagingToPublication(
  input: PublishStagingInput,
): Promise<PublishStagingResult> {
  const stagingDir = path.resolve(assertAbsolutePath(input.stagingDir, "stagingDir"));
  const publicationPath = path.resolve(
    assertAbsolutePath(input.publicationPath, "publicationPath"),
  );

  if (isSameOrInside(stagingDir, publicationPath) || isSameOrInside(publicationPath, stagingDir)) {
    throw new Error(
      `stagingDir and publicationPath must not overlap: ${stagingDir} vs ${publicationPath}`,
    );
  }

  let stagingInfo;
  try {
    stagingInfo = await lstat(stagingDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new Error(`staging directory does not exist: ${stagingDir}`);
    }
    throw error;
  }
  if (stagingInfo.isSymbolicLink()) {
    throw new Error(`stagingDir is a symlink: ${stagingDir}`);
  }
  if (!stagingInfo.isDirectory()) {
    throw new Error(`stagingDir is not a directory: ${stagingDir}`);
  }

  await assertNoSymlinkComponents(stagingDir, "stagingDir");
  await assertNoSymlinkComponents(publicationPath, "publicationPath");

  try {
    const pubInfo = await lstat(publicationPath);
    if (pubInfo.isSymbolicLink()) {
      throw new Error(`publicationPath is a symlink: ${publicationPath}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const validation = await validateWikiTree(stagingDir, {
    ...(input.sources?.length ? { sources: input.sources } : {}),
  });
  if (!validation.ok) {
    throw new Error(`staging failed wiki validation: ${validation.errors.join("; ")}`);
  }
  const pageCount = validation.pageCount ?? (await countMarkdownFiles(stagingDir));
  if (pageCount < 1) {
    throw new Error(`staging has no markdown pages: ${stagingDir}`);
  }

  const parent = path.dirname(publicationPath);
  await mkdir(parent, { recursive: true });
  await assertNoSymlinkComponents(parent, "publicationPath parent");

  return withPublicationLock(publicationPath, async () => {
    // One-shot path: any .next.* / .prev.* siblings are crash residue (no effect marker).
    await sweepPublishResidue(publicationPath);

    const ts = Date.now();
    const candidate = `${publicationPath}.next.${ts}`;
    const aside = `${publicationPath}.prev.${ts}`;

    const materialized = await materializePublicationCandidate({
      wikiDir: stagingDir,
      candidateDir: candidate,
      publicationPath,
      ...(input.sources?.length ? { sources: input.sources } : {}),
      ...(input.stamp ? { stamp: input.stamp } : {}),
    });

    let movedAside = false;
    try {
      await stat(publicationPath);
      await rename(publicationPath, aside);
      movedAside = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        await rm(candidate, { recursive: true, force: true });
        throw error;
      }
    }

    try {
      await rename(candidate, publicationPath);
    } catch (error) {
      if (movedAside) {
        try {
          await rename(aside, publicationPath);
        } catch {
          // Leave aside + candidate for operator recovery.
        }
      }
      await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    const finalInfo = await lstat(publicationPath);
    if (finalInfo.isSymbolicLink()) {
      throw new Error(`publicationPath became a symlink after publish: ${publicationPath}`);
    }
    if (!finalInfo.isDirectory()) {
      throw new Error(`publicationPath is not a directory after publish: ${publicationPath}`);
    }

    if (movedAside) {
      await rm(aside, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
      publicationPath,
      pageCount: materialized.pageCount,
      ...(materialized.rewrittenCitationPages !== undefined
        ? { rewrittenCitationPages: materialized.rewrittenCitationPages }
        : {}),
      ...(materialized.stampedPages !== undefined
        ? { stampedPages: materialized.stampedPages }
        : {}),
      ...(materialized.logChanges !== undefined ? { logChanges: materialized.logChanges } : {}),
      ...(materialized.regeneratedIndexes !== undefined
        ? { regeneratedIndexes: materialized.regeneratedIndexes }
        : {}),
    };
  });
}
