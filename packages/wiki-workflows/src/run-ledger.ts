import { appendFile, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { WikiDelegateReceipt } from "./delegate-contracts.js";
import type {
  WikiContextStats,
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
  WikiTaskTelemetry,
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
  usage?: WikiContextStats;
  updatedAt: string;
}

export type WikiLedgerFaultPoint = "afterJournal" | "afterTask" | "afterState" | "afterEvent";

export interface WikiRunLedgerOptions {
  /** @internal Deterministic crash injection for persistence tests. */
  fault?: (point: WikiLedgerFaultPoint) => void | Promise<void>;
}

interface WikiLedgerTransaction {
  version: 1;
  state: WikiRunState;
  event: WikiRunEvent;
  task?: { id: string; record: WikiTaskRecord };
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TERMINAL = new Set<WikiRunStatus>(["succeeded", "failed", "cancelled"]);

export function createWikiRunLedger(rootDirectory: string, options: WikiRunLedgerOptions = {}) {
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
      journal: path.join(directory, "pending-transaction.json"),
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

  const recover = async (runId: string): Promise<void> => {
    const journal = paths(runId).journal;
    let transaction: WikiLedgerTransaction;
    try {
      transaction = parseTransaction(JSON.parse(await readFile(journal, "utf8")), runId);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    await applyTransaction(transaction, false);
  };

  const applyTransaction = async (transaction: WikiLedgerTransaction, injectFaults: boolean): Promise<void> => {
    const runPaths = paths(transaction.state.id);
    if (transaction.task) {
      const target = runPaths.task(transaction.task.id);
      await mkdir(path.dirname(target), { recursive: true });
      await writeAtomic(target, `${JSON.stringify(transaction.task.record, null, 2)}\n`);
    }
    if (injectFaults) await options.fault?.("afterTask");
    await writeState(transaction.state);
    if (injectFaults) await options.fault?.("afterState");
    const existing = await readEventsFile(runPaths.events, transaction.state.id);
    if (!existing.some((event) => event.sequence === transaction.event.sequence)) {
      await mkdir(path.dirname(runPaths.events), { recursive: true });
      await appendFile(runPaths.events, `${JSON.stringify(transaction.event)}\n`, "utf8");
    }
    if (injectFaults) await options.fault?.("afterEvent");
    await rm(runPaths.journal, { force: true });
  };

  const commitEvent = async (
    runId: string,
    input: Omit<WikiRunEvent, "version" | "runId" | "sequence">,
    taskPatch?: { taskId: string; receipt?: WikiDelegateReceipt; history?: WikiHistoryEntry[]; usage?: WikiContextStats },
    mutateState?: (state: WikiRunState) => WikiRunState,
    allowTerminalTransition = false,
  ): Promise<WikiRunEvent> => {
    await recover(runId);
    const current = await readState(runId);
    if (!current) throw new Error(`Unknown Wiki run: ${runId}`);
    if (TERMINAL.has(current.status)) throw new Error(`Terminal Wiki run ${runId} is immutable`);
    let next = mutateState ? parseState(mutateState(structuredClone(current)), runId) : structuredClone(current);
    if (!allowTerminalTransition && TERMINAL.has(next.status)) {
      throw new Error("Terminal Wiki state transitions require commitTerminal");
    }
    const event: WikiRunEvent = {
      version: 1,
      runId,
      sequence: current.lastEventSequence + 1,
      ...input,
    };
    next.lastEventSequence = event.sequence;
    next.updatedAt = event.at;
    if (event.type === "progress" || event.type === "telemetry" || hasProgressFields(event.data)) {
      const progress = mergeProgress(next.progress, event.data ?? {}, event.message);
      if (progress) next.progress = progress;
    }
    let task: WikiLedgerTransaction["task"];
    if (taskPatch) {
      const existing = await readTaskRecordFile(paths(runId).task(taskPatch.taskId));
      task = {
        id: taskPatch.taskId,
        record: parseTaskRecord({
          ...(existing ?? {}),
          ...(taskPatch.receipt ? { receipt: taskPatch.receipt } : {}),
          ...(taskPatch.history ? { history: taskPatch.history } : {}),
          ...(taskPatch.usage ? { usage: taskPatch.usage } : {}),
          updatedAt: event.at,
        }),
      };
    }
    const transaction: WikiLedgerTransaction = { version: 1, state: parseState(next, runId), event, ...(task ? { task } : {}) };
    const journal = paths(runId).journal;
    await writeAtomic(journal, `${JSON.stringify(transaction, null, 2)}\n`);
    await options.fault?.("afterJournal");
    await applyTransaction(transaction, true);
    return event;
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
      return await serialize(async () => {
        await recover(runId);
        return await readState(runId);
      });
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
        const valid = entries.filter((entry) => SAFE_ID.test(entry));
        for (const entry of valid) await recover(entry);
        const states = await Promise.all(valid.map(readState));
        return states.filter((state): state is WikiRunState => state !== undefined)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      });
    },

    async update(runId: string, mutate: (state: WikiRunState) => WikiRunState) {
      return await serialize(async () => {
        await recover(runId);
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
        return await commitEvent(runId, input);
      });
    },

    async commitEvent(
      runId: string,
      input: Omit<WikiRunEvent, "version" | "runId" | "sequence">,
      taskPatch?: { taskId: string; receipt?: WikiDelegateReceipt; history?: WikiHistoryEntry[]; usage?: WikiContextStats },
      mutateState?: (state: WikiRunState) => WikiRunState,
    ) {
      return await serialize(async () => await commitEvent(runId, input, taskPatch, mutateState));
    },

    async commitTerminal(
      runId: string,
      input: Omit<WikiRunEvent, "version" | "runId" | "sequence">,
      mutateState: (state: WikiRunState) => WikiRunState,
    ) {
      return await serialize(async () => await commitEvent(runId, input, undefined, mutateState, true));
    },

    async commitTelemetry(runId: string, telemetry: WikiTaskTelemetry, message: string) {
      return await serialize(async () => {
        await recover(runId);
        const state = await readState(runId);
        if (!state) throw new Error(`Unknown Wiki run: ${runId}`);
        if (TERMINAL.has(state.status)) return undefined;
        const existingTask = state.progress?.tasks?.find((task) => task.id === telemetry.taskId);
        if (!existingTask) throw new Error(`Unknown Wiki task: ${telemetry.taskId}`);
        if ((existingTask.attempt ?? 0) > telemetry.attempt) return undefined;

        const at = telemetry.sampledAt;
        const target = paths(runId).task(telemetry.taskId);
        const existingRecord = await readTaskRecordFile(target);
        const record = parseTaskRecord({
          ...(existingRecord ?? {}),
          ...(telemetry.history ? { history: telemetry.history } : {}),
          ...(telemetry.usage ? { usage: telemetry.usage } : {}),
          updatedAt: at,
        });
        const data: Record<string, unknown> = {
          taskId: telemetry.taskId,
          attempt: telemetry.attempt,
          sampledAt: telemetry.sampledAt,
          activity: telemetry.activity,
          activeTool: telemetry.activeTool ?? null,
          ...(telemetry.contextRecalculating !== undefined
            ? { contextRecalculating: telemetry.contextRecalculating }
            : {}),
          ...(telemetry.usage ? { usage: telemetry.usage } : {}),
        };
        return await commitEvent(runId, {
          at,
          type: "telemetry",
          message,
          data,
        }, { taskId: telemetry.taskId, ...(record.history ? { history: record.history } : {}), ...(record.usage ? { usage: record.usage } : {}) });
      });
    },

    async events(runId: string, after = 0) {
      return await serialize(async () => {
        await recover(runId);
        if (!(await readState(runId))) throw new Error(`Unknown Wiki run: ${runId}`);
        return (await readEventsFile(paths(runId).events, runId))
          .filter((event) => event.sequence > after);
      });
    },

    async releaseActive(runId: string) {
      await serialize(async () => {
        await recover(runId);
        if (await activeRunId(activeFile) === runId) await rm(activeFile, { force: true });
      });
    },

    async readTask(runId: string, taskId: string) {
      return await serialize(async () => {
        await recover(runId);
        const file = paths(runId).task(taskId);
        return await readTaskRecordFile(file);
      });
    },

    async writeTask(runId: string, taskId: string, record: WikiTaskRecord) {
      return await serialize(async () => {
        await recover(runId);
        if (!(await readState(runId))) throw new Error(`Unknown Wiki run: ${runId}`);
        const target = paths(runId).task(taskId);
        const parsed = parseTaskRecord(record);
        await mkdir(path.dirname(target), { recursive: true });
        await writeAtomic(target, `${JSON.stringify(parsed, null, 2)}\n`);
        return parsed;
      });
    },
  };

  async function readTaskRecordFile(file: string): Promise<WikiTaskRecord | undefined> {
    try {
      return parseTaskRecord(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }
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
    if (index >= 0) {
      tasks[index] = { ...tasks[index], ...patch };
      if ("activeTool" in data && data.activeTool === null) delete tasks[index].activeTool;
    }
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
  const usage = parseContextStats(data.usage);
  return parseTaskSnapshot({
    ...(existing ?? {}),
    id,
    ...(typeof data.role === "string" ? { role: data.role } : {}),
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(typeof data.summary === "string" ? { summary: data.summary } : {}),
    ...(typeof data.attempts === "number" ? { attempts: data.attempts } : {}),
    ...(typeof data.startedAt === "string" ? { startedAt: data.startedAt } : {}),
    ...(typeof data.updatedAt === "string" ? { updatedAt: data.updatedAt } : {}),
    ...(typeof data.attempt === "number" ? { attempt: data.attempt } : {}),
    ...(typeof data.sampledAt === "string" ? { sampledAt: data.sampledAt } : {}),
    ...(typeof data.activity === "string" ? { activity: data.activity } : {}),
    ...("activeTool" in data
      ? { activeTool: data.activeTool && typeof data.activeTool === "object" ? data.activeTool : undefined }
      : {}),
    ...(typeof data.contextRecalculating === "boolean"
      ? { contextRecalculating: data.contextRecalculating }
      : {}),
    ...(usage ? { usage } : {}),
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
  if (raw.attempt !== undefined && !isProgressCount(raw.attempt)) return undefined;
  if (raw.sampledAt !== undefined && typeof raw.sampledAt !== "string") return undefined;
  if (raw.activity !== undefined && !["responding", "tool", "idle", "compacting"].includes(raw.activity)) return undefined;
  if (raw.activeTool !== undefined && (!raw.activeTool || typeof raw.activeTool !== "object"
    || typeof raw.activeTool.name !== "string" || typeof raw.activeTool.startedAt !== "string")) return undefined;
  if (raw.contextRecalculating !== undefined && typeof raw.contextRecalculating !== "boolean") return undefined;
  const usage = parseContextStats(raw.usage);
  return {
    id: raw.id,
    role: raw.role,
    status: raw.status,
    ...(raw.summary !== undefined ? { summary: raw.summary } : {}),
    ...(raw.attempts !== undefined ? { attempts: raw.attempts } : {}),
    ...(raw.startedAt !== undefined ? { startedAt: raw.startedAt } : {}),
    ...(raw.updatedAt !== undefined ? { updatedAt: raw.updatedAt } : {}),
    ...(raw.attempt !== undefined ? { attempt: raw.attempt } : {}),
    ...(raw.sampledAt !== undefined ? { sampledAt: raw.sampledAt } : {}),
    ...(raw.activity !== undefined ? { activity: raw.activity } : {}),
    ...(raw.activeTool !== undefined ? { activeTool: raw.activeTool } : {}),
    ...(raw.contextRecalculating !== undefined ? { contextRecalculating: raw.contextRecalculating } : {}),
    ...(usage ? { usage } : {}),
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
  const usage = parseContextStats(raw.usage);
  return {
    ...(raw.receipt ? { receipt: raw.receipt } : {}),
    ...(history ? { history } : {}),
    ...(usage ? { usage } : {}),
    updatedAt: raw.updatedAt,
  };
}

function parseContextStats(value: unknown): WikiContextStats | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const stats: WikiContextStats = {};
  const assign = (key: keyof WikiContextStats) => {
    const next = raw[key];
    if (typeof next === "number" && Number.isFinite(next)) (stats as Record<string, number>)[key] = next;
  };
  assign("turns");
  assign("toolCalls");
  assign("input");
  assign("output");
  assign("cacheRead");
  assign("cacheWrite");
  assign("total");
  assign("cost");
  assign("contextTokens");
  assign("contextWindow");
  assign("contextPercent");
  if (typeof raw.model === "string" && raw.model.trim()) stats.model = raw.model.trim();
  return Object.keys(stats).length > 0 ? stats : undefined;
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

function parseTransaction(value: unknown, expectedId: string): WikiLedgerTransaction {
  if (!value || typeof value !== "object") throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
  const raw = value as Partial<WikiLedgerTransaction>;
  if (raw.version !== 1) throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
  const state = parseState(raw.state, expectedId);
  const event = parseEvent(raw.event, expectedId);
  let task: WikiLedgerTransaction["task"];
  if (raw.task !== undefined) {
    if (!raw.task || typeof raw.task !== "object" || typeof raw.task.id !== "string") {
      throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
    }
    assertSafeId(raw.task.id, "Wiki task ID");
    task = { id: raw.task.id, record: parseTaskRecord(raw.task.record) };
  }
  return { version: 1, state, event, ...(task ? { task } : {}) };
}

async function readEventsFile(file: string, runId: string): Promise<WikiRunEvent[]> {
  try {
    const content = await readFile(file, "utf8");
    return content.split("\n").filter(Boolean).map((line) => parseEvent(JSON.parse(line), runId));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
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
