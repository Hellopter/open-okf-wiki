/**
 * Symlink-safe path guard for wiki-scoped FS operations (ADR 0030).
 *
 * Logical containment is enforced by path-policy; this module additionally
 * realpath-checks the target so a symlink cannot escape the run workdir.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  assertAbsolutePathAllowed,
  isDeniedRel,
  isIgnoredSourceRel,
  isUnder,
  type PathAccessMode,
  type SourceIgnoreInput,
} from "./path-policy.js";

/** Walk parents until an existing path can be realpath'd (for write-to-create). */
export async function closestExistingRealPath(absolutePath: string): Promise<string> {
  let current = absolutePath;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

/**
 * Single symlink-defense API for wiki FS operations.
 *
 * Asserts logical path policy, then verifies the realpath of the target
 * (or its closest existing ancestor for write) stays inside the workdir and
 * still satisfies deny/ignore rules.
 *
 * Returns the logical absolute path (not the canonical realpath) so callers
 * write through the intended location when creating new files.
 */
export async function guardAbs(
  runWorkDir: string,
  absolutePath: string,
  mode: PathAccessMode,
  sourceIgnores?: SourceIgnoreInput,
  denyPrefixes?: readonly string[],
): Promise<string> {
  const logicalPath = assertAbsolutePathAllowed(runWorkDir, absolutePath, {
    mode,
    sourceIgnores,
    denyPrefixes,
  });
  const canonicalRoot = await realpath(path.resolve(runWorkDir));
  const canonicalPath =
    mode === "write" ? await closestExistingRealPath(logicalPath) : await realpath(logicalPath);
  if (!isUnder(canonicalRoot, canonicalPath)) {
    throw new Error(`path escapes run workdir through symlink: ${absolutePath}`);
  }

  const canonicalRel = path.relative(canonicalRoot, canonicalPath).replace(/\\/g, "/");
  if (canonicalRel && isDeniedRel(canonicalRel, denyPrefixes)) {
    throw new Error(`${mode} denied: symlink target is product-reserved (${canonicalRel})`);
  }
  if (mode === "read") {
    if (canonicalRel && isIgnoredSourceRel(canonicalRel, sourceIgnores)) {
      throw new Error(`read denied: symlink target is ignored by Source Ignores (${canonicalRel})`);
    }
  }
  return logicalPath;
}

/** Alias for {@link guardAbs} — preferred name at call sites that resolve then act. */
export const resolveGuardedAbs = guardAbs;
