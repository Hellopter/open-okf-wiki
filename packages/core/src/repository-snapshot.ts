import { lstat, mkdir, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupWritableTree } from "./atomicity.js";
import { createDefaultGitRunner, type GitRunner } from "./git-runner.js";
import { assertOrdinaryTree, makeTreeReadOnly } from "./immutable-tree.js";
import { entryMatchesIgnore } from "./source-ignores.js";

/**
 * Materialise one exact Git revision as a detached ordinary-file tree.
 *
 * A temporary index avoids touching the source checkout's index. Disabling
 * core.symlinks makes Git symlink blobs land as regular files containing the
 * link target instead of creating filesystem symlinks.
 */
export async function materializeRepositorySnapshot(
  input: {
    repositoryPath: string;
    revision: string;
    destination: string;
    effectiveIgnores: readonly string[];
  },
  runner: GitRunner = createDefaultGitRunner(),
): Promise<void> {
  const repositoryPath = path.resolve(input.repositoryPath);
  const destination = path.resolve(input.destination);

  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination);

  let indexDir: string | undefined;
  try {
    indexDir = await mkdtemp(path.join(os.tmpdir(), "okf-snapshot-index-"));
    const indexPath = path.join(indexDir, "index");
    const env = { GIT_INDEX_FILE: indexPath };
    const readTree = await runner(repositoryPath, ["read-tree", input.revision], { env });
    if (readTree.code !== 0) {
      throw new Error(`git read-tree failed: ${readTree.stderr || readTree.stdout}`);
    }

    const prefix = destination.endsWith(path.sep) ? destination : `${destination}${path.sep}`;
    const checkout = await runner(
      repositoryPath,
      ["-c", "core.symlinks=false", "checkout-index", "--all", "--force", `--prefix=${prefix}`],
      { env },
    );
    if (checkout.code !== 0) {
      throw new Error(`git checkout-index failed: ${checkout.stderr || checkout.stdout}`);
    }
    await removeIgnoredEntries(destination, "", input.effectiveIgnores);
    await assertOrdinaryTree(destination, "snapshot");
    await makeTreeReadOnly(destination);
  } catch (error) {
    await cleanupWritableTree(destination);
    throw error;
  } finally {
    if (indexDir) {
      await rm(indexDir, { recursive: true, force: true });
    }
  }
}

async function removeIgnoredEntries(
  directory: string,
  relativeDirectory: string,
  patterns: readonly string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const info = await lstat(absolutePath);
    if (entryMatchesIgnore(relativeDirectory, entry.name, info.isDirectory(), patterns)) {
      if (info.isSymbolicLink()) {
        await unlink(absolutePath);
      } else {
        await rm(absolutePath, { recursive: info.isDirectory(), force: true });
      }
      continue;
    }
    if (info.isDirectory()) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      await removeIgnoredEntries(absolutePath, relativePath, patterns);
    }
  }
}
