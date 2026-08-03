/**
 * Deterministic CoverageInventory builder from sealed snapshot roots.
 *
 * Walks ordinary files only (no symlink follow), applies Effective Source Ignores,
 * and discovers package/workspace surfaces. Soft caps bound cost; truncation is
 * recorded per source rather than failing the inventory.
 */

import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { unitIdForSurface } from "@okf-wiki/contract/coverage";
import {
  type CoverageInventory,
  type CoverageSourceRecord,
  type CoverageSurface,
  type CoverageUnit,
  makeSourceUnit,
  makeSurfaceUnit,
  normalizeSurfacePath,
} from "./coverage-types.js";
import { assertAbsolutePath } from "./paths.js";
import { entryMatchesIgnore, pathMatchesIgnore } from "./source-ignores.js";

/** Soft cap: max ordinary files counted/visited per source. */
export const INVENTORY_MAX_FILES_PER_SOURCE = 20_000;
/** Soft cap: max surfaces retained per source (after deterministic sort). */
export const INVENTORY_MAX_SURFACES_PER_SOURCE = 48;
/**
 * File-count threshold for the inventory `large` aggregate (aligned with
 * adaptive-router LARGE_FILE_THRESHOLD).
 */
export const INVENTORY_LARGE_FILE_THRESHOLD = 2_000;

/** Package / workspace manifests that mark multi-entry surfaces. */
export const PACKAGE_MANIFEST_NAMES = Object.freeze([
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
] as const);

/** Top-level monorepo workspace parent directories. */
export const WORKSPACE_PARENT_DIRS = Object.freeze([
  "apps",
  "packages",
  "services",
  "libs",
] as const);

const MANIFEST_SET = new Set<string>(PACKAGE_MANIFEST_NAMES);
const WORKSPACE_PARENT_SET = new Set<string>(WORKSPACE_PARENT_DIRS);

/** Extension → language key (sorted uniqueness later). */
const EXT_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  c: "c",
  h: "c",
  hpp: "cpp",
  swift: "swift",
  scala: "scala",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  r: "r",
  lua: "lua",
  dart: "dart",
  vue: "vue",
  svelte: "svelte",
});

export type InventorySourceInput = {
  id: string;
  /** Absolute path to a sealed snapshot root. */
  path: string;
  /** Effective Source Ignores for this source (defaults applied if omitted). */
  effectiveIgnores?: readonly string[];
};

export type BuildCoverageInventoryOptions = {
  maxFilesPerSource?: number;
  maxSurfacesPerSource?: number;
  largeFileThreshold?: number;
  signal?: AbortSignal;
};

/**
 * Build a deterministic CoverageInventory from frozen snapshot roots.
 * Source order follows the input array; surfaces/languages/units are sorted.
 */
export async function buildCoverageInventory(
  sources: readonly InventorySourceInput[],
  options: BuildCoverageInventoryOptions = {},
): Promise<CoverageInventory> {
  const maxFiles = options.maxFilesPerSource ?? INVENTORY_MAX_FILES_PER_SOURCE;
  const maxSurfaces = options.maxSurfacesPerSource ?? INVENTORY_MAX_SURFACES_PER_SOURCE;
  const largeThreshold = options.largeFileThreshold ?? INVENTORY_LARGE_FILE_THRESHOLD;

  const sourceRecords: CoverageSourceRecord[] = [];
  for (const source of sources) {
    options.signal?.throwIfAborted();
    const id = source.id.trim();
    if (!id) {
      throw new Error("inventory source id must be non-empty");
    }
    const root = path.resolve(assertAbsolutePath(source.path, `source[${id}].path`));
    const ignores = source.effectiveIgnores ?? [];
    const record = await walkSource({
      sourceId: id,
      root,
      ignores,
      maxFiles,
      maxSurfaces,
      signal: options.signal,
    });
    sourceRecords.push(record);
  }

  // Flatten units: source units first (input order), then surfaces per source.
  const units: CoverageUnit[] = [];
  for (const record of sourceRecords) {
    units.push(makeSourceUnit(record.sourceId));
    for (const surface of record.surfaces) {
      units.push(makeSurfaceUnit(record.sourceId, surface.path));
    }
  }

  const fileCount = sourceRecords.reduce((n, s) => n + s.fileCount, 0);
  const languageSet = new Set<string>();
  for (const record of sourceRecords) {
    for (const lang of record.languages) languageSet.add(lang);
  }
  const languages = [...languageSet].sort((a, b) => a.localeCompare(b));
  const multiEntry = sourceRecords.some((s) => s.multiEntry);
  const sourceCount = sourceRecords.length;
  const large = sourceCount >= 2 || fileCount >= largeThreshold;

  return {
    version: 1,
    sources: sourceRecords,
    units,
    sourceCount,
    fileCount,
    languages,
    multiEntry,
    large,
  };
}

/**
 * Coarse adaptive-router shape from a CoverageInventory (no second walk).
 */
export function toAdaptiveRepositoryInventory(inventory: CoverageInventory): {
  sourceCount: number;
  fileCount: number;
  languages: readonly string[];
  multiEntry: boolean;
  large: boolean;
} {
  return {
    sourceCount: inventory.sourceCount,
    fileCount: inventory.fileCount,
    languages: inventory.languages,
    multiEntry: inventory.multiEntry,
    large: inventory.large,
  };
}

type WalkInput = {
  sourceId: string;
  root: string;
  ignores: readonly string[];
  maxFiles: number;
  maxSurfaces: number;
  signal?: AbortSignal;
};

async function walkSource(input: WalkInput): Promise<CoverageSourceRecord> {
  const { sourceId, root, ignores, maxFiles, maxSurfaces, signal } = input;

  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new Error(`inventory source root does not exist: ${root}`);
    }
    throw error;
  }
  if (rootInfo.isSymbolicLink()) {
    throw new Error(`inventory source root is a symlink: ${root}`);
  }
  if (!rootInfo.isDirectory()) {
    throw new Error(`inventory source root is not a directory: ${root}`);
  }

  let fileCount = 0;
  let truncated = false;
  let manifestCount = 0;
  const languages = new Set<string>();
  /** surface path → best origin (root < manifest < workspace_dir for upgrade). */
  const surfaceMap = new Map<string, CoverageSurface["origin"]>();

  // Always include the source root as a surface.
  surfaceMap.set(".", "root");

  // Discover top-level workspace children (apps/*, packages/*, …) without full walk.
  await discoverWorkspaceSurfaces(root, ignores, surfaceMap, signal);

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    if (truncated) return;
    signal?.throwIfAborted();

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      signal?.throwIfAborted();

      const absolutePath = path.join(directory, entry.name);
      let info;
      try {
        info = await lstat(absolutePath);
      } catch {
        continue;
      }

      // Never follow symlinks.
      if (info.isSymbolicLink()) {
        continue;
      }

      const isDir = info.isDirectory();
      if (entryMatchesIgnore(relativeDirectory, entry.name, isDir, ignores)) {
        continue;
      }

      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;

      if (isDir) {
        await walk(absolutePath, relativePath);
        continue;
      }

      if (!info.isFile()) {
        continue;
      }

      if (pathMatchesIgnore(relativePath, ignores)) {
        continue;
      }

      fileCount += 1;
      if (fileCount >= maxFiles) {
        truncated = true;
      }

      const lang = languageFromFilename(entry.name);
      if (lang) languages.add(lang);

      if (MANIFEST_SET.has(entry.name)) {
        manifestCount += 1;
        const surfacePath = normalizeSurfacePath(relativeDirectory || ".");
        // Prefer root origin when the manifest sits at the source root.
        if (surfacePath === ".") {
          surfaceMap.set(".", surfaceMap.get(".") ?? "root");
        } else {
          const prev = surfaceMap.get(surfacePath);
          if (!prev || originRank(prev) < originRank("manifest")) {
            surfaceMap.set(surfacePath, "manifest");
          }
        }
      }

      if (truncated) return;
    }
  }

  await walk(root, "");

  const surfaces = materializeSurfaces(sourceId, surfaceMap, maxSurfaces);
  const languageList = [...languages].sort((a, b) => a.localeCompare(b));

  return {
    sourceId,
    fileCount,
    languages: languageList,
    multiEntry: manifestCount >= 2,
    surfaces,
    truncated,
  };
}

async function discoverWorkspaceSurfaces(
  root: string,
  ignores: readonly string[],
  surfaceMap: Map<string, CoverageSurface["origin"]>,
  signal?: AbortSignal,
): Promise<void> {
  for (const parent of WORKSPACE_PARENT_DIRS) {
    signal?.throwIfAborted();
    if (entryMatchesIgnore("", parent, true, ignores)) continue;
    const parentAbs = path.join(root, parent);
    let parentInfo;
    try {
      parentInfo = await lstat(parentAbs);
    } catch {
      continue;
    }
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) continue;

    let children;
    try {
      children = await readdir(parentAbs, { withFileTypes: true });
    } catch {
      continue;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      signal?.throwIfAborted();
      if (entryMatchesIgnore(parent, child.name, true, ignores)) continue;
      const childAbs = path.join(parentAbs, child.name);
      let childInfo;
      try {
        childInfo = await lstat(childAbs);
      } catch {
        continue;
      }
      if (childInfo.isSymbolicLink() || !childInfo.isDirectory()) continue;
      const surfacePath = `${parent}/${child.name}`;
      const prev = surfaceMap.get(surfacePath);
      // workspace_dir is the weakest origin; do not downgrade manifest/root.
      if (!prev) {
        surfaceMap.set(surfacePath, "workspace_dir");
      }
    }
  }
}

function materializeSurfaces(
  sourceId: string,
  surfaceMap: Map<string, CoverageSurface["origin"]>,
  maxSurfaces: number,
): CoverageSurface[] {
  const paths = [...surfaceMap.keys()].sort((a, b) => {
    // Root first, then lexicographic.
    if (a === "." && b !== ".") return -1;
    if (b === "." && a !== ".") return 1;
    return a.localeCompare(b);
  });

  const out: CoverageSurface[] = [];
  for (const surfacePath of paths) {
    if (out.length >= maxSurfaces) break;
    const origin = surfaceMap.get(surfacePath)!;
    out.push({
      id: unitIdForSurface(sourceId, surfacePath),
      path: surfacePath,
      origin,
    });
  }
  return out;
}

function originRank(origin: CoverageSurface["origin"]): number {
  switch (origin) {
    case "root":
      return 3;
    case "manifest":
      return 2;
    case "workspace_dir":
      return 1;
    default:
      return 0;
  }
}

function languageFromFilename(name: string): string | undefined {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return undefined;
  const ext = lower.slice(dot + 1);
  return EXT_LANGUAGE[ext];
}

/** Exported for boundary-index / tests: package manifest basename set. */
export function isPackageManifestName(name: string): boolean {
  return MANIFEST_SET.has(name);
}

/** Exported for tests: workspace parent directory names. */
export function isWorkspaceParentDir(name: string): boolean {
  return WORKSPACE_PARENT_SET.has(name);
}
