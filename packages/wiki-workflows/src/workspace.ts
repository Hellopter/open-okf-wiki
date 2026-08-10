import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { git, repositoryRoot } from "./git.js";

const WORKSPACE_FILE = "workspace.yaml";
const WORKSPACE_GITIGNORE_FILE = ".gitignore";
const WIKI_INTERNAL_DIRECTORY_IGNORE = ".okf-wiki/";
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_WORKSPACE_DIRECTORIES = new Set(["wiki"]);

/** Applied to source discovery by default. Users can use each source's .gitignore for additions. */
export const DEFAULT_SOURCE_IGNORES = [
  ".git", "node_modules", ".pnpm-store", "dist", "build", "out", "target", ".venv", "venv",
  "__pycache__", ".mypy_cache", ".pytest_cache", ".tox", ".coverage", "coverage", ".nyc_output",
  ".idea", ".vscode", ".gradle", ".mvn", ".DS_Store", "Thumbs.db",
];

const DEFAULT_SOURCE_IGNORE_FILES = ["*.pyc", "*.pyo", "*.pyd", "*.class", "*.log"];

export interface WikiWorkspaceSource {
  /** The actual top-level directory name, never a separate alias. */
  path: string;
  origin: { type: "link"; localPath: string } | { type: "clone"; remoteUrl: string; ref?: string };
}

export interface WikiWorkspace {
  version: 1;
  root: string;
  configPath?: string;
  language: "zh" | "en";
  defaultSourceIgnores: boolean;
  quality: { maxResearchRounds: number };
  sources: WikiWorkspaceSource[];
}

export interface ResolvedWikiSource extends WikiWorkspaceSource {
  absolutePath: string;
  realPath: string;
  repositoryRoot: string;
}

export interface ResolvedWikiWorkspace extends WikiWorkspace {
  configPath: string;
  sources: ResolvedWikiSource[];
}

export interface InitializeWikiWorkspaceRequest {
  cwd: string;
  workspace?: string;
  language?: "zh" | "en";
}

export interface AddWikiSourceRequest {
  cwd: string;
  workspace?: string;
  source: { kind: "link"; path: string } | { kind: "clone"; url: string; ref?: string };
}

export interface WikiWorkspaceResult {
  action: "initialized" | "linked" | "cloned";
  workspace: string;
  language: "zh" | "en";
  sourcePath?: string;
}

export interface WikiWorkspaceService {
  initialize(request: InitializeWikiWorkspaceRequest): Promise<WikiWorkspaceResult>;
  addSource(request: AddWikiSourceRequest): Promise<WikiWorkspaceResult>;
  load(cwd: string): Promise<ResolvedWikiWorkspace>;
}

/** Host-side workspace operations behind the Pi command, not a CLI. */
export const wikiWorkspaceService: WikiWorkspaceService = {
  initialize: initializeWikiWorkspace,
  addSource: addWikiSource,
  load: loadWikiWorkspace,
};

/** Git's directory links avoid Windows symlink privilege requirements on local volumes. */
export function directoryLinkType(platform = process.platform): "dir" | "junction" {
  return platform === "win32" ? "junction" : "dir";
}

export async function initializeWikiWorkspace(request: InitializeWikiWorkspaceRequest): Promise<WikiWorkspaceResult> {
  const root = path.resolve(request.cwd, request.workspace ?? ".");
  await ensureDirectory(root);
  const configPath = path.join(root, WORKSPACE_FILE);
  const existing = await readWorkspaceConfig(configPath, root, false);
  const workspace: WikiWorkspace = existing
    ? { ...existing, language: request.language ?? existing.language }
    : {
      version: 1,
      root,
      configPath,
      language: request.language ?? "zh",
      defaultSourceIgnores: true,
      quality: { maxResearchRounds: 6 },
      sources: [],
  };
  await writeWorkspaceConfig(configPath, workspace);
  await ensureWikiWorkspaceInternalIgnore(root);
  return { action: "initialized", workspace: root, language: workspace.language };
}

export async function addWikiSource(request: AddWikiSourceRequest): Promise<WikiWorkspaceResult> {
  const workspace = await loadWikiWorkspace(request.workspace ? path.resolve(request.cwd, request.workspace) : request.cwd);
  const root = workspace.root;
  const sources: WikiWorkspaceSource[] = workspace.sources.map(({ path: sourcePath, origin }) => ({
    path: sourcePath,
    origin,
  }));
  let sourcePath: string;
  if (request.source.kind === "link") {
    const localPath = path.resolve(request.cwd, request.source.path);
    const repository = await realpath(await repositoryRoot(localPath));
    if (repository === await realpath(root)) throw new Error("A workspace cannot be its own source; link a project into the workspace instead");
    sourcePath = sourceDirectoryName(repository);
    assertSourceDirectoryName(sourcePath);
    await assertAvailableSourcePath(root, sourcePath);
    await linkDirectory(repository, path.join(root, sourcePath));
    sources.push({ path: sourcePath, origin: { type: "link", localPath: repository } });
  } else {
    sourcePath = sourceDirectoryName(request.source.url);
    assertSourceDirectoryName(sourcePath);
    await assertAvailableSourcePath(root, sourcePath);
    const destination = path.join(root, sourcePath);
    const args = ["clone"];
    if (request.source.ref) args.push("--branch", request.source.ref);
    args.push("--", request.source.url, destination);
    const result = await git(root, args);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not clone source into ${destination}`);
    sources.push({ path: sourcePath, origin: { type: "clone", remoteUrl: request.source.url, ref: request.source.ref } });
  }
  await writeWorkspaceConfig(workspace.configPath, {
    version: workspace.version,
    root: workspace.root,
    configPath: workspace.configPath,
    language: workspace.language,
    defaultSourceIgnores: workspace.defaultSourceIgnores,
    quality: workspace.quality,
    sources,
  });
  return {
    action: request.source.kind === "link" ? "linked" : "cloned",
    workspace: root,
    language: workspace.language,
    sourcePath,
  };
}

export async function loadWikiWorkspace(cwd: string): Promise<ResolvedWikiWorkspace> {
  const configPath = await findWorkspaceConfig(cwd);
  if (!configPath) throw new Error("No workspace.yaml found. Run /wiki init first.");
  const root = path.dirname(configPath);
  const workspace = await readWorkspaceConfig(configPath, root, true);
  if (!workspace) throw new Error("workspace.yaml is missing");
  const workspaceRealPath = await realpath(root);
  const sources = await Promise.all(workspace.sources.map(async (source) => {
    const absolutePath = path.join(root, source.path);
    const realPath = await realpath(absolutePath);
    const sourceRepository = await repositoryRoot(realPath);
    const repository = await realpath(sourceRepository);
    if (repository !== realPath) throw new Error(`Source must point to a Git repository root: ${source.path}`);
    if (repository === workspaceRealPath) throw new Error(`Source cannot be the workspace itself: ${source.path}`);
    return { ...source, absolutePath, realPath, repositoryRoot: repository };
  }));
  return { ...workspace, root, configPath, sources };
}

export function sourceIsIgnored(_source: ResolvedWikiSource, relativePath: string, defaultsEnabled: boolean): boolean {
  if (!defaultsEnabled) return false;
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  const basename = parts.at(-1) ?? "";
  return DEFAULT_SOURCE_IGNORES.some((ignored) => parts.includes(ignored))
    || DEFAULT_SOURCE_IGNORE_FILES.some((pattern) => matchesSimpleGlob(basename, pattern));
}

async function findWorkspaceConfig(cwd: string): Promise<string | undefined> {
  let candidate = path.resolve(cwd);
  while (true) {
    const config = path.join(candidate, WORKSPACE_FILE);
    try {
      if ((await lstat(config)).isFile()) return config;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

async function readWorkspaceConfig(configPath: string, root: string, required: boolean): Promise<WikiWorkspace | undefined> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (!required && isMissing(error)) return undefined;
    throw error;
  }
  let document: unknown;
  try {
    document = YAML.parse(text);
  } catch (error) {
    throw new Error(`Invalid workspace.yaml: ${errorMessage(error)}`);
  }
  if (!isRecord(document) || document.version !== 1) throw new Error("workspace.yaml must declare version: 1");
  if (document.language !== "zh" && document.language !== "en") throw new Error("workspace.yaml language must be zh or en");
  if (typeof document.defaultSourceIgnores !== "boolean") throw new Error("workspace.yaml defaultSourceIgnores must be true or false");
  const quality = document.quality === undefined ? { maxResearchRounds: 6 } : parseQuality(document.quality);
  if (!Array.isArray(document.sources)) throw new Error("workspace.yaml sources must be an array");
  const seen = new Set<string>();
  const sources = document.sources.map((value) => parseSource(value, seen));
  return { version: 1, root, configPath, language: document.language, defaultSourceIgnores: document.defaultSourceIgnores, quality, sources };
}

function parseQuality(value: unknown): WikiWorkspace["quality"] {
  if (!isRecord(value) || !Number.isInteger(value.maxResearchRounds)
    || Number(value.maxResearchRounds) < 3 || Number(value.maxResearchRounds) > 20) {
    throw new Error("workspace.yaml quality.maxResearchRounds must be an integer from 3 to 20");
  }
  return { maxResearchRounds: Number(value.maxResearchRounds) };
}

function parseSource(value: unknown, seen: Set<string>): WikiWorkspaceSource {
  if (!isRecord(value) || typeof value.path !== "string" || !SOURCE_NAME.test(value.path) || RESERVED_WORKSPACE_DIRECTORIES.has(value.path) || seen.has(value.path)) {
    throw new Error("workspace.yaml source paths must be unique project directory names");
  }
  seen.add(value.path);
  if (!isRecord(value.origin) || typeof value.origin.type !== "string") throw new Error(`Invalid source origin for ${value.path}`);
  if (value.origin.type === "link" && typeof value.origin.localPath === "string") {
    return { path: value.path, origin: { type: "link", localPath: value.origin.localPath } };
  }
  if (value.origin.type === "clone" && typeof value.origin.remoteUrl === "string") {
    if (value.origin.ref !== undefined && typeof value.origin.ref !== "string") throw new Error(`Invalid clone ref for ${value.path}`);
    return { path: value.path, origin: { type: "clone", remoteUrl: value.origin.remoteUrl, ref: value.origin.ref as string | undefined } };
  }
  throw new Error(`Invalid source origin for ${value.path}`);
}

function assertSourceDirectoryName(value: string): void {
  if (RESERVED_WORKSPACE_DIRECTORIES.has(value)) throw new Error(`Project name is reserved by the workspace: ${value}`);
}

async function writeWorkspaceConfig(configPath: string, workspace: WikiWorkspace): Promise<void> {
  const document = {
    version: 1,
    language: workspace.language,
    defaultSourceIgnores: workspace.defaultSourceIgnores,
    quality: workspace.quality,
    sources: workspace.sources.map((source) => ({ path: source.path, origin: source.origin })),
  };
  await writeFile(configPath, YAML.stringify(document, { lineWidth: 0 }), "utf8");
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error(`Workspace must be a directory: ${directory}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(directory, { recursive: true });
  }
}

/** Keep private workflow handoffs out of a workspace's generated Wiki commits. */
export async function ensureWikiWorkspaceInternalIgnore(root: string): Promise<void> {
  const location = path.join(root, WORKSPACE_GITIGNORE_FILE);
  let current = "";
  try {
    current = await readFile(location, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === WIKI_INTERNAL_DIRECTORY_IGNORE)) return;
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await writeFile(location, `${current}${separator}${WIKI_INTERNAL_DIRECTORY_IGNORE}\n`, "utf8");
}

async function assertAvailableSourcePath(root: string, sourcePath: string): Promise<void> {
  const destination = path.join(root, sourcePath);
  try {
    await lstat(destination);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(`A workspace entry already exists at ${sourcePath}`);
}

async function linkDirectory(source: string, destination: string): Promise<void> {
  if (process.platform !== "win32") {
    await symlink(source, destination, "dir");
    return;
  }
  if (!isUncPath(source)) {
    try {
      await symlink(source, destination, "junction");
      return;
    } catch (error) {
      if (!isLinkPermissionError(error)) throw error;
    }
  }
  try {
    await symlink(source, destination, "dir");
  } catch (error) {
    throw new Error(`Could not link ${source} into this workspace. Windows network paths need Developer Mode or elevation; use /wiki source add clone instead. ${errorMessage(error)}`);
  }
}

function sourceDirectoryName(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  const name = path.basename(normalized).replace(/\.git$/i, "");
  if (!SOURCE_NAME.test(name)) throw new Error(`Project name cannot be used as a workspace directory: ${name}`);
  return name;
}

function isUncPath(value: string): boolean {
  return /^[\\/]{2}[^\\/]+/.test(value);
}

function isLinkPermissionError(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "EPERM" || code === "EACCES" || code === "EINVAL";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function matchesSimpleGlob(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
