import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { claimText, removePath, syncDirectory, writeText } from "./files.js";
import { parseWikiDelegateContract, parseWikiDelegateReceipt, type WikiDelegateContract, type WikiDelegateError, type WikiDelegateReceipt, type WikiTaskFailureCode } from "./delegate-contracts.js";
import { WIKI_BUDGET_EXHAUSTED_CODES } from "./failures.js";
import type {
  WikiContextStats,
  WikiActivityEntry,
  WikiActivityPage,
  WikiAgentSnapshot,
  WikiAgentTarget,
  WikiActiveTool,
  WikiProducerResult,
  WikiRunEvent,
  WikiRunPause,
  WikiRunProgress,
  WikiRunStage,
  WikiRunStatus,
  WikiRunView,
  WikiTaskSnapshot,
  WikiAgentTelemetry,
  WikiExecutionBudgets,
  WikiRunWarning,
} from "./producer-types.js";
import type {
  WikiAgentExecution,
  WikiAgentRecord,
  WikiLeadObservation,
  WikiProductionPlan,
  WikiTaskRuntimePartial,
  WikiTaskRuntimeState,
  WikiTaskRuntimeTaskState,
} from "./runtime-types.js";

export const WIKI_RUN_LEDGER_VERSION = 2 as const;

export class UnsupportedWikiRunVersionError extends Error {
  constructor(readonly location: string, readonly found: unknown) {
    super(`Unsupported Wiki run version at ${location}: expected ${WIKI_RUN_LEDGER_VERSION}, found ${String(found)}`);
    this.name = "UnsupportedWikiRunVersionError";
  }
}

export interface WikiRunState extends WikiRunView {
  version: typeof WIKI_RUN_LEDGER_VERSION;
  attempt: number;
  executionToken?: string;
  productionPlan?: WikiProductionPlan;
  leadSummary?: string;
  publication?: { pages: string[]; sourceFingerprint: string; finalTreeDigest: string };
  pause?: WikiRunPause;
  /** Latest cumulative usage for each target+attempt; used to derive progress.usage idempotently. */
  usageByAttempt?: Record<string, WikiContextStats>;
}

export interface CreateWikiRunState {
  id: string;
  cwd: string;
  focus?: string;
  at: string;
}

export type WikiLedgerFaultPoint = "afterJournal" | "afterExecution" | "afterAgent" | "afterState" | "afterEvent" | "afterActivity" | "afterActive";

export interface WikiRunLedgerOptions {
  /** @internal Deterministic crash injection for persistence tests. */
  fault?: (point: WikiLedgerFaultPoint) => void | Promise<void>;
}

interface WikiLedgerTransaction {
  version: 2;
  state: WikiRunState;
  event: WikiRunEvent;
  agent?: { target: WikiAgentTarget; record: WikiAgentRecord };
  agents?: Array<{ target: WikiAgentTarget; record: WikiAgentRecord }>;
  activity?: WikiActivityEntry[];
  active?: "retain" | "release";
  execution?: { action: "claim"; lease: WikiExecutionLease } | { action: "release" };
}

interface WikiExecutionLease {
  version: 1;
  runId: string;
  attempt: number;
  executionToken: string;
  ownerToken: string;
  pid: number;
  acquiredAt: string;
}

export interface WikiExecutionAuthority {
  attempt: number;
  executionToken: string;
}

export interface WikiExecutionOwner {
  ownerToken: string;
  pid: number;
}

interface WikiDurableUpdate {
  version: 2;
  event: WikiRunEvent;
  state: WikiRunState;
}

interface AgentPatch {
  target: WikiAgentTarget;
  agent: WikiAgentSnapshot;
  process?: WikiActivityEntry[];
  receipt?: WikiDelegateReceipt;
  sessionFile?: string;
  execution?: WikiAgentRecord["execution"];
}

export type WikiProductionTransition =
  | { kind: "started"; at: string }
  | { kind: "attempt_started"; at: string; executionToken: string; owner: WikiExecutionOwner }
  | { kind: "plan_pinned"; at: string; plan: WikiProductionPlan }
  | { kind: "stage_entered"; at: string; stage: WikiRunStage; budgets?: WikiExecutionBudgets }
  | { kind: "lead_completed"; at: string; summary: string }
  | { kind: "paused"; at: string; pause: WikiRunPause }
  | { kind: "interrupted" | "manual_paused"; at: string }
  | { kind: "resumed"; at: string; executionToken: string; owner: WikiExecutionOwner }
  | { kind: "cancelled"; at: string }
  | { kind: "failed"; at: string; error: string }
  | { kind: "warning"; at: string; warning: WikiRunWarning }
  | { kind: "published"; at: string; pages: string[]; sourceFingerprint: string; finalTreeDigest: string };

type WikiRunEventInput = WikiRunEvent extends infer Event
  ? Event extends WikiRunEvent ? Omit<Event, "version" | "runId" | "sequence"> : never
  : never;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TERMINAL = new Set<WikiRunStatus>(["succeeded", "failed", "cancelled"]);
const LOCK_STALE_MS = 5_000;
const LOCK_POLL_MS = 10;

interface ProcessQueue { chain: Promise<void> }
const PROCESS_QUEUES = new Map<string, ProcessQueue>();

export function createWikiRunLedger(rootDirectory: string, options: WikiRunLedgerOptions = {}) {
  const root = path.resolve(rootDirectory);
  const runsRoot = path.join(root, "runs");
  const activeFile = path.join(root, "active-run");
  const lockDirectory = path.join(root, ".ledger.lock");
  const queue = PROCESS_QUEUES.get(root) ?? { chain: Promise.resolve() };
  PROCESS_QUEUES.set(root, queue);

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    let value!: T;
    const next = queue.chain.catch(() => undefined).then(async () => {
      value = await withFilesystemLock(root, lockDirectory, operation);
    });
    queue.chain = next.then(() => undefined, () => undefined);
    await next;
    return value;
  };

  const paths = (runId: string) => {
    assertSafeId(runId, "Wiki run ID");
    const directory = path.join(runsRoot, runId);
    return {
      directory,
      state: path.join(directory, "run-state.json"),
      events: path.join(directory, "events"),
      activity: path.join(directory, "activity.jsonl"),
      journal: path.join(directory, "pending-transaction.json"),
      execution: path.join(directory, "execution-owner.json"),
      agent: (target: WikiAgentTarget) => target.kind === "lead"
        ? path.join(directory, "agents", "lead.json")
        : path.join(directory, "agents", "batches", String(target.batch), `${safeTaskId(target.taskId)}.json`),
      agentBatches: path.join(directory, "agents", "batches"),
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
    await ensureDirectoryDurable(path.dirname(target));
    await writeText(target, `${JSON.stringify(state, null, 2)}\n`);
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
    if (transaction.execution?.action === "claim") {
      await writeText(runPaths.execution, `${JSON.stringify(transaction.execution.lease, null, 2)}\n`);
    }
    if (injectFaults) await options.fault?.("afterExecution");
    const agentWrites = [...(transaction.agents ?? []), ...(transaction.agent ? [transaction.agent] : [])];
    for (const agent of agentWrites) {
      const target = runPaths.agent(agent.target);
      await ensureDirectoryDurable(path.dirname(target));
      await writeText(target, `${JSON.stringify(agent.record, null, 2)}\n`);
    }
    if (injectFaults) await options.fault?.("afterAgent");
    await writeState(transaction.state);
    if (injectFaults) await options.fault?.("afterState");
    const existing = await readUpdatesFile(runPaths.events, transaction.state.id);
    if (!existing.some((update) => update.event.sequence === transaction.event.sequence)) {
      await ensureDirectoryDurable(runPaths.events);
      const update: WikiDurableUpdate = { version: 2, event: transaction.event, state: transaction.state };
      await writeText(eventRecordPath(runPaths.events, transaction.event.sequence), `${JSON.stringify(update)}\n`);
    }
    if (injectFaults) await options.fault?.("afterEvent");
    if (transaction.activity?.length) {
      const existingActivity = await readActivityFile(runPaths.activity);
      const known = new Set(existingActivity.map(activityIdentity));
      const combined = [...existingActivity, ...transaction.activity.filter((entry) => !known.has(activityIdentity(entry)))];
      const tools = combined.filter((entry) => entry.kind === "tool").slice(-1000);
      const retained = [...combined.filter((entry) => entry.kind !== "tool"), ...tools].sort((left, right) => left.sequence - right.sequence);
      await writeText(runPaths.activity, retained.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    }
    if (injectFaults) await options.fault?.("afterActivity");
    if (transaction.active === "release" && await activeRunId(activeFile) === transaction.state.id) {
      await removePath(activeFile, { force: true });
    }
    if (transaction.execution?.action === "release") await removePath(runPaths.execution, { force: true });
    if (injectFaults) await options.fault?.("afterActive");
    await removePath(runPaths.journal, { force: true });
  };

  const commitEvent = async (
    runId: string,
    input: WikiRunEventInput,
    mutateState?: (state: WikiRunState) => WikiRunState,
    allowTerminalTransition = false,
    agentPatch?: AgentPatch,
    activity?: WikiActivityEntry[],
    active: WikiLedgerTransaction["active"] = "retain",
    execution?: WikiLedgerTransaction["execution"],
  ): Promise<WikiRunEvent> => {
    await recover(runId);
    const current = await readState(runId);
    if (!current) throw new Error(`Unknown Wiki run: ${runId}`);
    if (TERMINAL.has(current.status)) throw new Error(`Terminal Wiki run ${runId} is immutable`);
    let next = mutateState ? parseState(mutateState(structuredClone(current)), runId) : structuredClone(current);
    if (!allowTerminalTransition && TERMINAL.has(next.status)) {
      throw new Error("Terminal Wiki state transitions require commitTerminal");
    }
    const event = {
      version: 1,
      runId,
      sequence: current.lastEventSequence + 1,
      ...input,
    } as WikiRunEvent;
    next.lastEventSequence = event.sequence;
    next.updatedAt = event.at;
    const projectedProgress = progressFromEvent(next.progress, event);
    if (projectedProgress) next.progress = projectedProgress;
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
          ...(effectivePatch.sessionFile ?? existing?.sessionFile ? { sessionFile: effectivePatch.sessionFile ?? existing?.sessionFile } : {}),
          ...(effectivePatch.execution ?? existing?.execution ? { execution: effectivePatch.execution ?? existing?.execution } : {}),
        }),
      };
    }
    const transaction: WikiLedgerTransaction = { version: 2, state: parseState(next, runId), event, active, ...(execution ? { execution } : {}), ...(agent ? { agent } : {}), ...(transactionActivity.length ? { activity: transactionActivity } : {}) };
    const journal = paths(runId).journal;
    await writeText(journal, `${JSON.stringify(transaction, null, 2)}\n`);
    await options.fault?.("afterJournal");
    await applyTransaction(transaction, true);
    return event;
  };

  return {
    async create(input: CreateWikiRunState) {
      return await serialize(async () => {
        assertSafeId(input.id, "Wiki run ID");
        await ensureDirectoryDurable(root);
        if (await readState(input.id)) throw new Error(`Wiki run ${input.id} already exists`);
        const existing = await activeRunId(activeFile);
        if (existing) {
          const active = await readState(existing);
          if (active && !TERMINAL.has(active.status)) {
            throw new Error(`Wiki run ${existing} is already active in this workspace`);
          }
          await removePath(activeFile, { force: true });
        }
        await claimText(activeFile, `${JSON.stringify({ version: 2, runId: input.id })}\n`);
        const state: WikiRunState = {
          version: 2,
          id: input.id,
          cwd: path.resolve(input.cwd),
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
          await removePath(activeFile, { force: true });
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

    async transition(runId: string, transition: WikiProductionTransition, authority?: WikiExecutionAuthority) {
      return await serialize(async () => {
        await recover(runId);
        const current = await readState(runId);
        if (!current) throw new Error(`Unknown Wiki run: ${runId}`);
        if (TERMINAL.has(current.status)) throw new Error(`Terminal Wiki run ${runId} is immutable`);
        if (authority && (current.attempt !== authority.attempt || current.executionToken !== authority.executionToken || current.status !== "running")) {
          throw new Error("Wiki execution authority is no longer current");
        }
        const commit = async (
          event: WikiRunEventInput,
          mutate?: (state: WikiRunState) => WikiRunState,
          terminal = false,
          execution?: WikiLedgerTransaction["execution"],
        ) => await commitEvent(runId, event, mutate, terminal, undefined,
          domainActivity(event), terminal ? "release" : "retain", execution);
        switch (transition.kind) {
          case "started":
            if (current.lastEventSequence !== 0 || current.attempt !== 0) throw new Error("Wiki run may be started only once");
            return await commit({ at: transition.at, type: "started", message: "Started Wiki production" });
          case "attempt_started":
            if (current.status !== "running" || current.attempt !== 0 || current.executionToken) throw new Error("The initial Wiki attempt may start only once");
            return await commit({ at: transition.at, type: "stage", stage: "prepare", message: "Preparing candidate Wiki" },
              (state) => ({ ...state, attempt: 1, executionToken: transition.executionToken }), false,
              { action: "claim", lease: executionLease(runId, 1, transition.executionToken, transition.owner, transition.at) });
          case "plan_pinned": {
            const plan = parseProductionPlan(transition.plan, runId);
            if (current.productionPlan) throw new Error("Wiki production plan is already pinned");
            return await commit({ at: transition.at, type: "progress", message: "Pinned Wiki production plan" }, (state) => ({ ...state, productionPlan: plan }));
          }
          case "stage_entered":
            if (current.status !== "running" || !current.productionPlan) throw new Error("Wiki stage requires a pinned running production plan");
            return await commit({ at: transition.at, type: "stage", stage: transition.stage, message: stageMessage(transition.stage), ...(transition.budgets ? { budgets: transition.budgets } : {}) });
          case "lead_completed":
            return await commit({ at: transition.at, type: "progress", message: "Wiki Lead finished" }, (state) => ({ ...state, leadSummary: transition.summary }));
          case "paused":
            if (current.status !== "running") throw new Error("Only a running Wiki run may pause");
            return await commit({ at: transition.at, type: "paused", message: transition.pause.summary, reason: transition.pause.reason,
              ...(transition.pause.retryAt ? { retryAt: transition.pause.retryAt } : {}) }, (state) => {
                const next = { ...state, status: "paused" as const, pause: transition.pause };
                delete next.executionToken;
                return next;
              }, false, { action: "release" });
          case "interrupted":
          case "manual_paused":
            if (current.status !== "running") throw new Error("Only a running Wiki run may pause");
            return await commit({ at: transition.at, type: "paused", message: transition.kind === "interrupted" ? "Recovered interrupted Wiki run" : "Wiki run paused" },
              (state) => {
                const next = { ...state, status: "paused" as const, pause: undefined };
                delete next.executionToken;
                return next;
              }, false, { action: "release" });
          case "resumed":
            if (current.status !== "paused") throw new Error("Only a paused Wiki run may resume");
            return await commit({ at: transition.at, type: "resumed", message: "Wiki run resumed" }, (state) => ({
              ...state, status: "running", attempt: state.attempt + 1, executionToken: transition.executionToken, error: undefined, pause: undefined,
            }), false, { action: "claim", lease: executionLease(runId, current.attempt + 1, transition.executionToken, transition.owner, transition.at) });
          case "cancelled":
            if (current.status !== "running" && current.status !== "paused") throw new Error("Only an active Wiki run may be cancelled");
            return await commit({ at: transition.at, type: "cancelled", message: "Wiki run cancelled" }, (state) => {
              const next = { ...state, status: "cancelled" as const, completedAt: transition.at };
              delete next.executionToken;
              return next;
            }, true, { action: "release" });
          case "failed":
            if (current.status !== "running") throw new Error("Only a running Wiki run may fail");
            return await commit({ at: transition.at, type: "failed", message: transition.error }, (state) => {
              const next = { ...state, status: "failed" as const, error: transition.error, completedAt: transition.at };
              delete next.executionToken;
              return next;
            }, true, { action: "release" });
          case "warning":
            return await commit({ at: transition.at, type: "warning", message: transition.warning.message, code: transition.warning.code, detail: transition.warning.message },
              (state) => ({ ...state, warnings: [...(state.warnings ?? []), transition.warning] }));
          case "published":
            if (current.status !== "running" || current.leadSummary === undefined) {
              throw new Error("Wiki publication requires a completed Lead on a running run");
            }
            return await commit({ at: transition.at, type: "completed", message: "Wiki published" }, (state) => ({
              ...state, status: "succeeded", publication: { pages: transition.pages, sourceFingerprint: transition.sourceFingerprint, finalTreeDigest: transition.finalTreeDigest }, completedAt: transition.at,
              executionToken: undefined,
            }), true, { action: "release" });
        }
      });
    },

    async updates(runId: string, after = 0) {
      return await serialize(async () => {
        await recover(runId);
        if (!(await readState(runId))) throw new Error(`Unknown Wiki run: ${runId}`);
        return (await readUpdatesFile(paths(runId).events, runId))
          .filter((update) => update.event.sequence > after);
      });
    },

    async recordObservation(runId: string, observation: WikiLeadObservation, authority: WikiExecutionAuthority) {
      return await serialize(async () => {
        await recover(runId);
        const state = await readState(runId);
        if (!state) throw new Error(`Unknown Wiki run: ${runId}`);
        if (state.status !== "running" || state.attempt !== authority.attempt || state.executionToken !== authority.executionToken) return undefined;
        if (observation.kind === "progress") {
          return await commitEvent(runId, { at: state.updatedAt, type: "progress", message: observation.message });
        }
        if (observation.kind === "batch") {
          const at = observation.tasks.reduce((latest, task) => task.updatedAt && task.updatedAt > latest ? task.updatedAt : latest, state.updatedAt);
          const completed = observation.tasks.filter((task) => ["complete", "incomplete", "failed"].includes(task.status)).length;
          return await commitEvent(runId, {
            at, type: "delegate", message: `Wiki delegate batch ${observation.batch} ${observation.phase}`,
            phase: observation.phase, batch: observation.batch, tasks: observation.tasks, completed, total: observation.tasks.length,
            ...(observation.taskId ? { taskId: observation.taskId } : {}),
          });
        }
        if (observation.kind === "task_settled") {
          const saved = observation.state;
          if (saved.phase !== "terminal" || !saved.receipt || saved.task.id !== observation.taskId) {
            throw new Error("Wiki task_settled observation requires its matching durable terminal state");
          }
          const target = { kind: "task" as const, batch: observation.batch, taskId: observation.taskId };
          if (observation.telemetry && (!sameTarget(observation.telemetry.target, target) || observation.telemetry.attempt !== saved.attempt)) {
            throw new Error("Wiki task_settled telemetry does not match its durable task state");
          }
          let existing = await readAgentRecordFile(paths(runId).agent(target));
          if ((existing?.agent.attempt ?? 0) > saved.attempt) return undefined;
          if (observation.telemetry) {
            existing = {
              agent: mergeAgentCheckpoint(observation.telemetry, existing?.agent, { role: saved.task.role }),
              process: observation.telemetry.process ?? existing?.process ?? [],
              ...(existing?.receipt ? { receipt: existing.receipt } : {}),
              ...(observation.telemetry.sessionFile ?? existing?.sessionFile ? { sessionFile: observation.telemetry.sessionFile ?? existing?.sessionFile } : {}),
            };
          }
          const record = runtimeAgentRecord(target, saved, existing, observation.telemetry?.sampledAt ?? state.updatedAt);
          return await commitEvent(runId, {
            at: observation.telemetry?.sampledAt ?? state.updatedAt,
            type: "delegate",
            message: saved.receipt.summary,
            phase: "settled", batch: observation.batch, taskId: observation.taskId, completed: 1, total: 1,
          }, observation.telemetry?.usage ? (current) => projectUsage(current, observation.telemetry!) : undefined, false, {
            target, agent: record.agent, process: record.process, receipt: record.receipt, sessionFile: record.sessionFile, execution: record.execution,
          }, record.process);
        }
        if (observation.kind === "telemetry") {
          if (!sameTarget(observation.target, observation.telemetry.target)) throw new Error("Wiki telemetry target does not match its observation target");
          const telemetry = observation.telemetry;
          const existing = await readAgentRecordFile(paths(runId).agent(telemetry.target));
          if ((existing?.agent.attempt ?? 0) > telemetry.attempt) return undefined;
          const agent = mergeAgentCheckpoint(telemetry, existing?.agent, {});
          return await commitEvent(runId, {
            at: telemetry.sampledAt, type: "telemetry", message: "Wiki Agent telemetry", phase: "agent_update", target: telemetry.target,
          }, telemetry.usage ? (current) => projectUsage(current, telemetry) : undefined, false, {
            target: telemetry.target, agent, process: telemetry.process ?? existing?.process, sessionFile: telemetry.sessionFile,
          }, telemetry.process);
        }
        const existing = await readAgentRecordFile(paths(runId).agent(observation.target)) ?? projectQueuedAgent(state, observation.target);
        const projected = observation.target.kind === "lead" ? state.progress?.lead ?? {
          target: observation.target, role: "lead" as const, status: "running" as const, attempt: state.attempt || 1,
          activity: "starting" as const, activeTools: [], health: observation.status, updatedAt: observation.at,
        } : undefined;
        const agent = existing?.agent ?? projected;
        if (!agent) return undefined;
        const message = observation.message ?? `Observability ${observation.status}`;
        return await commitEvent(runId, {
          at: observation.at, type: "telemetry", message, phase: "observability_health", target: observation.target, status: observation.status,
        }, undefined, false, {
          target: observation.target, agent: { ...agent, health: observation.status, updatedAt: observation.at }, process: existing?.process, receipt: existing?.receipt,
        }, [{ sequence: 0, at: observation.at, kind: "warning", severity: observation.status === "degraded" ? "warning" : "info", target: observation.target, message }]);
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

    async executionOwner(runId: string): Promise<"live" | "stale" | "absent"> {
      return await serialize(async () => {
        await recover(runId);
        const state = await readState(runId);
        if (!state) throw new Error(`Unknown Wiki run: ${runId}`);
        const file = paths(runId).execution;
        let lease: WikiExecutionLease;
        try { lease = parseExecutionLease(JSON.parse(await readFile(file, "utf8")), runId); }
        catch (error) { if (isMissing(error)) return "absent"; throw error; }
        if (state.status !== "running" || lease.attempt !== state.attempt || lease.executionToken !== state.executionToken) {
          await removePath(file, { force: true });
          return "stale";
        }
        if (!processIsAlive(lease.pid)) {
          await removePath(file, { force: true });
          return "stale";
        }
        return "live";
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
  const publication = state.publication;
  if (!publication || state.leadSummary === undefined) {
    throw new Error(`Wiki run ${state.id} has an invalid successful result`);
  }
  return {
    runId: state.id,
    status: "succeeded",
    pages: publication.pages,
    sourceFingerprint: publication.sourceFingerprint,
    summary: state.leadSummary,
  };
}

function stageMessage(stage: WikiRunStage): string {
  switch (stage) {
    case "prepare": return "Preparing candidate Wiki";
    case "lead": return "Running Wiki Lead";
    case "validate": return "Validating candidate Wiki";
    case "publish": return "Publishing candidate Wiki";
  }
}

function domainActivity(event: WikiRunEventInput): WikiActivityEntry[] {
  return [{
    sequence: 0, at: event.at,
    kind: event.type === "failed" ? "failure" : event.type === "stage" ? "stage" : event.type === "delegate" ? "batch" : event.type === "warning" ? "warning" : "agent",
    severity: event.type === "failed" ? "error" : event.type === "warning" ? "warning" : "info",
    message: event.message,
    completed: event.type === "completed" || event.type === "cancelled" || event.type === "failed",
  }];
}

function parseState(value: unknown, expectedId: string): WikiRunState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki run state: ${expectedId}`);
  const state = value as Partial<WikiRunState> & Record<string, unknown>;
  assertExactKeys(state, ["version", "id", "cwd", "focus", "status", "createdAt", "updatedAt", "completedAt", "lastEventSequence",
    "error", "pause", "warnings", "progress", "attempt", "executionToken", "productionPlan", "leadSummary", "publication", "usageByAttempt"], "Wiki run state");
  if (state.version !== WIKI_RUN_LEDGER_VERSION) {
    throw new UnsupportedWikiRunVersionError(`runs/${expectedId}/run-state.json`, state.version);
  }
  if (state.id !== expectedId || typeof state.cwd !== "string"
    || !["running", "paused", "succeeded", "failed", "cancelled"].includes(state.status ?? "")
    || typeof state.createdAt !== "string" || typeof state.updatedAt !== "string"
    || !Number.isInteger(state.lastEventSequence) || (state.lastEventSequence ?? -1) < 0
    || !Number.isInteger(state.attempt) || (state.attempt ?? -1) < 0
    || (state.executionToken !== undefined && !isToken(state.executionToken))
    || (state.leadSummary !== undefined && typeof state.leadSummary !== "string")
    || (state.focus !== undefined && typeof state.focus !== "string")
    || (state.completedAt !== undefined && typeof state.completedAt !== "string")
    || (state.error !== undefined && typeof state.error !== "string")
    || !isPause(state.pause)) {
    throw new Error(`Invalid Wiki run state: ${expectedId}`);
  }
  const parsed = state as WikiRunState;
  if (state.productionPlan !== undefined) parsed.productionPlan = parseProductionPlan(state.productionPlan, expectedId);
  parsed.publication = parseRunPublication(state.publication, expectedId);
  if (!parsed.publication) delete parsed.publication;
  parsed.warnings = parseWarnings(state.warnings, expectedId);
  if (!parsed.warnings?.length) delete parsed.warnings;
  parsed.usageByAttempt = parseUsageByAttempt(state.usageByAttempt);
  if (!parsed.usageByAttempt) delete parsed.usageByAttempt;
  const progress = parseProgress(state.progress);
  if (progress) parsed.progress = progress;
  else delete parsed.progress;
  if (parsed.status === "running" && parsed.attempt > 0 && !parsed.executionToken
    || parsed.status !== "running" && parsed.executionToken
    || TERMINAL.has(parsed.status) !== Boolean(parsed.completedAt)
    || parsed.status === "succeeded" && (!parsed.publication || parsed.leadSummary === undefined)
    || parsed.status === "failed" && !parsed.error) throw new Error(`Invalid Wiki run state lifecycle: ${expectedId}`);
  return parsed;
}

function parseProductionPlan(value: unknown, runId: string): WikiProductionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki production plan: ${runId}`);
  const plan = value as Partial<WikiProductionPlan> & Record<string, unknown>;
  assertExactKeys(plan, ["sourcePlan", "candidateWikiRoot", "skillRoot", "skillTreeDigest", "language", "generation",
    "maxConcurrentAgents", "budgets", "models", "runSessionDirectory", "leadSessionFile", "leadSessionAttempt", "transientRetries",
    "sessionTimeoutMs", "baseRetryDelayMs", "prompt"], "Wiki production plan");
  const sourcePlan = parsePinnedSourcePlan(plan.sourcePlan, runId);
  if (!sourcePlan || typeof plan.candidateWikiRoot !== "string" || typeof plan.skillRoot !== "string" || !isDigest(plan.skillTreeDigest)
    || (plan.language !== "zh" && plan.language !== "en")
    || typeof plan.runSessionDirectory !== "string" || typeof plan.prompt !== "string"
    || !parseExecutionBudgets(plan.budgets) || !isRoleModels(plan.models) || !isGenerationProfile(plan.generation)
    || !Number.isInteger(plan.maxConcurrentAgents) || (plan.maxConcurrentAgents ?? 0) < 1
    || !Number.isInteger(plan.transientRetries) || (plan.transientRetries ?? -1) < 0
    || !Number.isFinite(plan.sessionTimeoutMs) || (plan.sessionTimeoutMs ?? 0) <= 0
    || !Number.isFinite(plan.baseRetryDelayMs) || (plan.baseRetryDelayMs ?? -1) < 0) {
    throw new Error(`Invalid Wiki production plan: ${runId}`);
  }
  const expectedRunRoot = path.join(sourcePlan.workspaceRoot, ".okf-wiki", "runs", runId);
  if (path.resolve(sourcePlan.workspaceRoot) !== sourcePlan.workspaceRoot
    || path.resolve(plan.candidateWikiRoot) !== path.join(expectedRunRoot, "candidate", "wiki")
    || path.resolve(plan.skillRoot) !== path.join(expectedRunRoot, "skill")
    || path.resolve(plan.runSessionDirectory) !== path.join(expectedRunRoot, "sessions")) {
    throw new Error(`Invalid Wiki production plan identity: ${runId}`);
  }
  return structuredClone(plan as WikiProductionPlan);
}

function parsePinnedSourcePlan(value: unknown, runId: string): WikiProductionPlan["sourcePlan"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<WikiProductionPlan["sourcePlan"]> & Record<string, unknown>;
  assertExactKeys(raw, ["workspaceRoot", "workspaceRealPath", "configPath", "defaultSourceIgnores", "excludes", "sources", "fingerprint"], "Wiki pinned source plan");
  if (typeof raw.workspaceRoot !== "string" || typeof raw.workspaceRealPath !== "string" || typeof raw.configPath !== "string"
    || typeof raw.defaultSourceIgnores !== "boolean" || !isStringArray(raw.excludes) || !Array.isArray(raw.sources)
    || typeof raw.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.fingerprint)) return undefined;
  const scopes = new Set<string>();
  const sources = raw.sources.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki pinned source: ${runId}`);
    const source = value as Partial<WikiProductionPlan["sourcePlan"]["sources"][number]>;
    assertExactKeys(source as Record<string, unknown>, ["scopeId", "logicalPath", "absolutePath", "realPath", "repositoryRoot", "repositoryIdentity", "origin", "head", "dirtyFingerprint"], "Wiki pinned source");
    if (typeof source.scopeId !== "string" || !source.scopeId || scopes.has(source.scopeId)
      || typeof source.logicalPath !== "string" || typeof source.absolutePath !== "string" || typeof source.realPath !== "string"
      || typeof source.repositoryRoot !== "string" || typeof source.repositoryIdentity !== "string"
      || !isPinnedOrigin(source.origin)
      || typeof source.head !== "string" || typeof source.dirtyFingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(source.repositoryIdentity) || !/^[a-f0-9]{64}$/.test(source.dirtyFingerprint)) {
      throw new Error(`Invalid Wiki pinned source: ${runId}`);
    }
    if (path.resolve(source.absolutePath) !== source.absolutePath || path.resolve(source.realPath) !== source.realPath
      || path.resolve(source.repositoryRoot) !== source.repositoryRoot) throw new Error(`Invalid Wiki pinned source paths: ${runId}`);
    scopes.add(source.scopeId);
    return structuredClone(source as WikiProductionPlan["sourcePlan"]["sources"][number]);
  });
  if (path.resolve(raw.workspaceRoot) !== raw.workspaceRoot || path.resolve(raw.workspaceRealPath) !== raw.workspaceRealPath
    || path.resolve(raw.configPath) !== raw.configPath) throw new Error(`Invalid Wiki pinned workspace paths: ${runId}`);
  return { ...structuredClone(raw as WikiProductionPlan["sourcePlan"]), sources };
}

function isPinnedOrigin(value: unknown): value is WikiProductionPlan["sourcePlan"]["sources"][number]["origin"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.type === "link") return Object.keys(raw).every((key) => ["type", "localPath"].includes(key)) && typeof raw.localPath === "string";
  return raw.type === "clone" && Object.keys(raw).every((key) => ["type", "remoteUrl", "ref"].includes(key))
    && typeof raw.remoteUrl === "string" && (raw.ref === undefined || typeof raw.ref === "string");
}

function parseRunPublication(value: unknown, runId: string): WikiRunState["publication"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error(`Invalid Wiki run publication: ${runId}`);
  const raw = value as Partial<NonNullable<WikiRunState["publication"]>>;
  assertExactKeys(raw as Record<string, unknown>, ["pages", "sourceFingerprint", "finalTreeDigest"], "Wiki run publication");
  if (!isStringArray(raw.pages) || typeof raw.sourceFingerprint !== "string" || typeof raw.finalTreeDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(raw.finalTreeDigest)) throw new Error(`Invalid Wiki run publication: ${runId}`);
  return { pages: [...raw.pages], sourceFingerprint: raw.sourceFingerprint, finalTreeDigest: raw.finalTreeDigest };
}

function parseWarnings(value: unknown, runId: string): WikiRunWarning[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Invalid Wiki run warnings: ${runId}`);
  return value.map((entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) assertExactKeys(entry as Record<string, unknown>, ["code", "message", "at"], "Wiki run warning");
    if (!entry || typeof entry !== "object" || (entry as { code?: unknown }).code !== "cleanup_failed"
      || typeof (entry as { message?: unknown }).message !== "string" || typeof (entry as { at?: unknown }).at !== "string") {
      throw new Error(`Invalid Wiki run warning: ${runId}`);
    }
    return structuredClone(entry as WikiRunWarning);
  });
}

const STAGES = new Set<WikiRunStage>(["prepare", "lead", "validate", "publish"]);
const TASK_ROLES = new Set<WikiTaskSnapshot["role"]>(["research", "write", "review"]);
const TASK_STATUSES = new Set<WikiTaskSnapshot["status"]>(["queued", "running", "complete", "incomplete", "failed"]);

function progressFromEvent(current: WikiRunProgress | undefined, event: WikiRunEvent): WikiRunProgress | undefined {
  if (event.type === "stage") return mergeProgress(current, { stage: event.stage, budgets: event.budgets }, event.message, event.at);
  if (event.type === "delegate") return mergeProgress(current, {
    stage: "lead", batch: event.batch, completed: event.completed, total: event.total,
    ...(event.tasks ? { tasks: event.tasks } : {}), ...(event.taskId ? { taskId: event.taskId } : {}),
  }, event.message, event.at);
  if (event.type === "progress" && current) return { ...current, lastMessage: event.message };
  return current;
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
    ...(current?.usage ? { usage: current.usage } : {}),
    ...(current?.budgets ? { budgets: current.budgets } : {}),
    lastMessage: message,
  };
  const budgets = parseExecutionBudgets(data.budgets);
  if (budgets) next.budgets = budgets;
  if (Array.isArray(data.tasks)) {
    const tasks = data.tasks.map(parseTaskSnapshot).filter((task): task is WikiTaskSnapshot => task !== undefined);
    const batch = isPositiveInteger(data.batch) ? data.batch : next.currentBatch?.batch ?? 1;
    const previous = next.batches?.find((entry) => entry.batch === batch)
      ?? (next.currentBatch?.batch === batch ? next.currentBatch : undefined);
    next.currentBatch = deriveBatch(batch, tasks, previous, message, at);
    next.batches = upsertBatch(next.batches, next.currentBatch);
  }
  const patchId = eventTaskId(data);
  const patchBatchId = isPositiveInteger(data.batch) ? data.batch : next.currentBatch?.batch;
  const patchBatch = patchBatchId === undefined ? undefined : next.batches?.find((entry) => entry.batch === patchBatchId)
    ?? (next.currentBatch?.batch === patchBatchId ? next.currentBatch : undefined);
  const existing = patchId ? patchBatch?.tasks.find((task) => task.id === patchId) : undefined;
  const patch = patchTaskSnapshot(data, existing);
  if (patch && patchBatchId !== undefined) {
    const tasks = [...(patchBatch?.tasks ?? [])];
    const index = tasks.findIndex((task) => task.id === patch.id);
    if (index >= 0) {
      tasks[index] = { ...tasks[index], ...patch };
      if ("activeTool" in data && data.activeTool === null) delete tasks[index].activeTool;
    }
    else tasks.push(patch);
    next.currentBatch = deriveBatch(patchBatchId, tasks, patchBatch, message, at);
    next.batches = upsertBatch(next.batches, next.currentBatch);
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
  const usage = parseContextStats(raw.usage);
  const budgets = parseExecutionBudgets(raw.budgets);
  return {
    stage: raw.stage,
    ...(lead ? { lead } : {}),
    ...(currentBatch ? { currentBatch } : {}),
    ...(batches?.length ? { batches } : {}),
    ...(activity?.length ? { recentActivity: activity } : {}),
    ...(raw.language === "zh" || raw.language === "en" ? { language: raw.language } : {}),
    ...(raw.lastMessage !== undefined ? { lastMessage: raw.lastMessage } : {}),
    ...(usage ? { usage } : {}),
    ...(budgets ? { budgets } : {}),
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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Wiki agent record");
  const raw = value as Partial<WikiAgentRecord> & Record<string, unknown>;
  assertExactKeys(raw, ["agent", "process", "receipt", "sessionFile", "execution"], "Wiki agent record");
  const agent = parseAgentSnapshot(raw.agent);
  if (!agent || typeof agent.updatedAt !== "string" || !Array.isArray(raw.process)) throw new Error("Invalid Wiki agent record");
  const process = raw.process.map(parseActivityEntry);
  if (process.some((entry) => !entry)) throw new Error("Invalid Wiki agent record");
  const execution = parseAgentExecution(raw.execution);
  const receipt = raw.receipt === undefined ? undefined : parseWikiDelegateReceipt(raw.receipt);
  return {
    agent,
    process: limitAgentProcess(process as WikiActivityEntry[]),
    ...(receipt ? { receipt } : {}),
    ...(typeof raw.sessionFile === "string" && raw.sessionFile.trim() ? { sessionFile: raw.sessionFile } : {}),
    ...(execution ? { execution } : {}),
  };
}

function parseAgentExecution(value: unknown): WikiAgentRecord["execution"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<WikiAgentExecution>;
  const task = parseDelegateTask(raw.task);
  const partial = parseTaskRuntimePartial(raw.partial);
  const pause = parseDelegateError(raw.pause);
  if (!task || !isPositiveInteger(raw.batchId) || !isProgressCount(raw.attempt)
    || !["queued", "running", "paused", "terminal"].includes(raw.phase ?? "")
    || typeof raw.collected !== "boolean" || raw.partial !== undefined && !partial
    || raw.pause !== undefined && !pause || raw.phase !== "paused" && raw.pause !== undefined
    || raw.phase === "paused" && (!isPositiveInteger(raw.attempt) || raw.collected)) return undefined;
  return {
    batchId: raw.batchId,
    task,
    phase: raw.phase as WikiAgentExecution["phase"],
    attempt: raw.attempt,
    collected: raw.collected,
    ...(pause ? { pause } : {}),
    ...(partial ? { partial } : {}),
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
  const target = agent.target;
  const taskId = target.taskId;
  const patch = toTaskSnapshot(agent);
  const previous = progress.batches?.find((batch) => batch.batch === target.batch)
    ?? (progress.currentBatch?.batch === target.batch ? progress.currentBatch : undefined);
  const tasks = [...(previous?.tasks ?? [])];
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index >= 0) tasks[index] = { ...tasks[index], ...patch };
  else tasks.push(patch);
  const currentBatch = deriveBatch(target.batch, tasks, previous, agent.summary ?? agent.activity, agent.updatedAt ?? new Date().toISOString());
  return { ...state, progress: { ...progress, currentBatch, batches: upsertBatch(progress.batches, currentBatch) } };
}

function projectUsage(state: WikiRunState, telemetry: WikiAgentTelemetry): WikiRunState {
  if (!telemetry.usage) return state;
  const usageByAttempt = {
    ...(state.usageByAttempt ?? {}),
    [usageAttemptKey(telemetry.target, telemetry.attempt)]: telemetry.usage,
  };
  const progress = state.progress ?? { stage: "lead" as const };
  return {
    ...state,
    usageByAttempt,
    progress: { ...progress, usage: aggregateUsage(Object.values(usageByAttempt)) },
  };
}

function usageAttemptKey(target: WikiAgentTarget, attempt: number): string {
  return target.kind === "lead"
    ? `lead:${attempt}`
    : `task:${target.batch}:${target.taskId}:${attempt}`;
}

const AGGREGATE_USAGE_FIELDS = ["turns", "toolCalls", "input", "output", "cacheRead", "cacheWrite", "total", "cost"] as const;

function aggregateUsage(values: WikiContextStats[]): WikiContextStats {
  const result: WikiContextStats = {};
  for (const usage of values) {
    for (const field of AGGREGATE_USAGE_FIELDS) {
      const value = usage[field];
      if (value !== undefined) result[field] = (result[field] ?? 0) + value;
    }
  }
  return result;
}

function parseUsageByAttempt(value: unknown): Record<string, WikiContextStats> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, WikiContextStats> = {};
  for (const [key, raw] of Object.entries(value)) {
    const usage = parseContextStats(raw);
    if (!key || !usage) return undefined;
    result[key] = usage;
  }
  return Object.keys(result).length ? result : undefined;
}

function parseExecutionBudgets(value: unknown): WikiExecutionBudgets | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<WikiExecutionBudgets> & Record<string, unknown>;
  const fields = ["maxDelegatedTasks", "maxDelegateBatches", "maxTurnsPerSession", "maxToolCallsPerSession"] as const;
  if (Object.keys(raw).some((key) => !fields.includes(key as typeof fields[number]))) return undefined;
  if (fields.some((field) => !Number.isInteger(raw[field]) || (raw[field] ?? 0) < 1)) return undefined;
  return raw as WikiExecutionBudgets;
}

function parseTaskRuntimeState(value: unknown): WikiTaskRuntimeState {
  if (!value || typeof value !== "object") throw new Error("Invalid Wiki task runtime state");
  const raw = value as Partial<WikiTaskRuntimeState>;
  if (!Array.isArray(raw.batches)) throw new Error("Invalid Wiki task runtime state");
  const seenBatches = new Set<number>();
  const seenTargets = new Set<string>();
  const batches = raw.batches.map((batchValue) => {
    if (!batchValue || typeof batchValue !== "object") throw new Error("Invalid Wiki task runtime batch");
    const batch = batchValue as Partial<WikiTaskRuntimeState["batches"][number]>;
    if (!isPositiveInteger(batch.batchId) || seenBatches.has(batch.batchId) || !Array.isArray(batch.tasks)) {
      throw new Error("Invalid Wiki task runtime batch");
    }
    seenBatches.add(batch.batchId);
    const tasks = batch.tasks.map((taskValue) => {
      const task = parseTaskRuntimeTaskState(taskValue);
      const identity = `${batch.batchId}:${task.task.id}`;
      if (seenTargets.has(identity)) throw new Error(`Duplicate Wiki runtime task: ${identity}`);
      seenTargets.add(identity);
      return task;
    });
    return { batchId: batch.batchId, tasks };
  }).sort((left, right) => left.batchId - right.batchId);
  return { batches };
}

function parseTaskRuntimeTaskState(value: unknown): WikiTaskRuntimeTaskState {
  if (!value || typeof value !== "object") throw new Error("Invalid Wiki task runtime task");
  const raw = value as Partial<WikiTaskRuntimeTaskState>;
  const task = parseDelegateTask(raw.task);
  const partial = parseTaskRuntimePartial(raw.partial);
  const receipt = parseDelegateReceipt(raw.receipt);
  const pause = parseDelegateError(raw.pause);
  if (!task || !isProgressCount(raw.attempt) || !["queued", "running", "paused", "terminal"].includes(raw.phase ?? "")
    || typeof raw.collected !== "boolean" || raw.partial !== undefined && !partial
    || raw.sessionFile !== undefined && (typeof raw.sessionFile !== "string" || !raw.sessionFile.trim())
    || raw.phase === "terminal" && !receipt || raw.phase !== "terminal" && raw.receipt !== undefined
    || raw.pause !== undefined && !pause || raw.phase !== "paused" && raw.pause !== undefined
    || raw.phase === "paused" && (!isPositiveInteger(raw.attempt) || raw.collected)) {
    throw new Error("Invalid Wiki task runtime task");
  }
  return {
    task,
    phase: raw.phase as WikiTaskRuntimeTaskState["phase"],
    attempt: raw.attempt,
    collected: raw.collected,
    ...(raw.sessionFile ? { sessionFile: raw.sessionFile } : {}),
    ...(receipt ? { receipt } : {}),
    ...(pause ? { pause } : {}),
    ...(partial ? { partial } : {}),
  };
}

function parseDelegateTask(value: unknown): WikiDelegateContract | undefined {
  try { return parseWikiDelegateContract(value); }
  catch { return undefined; }
}

function parseTaskRuntimePartial(value: unknown): WikiTaskRuntimePartial | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<WikiTaskRuntimePartial>;
  if (!Array.isArray(raw.outputs) || raw.outputs.some((entry) => !entry || typeof entry !== "object")
    || !isStringArray(raw.coverage) || !Array.isArray(raw.gaps) || raw.gaps.some((entry) => !entry || typeof entry !== "object")) return undefined;
  return structuredClone(raw as WikiTaskRuntimePartial);
}

function parseDelegateReceipt(value: unknown): WikiDelegateReceipt | undefined {
  if (value === undefined) return undefined;
  try { return parseWikiDelegateReceipt(value); } catch { return undefined; }
}

const TASK_FAILURE_CODES = new Set<WikiTaskFailureCode>([
  "rate_limit", "quota", "usage_limit", "server_error", "network_reset", "timeout", "context_exhausted",
  "unauthorized", "forbidden", "billing", "invalid_request", "schema", "artifact_io", "cancelled", "unknown",
  ...WIKI_BUDGET_EXHAUSTED_CODES,
]);

function parseDelegateError(value: unknown): WikiDelegateError | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<WikiDelegateError>;
  if (typeof raw.code !== "string" || !TASK_FAILURE_CODES.has(raw.code as WikiTaskFailureCode)
    || typeof raw.message !== "string" || !raw.message.trim() || typeof raw.retryable !== "boolean"
    || raw.retryAfterMs !== undefined && (!Number.isFinite(raw.retryAfterMs) || raw.retryAfterMs < 0)) return undefined;
  return structuredClone(raw as WikiDelegateError);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function runtimeAgentRecord(
  target: Extract<WikiAgentTarget, { kind: "task" }>,
  state: WikiTaskRuntimeTaskState,
  existing: WikiAgentRecord | undefined,
  at: string,
): WikiAgentRecord {
  const sameAttempt = existing?.agent.attempt === state.attempt;
  const receipt = state.phase === "terminal" ? state.receipt : undefined;
  const status = state.phase === "queued" ? "queued"
    : state.phase === "running" ? "running"
      : state.phase === "paused" ? "retrying"
        : receipt!.status;
  const agent: WikiAgentSnapshot = {
    ...(sameAttempt ? existing.agent : {}),
    target,
    role: state.task.role,
    status,
    attempt: state.attempt,
    activity: state.phase === "queued" ? "starting"
      : state.phase === "running" ? "waiting_model"
        : state.phase === "paused" ? "retry_wait"
          : "settled",
    activeTools: state.phase === "running" && sameAttempt ? existing.agent.activeTools : [],
    health: sameAttempt ? existing.agent.health : "healthy",
    updatedAt: at,
    ...(receipt ? { summary: receipt.summary } : {}),
  };
  const execution: WikiAgentExecution = {
    batchId: target.batch,
    task: state.task,
    phase: state.phase,
    attempt: state.attempt,
    collected: state.collected,
    ...(state.pause ? { pause: state.pause } : {}),
    ...(state.partial ? { partial: state.partial } : {}),
  };
  const sessionFile = state.sessionFile ?? (sameAttempt ? existing?.sessionFile : undefined);
  return parseAgentRecord({
    agent,
    process: sameAttempt ? existing?.process ?? [] : [],
    ...(receipt ? { receipt } : {}),
    ...(sessionFile ? { sessionFile } : {}),
    execution,
  });
}

async function taskRuntimeStateFromLedger(
  batchesDirectory: string,
  readRecord: (file: string) => Promise<WikiAgentRecord | undefined>,
): Promise<WikiTaskRuntimeState> {
  const grouped = new Map<number, WikiTaskRuntimeTaskState[]>();
  let batchEntries: import("node:fs").Dirent[];
  try {
    batchEntries = await readdir(batchesDirectory, { withFileTypes: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
    batchEntries = [];
  }
  for (const batchEntry of batchEntries) {
    if (!batchEntry.isDirectory() || !/^\d+$/.test(batchEntry.name)) continue;
    const batchId = Number(batchEntry.name);
    if (!isPositiveInteger(batchId)) continue;
    const directory = path.join(batchesDirectory, batchEntry.name);
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const file of files) {
      const record = await readRecord(path.join(directory, file.name));
      const execution = record?.execution;
      if (!record || !execution) continue;
      if (record.agent.target.kind !== "task" || record.agent.target.batch !== batchId
        || execution.batchId !== batchId || execution.task.id !== record.agent.target.taskId) {
        throw new Error("Wiki task runtime sidecar identity mismatch");
      }
      const task: WikiTaskRuntimeTaskState = {
        task: execution.task,
        phase: execution.phase,
        attempt: execution.attempt,
        collected: execution.collected,
        ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
        ...(record.receipt ? { receipt: record.receipt } : {}),
        ...(execution.pause ? { pause: execution.pause } : {}),
        ...(execution.partial ? { partial: execution.partial } : {}),
      };
      (grouped.get(batchId) ?? grouped.set(batchId, []).get(batchId)!).push(task);
    }
  }
  const batches = [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([batchId, tasks]) => ({ batchId, tasks: tasks.sort((left, right) => left.task.id.localeCompare(right.task.id)) }));
  return parseTaskRuntimeState({ batches });
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
    status: agent.status === "retrying" ? "running" : agent.status === "cancelled" ? "failed" : agent.status,
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
  const event = value as Partial<WikiRunEvent> & Record<string, unknown>;
  if (event.version !== 1 || event.runId !== expectedId || !Number.isInteger(event.sequence)
    || (event.sequence ?? 0) < 1 || typeof event.at !== "string" || typeof event.type !== "string"
    || typeof event.message !== "string") throw new Error(`Invalid Wiki run event: ${expectedId}`);
  const common = ["version", "runId", "sequence", "at", "type", "message"];
  switch (event.type) {
    case "started": case "progress": case "resumed": case "cancelled": case "completed": case "failed":
      assertExactKeys(event, common, "Wiki run event");
      break;
    case "stage":
      assertExactKeys(event, [...common, "stage", "budgets"], "Wiki stage event");
      if (!isStage(event.stage) || event.budgets !== undefined && !parseExecutionBudgets(event.budgets)) throw new Error(`Invalid Wiki run event: ${expectedId}`);
      break;
    case "delegate":
      assertExactKeys(event, [...common, "phase", "batch", "completed", "total", "tasks", "taskId"], "Wiki delegate event");
      if (!["queued", "started", "updated", "completed", "settled"].includes(String(event.phase)) || !isPositiveInteger(event.batch)
        || !isProgressCount(event.completed) || !isProgressCount(event.total) || event.completed > event.total
        || event.tasks !== undefined && (!Array.isArray(event.tasks) || event.tasks.some((task) => !parseTaskSnapshot(task)))
        || event.taskId !== undefined && typeof event.taskId !== "string") throw new Error(`Invalid Wiki run event: ${expectedId}`);
      break;
    case "telemetry":
      assertExactKeys(event, [...common, "phase", "target", "status"], "Wiki telemetry event");
      if (!parseTarget(event.target)
        || event.phase === "agent_update" && event.status !== undefined
        || event.phase === "observability_health" && event.status !== "healthy" && event.status !== "degraded"
        || event.phase !== "agent_update" && event.phase !== "observability_health") throw new Error(`Invalid Wiki run event: ${expectedId}`);
      break;
    case "paused":
      assertExactKeys(event, [...common, "reason", "retryAt"], "Wiki paused event");
      if (event.reason !== undefined && event.reason !== "quota" && event.reason !== "usage_limit"
        || event.retryAt !== undefined && typeof event.retryAt !== "string") throw new Error(`Invalid Wiki run event: ${expectedId}`);
      break;
    case "warning":
      assertExactKeys(event, [...common, "code", "detail"], "Wiki warning event");
      if (event.code !== "cleanup_failed" || typeof event.detail !== "string") throw new Error(`Invalid Wiki run event: ${expectedId}`);
      break;
    default: throw new Error(`Invalid Wiki run event: ${expectedId}`);
  }
  return event as WikiRunEvent;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}

function parseTransaction(value: unknown, expectedId: string): WikiLedgerTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
  const raw = value as Partial<WikiLedgerTransaction> & Record<string, unknown>;
  assertExactKeys(raw, ["version", "state", "event", "agent", "agents", "activity", "active", "execution"], "Wiki ledger transaction");
  if (raw.version !== 2) throw new UnsupportedWikiRunVersionError(`runs/${expectedId}/pending-transaction.json`, raw.version);
  const state = parseState(raw.state, expectedId);
  const event = parseEvent(raw.event, expectedId);
  let agent: WikiLedgerTransaction["agent"];
  if (raw.agent !== undefined) {
    if (!raw.agent || typeof raw.agent !== "object" || Array.isArray(raw.agent)) throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
    assertExactKeys(raw.agent as unknown as Record<string, unknown>, ["target", "record"], "Wiki ledger agent transaction");
    const target = parseTarget(raw.agent.target);
    if (!target) throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
    agent = { target, record: parseAgentRecord(raw.agent.record) };
  }
  let agents: WikiLedgerTransaction["agents"];
  if (raw.agents !== undefined) {
    if (!Array.isArray(raw.agents)) throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
    agents = raw.agents.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
      assertExactKeys(entry as Record<string, unknown>, ["target", "record"], "Wiki ledger agents transaction");
      const target = parseTarget(entry.target);
      if (!target) throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
      return { target, record: parseAgentRecord(entry.record) };
    });
  }
  const activity = raw.activity?.map(parseActivityEntry);
  if (activity?.some((entry) => !entry)) throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
  if (raw.active !== undefined && raw.active !== "retain" && raw.active !== "release") throw new Error(`Invalid Wiki ledger transaction: ${expectedId}`);
  const execution = parseTransactionExecution(raw.execution, expectedId);
  assertUpdateInvariant(event, state);
  return { version: 2, state, event, ...(agent ? { agent } : {}), ...(agents ? { agents } : {}), ...(activity?.length ? { activity: activity as WikiActivityEntry[] } : {}), ...(raw.active ? { active: raw.active } : {}), ...(execution ? { execution } : {}) };
}

async function readUpdatesFile(directory: string, runId: string): Promise<WikiDurableUpdate[]> {
  try {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^\d{16}\.json$/.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    return await Promise.all(entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      const value = JSON.parse(await readFile(file, "utf8")) as Partial<WikiDurableUpdate> & Record<string, unknown>;
      assertExactKeys(value, ["version", "event", "state"], "Wiki durable update");
      if (value.version !== 2) throw new UnsupportedWikiRunVersionError(file, value.version);
      const event = parseEvent(value.event, runId);
      const state = parseState(value.state, runId);
      if (entry.name !== eventRecordName(event.sequence)) throw new Error(`Wiki event record name does not match sequence: ${entry.name}`);
      assertUpdateInvariant(event, state);
      return { version: 2, event, state };
    }));
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
    const text = (await readFile(file, "utf8")).trim();
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new UnsupportedWikiRunVersionError(file, 1); }
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 2) {
      throw new UnsupportedWikiRunVersionError(file, (value as { version?: unknown } | undefined)?.version);
    }
    const runId = (value as { runId?: unknown }).runId;
    if (typeof runId !== "string") throw new Error(`Invalid Wiki active run marker: ${file}`);
    assertSafeId(runId, "Wiki run ID");
    return runId;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function ensureDirectoryDurable(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await syncDirectory(directory);
  const parent = path.dirname(directory);
  if (parent !== directory) await syncDirectory(parent);
}

function eventRecordName(sequence: number): string {
  return `${String(sequence).padStart(16, "0")}.json`;
}

function eventRecordPath(directory: string, sequence: number): string {
  return path.join(directory, eventRecordName(sequence));
}

function executionLease(runId: string, attempt: number, executionToken: string, owner: WikiExecutionOwner, acquiredAt: string): WikiExecutionLease {
  return parseExecutionLease({ version: 1, runId, attempt, executionToken, ownerToken: owner.ownerToken, pid: owner.pid, acquiredAt }, runId);
}

function parseExecutionLease(value: unknown, expectedId: string): WikiExecutionLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki execution lease: ${expectedId}`);
  const raw = value as Partial<WikiExecutionLease> & Record<string, unknown>;
  assertExactKeys(raw, ["version", "runId", "attempt", "executionToken", "ownerToken", "pid", "acquiredAt"], "Wiki execution lease");
  if (raw.version !== 1 || raw.runId !== expectedId || !isPositiveInteger(raw.attempt) || !isToken(raw.executionToken)
    || !isToken(raw.ownerToken) || !Number.isSafeInteger(raw.pid) || (raw.pid ?? 0) < 1 || typeof raw.acquiredAt !== "string") {
    throw new Error(`Invalid Wiki execution lease: ${expectedId}`);
  }
  return raw as unknown as WikiExecutionLease;
}

function parseTransactionExecution(value: unknown, expectedId: string): WikiLedgerTransaction["execution"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki ledger execution transaction: ${expectedId}`);
  const raw = value as Record<string, unknown>;
  if (raw.action === "release") {
    assertExactKeys(raw, ["action"], "Wiki ledger execution transaction");
    return { action: "release" };
  }
  assertExactKeys(raw, ["action", "lease"], "Wiki ledger execution transaction");
  if (raw.action !== "claim") throw new Error(`Invalid Wiki ledger execution transaction: ${expectedId}`);
  return { action: "claim", lease: parseExecutionLease(raw.lease, expectedId) };
}

function assertUpdateInvariant(event: WikiRunEvent, state: WikiRunState): void {
  if (event.sequence !== state.lastEventSequence || event.at !== state.updatedAt) throw new Error("Wiki update event/state sequence mismatch");
  const expected = event.type === "completed" ? "succeeded"
    : event.type === "failed" ? "failed"
      : event.type === "cancelled" ? "cancelled"
        : event.type === "paused" ? "paused"
          : event.type === "resumed" ? "running"
            : undefined;
  if (expected && state.status !== expected) throw new Error(`Wiki update event/state lifecycle mismatch: ${event.type}/${state.status}`);
  if (!expected && event.type !== "warning" && state.status !== "running") throw new Error(`Wiki update event/state lifecycle mismatch: ${event.type}/${state.status}`);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

function isRoleModels(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const roles = new Set(["lead", "research", "write", "review"]);
  const thinking = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  return Object.entries(value).every(([role, selected]) => {
    if (!roles.has(role) || !selected || typeof selected !== "object" || Array.isArray(selected)) return false;
    const raw = selected as Record<string, unknown>;
    return Object.keys(raw).every((key) => ["provider", "id", "thinkingLevel"].includes(key))
      && typeof raw.provider === "string" && raw.provider.length > 0 && typeof raw.id === "string" && raw.id.length > 0
      && (raw.thinkingLevel === undefined || thinking.has(String(raw.thinkingLevel)));
  });
}

function isGenerationProfile(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (!hasExactKeys(raw, ["audience", "purpose", "focus", "granularity", "templates", "review"])
    || !isStringArray(raw.audience) || typeof raw.purpose !== "string") return false;
  return stringArrayRecord(raw.focus, ["include", "exclude"])
    && stringArrayRecord(raw.granularity, ["preferChildPagesFor"])
    && stringArrayRecord(raw.templates, ["requiredSections"])
    && stringArrayRecord(raw.review, ["mustCover"]);
}

function stringArrayRecord(value: unknown, fields: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return hasExactKeys(raw, fields) && fields.every((field) => isStringArray(raw[field]));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

async function withFilesystemLock<T>(root: string, lockDirectory: string, operation: () => Promise<T>): Promise<T> {
  await ensureDirectoryDurable(root);
  while (true) {
    try {
      await mkdir(lockDirectory);
      await writeText(path.join(lockDirectory, "owner.json"), `${JSON.stringify({ version: 1, pid: process.pid })}\n`);
      break;
    } catch (error) {
      if (!isExists(error)) throw error;
      if (await lockIsStale(lockDirectory)) {
        await removePath(lockDirectory, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  try { return await operation(); }
  finally { await removePath(lockDirectory, { recursive: true, force: true }); }
}

async function lockIsStale(lockDirectory: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(path.join(lockDirectory, "owner.json"), "utf8")) as Record<string, unknown>;
    if (raw.version === 1 && Number.isSafeInteger(raw.pid)) return !processIsAlive(raw.pid as number);
  } catch (error) { if (!isMissing(error)) return true; }
  try { return Date.now() - (await stat(lockDirectory)).mtimeMs > LOCK_STALE_MS; }
  catch { return true; }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST";
}
