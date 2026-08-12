import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { repositoryRoot } from "./git.js";
import { errorMessage } from "./failures.js";

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

export interface WikiWorkspaceWikiConfig {
  exclude: string[];
}

export const DEFAULT_WORKSPACE_WIKI_CONFIG: WikiWorkspaceWikiConfig = {
  exclude: [],
};

export interface WikiWorkspace {
  version: 1;
  root: string;
  configPath?: string;
  language: "zh" | "en";
  defaultSourceIgnores: boolean;
  wiki: WikiWorkspaceWikiConfig;
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

export async function loadWikiWorkspace(cwd: string): Promise<ResolvedWikiWorkspace> {
  const configPath = await findWorkspaceConfig(cwd);
  if (!configPath) return await implicitSelfWorkspace(cwd);
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

export function sourceIsIgnored(source: ResolvedWikiSource, relativePath: string, defaultsEnabled: boolean, workspaceExcludes: readonly string[] = []): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  const basename = parts.at(-1) ?? "";
  const declaredPath = `${source.path}/${normalized}`;
  if (workspaceExcludes.some((pattern) => matchesPathGlob(normalized, pattern) || matchesPathGlob(declaredPath, pattern))) return true;
  if (source.path === "." && (parts[0] === ".okf-wiki" || parts[0] === "wiki")) return true;
  if (!defaultsEnabled) return false;
  return DEFAULT_SOURCE_IGNORES.some((ignored) => parts.includes(ignored))
    || DEFAULT_SOURCE_IGNORE_FILES.some((pattern) => matchesSimpleGlob(basename, pattern));
}

async function implicitSelfWorkspace(cwd: string): Promise<ResolvedWikiWorkspace> {
  const requested = await realpath(path.resolve(cwd));
  const repository = await realpath(await repositoryRoot(requested));
  const source: ResolvedWikiSource = {
    path: ".",
    origin: { type: "link", localPath: repository },
    absolutePath: repository,
    realPath: repository,
    repositoryRoot: repository,
  };
  return {
    version: 1,
    root: repository,
    configPath: path.join(repository, WORKSPACE_FILE),
    language: "zh",
    defaultSourceIgnores: true,
    wiki: structuredClone(DEFAULT_WORKSPACE_WIKI_CONFIG),
    sources: [source],
  };
}

function matchesPathGlob(value: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  return path.matchesGlob(value, normalized);
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
  const wiki = document.wiki === undefined ? structuredClone(DEFAULT_WORKSPACE_WIKI_CONFIG) : parseWikiConfig(document.wiki);
  if (!Array.isArray(document.sources)) throw new Error("workspace.yaml sources must be an array");
  const seen = new Set<string>();
  const sources = document.sources.map((value) => parseSource(value, seen));
  return { version: 1, root, configPath, language: document.language, defaultSourceIgnores: document.defaultSourceIgnores, wiki, sources };
}

function parseWikiConfig(value: unknown): WikiWorkspaceWikiConfig {
  if (!isRecord(value)) throw new Error("workspace.yaml wiki must be an object");
  const exclude = parseStringArray(value.exclude, "wiki.exclude");
  return { exclude };
}

function parseStringArray(value: unknown, field: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`workspace.yaml ${field} must be an array of non-empty strings`);
  }
  const result = [...new Set(value.map((entry) => String(entry).trim()))];
  if (required && result.length === 0) throw new Error(`workspace.yaml ${field} must not be empty`);
  return result;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function matchesSimpleGlob(value: string, pattern: string): boolean {
  return path.matchesGlob(value.toLowerCase(), pattern.toLowerCase());
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
