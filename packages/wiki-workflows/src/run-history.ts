import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createWikiArtifactStore, type WikiArtifactStore } from "./artifact-store.js";
import type { WikiRunSnapshot, WikiRunSummary } from "./workflow-types.js";

export const DEFAULT_MAX_TERMINAL_WIKI_RUNS = 100;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "blocked", "cancelled"]);
const LIST_CACHE_TTL_MS = 500;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface WikiRunHistoryStore {
  save(snapshot: WikiRunSnapshot): Promise<void>;
  load(runId: string): Promise<WikiRunSnapshot | undefined>;
  list(): Promise<WikiRunSummary[]>;
  delete(runId: string): Promise<boolean>;
  getRunsDir(): string;
  /** Workspace-local artifact root paired with this history store. */
  getArtifactsRoot(): string;
}

export interface WikiRunHistoryStoreOptions {
  workspace: string;
  /** Test seam and explicit override. Defaults below Pi's user agent directory. */
  rootDir?: string;
  maxTerminalRuns?: number;
  /** Test seam for the workspace-local handoff artifact lifecycle. */
  artifactStore?: WikiArtifactStore;
}

/**
 * Durable, project-scoped execution history. This intentionally stores only
 * bounded run metadata and agent outputs; Git remains the source rollback path.
 */
export function createWikiRunHistoryStore(options: WikiRunHistoryStoreOptions): WikiRunHistoryStore {
  const rootDir = options.rootDir ?? path.join(getAgentDir(), "okf-wiki", "projects", wikiHistoryProjectKey(options.workspace));
  const runsDir = path.join(rootDir, "runs");
  const maxTerminalRuns = positiveInt(options.maxTerminalRuns, DEFAULT_MAX_TERMINAL_WIKI_RUNS);
  const artifactStore = options.artifactStore ?? createWikiArtifactStore({ workspace: options.workspace });
  let writeChain = Promise.resolve();
  let cached: WikiRunSummary[] | undefined;
  let cachedAt = 0;

  const invalidateCache = () => {
    cached = undefined;
    cachedAt = 0;
  };

  const enqueue = async (operation: () => Promise<void>): Promise<void> => {
    const next = writeChain.catch(() => {}).then(operation);
    writeChain = next;
    await next;
  };

  const loadAll = async (): Promise<WikiRunSnapshot[]> => {
    await writeChain.catch(() => {});
    let entries: string[];
    try {
      entries = await readdir(runsDir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const snapshots = await Promise.all(entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => await readSnapshot(path.join(runsDir, entry))));
    return snapshots.filter((snapshot): snapshot is WikiRunSnapshot => Boolean(snapshot));
  };

  return {
    async save(snapshot): Promise<void> {
      const value = clone(snapshot);
      await enqueue(async () => {
        await mkdir(runsDir, { recursive: true });
        await writeSnapshot(runFile(runsDir, value.id), value);
        const evictedRunIds = await enforceRetention(runsDir, maxTerminalRuns);
        await Promise.all(evictedRunIds.map(async (runId) => await artifactStore.removeRun(runId)));
        invalidateCache();
      });
    },

    async load(runId): Promise<WikiRunSnapshot | undefined> {
      await writeChain.catch(() => {});
      return await readSnapshot(runFile(runsDir, runId));
    },

    async list(): Promise<WikiRunSummary[]> {
      const now = Date.now();
      if (cached && now - cachedAt < LIST_CACHE_TTL_MS) return cached.map(clone);
      const summaries = (await loadAll()).map(summarizeWikiRun).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      cached = summaries;
      cachedAt = now;
      return summaries.map(clone);
    },

    async delete(runId): Promise<boolean> {
      let deleted = false;
      await enqueue(async () => {
        try {
          await rm(runFile(runsDir, runId));
          deleted = true;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        await artifactStore.removeRun(runId);
        invalidateCache();
      });
      return deleted;
    },

    getRunsDir(): string {
      return runsDir;
    },

    getArtifactsRoot(): string {
      return artifactStore.getRunsRoot();
    },
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
    head: snapshot.inspection?.head,
    changedPaths: snapshot.inspection?.changedPaths.length ?? 0,
    totalNodes: snapshot.nodes.length,
    succeededNodes: snapshot.nodes.filter((node) => node.status === "succeeded").length,
    failedNodes: snapshot.nodes.filter((node) => node.status === "failed" || node.status === "blocked").length,
  };
}

export function wikiHistoryProjectKey(workspace: string): string {
  const absolute = path.resolve(workspace);
  const slug = path.basename(absolute).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workspace";
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

async function readSnapshot(location: string): Promise<WikiRunSnapshot | undefined> {
  try {
    const value = JSON.parse(await readFile(location, "utf8")) as unknown;
    return isSnapshot(value) ? clone(value) : undefined;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function writeSnapshot(location: string, snapshot: WikiRunSnapshot): Promise<void> {
  const temporary = `${location}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, "utf8");
  await rename(temporary, location);
}

async function enforceRetention(runsDir: string, maximum: number): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const candidates = await Promise.all(entries
    .filter((entry) => entry.endsWith(".json"))
    .map(async (entry) => ({ entry, snapshot: await readSnapshot(path.join(runsDir, entry)) })));
  const terminal = candidates
    .filter((item) => item.snapshot !== undefined)
    .map((item) => ({ entry: item.entry, snapshot: item.snapshot! }))
    .filter((item) => TERMINAL_STATUSES.has(item.snapshot.status))
    .sort((left, right) => left.snapshot.updatedAt.localeCompare(right.snapshot.updatedAt));
  const excess = terminal.length - maximum;
  if (excess <= 0) return [];
  const evicted = terminal.slice(0, excess);
  await Promise.all(evicted.map(async ({ entry }) => await rm(path.join(runsDir, entry), { force: true })));
  return evicted.map(({ snapshot }) => snapshot.id);
}

function isSnapshot(value: unknown): value is WikiRunSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 4
    && typeof candidate.id === "string"
    && typeof candidate.cwd === "string"
    && (candidate.requestedMode === "generate" || candidate.requestedMode === "refresh")
    && (candidate.language === "zh" || candidate.language === "en")
    && typeof candidate.status === "string"
    && Array.isArray(candidate.nodes)
    && Array.isArray(candidate.events)
    && typeof candidate.createdAt === "string"
    && typeof candidate.updatedAt === "string";
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function runFile(runsDir: string, runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) throw new Error("Invalid Wiki run history identifier");
  return path.join(runsDir, `${runId}.json`);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
