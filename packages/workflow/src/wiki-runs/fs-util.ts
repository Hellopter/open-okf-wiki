/**
 * Filesystem durability helpers for WikiRuns seal / cleanup.
 */

import { chmod, lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { manifestPublicationTree } from "@okf-wiki/core";
import type { ArtifactManifest } from "./types.js";

/**
 * Content-addressed tree manifest for WikiRuns Artifacts.
 *
 * Core is the sole authority for walk order, path form, file digests, and
 * symlink fail-closed semantics ({@link manifestPublicationTree}).
 *
 * Prepare, seal, and verify all use content-only identity
 * (`ignoreSealManifest=true`): the seal sidecar `.okf-artifact-manifest.json`
 * must not affect the digest. Otherwise repair/refresh that re-seed from an
 * already-sealed wiki_tree copy the sidecar into the stage tree, prepare
 * embeds it in the digest, seal overwrites the sidecar, and final verify fails
 * with "sealed artifact verification failed".
 */
export async function manifestFor(
  directory: string,
  ignoreSealManifest = false,
): Promise<ArtifactManifest> {
  const manifest = await manifestPublicationTree(directory);
  if (!ignoreSealManifest) return manifest;
  return {
    schema: 1,
    files: manifest.files.filter((file) => file.path !== ".okf-artifact-manifest.json"),
  };
}

/** Make only an ordinary, run-owned tree removable without following links. */
export async function makeOwnedTreeWritable(directory: string): Promise<void> {
  const info = await lstat(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  if (!info.isDirectory())
    throw new Error(`refusing to clean non-directory freeze work: ${directory}`);
  const unlocked = await chmod(directory, 0o755).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
  if (unlocked === false) return;
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!entries) return;
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    const childInfo = await lstat(child).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!childInfo) continue;
    if (childInfo.isSymbolicLink() || (!childInfo.isDirectory() && !childInfo.isFile())) {
      throw new Error(`refusing to clean non-ordinary freeze work entry: ${child}`);
    }
    if (childInfo.isDirectory()) {
      await makeOwnedTreeWritable(child);
    } else {
      await chmod(child, 0o644).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
}

/**
 * Best-effort fsync. On Windows (and some cloud/network FS) fsync may return
 * EPERM/ENOTSUP/EINVAL; durability still rests on process-local disk + rename.
 */
export async function durableFsyncPath(target: string): Promise<void> {
  const handle = await open(target, "r");
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "ENOTSUP" || code === "EINVAL" || code === "EACCES") {
      return;
    }
    throw error;
  } finally {
    await handle.close();
  }
}
