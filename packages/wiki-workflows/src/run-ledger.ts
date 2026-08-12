import { appendFile, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  WikiProducerOperation,
  WikiProducerResult,
  WikiRunPause,
  WikiRunEvent,
  WikiRunStatus,
  WikiRunView,
} from "./producer-types.js";

export const WIKI_RUN_LEDGER_VERSION = 1 as const;

export interface WikiRunState extends WikiRunView {
  version: typeof WIKI_RUN_LEDGER_VERSION;
  attempt: number;
  sourceFingerprint?: string;
  output?: unknown;
  publication?: unknown;
  pause?: WikiRunPause;
}

export interface CreateWikiRunState {
  id: string;
  cwd: string;
  operation: WikiProducerOperation;
  focus?: string;
  at: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TERMINAL = new Set<WikiRunStatus>(["succeeded", "failed", "cancelled"]);

export function createWikiRunLedger(rootDirectory: string) {
  const root = path.resolve(rootDirectory);
  const runsRoot = path.join(root, "runs");
  const activeFile = path.join(root, "active-run");
  let chain = Promise.resolve();

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    let value!: T;
    const next = chain.catch(() => undefined).then(async () => { value = await operation(); });
    chain = next.then(() => undefined, () => undefined);
    await next;
    return value;
  };

  const paths = (runId: string) => {
    assertRunId(runId);
    const directory = path.join(runsRoot, runId);
    return { directory, state: path.join(directory, "run-state.json"), events: path.join(directory, "events.jsonl") };
  };

  const readState = async (runId: string): Promise<WikiRunState | undefined> => {
    const file = paths(runId).state;
    try {
      return parseState(JSON.parse(await readFile(file, "utf8")), runId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };

  const writeState = async (state: WikiRunState): Promise<void> => {
    const target = paths(state.id).state;
    await mkdir(path.dirname(target), { recursive: true });
    await writeAtomic(target, `${JSON.stringify(state, null, 2)}\n`);
  };

  return {
    async create(input: CreateWikiRunState) {
      return await serialize(async () => {
        assertRunId(input.id);
        await mkdir(root, { recursive: true });
        const existing = await activeRunId(activeFile);
        if (existing) {
          const active = await readState(existing);
          if (active && !TERMINAL.has(active.status)) {
            throw new Error(`Wiki run ${existing} is already active in this workspace`);
          }
          await rm(activeFile, { force: true });
        }
        const lock = await open(activeFile, "wx");
        try {
          await lock.writeFile(`${input.id}\n`, "utf8");
        } finally {
          await lock.close();
        }
        const state: WikiRunState = {
          version: 1,
          id: input.id,
          cwd: path.resolve(input.cwd),
          operation: input.operation,
          ...(input.focus ? { focus: input.focus } : {}),
          status: "running",
          createdAt: input.at,
          updatedAt: input.at,
          lastEventSequence: 0,
          attempt: 0,
        };
        try {
          await writeState(state);
          return state;
        } catch (error) {
          await rm(activeFile, { force: true });
          throw error;
        }
      });
    },

    async read(runId: string) {
      return await serialize(async () => await readState(runId));
    },

    async list() {
      return await serialize(async () => {
        let entries: string[];
        try {
          entries = await readdir(runsRoot);
        } catch (error) {
          if (isMissing(error)) return [];
          throw error;
        }
        const states = await Promise.all(entries.filter((entry) => SAFE_ID.test(entry)).map(readState));
        return states.filter((state): state is WikiRunState => state !== undefined)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      });
    },

    async update(runId: string, mutate: (state: WikiRunState) => WikiRunState) {
      return await serialize(async () => {
        const current = await readState(runId);
        if (!current) throw new Error(`Unknown Wiki run: ${runId}`);
        if (TERMINAL.has(current.status)) throw new Error(`Terminal Wiki run ${runId} is immutable`);
        const next = parseState(mutate(structuredClone(current)), runId);
        if (next.id !== current.id || next.cwd !== current.cwd || next.createdAt !== current.createdAt) {
          throw new Error("Wiki run identity is immutable");
        }
        await writeState(next);
        return next;
      });
    },

    async append(
      runId: string,
      input: Omit<WikiRunEvent, "version" | "runId" | "sequence">,
    ) {
      return await serialize(async () => {
        const state = await readState(runId);
        if (!state) throw new Error(`Unknown Wiki run: ${runId}`);
        const event: WikiRunEvent = {
          version: 1,
          runId,
          sequence: state.lastEventSequence + 1,
          ...input,
        };
        const file = paths(runId).events;
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
        state.lastEventSequence = event.sequence;
        state.updatedAt = event.at;
        await writeState(state);
        return event;
      });
    },

    async events(runId: string, after = 0) {
      return await serialize(async () => {
        if (!(await readState(runId))) throw new Error(`Unknown Wiki run: ${runId}`);
        let content: string;
        try {
          content = await readFile(paths(runId).events, "utf8");
        } catch (error) {
          if (isMissing(error)) return [];
          throw error;
        }
        return content.split("\n").filter(Boolean).map((line) => parseEvent(JSON.parse(line), runId))
          .filter((event) => event.sequence > after);
      });
    },

    async releaseActive(runId: string) {
      await serialize(async () => {
        if (await activeRunId(activeFile) === runId) await rm(activeFile, { force: true });
      });
    },
  };
}

/** @internal One filesystem implementation; inferred rather than a hypothetical adapter seam. */
export type WikiRunLedger = ReturnType<typeof createWikiRunLedger>;

export function resultFromState(state: WikiRunState): WikiProducerResult {
  if (state.status !== "succeeded") throw new Error(`Wiki run ${state.id} has no successful result`);
  const publication = state.publication as { pages?: unknown; sourceFingerprint?: unknown } | undefined;
  const outcome = state.output as { kind?: unknown; summary?: unknown } | undefined;
  if (!publication || !Array.isArray(publication.pages) || publication.pages.some((page) => typeof page !== "string")
    || typeof publication.sourceFingerprint !== "string" || outcome?.kind !== "complete" || typeof outcome.summary !== "string") {
    throw new Error(`Wiki run ${state.id} has an invalid successful result`);
  }
  return {
    runId: state.id,
    status: "succeeded",
    pages: publication.pages,
    sourceFingerprint: publication.sourceFingerprint,
    summary: outcome.summary,
  };
}

function parseState(value: unknown, expectedId: string): WikiRunState {
  if (!value || typeof value !== "object") throw new Error(`Invalid Wiki run state: ${expectedId}`);
  const state = value as Partial<WikiRunState>;
  if (state.version !== 1 || state.id !== expectedId || typeof state.cwd !== "string"
    || (state.operation !== "update" && state.operation !== "regenerate")
    || !["running", "paused", "succeeded", "failed", "cancelled"].includes(state.status ?? "")
    || typeof state.createdAt !== "string" || typeof state.updatedAt !== "string"
    || !Number.isInteger(state.lastEventSequence) || (state.lastEventSequence ?? -1) < 0
    || !Number.isInteger(state.attempt) || (state.attempt ?? -1) < 0
    || (state.sourceFingerprint !== undefined && typeof state.sourceFingerprint !== "string")
    || !isPause(state.pause)) {
    throw new Error(`Invalid Wiki run state: ${expectedId}`);
  }
  return state as WikiRunState;
}

function isPause(value: unknown): value is WikiRunPause | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const pause = value as Partial<WikiRunPause>;
  return (pause.reason === "quota" || pause.reason === "usage_limit")
    && typeof pause.summary === "string"
    && (pause.retryAt === undefined || typeof pause.retryAt === "string");
}

function parseEvent(value: unknown, expectedId: string): WikiRunEvent {
  if (!value || typeof value !== "object") throw new Error(`Invalid Wiki run event: ${expectedId}`);
  const event = value as Partial<WikiRunEvent>;
  if (event.version !== 1 || event.runId !== expectedId || !Number.isInteger(event.sequence)
    || (event.sequence ?? 0) < 1 || typeof event.at !== "string" || typeof event.type !== "string"
    || typeof event.message !== "string") throw new Error(`Invalid Wiki run event: ${expectedId}`);
  return event as WikiRunEvent;
}

async function activeRunId(file: string): Promise<string | undefined> {
  try {
    const value = (await readFile(file, "utf8")).trim();
    assertRunId(value);
    return value;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function assertRunId(value: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid Wiki run ID: ${value}`);
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}
