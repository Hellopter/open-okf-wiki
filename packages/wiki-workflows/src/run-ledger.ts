import { appendFile, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { WikiDelegateReceipt } from "./delegate-contracts.js";
import type {
  WikiContextStats,
  WikiActivityEntry,
  WikiActivityPage,
  WikiAgentRecord,
  WikiAgentSnapshot,
  WikiAgentTarget,
  WikiActiveTool,
  WikiProducerOperation,
  WikiProducerResult,
  WikiRunEvent,
  WikiRunPause,
  WikiRunProgress,
  WikiRunStage,
  WikiRunStatus,
  WikiRunView,
  WikiTaskSnapshot,
  WikiAgentTelemetry,
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

export type WikiLedgerFaultPoint = "afterJournal" | "afterAgent" | "afterState" | "afterEvent" | "afterActivity";

export interface WikiRunLedgerOptions {
  /** @internal Deterministic crash injection for persistence tests. */
  fault?: (point: WikiLedgerFaultPoint) => void | Promise<void>;
}

interface WikiLedgerTransaction {
  version: 1;
  state: WikiRunState;
  event: WikiRunEvent;
  agent?: { target: WikiAgentTarget; record: WikiAgentRecord };
  activity?: WikiActivityEntry[];
}

interface AgentPatch {
  target: WikiAgentTarget;
  agent: WikiAgentSnapshot;
  process?: WikiActivityEntry[];
  receipt?: WikiDelegateReceipt;
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
      activity: path.join(directory, "activity.jsonl"),
      journal: path.join(directory, "pending-transaction.json"),
      agent: (target: WikiAgentTarget) => target.kind === "lead"
        ? path.join(directory, "agents", "lead.json")
        : path.join(directory, "agents", "batches", String(target.batch), `${safeTaskId(target.taskId)}.json`),
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
    if (transaction.agent) {
      const target = runPaths.agent(transaction.agent.target);
      await mkdir(path.dirname(target), { recursive: true });
      await writeAtomic(target, `${JSON.stringify(transaction.agent.record, null, 2)}\n`);
    }
    if (injectFaults) await options.fault?.("afterAgent");
    await writeState(transaction.state);
    if (injectFaults) await options.fault?.("afterState");
    const existing = await readEventsFile(runPaths.events, transaction.state.id);
    if (!existing.some((event) => event.sequence === transaction.event.sequence)) {
      await mkdir(path.dirname(runPaths.events), { recursive: true });
      await appendFile(runPaths.events, `${JSON.stringify(transaction.event)}\n`, "utf8");
    }
    if (injectFaults) await options.fault?.("afterEvent");
    if (transaction.activity?.length) {
      const existingActivity = await readActivityFile(runPaths.activity);
      const known = new Set(existingActivity.map(activityIdentity));
      const combined = [...existingActivity, ...transaction.activity.filter((entry) => !known.has(activityIdentity(entry)))];
      const tools = combined.filter((entry) => entry.kind === "tool").slice(-1000);
      const retained = [...combined.filter((entry) => entry.kind !== "tool"), ...tools].sort((left, right) => left.sequence - right.sequence);
      await writeAtomic(runPaths.activity, retained.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    }
    if (injectFaults) await options.fault?.("afterActivity");
    await rm(runPaths.journal, { force: true });
  };

  const commitEvent = async (
    runId: string,
    input: Omit<WikiRunEvent, "version" | "runId" | "sequence">,
    mutateState?: (state: WikiRunState) => WikiRunState,
    allowTerminalTransition = false,
    agentPatch?: AgentPatch,
    activity?: WikiActivityEntry[],
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
      const progress = mergeProgress(next.progress, event.data ?? {}, event.message, event.at);
      if (progress) next.progress = progress;
    }
    const activityInput = activity ?? agentPatch?.process ?? [];
    const durableActivity = await readActivityFile(paths(runId).activity);
    const transactionActivity = normalizeActivity(durableActivity, activityInput);
    next = projectActivity(next, transactionActivity);
    if (agentPatch) next = projectAgent(next, agentPatch.agent);
    if (next.progress && ["completed", "failed", "paused", "cancelled"].includes(event.type)) {
      if (next.progress.lead) {
        next.progress.lead = {
          ...next.progress.lead,
          status: event.type === "completed" ? "complete" : event.type === "cancelled" ? "cancelled" : event.type === "paused" ? "retrying" : "failed",
          activity: event.type === "completed" ? "settled" : next.progress.lead.activity,
          activeTools: [],
          updatedAt: event.at,
        };
      }
    }
    const terminalLead = next.progress?.lead && ["completed", "failed", "paused", "cancelled"].includes(event.type)
      ? next.progress.lead
      : undefined;
    let agent: WikiLedgerTransaction["agent"];
    const effectivePatch: AgentPatch | undefined = agentPatch ?? (terminalLead ? { target: { kind: "lead" }, agent: terminalLead } : undefined);
    if (effectivePatch) {
      const existing = await readAgentRecordFile(paths(runId).agent(effectivePatch.target));
      agent = {
        target: effectivePatch.target,
        record: parseAgentRecord({
          ...(existing ?? {}),
          agent: effectivePatch.agent,
          process: limitAgentProcess(effectivePatch.process ?? existing?.process ?? []),
          ...(effectivePatch.receipt ? { receipt: effectivePatch.receipt } : {}),
        }),
      };
    }
    const transaction: WikiLedgerTransaction = { version: 1, state: parseState(next, runId), event, ...(agent ? { agent } : {}), ...(transactionActivity.length ? { activity: transactionActivity } : {}) };
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
      activity?: WikiActivityEntry[],
    ) {
      return await serialize(async () => await commitEvent(runId, input, undefined, false, undefined, activity));
    },

    async commitTerminal(
      runId: string,
      input: Omit<WikiRunEvent, "version" | "runId" | "sequence">,
      mutateState: (state: WikiRunState) => WikiRunState,
      activity?: WikiActivityEntry[],
    ) {
      return await serialize(async () => await commitEvent(runId, input, mutateState, true, undefined, activity));
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

    async readAgent(runId: string, target: WikiAgentTarget) {
      return await serialize(async () => {
        await recover(runId);
        const record = await readAgentRecordFile(paths(runId).agent(target));
        if (record) return record;
        const state = await readState(runId);
        if (!state) throw new Error(`Unknown Wiki run: ${runId}`);
        return projectQueuedAgent(state, target);
      });
    },

    async commitAgent(
      runId: string,
      telemetry: WikiAgentTelemetry,
      message: string,
      details?: { role?: WikiTaskSnapshot["role"]; status?: WikiAgentSnapshot["status"]; receipt?: WikiDelegateReceipt },
    ) {
      return await serialize(async () => {
        await recover(runId);
        const state = await readState(runId);
        if (!state) throw new Error(`Unknown Wiki run: ${runId}`);
        if (TERMINAL.has(state.status)) {
          if (details?.receipt) throw new Error(`Terminal Wiki run ${runId} is immutable`);
          return undefined;
        }
        const existing = await readAgentRecordFile(paths(runId).agent(telemetry.target));
        if ((existing?.agent.attempt ?? 0) > telemetry.attempt) return undefined;
        const taskTarget = telemetry.target.kind === "task" ? telemetry.target : undefined;
        const projectedRole = taskTarget
          ? state.progress?.batches?.find((batch) => batch.batch === taskTarget.batch)?.tasks.find((task) => task.id === taskTarget.taskId)?.role
          : undefined;
        const agent = mergeAgentCheckpoint(telemetry, existing?.agent, { ...details, role: details?.role ?? projectedRole });
        return await commitEvent(runId, {
          at: telemetry.sampledAt,
          type: "telemetry",
          message,
          data: { phase: "agent_update", target: telemetry.target },
        }, undefined, false, {
          target: telemetry.target,
          agent,
          process: telemetry.process ?? existing?.process,
          receipt: details?.receipt,
        }, telemetry.process);
      });
    },

    async commitHealth(
      runId: string,
      input: { target: WikiAgentTarget; status: "degraded" | "healthy"; at: string; message?: string },
    ) {
      return await serialize(async () => {
        await recover(runId);
        const state = await readState(runId);
        if (!state) throw new Error(`Unknown Wiki run: ${runId}`);
        if (TERMINAL.has(state.status)) return undefined;
        const existing = await readAgentRecordFile(paths(runId).agent(input.target)) ?? projectQueuedAgent(state, input.target);
        const projected = input.target.kind === "lead"
          ? state.progress?.lead ?? {
              target: input.target,
              role: "lead" as const,
              status: "running" as const,
              attempt: state.attempt || 1,
              activity: "starting" as const,
              activeTools: [],
              health: input.status,
              updatedAt: input.at,
            }
          : undefined;
        const agent = existing?.agent ?? projected;
        if (!agent) return undefined;
        const message = input.message ?? `Observability ${input.status}`;
        return await commitEvent(runId, {
          at: input.at,
          type: "telemetry",
          message,
          data: { phase: "observability_health", target: input.target, status: input.status },
        }, undefined, false, {
          target: input.target,
          agent: { ...agent, health: input.status, updatedAt: input.at },
          process: existing?.process,
          receipt: existing?.receipt,
        }, [{ sequence: 0, at: input.at, kind: "warning", severity: input.status === "degraded" ? "warning" : "info", target: input.target, message }]);
      });
    },

    async activity(runId: string, options: { before?: number; limit?: number; actor?: WikiAgentTarget; severity?: WikiActivityEntry["severity"] } = {}): Promise<WikiActivityPage> {
      return await serialize(async () => {
        await recover(runId);
        if (!(await readState(runId))) throw new Error(`Unknown Wiki run: ${runId}`);
        const before = options.before ?? Number.POSITIVE_INFINITY;
        const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)));
        const filtered = (await readActivityFile(paths(runId).activity))
          .filter((entry) => entry.sequence < before
            && (!options.actor || sameTarget(entry.target, options.actor))
            && (!options.severity || entry.severity === options.severity))
          .sort((left, right) => right.sequence - left.sequence);
        const entries = filtered.slice(0, limit);
        return { entries, ...(filtered.length > limit ? { nextBefore: entries.at(-1)!.sequence } : {}) };
      });
    },
  };

  async function readAgentRecordFile(file: string): Promise<WikiAgentRecord | undefined> {
    try {
      return parseAgentRecord(JSON.parse(await readFile(file, "utf8")));
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

const STAGES = new Set<WikiRunStage>(["prepare", "lead", "validate", "publish"]);
const TASK_ROLES = new Set<WikiTaskSnapshot["role"]>(["research", "write", "review"]);
const TASK_STATUSES = new Set<WikiTaskSnapshot["status"]>(["queued", "running", "complete", "incomplete", "failed"]);

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
  at: string,
): WikiRunProgress | undefined {
  const stage = isStage(data.stage) ? data.stage : current?.stage;
  if (!stage) return current;
  const next: WikiRunProgress = {
    stage,
    ...(current?.lead ? { lead: current.lead } : {}),
    ...(current?.currentBatch ? { currentBatch: current.currentBatch } : {}),
    ...(current?.batches ? { batches: current.batches } : {}),
    ...(current?.recentActivity ? { recentActivity: current.recentActivity } : {}),
    ...(current?.language ? { language: current.language } : {}),
    lastMessage: message,
  };
  if (Array.isArray(data.tasks)) {
    const tasks = data.tasks.map(parseTaskSnapshot).filter((task): task is WikiTaskSnapshot => task !== undefined);
    const batch = isProgressCount(data.batch) ? data.batch : next.currentBatch?.batch ?? 1;
    next.currentBatch = deriveBatch(batch, tasks, next.currentBatch?.batch === batch ? next.currentBatch : undefined, message, at);
    next.batches = upsertBatch(next.batches, next.currentBatch);
  }
  const patchId = eventTaskId(data);
  const existing = patchId ? next.currentBatch?.tasks.find((task) => task.id === patchId) : undefined;
  const patch = patchTaskSnapshot(data, existing);
  if (patch) {
    const tasks = [...(next.currentBatch?.tasks ?? [])];
    const index = tasks.findIndex((task) => task.id === patch.id);
    if (index >= 0) {
      tasks[index] = { ...tasks[index], ...patch };
      if ("activeTool" in data && data.activeTool === null) delete tasks[index].activeTool;
    }
    else tasks.push(patch);
    if (next.currentBatch) {
      next.currentBatch = deriveBatch(next.currentBatch.batch, tasks, next.currentBatch, message, at);
      next.batches = upsertBatch(next.batches, next.currentBatch);
    }
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
    ...(typeof data.activity === "string" ? { activity: data.activity } : {}),
    ...("activeTool" in data
      ? { activeTool: data.activeTool && typeof data.activeTool === "object" ? data.activeTool : undefined }
      : {}),
    ...(usage ? { usage } : {}),
  });
}

function parseProgress(value: unknown): WikiRunProgress | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<WikiRunProgress>;
  if (!isStage(raw.stage)) return undefined;
  if (raw.lastMessage !== undefined && typeof raw.lastMessage !== "string") return undefined;
  const lead = parseAgentSnapshot(raw.lead);
  const currentBatch = parseBatch(raw.currentBatch);
  const batches = Array.isArray(raw.batches) ? raw.batches.map(parseBatch).filter((value): value is NonNullable<typeof value> => !!value) : undefined;
  const activity = Array.isArray(raw.recentActivity) ? raw.recentActivity.map(parseActivityEntry).filter((value): value is WikiActivityEntry => !!value).slice(-20) : undefined;
  return {
    stage: raw.stage,
    ...(lead ? { lead } : {}),
    ...(currentBatch ? { currentBatch } : {}),
    ...(batches?.length ? { batches } : {}),
    ...(activity?.length ? { recentActivity: activity } : {}),
    ...(raw.language === "zh" || raw.language === "en" ? { language: raw.language } : {}),
    ...(raw.lastMessage !== undefined ? { lastMessage: raw.lastMessage } : {}),
  };
}

function parseTaskSnapshot(value: unknown): WikiTaskSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<WikiTaskSnapshot>;
  if (typeof raw.id !== "string" || !isTaskRole(raw.role) || !isTaskStatus(raw.status)) return undefined;
  if (raw.summary !== undefined && typeof raw.summary !== "string") return undefined;
  if (raw.health !== undefined && raw.health !== "healthy" && raw.health !== "degraded") return undefined;
  if (raw.attempts !== undefined && !isProgressCount(raw.attempts)) return undefined;
  if (raw.startedAt !== undefined && typeof raw.startedAt !== "string") return undefined;
  if (raw.updatedAt !== undefined && typeof raw.updatedAt !== "string") return undefined;
  if (raw.attempt !== undefined && !isProgressCount(raw.attempt)) return undefined;
  if (raw.activity !== undefined && !["responding", "tool", "idle", "compacting"].includes(raw.activity)) return undefined;
  if (raw.activeTool !== undefined && (!raw.activeTool || typeof raw.activeTool !== "object"
    || typeof raw.activeTool.name !== "string" || typeof raw.activeTool.startedAt !== "string")) return undefined;
  const usage = parseContextStats(raw.usage);
  return {
    id: raw.id,
    role: raw.role,
    status: raw.status,
    ...(raw.health ? { health: raw.health } : {}),
    ...(raw.summary !== undefined ? { summary: raw.summary } : {}),
    ...(raw.attempts !== undefined ? { attempts: raw.attempts } : {}),
    ...(raw.startedAt !== undefined ? { startedAt: raw.startedAt } : {}),
    ...(raw.updatedAt !== undefined ? { updatedAt: raw.updatedAt } : {}),
    ...(raw.attempt !== undefined ? { attempt: raw.attempt } : {}),
    ...(raw.activity !== undefined ? { activity: raw.activity } : {}),
    ...(raw.activeTool !== undefined ? { activeTool: raw.activeTool } : {}),
    ...(usage ? { usage } : {}),
  };
}

function safeTaskId(value: string): string {
  assertSafeId(value, "Wiki task ID");
  return value;
}

function sameTarget(left: WikiAgentTarget | undefined, right: WikiAgentTarget): boolean {
  if (!left || left.kind !== right.kind) return false;
  return left.kind === "lead" || right.kind === "task" && left.batch === right.batch && left.taskId === right.taskId;
}

function parseAgentRecord(value: unknown): WikiAgentRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid Wiki agent record");
  const raw = value as Partial<WikiAgentRecord>;
  const agent = parseAgentSnapshot(raw.agent);
  if (!agent || typeof agent.updatedAt !== "string" || !Array.isArray(raw.process)) throw new Error("Invalid Wiki agent record");
  const process = raw.process.map(parseActivityEntry);
  if (process.some((entry) => !entry)) throw new Error("Invalid Wiki agent record");
  return {
    agent,
    process: limitAgentProcess(process as WikiActivityEntry[]),
    ...(raw.receipt && typeof raw.receipt === "object" ? { receipt: raw.receipt } : {}),
  };
}

function limitAgentProcess(entries: WikiActivityEntry[]): WikiActivityEntry[] {
  return entries.slice(-200);
}

function parseAgentSnapshot(value: unknown): WikiAgentSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<WikiAgentSnapshot>;
  const target = parseTarget(raw.target);
  if (!target || !["lead", "research", "write", "review"].includes(raw.role ?? "")
    || !["queued", "running", "retrying", "complete", "incomplete", "failed", "cancelled"].includes(raw.status ?? "")
    || !Number.isInteger(raw.attempt) || (raw.attempt ?? -1) < 0 || typeof raw.activity !== "string"
    || !Array.isArray(raw.activeTools) || !["healthy", "degraded"].includes(raw.health ?? "")) return undefined;
  const activeTools = raw.activeTools.map(parseActiveTool);
  if (activeTools.some((tool) => !tool)) return undefined;
  return { ...raw, target, activeTools: activeTools as NonNullable<WikiAgentSnapshot["activeTools"]> } as WikiAgentSnapshot;
}

function parseTarget(value: unknown): WikiAgentTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<WikiAgentTarget> & { batch?: unknown; taskId?: unknown };
  if (raw.kind === "lead") return { kind: "lead" };
  if (raw.kind === "task" && isProgressCount(raw.batch) && typeof raw.taskId === "string" && SAFE_ID.test(raw.taskId)) {
    return { kind: "task", batch: raw.batch, taskId: raw.taskId };
  }
  return undefined;
}

function parseActiveTool(value: unknown): WikiActiveTool | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<WikiActiveTool>;
  return typeof raw.name === "string" && typeof raw.startedAt === "string" ? raw as WikiActiveTool : undefined;
}

function parseActivityEntry(value: unknown): WikiActivityEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<WikiActivityEntry>;
  if (!Number.isInteger(raw.sequence) || typeof raw.at !== "string" || typeof raw.message !== "string"
    || !["stage", "agent", "tool", "batch", "retry", "compaction", "warning", "failure"].includes(raw.kind ?? "")
    || !["info", "warning", "error"].includes(raw.severity ?? "")) return undefined;
  const target = raw.target === undefined ? undefined : parseTarget(raw.target);
  if (raw.target !== undefined && !target) return undefined;
  return { ...raw, ...(target ? { target } : {}) } as WikiActivityEntry;
}

function parseBatch(value: unknown): NonNullable<WikiRunProgress["currentBatch"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as NonNullable<WikiRunProgress["currentBatch"]>;
  if (!isProgressCount(raw.batch) || !isProgressCount(raw.completed) || !isProgressCount(raw.total)
    || !["running", "complete", "partial", "failed"].includes(raw.status) || !Array.isArray(raw.tasks)) return undefined;
  const tasks = raw.tasks.map(parseTaskSnapshot);
  if (tasks.some((task) => !task)) return undefined;
  return { ...raw, tasks: tasks as WikiTaskSnapshot[] };
}

function upsertBatch(batches: WikiRunProgress["batches"], batch: NonNullable<WikiRunProgress["currentBatch"]>): NonNullable<WikiRunProgress["batches"]> {
  const next = [...(batches ?? [])];
  const index = next.findIndex((entry) => entry.batch === batch.batch);
  if (index >= 0) next[index] = batch;
  else next.push(batch);
  return next;
}

function deriveBatch(batch: number, tasks: WikiTaskSnapshot[], previous: WikiRunProgress["currentBatch"], summary: string, at: string): NonNullable<WikiRunProgress["currentBatch"]> {
  const complete = tasks.filter((task) => task.status === "complete").length;
  const terminal = tasks.filter((task) => ["complete", "incomplete", "failed"].includes(task.status)).length;
  const status = tasks.length > 0 && terminal === tasks.length
    ? complete === tasks.length ? "complete" : complete > 0 ? "partial" : "failed"
    : "running";
  return {
    ...(previous ?? {}),
    batch,
    status,
    completed: complete,
    total: tasks.length,
    tasks,
    startedAt: previous?.startedAt ?? at,
    ...(status !== "running" ? { completedAt: previous?.completedAt ?? at } : {}),
  };
}

function projectAgent(state: WikiRunState, agent: WikiAgentSnapshot): WikiRunState {
  const progress = state.progress ?? { stage: "lead" as const };
  if (agent.target.kind === "lead") return { ...state, progress: { ...progress, lead: agent } };
  const taskId = agent.target.taskId;
  const patch = toTaskSnapshot(agent);
  const tasks = progress.currentBatch?.batch === agent.target.batch ? [...progress.currentBatch.tasks] : [];
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index >= 0) tasks[index] = { ...tasks[index], ...patch };
  else tasks.push(patch);
  const currentBatch = deriveBatch(agent.target.batch, tasks, progress.currentBatch?.batch === agent.target.batch ? progress.currentBatch : undefined, agent.summary ?? agent.activity, agent.updatedAt ?? new Date().toISOString());
  return { ...state, progress: { ...progress, currentBatch, batches: upsertBatch(progress.batches, currentBatch) } };
}

function projectActivity(state: WikiRunState, process: WikiActivityEntry[]): WikiRunState {
  const progress = state.progress;
  if (!progress) return state;
  const existing = progress.recentActivity ?? [];
  return { ...state, progress: { ...progress, recentActivity: [...existing, ...process].slice(-20) } };
}

function mergeAgentCheckpoint(telemetry: WikiAgentTelemetry, current: WikiAgentSnapshot | undefined, details?: { role?: WikiTaskSnapshot["role"]; status?: WikiAgentSnapshot["status"]; receipt?: WikiDelegateReceipt }): WikiAgentSnapshot {
  const role = telemetry.target.kind === "lead" ? "lead" : details?.role ?? current?.role;
  if (!role || role === "lead" && telemetry.target.kind === "task") throw new Error("Delegated agent checkpoint requires a task role");
  return {
    ...(current ?? {}),
    target: telemetry.target,
    role,
    status: details?.status ?? details?.receipt?.status ?? current?.status ?? "running",
    attempt: telemetry.attempt,
    activity: telemetry.activity ?? current?.activity ?? "waiting_model",
    activeTools: telemetry.activeTools ?? current?.activeTools ?? [],
    health: current?.health ?? "healthy",
    updatedAt: telemetry.sampledAt,
    lastActivityAt: telemetry.lastActivityAt ?? current?.lastActivityAt,
    lastHeartbeatAt: telemetry.lastHeartbeatAt ?? current?.lastHeartbeatAt,
    deadlineAt: telemetry.deadlineAt ?? current?.deadlineAt,
    usage: telemetry.usage ?? current?.usage,
    summary: details?.receipt?.summary ?? current?.summary,
  };
}

function activityIdentity(entry: WikiActivityEntry): string {
  const target = entry.target?.kind === "task" ? `task:${entry.target.batch}:${entry.target.taskId}` : entry.target?.kind ?? "run";
  return `${target}\0${entry.kind}\0${entry.toolCallId ?? ""}\0${entry.at}\0${entry.message}\0${entry.completed ?? ""}`;
}

function normalizeActivity(existing: WikiActivityEntry[], incoming: WikiActivityEntry[]): WikiActivityEntry[] {
  const known = new Set(existing.map(activityIdentity));
  let sequence = existing.reduce((maximum, entry) => Math.max(maximum, entry.sequence), 0);
  const normalized: WikiActivityEntry[] = [];
  for (const entry of incoming) {
    const identity = activityIdentity(entry);
    if (known.has(identity)) continue;
    known.add(identity);
    normalized.push({ ...entry, sequence: ++sequence });
  }
  return normalized;
}

function projectQueuedAgent(state: WikiRunState, target: WikiAgentTarget): WikiAgentRecord | undefined {
  if (target.kind !== "task") return undefined;
  const task = state.progress?.batches?.find((batch) => batch.batch === target.batch)?.tasks.find((entry) => entry.id === target.taskId)
    ?? (state.progress?.currentBatch?.batch === target.batch
      ? state.progress.currentBatch.tasks.find((entry) => entry.id === target.taskId)
      : undefined);
  if (!task) return undefined;
  const updatedAt = task.updatedAt ?? task.startedAt ?? state.updatedAt;
  return {
    agent: {
      target,
      role: task.role,
      status: task.status,
      attempt: task.attempt ?? task.attempts ?? 0,
      activity: task.status === "queued" ? "starting" : task.activity === "tool" ? "using_tool" : task.activity ?? "waiting_model",
      activeTools: task.activeTool ? [task.activeTool] : [],
      health: "healthy",
      ...(task.startedAt ? { startedAt: task.startedAt } : {}),
      updatedAt,
      ...(task.usage ? { usage: task.usage } : {}),
      ...(task.summary ? { summary: task.summary } : {}),
    },
    process: [],
  };
}

function toTaskSnapshot(agent: WikiAgentSnapshot): WikiTaskSnapshot {
  const activeTool = agent.activeTools[0];
  return {
    id: agent.target.kind === "task" ? agent.target.taskId : "lead",
    role: agent.role === "lead" ? "research" : agent.role,
    status: agent.status === "retrying" || agent.status === "cancelled" ? "failed" : agent.status,
    health: agent.health,
    attempt: agent.attempt,
    activity: agent.activity === "using_tool" ? "tool" : agent.activity === "compacting" ? "compacting" : agent.activity === "settled" ? "idle" : "responding",
    ...(activeTool ? { activeTool } : {}),
    ...(agent.usage ? { usage: agent.usage } : {}),
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

function isStage(value: unknown): value is WikiRunStage {
  return typeof value === "string" && STAGES.has(value as WikiRunStage);
}

function isTaskRole(value: unknown): value is WikiTaskSnapshot["role"] {
  return typeof value === "string" && TASK_ROLES.has(value as WikiTaskSnapshot["role"]);
}

function isTaskStatus(value: unknown): value is WikiTaskSnapshot["status"] {
  return typeof value === "string" && TASK_STATUSES.has(value as WikiTaskSnapshot["status"]);
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
  let agent: WikiLedgerTransaction["agent"];
  if (raw.agent !== undefined) {
    if (!raw.agent || typeof raw.agent !== "object") throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
    const target = parseTarget(raw.agent.target);
    if (!target) throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
    agent = { target, record: parseAgentRecord(raw.agent.record) };
  }
  const activity = raw.activity?.map(parseActivityEntry);
  if (activity?.some((entry) => !entry)) throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
  return { version: 1, state, event, ...(agent ? { agent } : {}), ...(activity?.length ? { activity: activity as WikiActivityEntry[] } : {}) };
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

async function readActivityFile(file: string): Promise<WikiActivityEntry[]> {
  try {
    const content = await readFile(file, "utf8");
    return content.split("\n").filter(Boolean).map((line) => {
      const entry = parseActivityEntry(JSON.parse(line));
      if (!entry) throw new Error("Invalid Wiki activity entry");
      return entry;
    });
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
