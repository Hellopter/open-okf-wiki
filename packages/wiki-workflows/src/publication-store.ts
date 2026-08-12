import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureWikiWorkspaceInternalIgnore } from "./workspace.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type WikiPublishStep = "prepared" | "backed_up" | "installed" | "committed" | "rolled_back";

export interface WikiPublishJournal {
  version: 1;
  runId: string;
  state: WikiPublishStep;
  hadPublishedWiki: boolean;
  preparedAt: string;
  updatedAt: string;
  publishedMetadata?: Record<string, unknown>;
}

export interface WikiPublishRecovery {
  runId: string;
  outcome: "none" | "committed" | "rolled_back";
}

export interface WikiPublicationStore {
  /** Discard a prior attempt and seed a clean candidate with published non-Markdown assets. */
  prepareCandidate(runId: string, mode?: "generate" | "refresh"): Promise<string>;
  /** Resume an existing candidate, or prepare it when this run has not written yet. */
  ensureCandidate(runId: string, mode?: "generate" | "refresh"): Promise<string>;
  /** Atomically replace published `wiki/` using a recoverable rename journal. */
  publish(runId: string, metadata?: Record<string, unknown>): Promise<WikiPublishJournal>;
  recover(runId: string): Promise<WikiPublishRecovery>;
  recoverPending(): Promise<WikiPublishRecovery[]>;
  readJournal(runId: string): Promise<WikiPublishJournal | undefined>;
}

export interface WikiPublicationStoreOptions {
  workspace: string;
  now?: () => string;
  /** Fault-injection seam invoked after each durable transition. */
  afterStep?: (step: Exclude<WikiPublishStep, "rolled_back">) => void | Promise<void>;
}

/**
 * Candidate and publication lifecycle rooted on the workspace filesystem.
 * Writers never touch the published Wiki; publication uses same-filesystem
 * renames and a journal that can distinguish install completion from rollback.
 */
export function createWikiPublicationStore(options: WikiPublicationStoreOptions): WikiPublicationStore {
  const workspace = path.resolve(options.workspace);
  const okfRoot = path.join(workspace, ".okf-wiki");
  const runsRoot = path.join(okfRoot, "runs");
  const publishedWiki = path.join(workspace, "wiki");
  const publishedMetadataFile = path.join(okfRoot, "published.json");
  const now = options.now ?? (() => new Date().toISOString());
  let operationChain = Promise.resolve();

  const enqueue = async <T>(operation: () => Promise<T>): Promise<T> => {
    let result: T | undefined;
    const next = operationChain.catch(() => {}).then(async () => { result = await operation(); });
    operationChain = next.then(() => undefined).catch(() => {});
    await next;
    return result!;
  };

  const pathsFor = (runId: string) => {
    assertRunId(runId);
    const runRoot = path.join(runsRoot, runId);
    return {
      runRoot,
      candidate: path.join(runRoot, "candidate", "wiki"),
      backup: path.join(runRoot, "publish-backup"),
      journal: path.join(runRoot, "publish.json"),
    };
  };

  const readJournal = async (runId: string): Promise<WikiPublishJournal | undefined> => {
    const { journal } = pathsFor(runId);
    try {
      await assertRegularFileOrMissing(journal, "Wiki publish journal");
      const value = JSON.parse(await readFile(journal, "utf8")) as unknown;
      if (!isPublishJournal(value, runId)) throw new Error(`Invalid Wiki publish journal for run ${runId}`);
      return value;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };

  const recoverOperation = async (runId: string): Promise<WikiPublishRecovery> => {
    const journal = await readJournal(runId);
    if (!journal) return { runId, outcome: "none" };
    const paths = pathsFor(runId);
    await assertDirectoryOrMissing(paths.candidate, "candidate Wiki");
    await assertDirectoryOrMissing(paths.backup, "Wiki publish backup");
    await assertDirectoryOrMissing(publishedWiki, "published Wiki");

    if (journal.state === "committed") {
      await rm(paths.backup, { recursive: true, force: true });
      return { runId, outcome: "committed" };
    }
    if (journal.state === "rolled_back") return { runId, outcome: "rolled_back" };

    const candidateExists = await exists(paths.candidate);
    const backupExists = await exists(paths.backup);
    const publishedExists = await exists(publishedWiki);

    // Candidate has already moved into place. Finish the commit; restoring the
    // backup here would discard a fully installed and previously validated Wiki.
    if (!candidateExists && publishedExists) {
      const committed = await finishCommit(journal, paths.backup, publishedMetadataFile, now);
      await writeJournal(paths.journal, committed);
      return { runId, outcome: "committed" };
    }

    // The old Wiki was moved aside but the candidate was not installed.
    if (backupExists && !publishedExists) {
      await rename(paths.backup, publishedWiki);
      await writeJournal(paths.journal, { ...journal, state: "rolled_back", updatedAt: now() });
      return { runId, outcome: "rolled_back" };
    }

    // No old Wiki existed and installation never started. Leave the candidate
    // intact for a normal publish retry and record a completed rollback.
    if (candidateExists && !backupExists && !publishedExists && !journal.hadPublishedWiki) {
      await writeJournal(paths.journal, { ...journal, state: "rolled_back", updatedAt: now() });
      return { runId, outcome: "rolled_back" };
    }

    // A prepared journal with an untouched target is also a clean rollback.
    if (candidateExists && publishedExists && !backupExists) {
      await writeJournal(paths.journal, { ...journal, state: "rolled_back", updatedAt: now() });
      return { runId, outcome: "rolled_back" };
    }

    throw new Error(`Cannot safely recover Wiki publication for run ${runId}; publication paths are inconsistent`);
  };

  const recover = async (runId: string): Promise<WikiPublishRecovery> => await enqueue(async () => await recoverOperation(runId));

  const recoverAfterPublishFailure = async (runId: string, publishError: unknown): Promise<never> => {
    try {
      await recoverOperation(runId);
    } catch (recoveryError) {
      throw new AggregateError(
        [publishError, recoveryError],
        `Wiki publication failed and automatic recovery also failed for run ${runId}`,
      );
    }
    throw publishError;
  };

  const prepareCandidate = async (runId: string, mode: "generate" | "refresh" = "generate"): Promise<string> => {
    await ensureWikiWorkspaceInternalIgnore(workspace);
    await ensureInternalRoot(okfRoot);
    const paths = pathsFor(runId);
    await assertDirectoryOrMissing(paths.runRoot, "Wiki run directory");
    const priorJournal = await readJournal(runId);
    if (priorJournal && priorJournal.state !== "committed") {
      throw new Error(`Run ${runId} already has a publish journal; recover it before preparing another candidate`);
    }
    if (priorJournal) await rm(paths.journal, { force: true });
    await rm(path.dirname(paths.candidate), { recursive: true, force: true });
    await mkdir(paths.candidate, { recursive: true });
    await copyPublishedWiki(publishedWiki, paths.candidate, mode === "refresh");
    return paths.candidate;
  };

  return {
    async prepareCandidate(runId, mode = "generate"): Promise<string> {
      return await enqueue(async () => await prepareCandidate(runId, mode));
    },

    async ensureCandidate(runId, mode = "generate"): Promise<string> {
      return await enqueue(async () => {
        const candidate = pathsFor(runId).candidate;
        if (await exists(candidate)) {
          await assertRegularDirectory(candidate, "candidate Wiki");
          return candidate;
        }
        // A same-run retry after successful publication starts from the Wiki it
        // just published, regardless of the run's original generate/refresh mode.
        const prior = await readJournal(runId);
        return await prepareCandidate(runId, prior?.state === "committed" ? "refresh" : mode);
      });
    },

    async publish(runId, metadata = {}): Promise<WikiPublishJournal> {
      return await enqueue(async () => {
        await ensureWikiWorkspaceInternalIgnore(workspace);
        await ensureInternalRoot(okfRoot);
        const paths = pathsFor(runId);
        const prior = await readJournal(runId);
        if (prior && prior.state !== "rolled_back") throw new Error(`Run ${runId} has an unfinished or completed publish journal; recover it before publishing again`);
        await assertRegularDirectory(paths.candidate, "candidate Wiki");
        await assertDirectoryOrMissing(publishedWiki, "published Wiki");
        await rm(paths.backup, { recursive: true, force: true });

        const timestamp = now();
        let journal: WikiPublishJournal = {
          version: 1,
          runId,
          state: "prepared",
          hadPublishedWiki: await exists(publishedWiki),
          preparedAt: timestamp,
          updatedAt: timestamp,
          publishedMetadata: structuredClone(metadata),
        };
        await writeJournal(paths.journal, journal);
        await options.afterStep?.("prepared");

        try {
          if (journal.hadPublishedWiki) await rename(publishedWiki, paths.backup);
          journal = { ...journal, state: "backed_up", updatedAt: now() };
          await writeJournal(paths.journal, journal);
        } catch (error) {
          return await recoverAfterPublishFailure(runId, error);
        }
        await options.afterStep?.("backed_up");

        try {
          await rename(paths.candidate, publishedWiki);
          journal = { ...journal, state: "installed", updatedAt: now() };
          await writeJournal(paths.journal, journal);
        } catch (error) {
          return await recoverAfterPublishFailure(runId, error);
        }
        await options.afterStep?.("installed");

        try {
          journal = await finishCommit(journal, paths.backup, publishedMetadataFile, now);
          await writeJournal(paths.journal, journal);
        } catch (error) {
          return await recoverAfterPublishFailure(runId, error);
        }
        await options.afterStep?.("committed");
        return journal;
      });
    },

    recover,

    async recoverPending(): Promise<WikiPublishRecovery[]> {
      let entries: string[];
      try {
        entries = (await readdir(runsRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && SAFE_RUN_ID.test(entry.name))
          .map((entry) => entry.name);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const results: WikiPublishRecovery[] = [];
      // Recovery mutates the single published Wiki, so preserve journal recency
      // and never recover runs concurrently.
      for (const runId of entries.sort()) {
        if (await readJournal(runId)) results.push(await recover(runId));
      }
      return results;
    },

    readJournal,
  };
}

async function finishCommit(
  journal: WikiPublishJournal,
  backup: string,
  publishedMetadataFile: string,
  now: () => string,
): Promise<WikiPublishJournal> {
  const updatedAt = now();
  await writeAtomic(publishedMetadataFile, `${JSON.stringify({
    version: 1,
    runId: journal.runId,
    publishedAt: updatedAt,
    ...journal.publishedMetadata,
  })}\n`);
  await rm(backup, { recursive: true, force: true });
  return { ...journal, state: "committed", updatedAt };
}

async function copyPublishedWiki(source: string, destination: string, includeMarkdown: boolean, relative = ""): Promise<void> {
  const directory = relative ? path.join(source, ...relative.split("/")) : source;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Published Wiki must not contain symbolic links: ${relative ? `${relative}/` : ""}${entry.name}`);
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await copyPublishedWiki(source, destination, includeMarkdown, child);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Published Wiki contains unsupported entry: ${child}`);
    if (!includeMarkdown && entry.name.endsWith(".md")) continue;
    const target = path.join(destination, ...child.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(source, ...child.split("/"))));
  }
}

async function assertRegularDirectory(location: string, label: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(location);
  } catch (error) {
    if (isMissing(error)) throw new Error(`Missing ${label}: ${location}`);
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${label} must be a regular directory: ${location}`);
}

async function assertDirectoryOrMissing(location: string, label: string): Promise<void> {
  try {
    await assertRegularDirectory(location, label);
  } catch (error) {
    if (!isMissing(error) && !(error instanceof Error && error.message.startsWith(`Missing ${label}:`))) throw error;
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

async function ensureInternalRoot(okfRoot: string): Promise<void> {
  try {
    const entry = await lstat(okfRoot);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Wiki internal root must be a regular directory: ${okfRoot}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(okfRoot, { recursive: true });
  }
}

async function exists(location: string): Promise<boolean> {
  try {
    await lstat(location);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function writeJournal(location: string, journal: WikiPublishJournal): Promise<void> {
  await mkdir(path.dirname(location), { recursive: true });
  await writeAtomic(location, `${JSON.stringify(journal)}\n`);
}

async function writeAtomic(location: string, content: string): Promise<void> {
  await mkdir(path.dirname(location), { recursive: true });
  const temporary = `${location}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, location);
}

function isPublishJournal(value: unknown, runId: string): value is WikiPublishJournal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WikiPublishJournal>;
  return candidate.version === 1 && candidate.runId === runId
    && ["prepared", "backed_up", "installed", "committed", "rolled_back"].includes(candidate.state ?? "")
    && typeof candidate.hadPublishedWiki === "boolean"
    && typeof candidate.preparedAt === "string" && typeof candidate.updatedAt === "string";
}

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new Error("Invalid Wiki publication run identifier");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
