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
import type { ToolCore, WikiRunPaths } from "./core.js";

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

async function requireRunPaths(core: ToolCore, root: string): Promise<WikiRunPaths> {
  const workspace = await core.getWorkspaceStatus(root);
  if (!workspace.activeRunId) throw new Error("No active Wiki run. Start /wiki generate before using Wiki workflow tools.");
  return core.getRunPaths(root, { runId: workspace.activeRunId });
}

async function assertRunWritable(core: ToolCore, root: string, paths: WikiRunPaths): Promise<void> {
  const state = await core.getRunState(root, { runId: paths.runId });
  if (state.status === "complete") {
    throw new Error("The Wiki bundle is sealed and cannot be modified by agents");
  }
}

type Scope =
  | "inputs" | "method" | "analysis" | "bundle" | "plan" | "discovery" | "discoverySources"
  | "integration" | "evidence" | "coverageReview" | "coverageRereview" | "reviews" | "qa"
  | "evidenceReview" | "workflowReview" | "navigationReview" | "questions" | "readerQa";
type PathRule = `${Scope}:exact` | `${Scope}:tree`;

const ROLE_POLICY: Readonly<Record<WikiToolRole, { read: readonly PathRule[]; files: readonly PathRule[]; directories: readonly PathRule[] }>> = {
  main: { read: ["inputs:tree", "method:tree", "analysis:tree", "bundle:tree"], files: ["plan:exact", "bundle:tree"], directories: ["analysis:exact", "bundle:tree"] },
  "source-researcher": { read: ["inputs:tree", "method:tree", "analysis:tree"], files: ["discoverySources:tree"], directories: ["discoverySources:tree"] },
  "integration-researcher": { read: ["inputs:tree", "method:tree", "analysis:tree"], files: ["integration:exact"], directories: ["discovery:exact"] },
  "evidence-researcher": { read: ["inputs:tree", "method:tree", "analysis:tree"], files: ["evidence:tree"], directories: ["evidence:tree"] },
  "coverage-critic": { read: ["inputs:tree", "method:tree", "analysis:tree"], files: ["coverageReview:exact", "coverageRereview:exact"], directories: ["analysis:exact", "reviews:tree"] },
  "reviewer-evidence": { read: ["inputs:tree", "method:tree", "analysis:tree", "bundle:tree"], files: ["evidenceReview:exact"], directories: ["reviews:tree"] },
  "reviewer-workflow": { read: ["inputs:tree", "method:tree", "analysis:tree", "bundle:tree"], files: ["workflowReview:exact"], directories: ["reviews:tree"] },
  "reviewer-navigation": { read: ["inputs:tree", "method:tree", "analysis:tree", "bundle:tree"], files: ["navigationReview:exact"], directories: ["reviews:tree"] },
  "qa-question-finder": { read: ["inputs:tree", "method:tree"], files: ["questions:exact"], directories: ["qa:tree"] },
  "qa-answer-verifier": { read: ["bundle:tree", "method:tree"], files: ["readerQa:exact"], directories: ["reviews:tree"] },
};

function scopePath(paths: WikiRunPaths, scope: Scope): string {
  const analysis = resolve(paths.analysisDir);
  const reviews = resolve(analysis, "reviews");
  switch (scope) {
    case "inputs": return resolve(paths.inputsDir);
    case "method": return resolve(paths.methodDir);
    case "analysis": return analysis;
    case "bundle": return resolve(paths.bundleDir);
    case "plan": return resolve(analysis, "plan.md");
    case "discovery": return resolve(analysis, "discovery");
    case "discoverySources": return resolve(analysis, "discovery", "sources");
    case "integration": return resolve(analysis, "discovery", "integration.md");
    case "evidence": return resolve(analysis, "evidence");
    case "coverageReview": return resolve(analysis, "coverage-review.md");
    case "coverageRereview": return resolve(reviews, "coverage-rereview.md");
    case "reviews": return reviews;
    case "qa": return resolve(analysis, "qa");
    case "evidenceReview": return resolve(reviews, "evidence.md");
    case "workflowReview": return resolve(reviews, "workflow.md");
    case "navigationReview": return resolve(reviews, "navigation.md");
    case "questions": return resolve(analysis, "qa", "questions.md");
    case "readerQa": return resolve(reviews, "reader-qa.md");
  }
}

function allows(paths: WikiRunPaths, candidate: string, rules: readonly PathRule[]): boolean {
  return rules.some((rule) => {
    const [scope, mode] = rule.split(":") as [Scope, "exact" | "tree"];
    const root = scopePath(paths, scope);
    return mode === "exact" ? candidate === root : inside(root, candidate);
  });
}

async function assertReadable(core: ToolCore, root: string, target: string, role: WikiToolRole): Promise<void> {
  const paths = await requireRunPaths(core, root);
  const candidate = resolve(target);
  const allowed = allows(paths, candidate, ROLE_POLICY[role].read);
  if (!allowed) throw new Error("Read is limited to the active Wiki run's inputs, method, analysis, and bundle directories");
  if (inside(resolve(paths.analysisDir), candidate) && extname(candidate) === ".json") {
    throw new Error("Run state, locks, and persisted sessions are host-owned and cannot be read by agents");
  }
  if (inside(resolve(paths.mainSessionDir), candidate)) throw new Error("Run state, locks, and persisted sessions are host-owned and cannot be read by agents");
  await noSymlinkBetween(resolve(paths.inputsDir, ".."), candidate);
}

/**
 * The run host owns state, session data, inventory materialization, indexes,
 * provenance, and sealing. Agents may only author Markdown handoffs or pages.
 */
function assertRoleWritable(paths: WikiRunPaths, candidate: string, role: WikiToolRole): void {
  if (!allows(paths, candidate, ROLE_POLICY[role].files)) {
    throw new Error(`The ${role} agent cannot write this Wiki run path`);
  }
  if (extname(candidate) !== ".md") throw new Error("Agents may only author Markdown files");
}

async function assertWritable(core: ToolCore, root: string, target: string, role: WikiToolRole): Promise<void> {
  const paths = await requireRunPaths(core, root);
  await assertRunWritable(core, root, paths);
  const candidate = resolve(target);
  assertRoleWritable(paths, candidate, role);
  if (inside(resolve(paths.bundleDir), candidate) && (basename(candidate) === "index.md" || basename(candidate) === "log.md")) {
    throw new Error("Bundle indexes and logs are host-owned and cannot be written by agents");
  }
  await noSymlinkBetween(resolve(paths.inputsDir, ".."), candidate);
}

async function assertWritableDirectory(core: ToolCore, root: string, target: string, role: WikiToolRole): Promise<void> {
  const paths = await requireRunPaths(core, root);
  await assertRunWritable(core, root, paths);
  const candidate = resolve(target);
  if (!allows(paths, candidate, ROLE_POLICY[role].directories)) throw new Error(`The ${role} agent cannot create this Wiki run directory`);
  await noSymlinkBetween(resolve(paths.inputsDir, ".."), candidate);
}

function resolveAgainstRoot(root: string, target: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(root, target);
}

async function defaultSearchPath(core: ToolCore, root: string, role: WikiToolRole): Promise<string> {
  const paths = await requireRunPaths(core, root);
  return role === "qa-answer-verifier" ? paths.bundleDir : paths.sourcesDir;
}

/**
 * Force readonly search tools onto the active run data plane: missing `path`
 * defaults to frozen sources, and the resolved search root must be readable.
 */
function withDataPlaneSearchRoot<TDetails>(
  tool: ToolDefinition<any, TDetails>,
  root: string,
  core: ToolCore,
  role: WikiToolRole,
): ToolDefinition<any, TDetails> {
  const execute = tool.execute;
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = (params ?? {}) as { path?: string; [key: string]: unknown };
      const rawPath = typeof input.path === "string" ? input.path.trim() : "";
      const path = rawPath || (await defaultSearchPath(core, root, role));
      await assertReadable(core, root, resolveAgainstRoot(root, path), role);
      return execute(toolCallId, { ...input, path }, signal, onUpdate, ctx);
    },
  };
}

async function isInsideAllowedReadableDirs(core: ToolCore, root: string, target: string, role: WikiToolRole): Promise<boolean> {
  try {
    await assertReadable(core, root, target, role);
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
  core: ToolCore,
  options: WikiToolsetOptions = {},
): ToolDefinition<any, any>[] {
  const role = options.role ?? "main";
  const grep = withDataPlaneSearchRoot(
    createGrepToolDefinition(root, {
      operations: {
        async isDirectory(absolutePath) {
          await assertReadable(core, root, absolutePath, role);
          return (await stat(absolutePath)).isDirectory();
        },
        async readFile(absolutePath) {
          await assertReadable(core, root, absolutePath, role);
          return readFile(absolutePath, "utf8");
        },
      },
    }),
    root,
    core,
    role,
  );

  const find = withDataPlaneSearchRoot(
    createFindToolDefinition(root, {
      operations: {
        async exists(absolutePath) {
          try {
            await assertReadable(core, root, absolutePath, role);
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
            if (!(await isInsideAllowedReadableDirs(core, root, absolute, role))) continue;
            matches.push(absolute);
            if (matches.length >= options.limit) break;
          }
          return matches;
        },
      },
    }),
    root,
    core,
    role,
  );

  return [
    createReadToolDefinition(root, {
      operations: {
        async readFile(path) {
          await assertReadable(core, root, path, role);
          return readFile(path);
        },
        async access(path) {
          await assertReadable(core, root, path, role);
          await access(path);
        },
      },
    }),
    createLsToolDefinition(root, {
      operations: {
        async exists(path) {
          try {
            await assertReadable(core, root, path, role);
            await access(path);
            return true;
          } catch {
            return false;
          }
        },
        async stat(path) {
          await assertReadable(core, root, path, role);
          return stat(path);
        },
        async readdir(path) {
          await assertReadable(core, root, path, role);
          return readdir(path);
        },
      },
    }),
    grep,
    find,
    createWriteToolDefinition(root, {
      operations: {
        async mkdir(path) {
          await assertWritableDirectory(core, root, path, role);
          await mkdir(path, { recursive: true });
        },
        async writeFile(path, content) {
          await assertWritable(core, root, path, role);
          await writeFile(path, content, "utf8");
        },
      },
    }),
    createEditToolDefinition(root, {
      operations: {
        async readFile(path) {
          await assertWritable(core, root, path, role);
          return readFile(path);
        },
        async writeFile(path, content) {
          await assertWritable(core, root, path, role);
          await writeFile(path, content, "utf8");
        },
        async access(path) {
          await assertWritable(core, root, path, role);
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
 * The core directly after its phase gates; agents can only inspect state.
 */
export function createWikiHostTools(root: string, core: ToolCore): ToolDefinition<any, any>[] {
  return [
    hostTool(
      "okf_run_status",
      "Read Wiki run status",
      "Read the current state of one Wiki run. This tool cannot prepare, approve, resume, validate, or otherwise change the run.",
      Type.Object({ runId: Type.String({ minLength: 1 }) }),
      (params: { runId: string }) => core.getRunState(root, params),
    ),
  ];
}

export function createWikiToolset(
  root: string,
  core: ToolCore,
  options: WikiToolsetOptions = {},
): ToolDefinition<any, any>[] {
  return [...createWikiFilesystemTools(root, core, options), ...createWikiHostTools(root, core)];
}
