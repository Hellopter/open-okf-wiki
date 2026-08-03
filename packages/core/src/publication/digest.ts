/**
 * Content-addressed publication tree digests and manifests (ADR 0017 / 0035).
 */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type PublicationTreeManifest = {
  schema: 1;
  files: Array<{ path: string; digest: string; size: number }>;
};

const EMPTY_MANIFEST: PublicationTreeManifest = { schema: 1, files: [] };

/** Canonical digest of an empty publication tree (first-publish baseline). */
export const EMPTY_PUBLICATION_DIGEST = digestJson(EMPTY_MANIFEST);

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
