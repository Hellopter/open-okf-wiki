/**
 * Sealed candidate apply + crash reconcile (ADR 0035).
 *
 * Never rewrites, stamps, indexes, or otherwise changes candidate bytes.
 * Under the publication lock: verify baseline → optional beginApply CAS →
 * same-parent renames (next / aside / live) with an apply marker for recovery.
 */

import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertAbsolutePath, assertNoSymlinkComponents, isPathInside } from "../paths.js";
import { countMarkdownFiles } from "../wiki-tree.js";
import {
  digestPublicationTree,
  digestPublicationTreeContentOnly,
} from "./digest.js";
import { withPublicationLock } from "./lock.js";

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

type ApplyMarker = {
  schema: 1;
  effectKey: string;
  candidateDigest: string;
  expectedLiveDigest: string;
  nextPath: string;
  prevPath: string;
  phase: "begin" | "aside" | "swapped";
};

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
    isPathInside(candidateDir, publicationPath) ||
    isPathInside(publicationPath, candidateDir)
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
