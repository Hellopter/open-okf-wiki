/**
 * Run Boundary freeze entry (ADR 0019 / 0030 / 0035).
 *
 * Fail-closed readiness for one Wiki Run: sources git+clean, Producer Skill
 * path + digest materialisation under an allocated run id. Does **not** write
 * `okf.wiki-run/v2` Run Records — durable control ownership is WikiRuns.
 * No Pi / framework deps.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { RepositorySnapshot } from "@okf-wiki/contract/wiki-runs";
import type { WorkspaceConfig } from "@okf-wiki/contract/workspace";
import { cleanupWritableTree } from "./atomicity.js";
import { probeLocalGit } from "./git.js";
import { materializeRepositorySnapshot } from "./repository-snapshot.js";
import { analysisDir as runAnalysisDir, runSkillDir, runsDir, runWorkDir } from "./run-layout.js";
import { materializeSkillVersion, skillDigest } from "./skill-digest.js";
import { resolveSkillPath } from "./skill-path.js";
import { effectiveIgnoresForSource } from "./source-ignores.js";

export type FreezeWikiRunErrorCode =
  | "no_sources"
  | "source_not_git"
  | "source_dirty"
  | "skill_resolve";

export class FreezeWikiRunError extends Error {
  readonly code: FreezeWikiRunErrorCode;
  readonly sourceId?: string;
  readonly details?: unknown;

  constructor(
    code: FreezeWikiRunErrorCode,
    message: string,
    opts?: { sourceId?: string; details?: unknown; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "FreezeWikiRunError";
    this.code = code;
    this.sourceId = opts?.sourceId;
    this.details = opts?.details;
  }
}

export type FrozenSourceSnapshot = RepositorySnapshot & {
  /** Absolute path to the immutable, run-owned ordinary-file tree. */
  path: string;
};

type ReadySource = RepositorySnapshot & {
  repositoryPath: string;
};

/** Materialize immutable run inputs under a run id allocated by the caller (WikiRuns). */
export type FreezeRunBoundaryInput = {
  workspace: WorkspaceConfig;
  runId: string;
  /** Cancels source/Skill materialisation and removes the run-owned tree. */
  signal?: AbortSignal;
};

export type FrozenRunBoundary = {
  runId: string;
  /** Absolute run workdir: …/runs/<runId>/ */
  runWorkDir: string;
  /** Staging Wiki directory under the run workdir. */
  wikiDir: string;
  /** Analysis scratch (spec, receipts, defects). */
  analysisDir: string;
  /** Materialized Producer Skill directory (read-only). */
  skillPath: string;
  skillDigest: string;
  sources: FrozenSourceSnapshot[];
  /** sourceId → absolute path under sources/. */
  sourcePathMap: Map<string, string>;
  /** Effective Source Ignores for Operations wrappers. */
  sourceIgnores: Map<string, readonly string[]>;
};

async function assertSourcesReady(
  workspace: WorkspaceConfig,
  signal?: AbortSignal,
): Promise<ReadySource[]> {
  const sources = workspace.sources ?? [];
  if (sources.length === 0) {
    throw new FreezeWikiRunError(
      "no_sources",
      "workspace must have at least one source before starting a run",
    );
  }

  const frozen: ReadySource[] = [];
  for (const source of sources) {
    signal?.throwIfAborted();
    if (!source.id?.trim() || !source.path?.trim()) {
      throw new FreezeWikiRunError("no_sources", `source entry missing id or path`, {
        sourceId: source.id,
      });
    }
    const abs = path.resolve(source.path);
    const probe = await probeLocalGit(abs, undefined, signal);
    if (!probe.isGit) {
      throw new FreezeWikiRunError(
        "source_not_git",
        `source "${source.id}" is not a git working tree: ${abs}`,
        { sourceId: source.id, details: probe },
      );
    }
    if (probe.dirty) {
      throw new FreezeWikiRunError(
        "source_dirty",
        `source "${source.id}" has a dirty git working tree; commit or stash before starting a run: ${abs}`,
        { sourceId: source.id, details: probe },
      );
    }
    if (!probe.head) {
      throw new FreezeWikiRunError(
        "source_not_git",
        `source "${source.id}" has no Git revision to freeze: ${abs}`,
        { sourceId: source.id, details: probe },
      );
    }
    frozen.push({
      id: source.id,
      repositoryPath: abs,
      revision: probe.head,
      effectiveIgnores: effectiveIgnoresForSource(source),
    });
  }
  return frozen;
}

async function freezeSkill(
  workspace: WorkspaceConfig,
  signal?: AbortSignal,
): Promise<{ skillPath: string; skillDigest: string }> {
  try {
    const skillPath = await resolveSkillPath({
      skillPath: workspace.skillPath,
      workspaceRoot: workspace.rootPath,
    });
    signal?.throwIfAborted();
    const digest = await skillDigest(skillPath, signal);
    return { skillPath, skillDigest: digest };
  } catch (err) {
    if (err instanceof FreezeWikiRunError) throw err;
    throw new FreezeWikiRunError(
      "skill_resolve",
      err instanceof Error ? err.message : "failed to freeze producer skill",
      { cause: err },
    );
  }
}

/**
 * Fail-closed freeze for an allocated Wiki Run: sources + Skill Version.
 * Does not create an `okf.wiki-run/v2` file record (WikiRuns owns control state).
 */
export async function freezeRunBoundary(input: FreezeRunBoundaryInput): Promise<FrozenRunBoundary> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.runId) || input.runId.includes("..")) {
    throw new Error("invalid runId");
  }

  const workspace = input.workspace;
  const workspaceRoot = path.resolve(workspace.rootPath);
  input.signal?.throwIfAborted();
  const sources = await assertSourcesReady(workspace, input.signal);
  const { skillPath: sourceSkillPath, skillDigest: digest } = await freezeSkill(
    workspace,
    input.signal,
  );

  const runId = input.runId;
  const runsRoot = runsDir(workspaceRoot);
  const runDir = runWorkDir(workspaceRoot, runId);
  const sourcePathMap = new Map<string, string>();
  const frozenSources: FrozenSourceSnapshot[] = [];
  const skillPath = runSkillDir(workspaceRoot, runId);
  let ownsRunDir = false;

  try {
    await mkdir(runsRoot, { recursive: true });
    try {
      await mkdir(runDir);
      ownsRunDir = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
        throw new Error(`run directory already exists: ${runDir}`, { cause: error });
      }
      throw error;
    }

    for (const source of sources) {
      input.signal?.throwIfAborted();
      const snapshotPath = path.join(runDir, "sources", source.id);
      await materializeRepositorySnapshot({
        repositoryPath: source.repositoryPath,
        revision: source.revision,
        destination: snapshotPath,
        effectiveIgnores: source.effectiveIgnores,
        signal: input.signal,
      });
      sourcePathMap.set(source.id, snapshotPath);
      frozenSources.push({
        id: source.id,
        revision: source.revision,
        effectiveIgnores: source.effectiveIgnores,
        path: snapshotPath,
      });
    }

    try {
      await materializeSkillVersion({
        sourceSkillPath,
        destination: skillPath,
        expectedDigest: digest,
        signal: input.signal,
      });
    } catch (error) {
      throw new FreezeWikiRunError(
        "skill_resolve",
        error instanceof Error ? error.message : "failed to materialize Producer Skill",
        { cause: error },
      );
    }
  } catch (error) {
    if (ownsRunDir) {
      await cleanupWritableTree(runDir);
    }
    throw error;
  }

  const sourceIgnores = new Map<string, readonly string[]>(
    frozenSources.map((source) => [source.id, source.effectiveIgnores]),
  );

  return {
    runId,
    runWorkDir: runDir,
    wikiDir: path.join(runDir, "wiki"),
    analysisDir: runAnalysisDir(workspaceRoot, runId),
    skillPath,
    skillDigest: digest,
    sources: frozenSources,
    sourcePathMap,
    sourceIgnores,
  };
}
