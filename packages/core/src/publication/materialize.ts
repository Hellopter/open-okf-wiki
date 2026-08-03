/**
 * Staging → publication candidate transforms (ADR 0035 prepare.publication).
 *
 * Builds the exact candidate tree (rewrite / index / log / stamp). Does not take
 * the publication lock, touch effect markers, or rename onto the live path.
 */

import { cp, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { rewriteRepoCitationsToRelative } from "../citation-rewrite.js";
import { type OkfStamp, stampWikiTreeForPublish } from "../okf-stamp.js";
import { assertAbsolutePath, assertNoSymlinkComponents, isPathInside } from "../paths.js";
import { validateWikiTree } from "../validate-wiki.js";
import { regenerateWikiIndexes, validateWikiIndexes } from "../wiki-index.js";
import { updateWikiLogForPublish } from "../wiki-log.js";
import { countMarkdownFiles, scanWikiTree } from "../wiki-tree.js";

/** Fields reported after materializing a publication candidate tree. */
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

  if (isPathInside(wikiDir, candidateDir) || isPathInside(candidateDir, wikiDir)) {
    throw new Error(`wikiDir and candidateDir must not overlap: ${wikiDir} vs ${candidateDir}`);
  }
  if (
    isPathInside(wikiDir, publicationPath) ||
    isPathInside(publicationPath, wikiDir) ||
    isPathInside(candidateDir, publicationPath) ||
    isPathInside(publicationPath, candidateDir)
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
