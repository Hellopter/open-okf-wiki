import { appendFile, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { WikiDelegateReceipt } from "./delegate-contracts.js";
import type {
  WikiHistoryEntry,
  WikiProducerOperation,
  WikiProducerResult,
  WikiRunEvent,
  WikiRunPause,
  WikiRunProgress,
  WikiRunStage,
  WikiRunStatus,
  WikiRunView,
  WikiTaskSnapshot,
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

export interface WikiTaskRecord {
  receipt?: WikiDelegateReceipt;
  history?: WikiHistoryEntry[];
  updatedAt: string;
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
    const next = chain.catch(() => undefined).then(async () => {
      value = await operation();
    });
    chain = next.then(() => undefined, () => undefined);
    await next;
    return value;
  };

  const paths = (runId: string) => {
    assertSafeId(runId, "Wiki run ID");
    const directory = path.join(runsRoot, runId);
    return {
      directory,
      state: path.join(directory, "run-state.json"),
      events: path.join(directory, "events.jsonl"),
      task: (taskId: string) => {
        assertSafeId(taskId, "Wiki task ID");
        return path.join(directory, "tasks", `${taskId}.json`);
      },
    };
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
        assertSafeId(input.id, "Wiki run ID");
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
        const latest = (await readState(runId)) ?? state;
        latest.lastEventSequence = event.sequence;
        latest.updatedAt = event.at;
        if (event.type === "progress" || hasProgressFields(event.data)) {
          const progress = mergeProgress(latest.progress, event.data ?? {}, event.message);
          if (progress) latest.progress = progress;
        }
        await writeState(latest);
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

    async readTask(runId: string, taskId: string) {
      return await serialize(async () => {
        const file = paths(runId).task(taskId);
        try {
          return parseTaskRecord(JSON.parse(await readFile(file, "utf8")));
        } catch (error) {
          if (isMissing(error)) return undefined;
          throw error;
        }
      });
    },

    async writeTask(runId: string, taskId: string, record: WikiTaskRecord) {
      return await serialize(async () => {
        if (!(await readState(runId))) throw new Error(`Unknown Wiki run: ${runId}`);
        const target = paths(runId).task(taskId);
        const parsed = parseTaskRecord(record);
        await mkdir(path.dirname(target), { recursive: true });
        await writeAtomic(target, `${JSON.stringify(parsed, null, 2)}\n`);
        return parsed;
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
  const parsed = state as WikiRunState;
  const progress = parseProgress(state.progress);
  if (progress) parsed.progress = progress;
  else delete parsed.progress;
  return parsed;
}

const STAGES = new Set<WikiRunStage>(["prepare", "lead", "delegate", "validate", "publish"]);
const TASK_ROLES = new Set<WikiTaskSnapshot["role"]>(["research", "write", "review"]);
const TASK_STATUSES = new Set<WikiTaskSnapshot["status"]>(["queued", "running", "complete", "incomplete", "failed"]);
const HISTORY_ROLES = new Set<WikiHistoryEntry["role"]>(["user", "assistant", "tool"]);
const HISTORY_KINDS = new Set<WikiHistoryEntry["kind"]>(["text", "toolCall", "toolResult", "error"]);

function hasProgressFields(data?: Record<string, unknown>): boolean {
  if (!data) return false;
  return typeof data.stage === "string"
    || typeof data.batch === "number"
    || typeof data.completed === "number"
    || typeof data.total === "number"
    || Array.isArray(data.tasks)
    || eventTaskId(data) !== undefined;
}

function eventTaskId(data?: Record<string, unknown>): string | undefined {
  if (!data) return undefined;
  if (typeof data.taskId === "string" && data.taskId) return data.taskId;
  if (data.task && typeof data.task === "object") {
    const id = (data.task as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

function mergeProgress(
  current: WikiRunProgress | undefined,
  data: Record<string, unknown>,
  message: string,
): WikiRunProgress | undefined {
  const stage = isStage(data.stage) ? data.stage : current?.stage;
  if (!stage) return current;
  const next: WikiRunProgress = {
    stage,
    ...(current?.batch !== undefined ? { batch: current.batch } : {}),
    ...(current?.completed !== undefined ? { completed: current.completed } : {}),
    ...(current?.total !== undefined ? { total: current.total } : {}),
    ...(current?.tasks ? { tasks: current.tasks } : {}),
    lastMessage: message,
  };
  if (isProgressCount(data.batch)) next.batch = data.batch;
  if (isProgressCount(data.completed)) next.completed = data.completed;
  if (isProgressCount(data.total)) next.total = data.total;
  if (Array.isArray(data.tasks)) {
    const tasks = data.tasks.map(parseTaskSnapshot).filter((task): task is WikiTaskSnapshot => task !== undefined);
    next.tasks = tasks;
  }
  const patchId = eventTaskId(data);
  const existing = patchId ? next.tasks?.find((task) => task.id === patchId) : undefined;
  const patch = patchTaskSnapshot(data, existing);
  if (patch) {
    const tasks = [...(next.tasks ?? [])];
    const index = tasks.findIndex((task) => task.id === patch.id);
    if (index >= 0) tasks[index] = { ...tasks[index], ...patch };
    else tasks.push(patch);
    next.tasks = tasks;
  }
  return parseProgress(next);
}

function patchTaskSnapshot(data: Record<string, unknown>, existing?: WikiTaskSnapshot): WikiTaskSnapshot | undefined {
  const fromTask = parseTaskSnapshot(data.task);
  if (fromTask) return { ...existing, ...fromTask };
  const id = typeof data.taskId === "string" && data.taskId ? data.taskId : existing?.id;
  if (!id) return undefined;
  return parseTaskSnapshot({
    ...(existing ?? {}),
    id,
    ...(typeof data.role === "string" ? { role: data.role } : {}),
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(typeof data.summary === "string" ? { summary: data.summary } : {}),
    ...(typeof data.attempts === "number" ? { attempts: data.attempts } : {}),
    ...(typeof data.startedAt === "string" ? { startedAt: data.startedAt } : {}),
    ...(typeof data.updatedAt === "string" ? { updatedAt: data.updatedAt } : {}),
  });
}

function parseProgress(value: unknown): WikiRunProgress | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<WikiRunProgress>;
  if (!isStage(raw.stage)) return undefined;
  if (raw.batch !== undefined && !isProgressCount(raw.batch)) return undefined;
  if (raw.completed !== undefined && !isProgressCount(raw.completed)) return undefined;
  if (raw.total !== undefined && !isProgressCount(raw.total)) return undefined;
  if (raw.lastMessage !== undefined && typeof raw.lastMessage !== "string") return undefined;
  let tasks: WikiTaskSnapshot[] | undefined;
  if (raw.tasks !== undefined) {
    if (!Array.isArray(raw.tasks)) return undefined;
    tasks = [];
    for (const entry of raw.tasks) {
      const task = parseTaskSnapshot(entry);
      if (!task) return undefined;
      tasks.push(task);
    }
  }
  return {
    stage: raw.stage,
    ...(raw.batch !== undefined ? { batch: raw.batch } : {}),
    ...(raw.completed !== undefined ? { completed: raw.completed } : {}),
    ...(raw.total !== undefined ? { total: raw.total } : {}),
    ...(tasks ? { tasks } : {}),
    ...(raw.lastMessage !== undefined ? { lastMessage: raw.lastMessage } : {}),
  };
}

function parseTaskSnapshot(value: unknown): WikiTaskSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<WikiTaskSnapshot>;
  if (typeof raw.id !== "string" || !isTaskRole(raw.role) || !isTaskStatus(raw.status)) return undefined;
  if (raw.summary !== undefined && typeof raw.summary !== "string") return undefined;
  if (raw.attempts !== undefined && !isProgressCount(raw.attempts)) return undefined;
  if (raw.startedAt !== undefined && typeof raw.startedAt !== "string") return undefined;
  if (raw.updatedAt !== undefined && typeof raw.updatedAt !== "string") return undefined;
  return {
    id: raw.id,
    role: raw.role,
    status: raw.status,
    ...(raw.summary !== undefined ? { summary: raw.summary } : {}),
    ...(raw.attempts !== undefined ? { attempts: raw.attempts } : {}),
    ...(raw.startedAt !== undefined ? { startedAt: raw.startedAt } : {}),
    ...(raw.updatedAt !== undefined ? { updatedAt: raw.updatedAt } : {}),
  };
}

function parseTaskRecord(value: unknown): WikiTaskRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid Wiki task record");
  const raw = value as Partial<WikiTaskRecord>;
  if (typeof raw.updatedAt !== "string") throw new Error("Invalid Wiki task record");
  if (raw.receipt !== undefined && (!raw.receipt || typeof raw.receipt !== "object")) {
    throw new Error("Invalid Wiki task record");
  }
  let history: WikiHistoryEntry[] | undefined;
  if (raw.history !== undefined) {
    if (!Array.isArray(raw.history)) throw new Error("Invalid Wiki task record");
    history = raw.history.map(parseHistoryEntry);
  }
  return {
    ...(raw.receipt ? { receipt: raw.receipt } : {}),
    ...(history ? { history } : {}),
    updatedAt: raw.updatedAt,
  };
}

function parseHistoryEntry(value: unknown): WikiHistoryEntry {
  if (!value || typeof value !== "object") throw new Error("Invalid Wiki task record");
  const raw = value as Partial<WikiHistoryEntry>;
  if (!isHistoryRole(raw.role) || !isHistoryKind(raw.kind) || typeof raw.text !== "string") {
    throw new Error("Invalid Wiki task record");
  }
  if (raw.toolName !== undefined && typeof raw.toolName !== "string") throw new Error("Invalid Wiki task record");
  if (raw.path !== undefined && typeof raw.path !== "string") throw new Error("Invalid Wiki task record");
  if (raw.isError !== undefined && typeof raw.isError !== "boolean") throw new Error("Invalid Wiki task record");
  if (raw.timestamp !== undefined && typeof raw.timestamp !== "number") throw new Error("Invalid Wiki task record");
  return {
    role: raw.role,
    kind: raw.kind,
    text: raw.text,
    ...(raw.toolName !== undefined ? { toolName: raw.toolName } : {}),
    ...(raw.path !== undefined ? { path: raw.path } : {}),
    ...(raw.isError !== undefined ? { isError: raw.isError } : {}),
    ...(raw.timestamp !== undefined ? { timestamp: raw.timestamp } : {}),
  };
}

function isStage(value: unknown): value is WikiRunStage {
  return typeof value === "string" && STAGES.has(value as WikiRunStage);
}

function isTaskRole(value: unknown): value is WikiTaskSnapshot["role"] {
  return typeof value === "string" && TASK_ROLES.has(value as WikiTaskSnapshot["role"]);
}

function isTaskStatus(value: unknown): value is WikiTaskSnapshot["status"] {
  return typeof value === "string" && TASK_STATUSES.has(value as WikiTaskSnapshot["status"]);
}

function isHistoryRole(value: unknown): value is WikiHistoryEntry["role"] {
  return typeof value === "string" && HISTORY_ROLES.has(value as WikiHistoryEntry["role"]);
}

function isHistoryKind(value: unknown): value is WikiHistoryEntry["kind"] {
  return typeof value === "string" && HISTORY_KINDS.has(value as WikiHistoryEntry["kind"]);
}

function isProgressCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
    assertSafeId(value, "Wiki run ID");
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

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}
