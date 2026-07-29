/**
 * Filesystem durability helpers for WikiRuns seal / cleanup.
 */

import { chmod, lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { fileDigest } from "./crypto-util.js";
import type { ArtifactManifest } from "./types.js";

/** A content-only manifest makes an Artifact independently verifiable after restart. */
export async function manifestFor(
  directory: string,
  ignoreSealManifest = false,
): Promise<ArtifactManifest> {
  const files: ArtifactManifest["files"] = [];
  const visit = async (absolute: string, relative: string): Promise<void> => {
    for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = path.join(absolute, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (ignoreSealManifest && !relative && entry.name === ".okf-artifact-manifest.json") continue;
      const info = await lstat(child);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error(`artifact contains a non-ordinary entry: ${child}`);
      }
      if (info.isDirectory()) await visit(child, childRelative);
      else files.push({ path: childRelative, digest: await fileDigest(child), size: info.size });
    }
  };
  await visit(directory, "");
  return { schema: 1, files };
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

