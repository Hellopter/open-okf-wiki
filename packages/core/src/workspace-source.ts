import { randomUUID } from "node:crypto";
import path from "node:path";
import { type GitProbe, type WorkspaceConfig, type WorkspaceSource, WorkspaceSourceSchema } from "@okf-wiki/contract/workspace";
import { probeLocalGit } from "./git.js";
import { assertAbsolutePath, resolveExistingDir } from "./paths.js";
import { WorkspaceIntakeError } from "./workspace-errors.js";

export type AddSourceInput = {
  id: string;
  path: string;
  applyDefaultIgnores?: boolean;
  ignore?: string[];
  /** How the source was attached; defaults to path-linked. */
  origin?: WorkspaceSource["origin"];
};

export type AddSourceOptions = {
  /**
   * When true (default), reject dirty working trees.
   * Set false when editing saved workspace config; probe is still returned.
   */
  requireClean?: boolean;
};

/**
 * Probe a local Git path and append it as a workspace source.
 * Always fails when the path is not a Git working tree.
 */
export async function addSource(
  config: WorkspaceConfig,
  input: AddSourceInput,
  options: AddSourceOptions = {},
): Promise<{ config: WorkspaceConfig; probe: GitProbe; source: WorkspaceSource }> {
  const requireClean = options.requireClean ?? true;
  const absoluteSourcePath = assertAbsolutePath(input.path, "path");
  const sourcePath = await resolveExistingDir(absoluteSourcePath);
  const probe = await probeLocalGit(sourcePath);

  if (!probe.isGit) {
    const detail = probe.error ? `: ${probe.error}` : "";
    throw new WorkspaceIntakeError(
      "source_not_git",
      `not a git working tree: ${sourcePath}${detail}`,
    );
  }
  if (requireClean && probe.dirty) {
    throw new WorkspaceIntakeError("source_not_git", `git working tree is dirty: ${sourcePath}`);
  }

  if (config.sources.some((source) => source.id === input.id)) {
    throw new WorkspaceIntakeError("source_exists", `source id already exists: ${input.id}`);
  }
  if (config.sources.some((source) => path.resolve(source.path) === sourcePath)) {
    throw new WorkspaceIntakeError(
      "source_exists",
      `source path already registered: ${sourcePath}`,
    );
  }

  const source = WorkspaceSourceSchema.parse({
    id: input.id,
    path: sourcePath,
    applyDefaultIgnores: input.applyDefaultIgnores,
    ignore: input.ignore,
    ...(input.origin ? { origin: input.origin } : { origin: { type: "path" as const } }),
  });

  return {
    config: {
      ...config,
      sources: [...config.sources, source],
    },
    probe,
    source,
  };
}

/** Remove a source by id. Throws if missing. */
export function removeSource(config: WorkspaceConfig, sourceId: string): WorkspaceConfig {
  const sources = config.sources.filter((source) => source.id !== sourceId);
  if (sources.length === config.sources.length) {
    throw new WorkspaceIntakeError("source_not_found", `source not found: ${sourceId}`);
  }
  return { ...config, sources };
}

export type UpdateSourceInput = {
  applyDefaultIgnores?: boolean;
  ignore?: string[];
};

/**
 * Update ignore policy for an existing source. Path and id are immutable here.
 */
export function updateSource(
  config: WorkspaceConfig,
  sourceId: string,
  input: UpdateSourceInput,
): WorkspaceConfig {
  const index = config.sources.findIndex((source) => source.id === sourceId);
  if (index < 0) {
    throw new WorkspaceIntakeError("source_not_found", `source not found: ${sourceId}`);
  }
  const current = config.sources[index]!;
  const nextSource = WorkspaceSourceSchema.parse({
    ...current,
    ...(input.applyDefaultIgnores !== undefined
      ? { applyDefaultIgnores: input.applyDefaultIgnores }
      : {}),
    ...(input.ignore !== undefined ? { ignore: input.ignore } : {}),
  });
  const sources = [...config.sources];
  sources[index] = nextSource;
  return { ...config, sources };
}

/** Derive a SourceIdSchema-compatible slug from a filesystem path. */
export function slugFromPath(rawPath: string): string {
  const base = path
    .basename(path.resolve(rawPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let slug = base.length > 0 ? base : "source";
  if (!/^[a-z]/.test(slug)) {
    slug = `s-${slug}`;
  }
  return slug.slice(0, 63);
}

/** Pick an unused source id, appending -2, -3, … on collision. */
export function uniqueSourceId(desired: string, existing: readonly WorkspaceSource[]): string {
  const taken = new Set(existing.map((s) => s.id));
  if (!taken.has(desired) && /^[a-z][a-z0-9-]{0,62}$/.test(desired)) {
    return desired;
  }
  const base = /^[a-z][a-z0-9-]{0,62}$/.test(desired) ? desired : slugFromPath(desired);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 60)}-${i}`.slice(0, 63);
    if (!taken.has(candidate) && /^[a-z][a-z0-9-]{0,62}$/.test(candidate)) {
      return candidate;
    }
  }
  return `src-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}
