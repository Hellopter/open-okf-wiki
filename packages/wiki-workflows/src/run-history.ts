import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createWikiArtifactStore, type WikiArtifactStore } from "./artifact-store.js";
import { isWikiRunSnapshot } from "./snapshot-validation.js";
import type { WikiRunSnapshot, WikiRunSummary } from "./workflow-types.js";

export const DEFAULT_MAX_TERMINAL_WIKI_RUNS = 100;
export const DEFAULT_WIKI_RUN_HISTORY_PAGE_SIZE = 25;
export const MAX_WIKI_RUN_HISTORY_PAGE_SIZE = 100;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "blocked", "cancelled"]);
const LIST_CACHE_TTL_MS = 500;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INDEX_FILE = "index.json";

interface WikiRunHistoryIndex {
  version: 1;
  summaries: WikiRunSummary[];
  files?: Record<string, string>;
}

export interface WikiRunHistoryPage {
  items: WikiRunSummary[];
  offset: number;
  limit: number;
  total: number;
  nextOffset?: number;
}

export interface WikiRunHistoryStore {
  save(snapshot: WikiRunSnapshot): Promise<void>;
  load(runId: string): Promise<WikiRunSnapshot | undefined>;
  list(): Promise<WikiRunSummary[]>;
  listPage(options?: { offset?: number; limit?: number }): Promise<WikiRunHistoryPage>;
  delete(runId: string): Promise<boolean>;
  getRunsDir(): string;
  /** Workspace-local artifact root paired with this history store. */
  getArtifactsRoot(): string;
}

export interface WikiRunHistoryStoreOptions {
  workspace: string;
  /** Test seam. Defaults to `<workspace>/.okf-wiki`. */
  rootDir?: string;
  maxTerminalRuns?: number;
  artifactStore?: WikiArtifactStore;
}

/**
 * Workspace-local run history. Each run owns an authoritative `run.json`; a
 * small derived index makes history browsing bounded and does not duplicate
 * snapshots below Pi's agent directory.
 */
export function createWikiRunHistoryStore(options: WikiRunHistoryStoreOptions): WikiRunHistoryStore {
  const rootDir = path.resolve(options.rootDir ?? path.join(options.workspace, ".okf-wiki"));
  const runsDir = path.join(rootDir, "runs");
  const indexFile = path.join(runsDir, INDEX_FILE);
  const maxTerminalRuns = positiveInt(options.maxTerminalRuns, DEFAULT_MAX_TERMINAL_WIKI_RUNS);
  const artifactStore = options.artifactStore ?? createWikiArtifactStore({ workspace: options.workspace });
  let writeChain = Promise.resolve();
  let cached: WikiRunSummary[] | undefined;
  let cachedAt = 0;

  const invalidateCache = () => {
    cached = undefined;
    cachedAt = 0;
  };

  const enqueue = async <T>(operation: () => Promise<T>): Promise<T> => {
    let result: T | undefined;
    const next = writeChain.catch(() => {}).then(async () => { result = await operation(); });
    writeChain = next.then(() => undefined).catch(() => {});
    await next;
    return result!;
  };

  const summaries = async (): Promise<WikiRunSummary[]> => {
    await writeChain.catch(() => {});
    await assertRegularDirectoryOrMissing(rootDir, "Wiki run history root");
    await assertRegularDirectoryOrMissing(runsDir, "Wiki runs directory");
    const now = Date.now();
    if (cached && now - cachedAt < LIST_CACHE_TTL_MS) return cached.map(clone);
    const value = await readOrRepairIndex(runsDir, indexFile);
    cached = value;
    cachedAt = now;
    return value.map(clone);
  };

  return {
    async save(snapshot): Promise<void> {
      const value = clone(snapshot);
      assertRunId(value.id);
      await enqueue(async () => {
        await ensureHistoryRoot(rootDir, runsDir);
        await mkdir(runDirectory(runsDir, value.id), { recursive: true });
        await assertRegularDirectory(runDirectory(runsDir, value.id), "Wiki run history directory");
        await writeSnapshot(runFile(runsDir, value.id), value);
        const current = await readOrRepairIndex(runsDir, indexFile);
        const merged = [summarizeWikiRun(value), ...current.filter((item) => item.id !== value.id)].sort(compareRunRecency);
        const { retained, evicted } = retainTerminalRuns(merged, maxTerminalRuns);
        for (const runId of evicted) {
          await artifactStore.removeRun(runId);
          await removeHistorySnapshot(runsDir, runId);
        }
        await writeIndex(indexFile, retained);
        invalidateCache();
      });
    },

    async load(runId): Promise<WikiRunSnapshot | undefined> {
      await writeChain.catch(() => {});
      await assertRegularDirectoryOrMissing(runDirectory(runsDir, runId), "Wiki run history directory");
      return await readSnapshot(runFile(runsDir, runId));
    },

    async list(): Promise<WikiRunSummary[]> {
      return await summaries();
    },

    async listPage(options = {}): Promise<WikiRunHistoryPage> {
      const all = await summaries();
      const offset = nonNegativeInt(options.offset, 0);
      const limit = Math.min(positiveInt(options.limit, DEFAULT_WIKI_RUN_HISTORY_PAGE_SIZE), MAX_WIKI_RUN_HISTORY_PAGE_SIZE);
      const items = all.slice(offset, offset + limit);
      return {
        items,
        offset,
        limit,
        total: all.length,
        nextOffset: offset + items.length < all.length ? offset + items.length : undefined,
      };
    },

    async delete(runId): Promise<boolean> {
      assertRunId(runId);
      return await enqueue(async () => {
        await assertRegularDirectoryOrMissing(runDirectory(runsDir, runId), "Wiki run history directory");
        const existing = await readSnapshot(runFile(runsDir, runId));
        await artifactStore.removeRun(runId);
        await removeHistorySnapshot(runsDir, runId);
        const current = await readOrRepairIndex(runsDir, indexFile);
        await writeIndex(indexFile, current.filter((item) => item.id !== runId));
        invalidateCache();
        return existing !== undefined;
      });
    },

    getRunsDir: () => runsDir,
    getArtifactsRoot: () => artifactStore.getRunsRoot(),
  };
}

export function summarizeWikiRun(snapshot: WikiRunSnapshot): WikiRunSummary {
  return {
    id: snapshot.id,
    cwd: snapshot.cwd,
    requestedMode: snapshot.requestedMode,
    effectiveMode: snapshot.effectiveMode,
    focus: snapshot.focus,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    completedAt: snapshot.completedAt,
    parentRunId: snapshot.parentRunId,
    head: snapshot.inspectionSummary?.head ?? snapshot.inspection?.head,
    changedPaths: snapshot.inspectionSummary?.changedPathCount ?? snapshot.inspection?.changedPaths.length ?? 0,
    totalNodes: snapshot.nodes.length,
    succeededNodes: snapshot.nodes.filter((node) => node.status === "succeeded").length,
    failedNodes: snapshot.nodes.filter((node) => node.status === "failed" || node.status === "blocked").length,
  };
}

/** Retained for external callers that need a stable workspace identifier. */
export function wikiHistoryProjectKey(workspace: string): string {
  const absolute = path.resolve(workspace);
  const slug = path.basename(absolute).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workspace";
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

async function readOrRepairIndex(runsDir: string, indexFile: string): Promise<WikiRunSummary[]> {
  let indexed: WikiRunSummary[] | undefined;
  let indexedFiles: Record<string, string> = {};
  try {
    await assertRegularFileOrMissing(indexFile, "Wiki run history index");
    const value = JSON.parse(await readFile(indexFile, "utf8")) as WikiRunHistoryIndex;
    if (value.version === 1 && Array.isArray(value.summaries)) {
      indexed = value.summaries;
      if (value.files && typeof value.files === "object") indexedFiles = value.files;
    }
  } catch (error) {
    if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
  }

  let entries: string[];
  try {
    const directoryEntries = await readdir(runsDir, { withFileTypes: true });
    const unsafe = directoryEntries.find((entry) => entry.isSymbolicLink());
    if (unsafe) throw new Error(`Wiki run history must not contain symbolic links: ${path.join(runsDir, unsafe.name)}`);
    entries = directoryEntries
      .filter((entry) => entry.isDirectory() && SAFE_RUN_ID.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const known = new Map((indexed ?? []).map((summary) => [summary.id, summary]));
  const liveIds = new Set(entries);
  let changed = indexed === undefined || known.size !== liveIds.size;
  for (const id of entries) {
    const fingerprint = await fileFingerprint(runFile(runsDir, id));
    if (!known.has(id) || indexedFiles[id] !== fingerprint) {
      const snapshot = await readSnapshot(runFile(runsDir, id));
      if (snapshot) known.set(id, summarizeWikiRun(snapshot));
      else known.delete(id);
      changed = true;
    }
  }
  for (const id of known.keys()) {
    if (!liveIds.has(id)) {
      known.delete(id);
      changed = true;
    }
  }
  const result = [...known.values()].sort(compareRunRecency);
  if (changed) await writeIndex(indexFile, result);
  return result;
}

async function readSnapshot(location: string): Promise<WikiRunSnapshot | undefined> {
  try {
    await assertRegularFileOrMissing(location, "Wiki run history snapshot");
    const value = JSON.parse(await readFile(location, "utf8")) as unknown;
    return isWikiRunSnapshot(value) ? clone(value) : undefined;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function writeSnapshot(location: string, snapshot: WikiRunSnapshot): Promise<void> {
  await writeAtomic(location, `${JSON.stringify(snapshot)}\n`);
}

async function writeIndex(location: string, summaries: WikiRunSummary[]): Promise<void> {
  await mkdir(path.dirname(location), { recursive: true });
  const files: Record<string, string> = {};
  for (const summary of summaries) {
    const fingerprint = await fileFingerprint(path.join(path.dirname(location), summary.id, "run.json"));
    if (fingerprint) files[summary.id] = fingerprint;
  }
  await writeAtomic(location, `${JSON.stringify({ version: 1, summaries, files })}\n`);
}

async function fileFingerprint(location: string): Promise<string> {
  try {
    await assertRegularFileOrMissing(location, "Wiki run history snapshot");
    const value = await stat(location);
    return `${value.size}:${value.mtimeMs}`;
  } catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
}

async function ensureHistoryRoot(rootDir: string, runsDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await assertRegularDirectory(rootDir, "Wiki run history root");
  await mkdir(runsDir, { recursive: true });
  await assertRegularDirectory(runsDir, "Wiki runs directory");
}

async function assertRegularDirectory(location: string, label: string): Promise<void> {
  const entry = await lstat(location);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${label} must be a regular directory: ${location}`);
}

async function assertRegularDirectoryOrMissing(location: string, label: string): Promise<void> {
  try {
    await assertRegularDirectory(location, label);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function assertRegularFileOrMissing(location: string, label: string): Promise<void> {
  try {
    const entry = await lstat(location);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${label} must be a regular file: ${location}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function writeAtomic(location: string, content: string): Promise<void> {
  await assertRegularFileOrMissing(location, "Wiki run history file");
  const temporary = `${location}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, location);
}

async function removeHistorySnapshot(runsDir: string, runId: string): Promise<void> {
  // History owns only run.json. The sibling candidate, publish journal, and
  // backup belong to the publication store and may be required for recovery.
  await rm(runFile(runsDir, runId), { force: true });
}

function retainTerminalRuns(summaries: WikiRunSummary[], maximum: number): { retained: WikiRunSummary[]; evicted: string[] } {
  const terminal = summaries.filter((item) => TERMINAL_STATUSES.has(item.status)).sort(compareRunRecency);
  const evicted = new Set(terminal.slice(maximum).map((item) => item.id));
  return { retained: summaries.filter((item) => !evicted.has(item.id)), evicted: [...evicted] };
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function runDirectory(runsDir: string, runId: string): string {
  assertRunId(runId);
  return path.join(runsDir, runId);
}

function runFile(runsDir: string, runId: string): string {
  return path.join(runDirectory(runsDir, runId), "run.json");
}

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new Error("Invalid Wiki run history identifier");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compareRunRecency(left: Pick<WikiRunSummary, "id" | "updatedAt">, right: Pick<WikiRunSummary, "id" | "updatedAt">): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
}
