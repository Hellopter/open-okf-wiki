import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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

/**
 * Publish a staging Wiki tree to the stable Published Wiki path.
 *
 * Portable MVP (ADR 0017): materialize a complete tree under a sibling temp
 * directory, then expose it via same-parent renames so readers never see a
 * half-written publication path.
 *
 * 1. Absolute paths; staging is a real directory with ≥1 `.md`
 * 2. Reject symlink components on staging / publication / parent
 * 3. Validate staging (repo: citations still required when sources set)
 * 4. Take the exclusive publication lock (`{publicationPath}.publish-lock`);
 *    concurrent publishes to the same path fail closed, never interleave
 * 5. Sweep `.next.*` / `.prev.*` residue left by a previously crashed publish
 * 6. Copy staging → `{publicationPath}.next.{ts}` (complete candidate)
 * 7. Rewrite `repo:` citations → relative `sources/<id>/…` on the candidate only
 * 8. If live publication exists → rename aside to `.prev.{ts}`
 * 9. Rename candidate → publicationPath; remove the aside on success
 * 10. On failure after moving live aside, best-effort restore from aside
 */

/** In-process serialization per publication path (same-process publishers). */
const publishTails = new Map<string, Promise<unknown>>();

/** A held lock dir older than this is treated as crash residue. */
const PUBLISH_LOCK_STALE_MS = 10 * 60 * 1000;

async function acquirePublishLockDir(lockDir: string): Promise<void> {
  try {
    await mkdir(lockDir); // non-recursive: EEXIST when another publisher holds it
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
      throw error;
    }
  }
  const info = await stat(lockDir).catch(() => null);
  if (info && Date.now() - info.mtimeMs > PUBLISH_LOCK_STALE_MS) {
    await rm(lockDir, { recursive: true, force: true });
    await mkdir(lockDir);
    return;
  }
  throw new Error(`another publish is in progress for this publication path (lock: ${lockDir})`);
}

/**
 * Exclusive publication lock (ADR 0017): in-process queue + on-disk lock dir
 * so concurrent Wiki Runs targeting the same Published Wiki path fail closed
 * instead of interleaving renames.
 */
async function withPublicationLock<T>(publicationPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = publishTails.get(publicationPath) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const lockDir = `${publicationPath}.publish-lock`;
      await acquirePublishLockDir(lockDir);
      try {
        return await fn();
      } finally {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  publishTails.set(publicationPath, run);
  try {
    return await run;
  } finally {
    if (publishTails.get(publicationPath) === run) {
      publishTails.delete(publicationPath);
    }
  }
}

/** Remove `.next.*` / `.prev.*` residue of a previously crashed publish. */
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
export async function publishStagingToPublication(
  input: PublishStagingInput,
): Promise<PublishStagingResult> {
  const stagingDir = path.resolve(assertAbsolutePath(input.stagingDir, "stagingDir"));
  const publicationPath = path.resolve(
    assertAbsolutePath(input.publicationPath, "publicationPath"),
  );

  // ADR 0017: staging and publication paths must not overlap — a nested
  // configuration would recursively self-copy or destroy its own input.
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

  // Mechanical wiki validation before any copy (frontmatter, citations, caps).
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
    // Under the lock, any .next.* / .prev.* siblings are crash residue.
    await sweepPublishResidue(publicationPath);

    const ts = Date.now();
    const candidate = `${publicationPath}.next.${ts}`;
    const aside = `${publicationPath}.prev.${ts}`;

    await cp(stagingDir, candidate, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });

    const candidateInfo = await lstat(candidate);
    if (candidateInfo.isSymbolicLink() || !candidateInfo.isDirectory()) {
      await rm(candidate, { recursive: true, force: true });
      throw new Error(`candidate release is not a directory: ${candidate}`);
    }
    const candidatePages = await countMarkdownFiles(candidate);
    if (candidatePages < 1) {
      await rm(candidate, { recursive: true, force: true });
      throw new Error(`candidate release has no markdown pages: ${candidate}`);
    }

    // Portable citations: rewrite on the candidate only (staging keeps repo: for validation).
    let rewrittenCitationPages = 0;
    if (input.sources?.length) {
      try {
        rewrittenCitationPages = await rewriteWikiTreeCitationsForPublish(
          candidate,
          input.sources.map((s) => ({ id: s.id })),
        );
      } catch (error) {
        await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }

    // OKF publish enrichment on the candidate only (staging keeps the model's
    // output). Order matters: the log diff runs before stamping so per-publish
    // timestamps do not churn every page into an Update entry; multi-level
    // index.md regeneration always runs so progressive-disclosure listings exist
    // before stamping (root index receives okf_version).
    let stampedPages = 0;
    let logChanges = 0;
    let regeneratedIndexes = 0;
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
          candidateDir: candidate,
          ...(previousDir ? { previousDir } : {}),
          date: input.stamp.generatedAt.slice(0, 10),
        });
        logChanges = log.changes;
      }
      // Always regenerate multi-level indexes on the candidate (overwrite),
      // then fail closed if structural index invariants still do not hold.
      const indexes = await regenerateWikiIndexes(candidate);
      regeneratedIndexes = indexes.written.length;
      const indexValidation = await validateWikiIndexes(candidate);
      if (!indexValidation.ok) {
        throw new Error(
          `candidate failed wiki index validation: ${indexValidation.errors.join("; ")}`,
        );
      }
      if (input.stamp) {
        const stamped = await stampWikiTreeForPublish(candidate, input.stamp);
        stampedPages = stamped.stampedPages;
      }
    } catch (error) {
      await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

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
      // Best-effort restore previous live tree if we moved it aside.
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

    // Retention is not a product feature (ADR 0017): drop the aside once the
    // swap has been verified, so publishes do not accumulate full-tree copies.
    if (movedAside) {
      await rm(aside, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
      publicationPath,
      pageCount,
      ...(rewrittenCitationPages > 0 ? { rewrittenCitationPages } : {}),
      ...(stampedPages > 0 ? { stampedPages } : {}),
      ...(logChanges > 0 ? { logChanges } : {}),
      ...(regeneratedIndexes > 0 ? { regeneratedIndexes } : {}),
    };
  });
}
