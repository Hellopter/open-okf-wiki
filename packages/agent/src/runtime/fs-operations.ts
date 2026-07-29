/**
 * Pi tool Operations write-scope / ignore wrappers (ADR 0030).
 *
 * Thin adapter: path policy lives in path-policy.ts, symlink defense in
 * path-guard.ts, grep stream filtering in grep-ignore-filter.ts.
 * When createAgentSession is given `customTools` built here, write/edit are
 * Operations-wrapped so the FS layer cannot write outside wiki/ + analysis/.
 * Read tools reject ignored source paths when an ignore list is provided.
 */

import { constants } from "node:fs";
import {
  access,
  glob as fsGlob,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type EditOperations,
  type FindOperations,
  type GrepOperations,
  type LsOperations,
  type ReadOperations,
  type ToolDefinition,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { withGrepSourceIgnoreFilter } from "./grep-ignore-filter.js";
import { guardAbs } from "./path-guard.js";
import {
  isDeniedRel,
  isIgnoredSourceRel,
  type PathAccessMode,
  type SourceIgnoreInput,
} from "./path-policy.js";

export type WikiToolOperationsOptions = {
  runWorkDir: string;
  sourceIgnores?: SourceIgnoreInput;
  /** Workdir-relative trees denied for all modes (see AssertPathAllowedOptions). */
  denyPrefixes?: readonly string[];
};

/**
 * Shared helper: resolve a symlink-safe absolute path, then run `fn` on it.
 */
async function guardedFsOp<T>(
  runWorkDir: string,
  absPath: string,
  mode: PathAccessMode,
  opts: Pick<WikiToolOperationsOptions, "sourceIgnores" | "denyPrefixes">,
  fn: (safePath: string) => Promise<T>,
): Promise<T> {
  const safePath = await guardAbs(runWorkDir, absPath, mode, opts.sourceIgnores, opts.denyPrefixes);
  return fn(safePath);
}

function assertRelativeToolPath(inputPath: unknown): void {
  if (inputPath === undefined || inputPath === "") {
    return;
  }
  if (typeof inputPath !== "string") {
    throw new Error("tool path must be a relative string");
  }
  const normalized = inputPath.replace(/\\/g, "/");
  if (
    path.isAbsolute(inputPath) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith("//")
  ) {
    throw new Error(`tool path must be relative: ${inputPath}`);
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(`tool path must not contain '..': ${inputPath}`);
  }
}

function withRelativePathGuard<T extends ToolDefinition<any, any>>(definition: T): T {
  const execute = definition.execute;
  return {
    ...definition,
    execute: (async (
      toolCallId: string,
      input: { path?: unknown },
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      context: unknown,
    ) => {
      assertRelativeToolPath(input?.path);
      return (execute as (...args: any[]) => Promise<unknown>)(
        toolCallId,
        input,
        signal,
        onUpdate,
        context,
      );
    }) as T["execute"],
  };
}

/** Read Operations: contain to runWorkDir + optional source ignores. */
export function createWikiReadOperations(options: WikiToolOperationsOptions): ReadOperations {
  const { runWorkDir, sourceIgnores, denyPrefixes } = options;
  const opts = { sourceIgnores, denyPrefixes };
  return {
    async readFile(absolutePath) {
      return guardedFsOp(runWorkDir, absolutePath, "read", opts, (safePath) => readFile(safePath));
    },
    async access(absolutePath) {
      await guardedFsOp(runWorkDir, absolutePath, "read", opts, async (safePath) => {
        await access(safePath, constants.R_OK);
      });
    },
  };
}

/** Write Operations: only wiki/ + analysis/. */
export function createWikiWriteOperations(options: WikiToolOperationsOptions): WriteOperations {
  const { runWorkDir, denyPrefixes } = options;
  const opts = { denyPrefixes };
  return {
    async writeFile(absolutePath, content) {
      await guardedFsOp(runWorkDir, absolutePath, "write", opts, async (safePath) => {
        await writeFile(safePath, content, "utf8");
      });
    },
    async mkdir(dir) {
      await guardedFsOp(runWorkDir, dir, "write", opts, async (safePath) => {
        await mkdir(safePath, { recursive: true });
      });
    },
  };
}

/** Edit Operations: read+write under write scope only. */
export function createWikiEditOperations(options: WikiToolOperationsOptions): EditOperations {
  const { runWorkDir, denyPrefixes } = options;
  const opts = { denyPrefixes };
  return {
    async readFile(absolutePath) {
      // edit only targets files that may be written
      return guardedFsOp(runWorkDir, absolutePath, "write", opts, (safePath) => readFile(safePath));
    },
    async writeFile(absolutePath, content) {
      await guardedFsOp(runWorkDir, absolutePath, "write", opts, async (safePath) => {
        await writeFile(safePath, content, "utf8");
      });
    },
    async access(absolutePath) {
      await guardedFsOp(runWorkDir, absolutePath, "write", opts, async (safePath) => {
        await access(safePath, constants.R_OK | constants.W_OK);
      });
    },
  };
}

/** Ls Operations: contain + hide ignored source entries when listing. */
export function createWikiLsOperations(options: WikiToolOperationsOptions): LsOperations {
  const { runWorkDir, sourceIgnores, denyPrefixes } = options;
  const opts = { sourceIgnores, denyPrefixes };
  const root = path.resolve(runWorkDir);
  return {
    async exists(absolutePath) {
      try {
        await guardedFsOp(runWorkDir, absolutePath, "read", opts, async (safePath) => {
          await access(safePath, constants.R_OK);
        });
        return true;
      } catch {
        return false;
      }
    },
    async stat(absolutePath) {
      return guardedFsOp(runWorkDir, absolutePath, "read", opts, async (safePath) => {
        const info = await stat(safePath);
        return { isDirectory: () => info.isDirectory() };
      });
    },
    async readdir(absolutePath) {
      return guardedFsOp(runWorkDir, absolutePath, "read", opts, async (safePath) => {
        const names = await readdir(safePath);
        if (!sourceIgnores && (!denyPrefixes || denyPrefixes.length === 0)) {
          return names;
        }
        const parentRel = path.relative(root, absolutePath).replace(/\\/g, "/");
        return names.filter((name) => {
          const childRel = parentRel ? `${parentRel}/${name}` : name;
          if (isDeniedRel(childRel, denyPrefixes)) return false;
          return !isIgnoredSourceRel(childRel, sourceIgnores);
        });
      });
    },
  };
}

/** Grep Operations: path containment + ignore on readFile. */
export function createWikiGrepOperations(options: WikiToolOperationsOptions): GrepOperations {
  const { runWorkDir, sourceIgnores, denyPrefixes } = options;
  const opts = { sourceIgnores, denyPrefixes };
  return {
    async isDirectory(absolutePath) {
      return guardedFsOp(runWorkDir, absolutePath, "read", opts, async (safePath) => {
        const info = await stat(safePath);
        return info.isDirectory();
      });
    },
    async readFile(absolutePath) {
      return guardedFsOp(runWorkDir, absolutePath, "read", opts, (safePath) =>
        readFile(safePath, "utf8"),
      );
    },
  };
}

/** Find Operations: native glob with the same containment and ignore policy. */
export function createWikiFindOperations(options: WikiToolOperationsOptions): FindOperations {
  const { runWorkDir, sourceIgnores, denyPrefixes } = options;
  const opts = { sourceIgnores, denyPrefixes };
  return {
    async exists(absolutePath) {
      try {
        await guardedFsOp(runWorkDir, absolutePath, "read", opts, async (safePath) => {
          await access(safePath, constants.R_OK);
        });
        return true;
      } catch {
        return false;
      }
    },
    async glob(pattern, cwd, { ignore, limit }) {
      const safeCwd = await guardAbs(runWorkDir, cwd, "read", sourceIgnores, denyPrefixes);
      const matches: string[] = [];
      for await (const candidate of fsGlob(pattern, {
        cwd: safeCwd,
        exclude: ignore,
      })) {
        const absoluteCandidate = path.isAbsolute(candidate)
          ? candidate
          : path.resolve(safeCwd, candidate);
        try {
          const safeCandidate = await guardAbs(
            runWorkDir,
            absoluteCandidate,
            "read",
            sourceIgnores,
            denyPrefixes,
          );
          matches.push(safeCandidate);
        } catch {
          continue;
        }
        if (matches.length >= limit) {
          break;
        }
      }
      return matches;
    },
  };
}

export type BuildWikiScopedToolsInput = {
  runWorkDir: string;
  /** When true, include write + edit tool definitions. */
  mayWrite: boolean;
  sourceIgnores?: SourceIgnoreInput;
  /** Workdir-relative trees denied for all modes (see AssertPathAllowedOptions). */
  denyPrefixes?: readonly string[];
};

/**
 * Build Pi ToolDefinitions that override built-ins via `customTools`.
 * Names match the allowlist from tool-policy (`read`, `ls`, `grep`, `find`,
 * and optionally `write` / `edit`).
 *
 * `find` is a custom implementation (createWikiFindOperations) with glob
 * containment and Source-Ignore filtering, same as read/ls/grep path guards.
 * Return type is loose so heterogeneous ToolDefinition generics can share an array
 * (same pattern as createAgentSession `customTools`).
 */
export function buildWikiScopedToolDefinitions(
  input: BuildWikiScopedToolsInput,
): ToolDefinition<any, any>[] {
  const runWorkDir = path.resolve(input.runWorkDir);
  const opsOpts: WikiToolOperationsOptions = {
    runWorkDir,
    sourceIgnores: input.sourceIgnores,
    denyPrefixes: input.denyPrefixes,
  };

  const defs: ToolDefinition<any, any>[] = [
    withRelativePathGuard(
      createReadToolDefinition(runWorkDir, {
        operations: createWikiReadOperations(opsOpts),
      }),
    ),
    withRelativePathGuard(
      createLsToolDefinition(runWorkDir, {
        operations: createWikiLsOperations(opsOpts),
      }),
    ),
    withGrepSourceIgnoreFilter(
      withRelativePathGuard(
        createGrepToolDefinition(runWorkDir, {
          operations: createWikiGrepOperations(opsOpts),
        }),
      ),
      opsOpts,
    ),
    withRelativePathGuard(
      createFindToolDefinition(runWorkDir, {
        operations: createWikiFindOperations(opsOpts),
      }),
    ),
  ];

  if (input.mayWrite) {
    defs.push(
      withRelativePathGuard(
        createWriteToolDefinition(runWorkDir, {
          operations: createWikiWriteOperations(opsOpts),
        }),
      ),
      withRelativePathGuard(
        createEditToolDefinition(runWorkDir, {
          operations: createWikiEditOperations(opsOpts),
        }),
      ),
    );
  }

  return defs;
}
