import { access, glob as fsGlob, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CoreAdapter, WikiRunPaths } from "./core-adapter.js";

export type WikiToolRole =
  | "main"
  | "source-researcher"
  | "integration-researcher"
  | "evidence-researcher"
  | "coverage-critic"
  | "reviewer-evidence"
  | "reviewer-workflow"
  | "reviewer-navigation"
  | "qa-question-finder"
  | "qa-answer-verifier";

export interface WikiToolsetOptions {
  /** Defaults to main for direct callers; orchestration must pass the actual role. */
  role?: WikiToolRole;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`${sep}..${sep}`));
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function methodDir(paths: WikiRunPaths): string {
  return resolve(paths.inputsDir, "..", "method");
}

async function noSymlinkBetween(root: string, target: string): Promise<void> {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (!inside(normalizedRoot, normalizedTarget)) throw new Error("Path escapes the active Wiki run");

  const rel = relative(normalizedRoot, normalizedTarget);
  let current = normalizedRoot;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symbolic links are not permitted: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

async function requireRunPaths(adapter: CoreAdapter, root: string): Promise<WikiRunPaths> {
  const paths = await adapter.getRunPaths(root);
  if (!paths) throw new Error("No active Wiki run. Start /wiki generate before using Wiki workflow tools.");
  return paths;
}

async function assertRunWritable(adapter: CoreAdapter, root: string, paths: WikiRunPaths): Promise<void> {
  const state = await adapter.getRunState(root, { runId: paths.runId });
  if (state?.status === "complete" || state?.status === "completed") {
    throw new Error("The Wiki bundle is sealed and cannot be modified by agents");
  }
}

function readableRoots(paths: WikiRunPaths, role: WikiToolRole): string[] {
  const inputs = resolve(paths.inputsDir);
  const method = methodDir(paths);
  const analysis = resolve(paths.analysisDir);
  const bundle = resolve(paths.bundleDir);
  if (role === "main") return [inputs, method, analysis, bundle];
  if (role === "qa-question-finder") return [inputs, method];
  if (role === "qa-answer-verifier") return [bundle, method];
  if (role === "reviewer-evidence" || role === "reviewer-workflow" || role === "reviewer-navigation") {
    return [inputs, method, analysis, bundle];
  }
  return [inputs, method, analysis];
}

async function assertReadable(adapter: CoreAdapter, root: string, target: string, role: WikiToolRole): Promise<void> {
  const paths = await requireRunPaths(adapter, root);
  const candidate = resolve(target);
  const allowed = readableRoots(paths, role).some((dir) => inside(dir, candidate));
  if (!allowed) throw new Error("Read is limited to the active Wiki run's inputs, method, analysis, and bundle directories");
  if (inside(resolve(paths.analysisDir), candidate) && extname(candidate) === ".json") {
    throw new Error("Run state, locks, and persisted sessions are host-owned and cannot be read by agents");
  }
  if (inside(resolve(paths.sessionDir), candidate)) throw new Error("Run state, locks, and persisted sessions are host-owned and cannot be read by agents");
  await noSymlinkBetween(resolve(paths.inputsDir, ".."), candidate);
}

/**
 * The run host owns state, session data, inventory materialization, indexes,
 * provenance, and sealing. Agents may only author Markdown handoffs or pages.
 */
function assertRoleWritable(paths: WikiRunPaths, candidate: string, role: WikiToolRole): void {
  const plan = resolve(paths.analysisDir, "plan.md");
  const discoverySources = resolve(paths.analysisDir, "discovery", "sources");
  const integration = resolve(paths.analysisDir, "discovery", "integration.md");
  const evidence = resolve(paths.analysisDir, "evidence");
  const coverage = resolve(paths.analysisDir, "coverage");
  const reviews = resolve(paths.analysisDir, "reviews");
  const qa = resolve(paths.analysisDir, "qa");
  const bundle = resolve(paths.bundleDir);

  const allowed =
    (role === "main" && (candidate === plan || inside(bundle, candidate))) ||
    (role === "source-researcher" && inside(discoverySources, candidate)) ||
    (role === "integration-researcher" && candidate === integration) ||
    (role === "evidence-researcher" && inside(evidence, candidate)) ||
    (role === "coverage-critic" && (candidate === resolve(paths.analysisDir, "coverage-review.md") || candidate === resolve(reviews, "coverage-rereview.md"))) ||
    (role === "reviewer-evidence" && candidate === resolve(reviews, "evidence.md")) ||
    (role === "reviewer-workflow" && candidate === resolve(reviews, "workflow.md")) ||
    (role === "reviewer-navigation" && candidate === resolve(reviews, "navigation.md")) ||
    (role === "qa-question-finder" && candidate === resolve(qa, "questions.md")) ||
    (role === "qa-answer-verifier" && candidate === resolve(reviews, "reader-qa.md"));
  if (!allowed) {
    throw new Error(`The ${role} agent cannot write this Wiki run path`);
  }
  if (extname(candidate) !== ".md") throw new Error("Agents may only author Markdown files");
}

async function assertWritable(adapter: CoreAdapter, root: string, target: string, role: WikiToolRole): Promise<void> {
  const paths = await requireRunPaths(adapter, root);
  await assertRunWritable(adapter, root, paths);
  const candidate = resolve(target);
  assertRoleWritable(paths, candidate, role);
  if (inside(resolve(paths.bundleDir), candidate) && (basename(candidate) === "index.md" || basename(candidate) === "log.md")) {
    throw new Error("Bundle indexes and logs are host-owned and cannot be written by agents");
  }
  await noSymlinkBetween(resolve(paths.inputsDir, ".."), candidate);
}

async function assertWritableDirectory(adapter: CoreAdapter, root: string, target: string, role: WikiToolRole): Promise<void> {
  const paths = await requireRunPaths(adapter, root);
  await assertRunWritable(adapter, root, paths);
  const candidate = resolve(target);
  const discoverySources = resolve(paths.analysisDir, "discovery", "sources");
  const evidence = resolve(paths.analysisDir, "evidence");
  const coverage = resolve(paths.analysisDir, "coverage");
  const reviews = resolve(paths.analysisDir, "reviews");
  const qa = resolve(paths.analysisDir, "qa");
  const allowed =
    (role === "main" && candidate === resolve(paths.analysisDir)) ||
    (role === "source-researcher" && inside(discoverySources, candidate)) ||
    (role === "integration-researcher" && candidate === resolve(paths.analysisDir, "discovery")) ||
    (role === "evidence-researcher" && inside(evidence, candidate)) ||
    (role === "coverage-critic" && (candidate === resolve(paths.analysisDir) || inside(coverage, candidate) || inside(reviews, candidate))) ||
    ((role === "reviewer-evidence" || role === "reviewer-workflow" || role === "reviewer-navigation" || role === "qa-answer-verifier") && inside(reviews, candidate)) ||
    (role === "qa-question-finder" && inside(qa, candidate)) ||
    (role === "main" && inside(resolve(paths.bundleDir), candidate));
  if (!allowed) throw new Error(`The ${role} agent cannot create this Wiki run directory`);
  await noSymlinkBetween(resolve(paths.inputsDir, ".."), candidate);
}

function resolveAgainstRoot(root: string, target: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(root, target);
}

async function defaultSearchPath(adapter: CoreAdapter, root: string, role: WikiToolRole): Promise<string> {
  const paths = await requireRunPaths(adapter, root);
  return role === "qa-answer-verifier" ? paths.bundleDir : paths.sourcesDir;
}

/**
 * Force readonly search tools onto the active run data plane: missing `path`
 * defaults to frozen sources, and the resolved search root must be readable.
 */
function withDataPlaneSearchRoot<TDetails>(
  tool: ToolDefinition<any, TDetails>,
  root: string,
  adapter: CoreAdapter,
  role: WikiToolRole,
): ToolDefinition<any, TDetails> {
  const execute = tool.execute;
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = (params ?? {}) as { path?: string; [key: string]: unknown };
      const rawPath = typeof input.path === "string" ? input.path.trim() : "";
      const path = rawPath || (await defaultSearchPath(adapter, root, role));
      await assertReadable(adapter, root, resolveAgainstRoot(root, path), role);
      return execute(toolCallId, { ...input, path }, signal, onUpdate, ctx);
    },
  };
}

async function isInsideAllowedReadableDirs(adapter: CoreAdapter, root: string, target: string, role: WikiToolRole): Promise<boolean> {
  try {
    await assertReadable(adapter, root, target, role);
    return true;
  } catch {
    return false;
  }
}

/**
 * Filesystem tools exposed to Wiki agents. `bash` stays absent and every path
 * is bounded to the active run. Semantic handoffs are Markdown; JSON state and
 * session data are host-owned and cannot be written by these tools.
 */
export function createWikiFilesystemTools(
  root: string,
  adapter: CoreAdapter,
  options: WikiToolsetOptions = {},
): ToolDefinition<any, any>[] {
  const role = options.role ?? "main";
  const grep = withDataPlaneSearchRoot(
    createGrepToolDefinition(root, {
      operations: {
        async isDirectory(absolutePath) {
          await assertReadable(adapter, root, absolutePath, role);
          return (await stat(absolutePath)).isDirectory();
        },
        async readFile(absolutePath) {
          await assertReadable(adapter, root, absolutePath, role);
          return readFile(absolutePath, "utf8");
        },
      },
    }),
    root,
    adapter,
    role,
  );

  const find = withDataPlaneSearchRoot(
    createFindToolDefinition(root, {
      operations: {
        async exists(absolutePath) {
          try {
            await assertReadable(adapter, root, absolutePath, role);
            await access(absolutePath);
            return true;
          } catch {
            return false;
          }
        },
        async glob(pattern, cwd, options) {
          const matches: string[] = [];
          const ignore = options.ignore ?? [];
          for await (const entry of fsGlob(pattern, {
            cwd,
            withFileTypes: false,
            exclude: (name) => {
              const rel = typeof name === "string" ? name : String(name);
              return ignore.some((rule) => {
                if (rule.includes("node_modules") && (rel === "node_modules" || rel.includes(`${sep}node_modules`))) return true;
                if (rule.includes(".git") && (rel === ".git" || rel.includes(`${sep}.git`))) return true;
                return false;
              });
            },
          })) {
            const absolute = isAbsolute(entry) ? resolve(entry) : resolve(cwd, entry);
            if (!(await isInsideAllowedReadableDirs(adapter, root, absolute, role))) continue;
            matches.push(absolute);
            if (matches.length >= options.limit) break;
          }
          return matches;
        },
      },
    }),
    root,
    adapter,
    role,
  );

  return [
    createReadToolDefinition(root, {
      operations: {
        async readFile(path) {
          await assertReadable(adapter, root, path, role);
          return readFile(path);
        },
        async access(path) {
          await assertReadable(adapter, root, path, role);
          await access(path);
        },
      },
    }),
    createLsToolDefinition(root, {
      operations: {
        async exists(path) {
          try {
            await assertReadable(adapter, root, path, role);
            await access(path);
            return true;
          } catch {
            return false;
          }
        },
        async stat(path) {
          await assertReadable(adapter, root, path, role);
          return stat(path);
        },
        async readdir(path) {
          await assertReadable(adapter, root, path, role);
          return readdir(path);
        },
      },
    }),
    grep,
    find,
    createWriteToolDefinition(root, {
      operations: {
        async mkdir(path) {
          await assertWritableDirectory(adapter, root, path, role);
          await mkdir(path, { recursive: true });
        },
        async writeFile(path, content) {
          await assertWritable(adapter, root, path, role);
          await writeFile(path, content, "utf8");
        },
      },
    }),
    createEditToolDefinition(root, {
      operations: {
        async readFile(path) {
          await assertWritable(adapter, root, path, role);
          return readFile(path);
        },
        async writeFile(path, content) {
          await assertWritable(adapter, root, path, role);
          await writeFile(path, content, "utf8");
        },
        async access(path) {
          await assertWritable(adapter, root, path, role);
          await access(path);
        },
      },
    }),
  ];
}

function hostTool<T>(
  name: string,
  label: string,
  description: string,
  parameters: T,
  execute: (params: any) => Promise<unknown>,
): ToolDefinition<any> {
  return defineTool({
    name,
    label,
    description,
    parameters: parameters as any,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = await execute(params);
      return { content: [{ type: "text", text: json(result) }], details: result };
    },
  });
}

/**
 * Workflow state transitions are deliberately not agent tools. Pi calls the
 * CoreAdapter directly after its phase gates; agents can only inspect state.
 */
export function createWikiHostTools(root: string, adapter: CoreAdapter): ToolDefinition<any, any>[] {
  return [
    hostTool(
      "okf_run_status",
      "Read Wiki run status",
      "Read the current state of one Wiki run. This tool cannot prepare, approve, resume, validate, or otherwise change the run.",
      Type.Object({ runId: Type.String({ minLength: 1 }) }),
      (params: { runId: string }) => adapter.getRunState(root, params),
    ),
  ];
}

export function createWikiToolset(
  root: string,
  adapter: CoreAdapter,
  options: WikiToolsetOptions = {},
): ToolDefinition<any, any>[] {
  return [...createWikiFilesystemTools(root, adapter, options), ...createWikiHostTools(root, adapter)];
}
