/**
 * Declarative BoundaryIndex: list of OpenAPI / proto / AsyncAPI / README /
 * package-manifest paths under sealed snapshot roots.
 *
 * Path list only — no graph edges, no inferred service relationships.
 */

import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  type BoundaryIndex,
  type BoundaryPathEntry,
  type BoundaryPathKind,
} from "./coverage-types.js";
import { assertAbsolutePath } from "./paths.js";
import {
  INVENTORY_MAX_FILES_PER_SOURCE,
  isPackageManifestName,
  type InventorySourceInput,
} from "./repository-inventory.js";
import { entryMatchesIgnore, pathMatchesIgnore } from "./source-ignores.js";

/** Soft cap on boundary entries retained per source (deterministic prefix). */
export const BOUNDARY_MAX_ENTRIES_PER_SOURCE = 200;

export type BuildBoundaryIndexOptions = {
  maxFilesPerSource?: number;
  maxEntriesPerSource?: number;
  signal?: AbortSignal;
};

/**
 * Walk sealed snapshot roots and collect declarative boundary paths.
 * Ordering: input source order, then path localeCompare within each source.
 */
export async function buildBoundaryIndex(
  sources: readonly InventorySourceInput[],
  options: BuildBoundaryIndexOptions = {},
): Promise<BoundaryIndex> {
  const maxFiles = options.maxFilesPerSource ?? INVENTORY_MAX_FILES_PER_SOURCE;
  const maxEntries = options.maxEntriesPerSource ?? BOUNDARY_MAX_ENTRIES_PER_SOURCE;
  const all: BoundaryPathEntry[] = [];

  for (const source of sources) {
    options.signal?.throwIfAborted();
    const id = source.id.trim();
    if (!id) {
      throw new Error("boundary-index source id must be non-empty");
    }
    const root = path.resolve(assertAbsolutePath(source.path, `source[${id}].path`));
    const ignores = source.effectiveIgnores ?? [];
    const entries = await walkBoundaryPaths({
      sourceId: id,
      root,
      ignores,
      maxFiles,
      maxEntries,
      signal: options.signal,
    });
    all.push(...entries);
  }

  return { version: 1, entries: all };
}

/**
 * Classify a single repo-relative file path. Returns undefined when the path
 * is not a recognized boundary artifact.
 */
export function classifyBoundaryPath(repoRelativePath: string): BoundaryPathKind | undefined {
  const normalized = repoRelativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const base = path.posix.basename(normalized);
  const lower = base.toLowerCase();

  if (isPackageManifestName(base)) {
    return "manifest";
  }
  if (lower === "readme" || lower === "readme.md" || lower === "readme.rst" || lower === "readme.txt") {
    return "readme";
  }
  if (lower.endsWith(".proto")) {
    return "proto";
  }
  // OpenAPI: openapi.yaml / *openapi*.{yaml,yml,json} / swagger.{yaml,yml,json}
  if (isOpenApiName(lower)) {
    return "openapi";
  }
  if (isAsyncApiName(lower)) {
    return "asyncapi";
  }
  return undefined;
}

function isOpenApiName(lowerBase: string): boolean {
  if (lowerBase === "openapi.yaml" || lowerBase === "openapi.yml" || lowerBase === "openapi.json") {
    return true;
  }
  if (lowerBase === "swagger.yaml" || lowerBase === "swagger.yml" || lowerBase === "swagger.json") {
    return true;
  }
  // *openapi*.{yaml,yml,json}
  if (
    lowerBase.includes("openapi") &&
    (lowerBase.endsWith(".yaml") || lowerBase.endsWith(".yml") || lowerBase.endsWith(".json"))
  ) {
    return true;
  }
  return false;
}

function isAsyncApiName(lowerBase: string): boolean {
  if (
    lowerBase === "asyncapi.yaml" ||
    lowerBase === "asyncapi.yml" ||
    lowerBase === "asyncapi.json"
  ) {
    return true;
  }
  if (
    lowerBase.includes("asyncapi") &&
    (lowerBase.endsWith(".yaml") || lowerBase.endsWith(".yml") || lowerBase.endsWith(".json"))
  ) {
    return true;
  }
  return false;
}

type WalkBoundaryInput = {
  sourceId: string;
  root: string;
  ignores: readonly string[];
  maxFiles: number;
  maxEntries: number;
  signal?: AbortSignal;
};

async function walkBoundaryPaths(input: WalkBoundaryInput): Promise<BoundaryPathEntry[]> {
  const { sourceId, root, ignores, maxFiles, maxEntries, signal } = input;

  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new Error(`boundary-index source root does not exist: ${root}`);
    }
    throw error;
  }
  if (rootInfo.isSymbolicLink()) {
    throw new Error(`boundary-index source root is a symlink: ${root}`);
  }
  if (!rootInfo.isDirectory()) {
    throw new Error(`boundary-index source root is not a directory: ${root}`);
  }

  const found: BoundaryPathEntry[] = [];
  let fileVisits = 0;
  let stop = false;

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    if (stop) return;
    signal?.throwIfAborted();

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (stop) return;
      signal?.throwIfAborted();

      const absolutePath = path.join(directory, entry.name);
      let info;
      try {
        info = await lstat(absolutePath);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;

      const isDir = info.isDirectory();
      if (entryMatchesIgnore(relativeDirectory, entry.name, isDir, ignores)) {
        continue;
      }

      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;

      if (isDir) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!info.isFile()) continue;
      if (pathMatchesIgnore(relativePath, ignores)) continue;

      fileVisits += 1;
      if (fileVisits >= maxFiles) {
        stop = true;
      }

      const kind = classifyBoundaryPath(relativePath);
      if (kind) {
        found.push({ sourceId, path: relativePath.replace(/\\/g, "/"), kind });
      }

      if (fileVisits >= maxFiles) return;
    }
  }

  await walk(root, "");

  // Deterministic order + soft cap on retained entries.
  found.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  return found.slice(0, maxEntries);
}
