import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { claimText, exists, removePath, syncDirectory, withExclusiveLock, writeText } from "./files.js";
import { parseWikiDelegateContract, parseWikiDelegateReceipt, type WikiDelegateContract, type WikiDelegateError, type WikiDelegateReceipt, type WikiTaskFailureCode } from "./delegate-contracts.js";
import { WIKI_BUDGET_EXHAUSTED_CODES } from "./failures.js";
import type {
  WikiContextStats,
  WikiActivityEntry,
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
  WikiTaskRuntimeTaskState,
} from "./runtime-types.js";

export const WIKI_FORMAT = 1 as const;

export class UnsupportedWikiRunVersionError extends Error {
  constructor(readonly location: string, readonly found: unknown) {
    super(`Unsupported Wiki format at ${location}: expected ${WIKI_FORMAT}, found ${String(found)}. Preserve needed evidence, then delete stale .okf-wiki Run state. The Published Wiki is independent.`);
    this.name = "UnsupportedWikiRunVersionError";
  }
}

export interface WikiRunState extends WikiRunView {
  version: typeof WIKI_FORMAT;
  attempt: number;
  executionToken?: string;
  productionPlan?: WikiProductionPlan;
  leadSummary?: string;
  publication?: { pages: string[]; sourceFingerprint: string; finalTreeDigest: string };
  pause?: WikiRunPause;
  pid?: number;
}

export interface CreateWikiRunState {
  id: string;
  cwd: string;
  focus?: string;
  at: string;
}

export type WikiLedgerFaultPoint = "afterRunWrite";

export interface WikiRunLedgerOptions {
  /** @internal Deterministic crash injection for persistence tests. */
  fault?: (point: WikiLedgerFaultPoint) => void | Promise<void>;
}

export interface WikiExecutionAuthority {
  attempt: number;
  executionToken: string;
}

export interface WikiExecutionOwner {
  pid: number;
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

/** In-memory projection of a Lead observation. `event` is set only for notify-worthy lifecycle facts. */
export interface WikiProjectedObservation {
  state: WikiRunState;
  event?: WikiRunEvent;
  record?: WikiAgentRecord;
  target?: WikiAgentTarget;
}

type WikiRunEventInput = WikiRunEvent extends infer Event
  ? Event extends WikiRunEvent ? Omit<Event, "version" | "runId"> : never
  : never;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TERMINAL = new Set<WikiRunStatus>(["succeeded", "failed", "cancelled"]);

export function createWikiRunLedger(rootDirectory: string, options: WikiRunLedgerOptions = {}) {
  const root = path.resolve(rootDirectory);
  const runsRoot = path.join(root, "runs");
  const activeFile = path.join(root, "active-run");
  const lockPath = path.join(root, ".ledger.lock");
  const cache = new Map<string, WikiRunState>();

  const writeExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    await mkdir(root, { recursive: true });
    return await withExclusiveLock(lockPath, operation);
  };

  const paths = (runId: string) => {
    assertSafeId(runId, "Wiki run ID");
    const directory = path.join(runsRoot, runId);
    return {
      directory,
      state: path.join(directory, "run.json"),
      plan: path.join(directory, "plan.json"),
      staleState: path.join(directory, "run-state.json"),
      staleEvents: path.join(directory, "events"),
      staleJournal: path.join(directory, "pending-transaction.json"),
      agent: (target: WikiAgentTarget) => target.kind === "lead"
        ? path.join(directory, "agents", "lead.json")
        : path.join(directory, "agents", "tasks", `${safeTaskId(target.taskId)}.json`),
    };
  };

  const remember = (state: WikiRunState): WikiRunState => {
    cache.set(state.id, state);
    return state;
  };

  const assertCurrentLayout = async (runId: string): Promise<void> => {
    const runPaths = paths(runId);
    if (await exists(runPaths.staleState) || await exists(runPaths.staleEvents) || await exists(runPaths.staleJournal)) {
      throw new UnsupportedWikiRunVersionError(`runs/${runId}`, "legacy process files");
    }
  };

  const readState = async (runId: string): Promise<WikiRunState | undefined> => {
    await assertCurrentLayout(runId);
    const file = paths(runId).state;
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const state = parseState(raw, runId);
      const plan = await readPinnedPlan(runId);
      if (plan) state.productionPlan = plan;
      return remember(state);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };

  const writeState = async (state: WikiRunState): Promise<void> => {
    const target = paths(state.id).state;
    await ensureDirectoryDurable(path.dirname(target));
    await writeText(target, `${JSON.stringify(durableSnapshot(state), null, 2)}\n`);
    if (state.productionPlan) await writePinnedPlanOnce(state.id, state.productionPlan);
    remember(state);
  };

  const writePinnedPlanOnce = async (runId: string, plan: WikiProductionPlan): Promise<void> => {
    const target = paths(runId).plan;
    if (await exists(target)) return;
    await ensureDirectoryDurable(path.dirname(target));
    await writeText(target, `${JSON.stringify(plan, null, 2)}\n`);
  };

  const readPinnedPlan = async (runId: string): Promise<WikiProductionPlan | undefined> => {
    try {
      return parseProductionPlan(JSON.parse(await readFile(paths(runId).plan, "utf8")), runId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };

  const ensure = async (runId: string): Promise<WikiRunState | undefined> => {
    return cache.get(runId) ?? await readState(runId);
  };

  const writeAgentRecord = async (runId: string, target: WikiAgentTarget, record: WikiAgentRecord, durable: boolean): Promise<void> => {
    const targetPath = paths(runId).agent(target);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeText(targetPath, `${JSON.stringify(record, null, 2)}\n`, durable ? {} : { sync: "file" });
  };

  const persistSnapshot = async (
    next: WikiRunState,
    agent?: { target: WikiAgentTarget; record: WikiAgentRecord },
    releaseActive = false,
  ): Promise<void> => {
    if (agent) await writeAgentRecord(next.id, agent.target, agent.record, true);
    await writeState(next);
    await options.fault?.("afterRunWrite");
    if (releaseActive && await activeRunId(activeFile) === next.id) {
      await removePath(activeFile, { force: true });
    }
  };

  const commitLifecycle = async (
    runId: string,
    input: WikiRunEventInput,
    mutateState?: (state: WikiRunState) => WikiRunState,
    allowTerminalTransition = false,
    agentPatch?: AgentPatch,
    releaseActive = false,
  ): Promise<WikiRunEvent> => {
    const current = await ensure(runId);
    if (!current) throw new Error(`Unknown Wiki run: ${runId}`);
    if (TERMINAL.has(current.status)) throw new Error(`Terminal Wiki run ${runId} is immutable`);
    let next = mutateState ? mutateState(cloneRunState(current)) : cloneRunState(current);
    if (!allowTerminalTransition && TERMINAL.has(next.status)) {
      throw new Error("Terminal Wiki state transitions require a terminal commit");
    }
    const event = { version: WIKI_FORMAT, runId, ...input } as WikiRunEvent;
    next.updatedAt = event.at;
    const projectedProgress = progressFromEvent(next.progress, event);
    if (projectedProgress) next.progress = projectedProgress;
    if (agentPatch) next = projectAgent(next, agentPatch.agent);
    if (next.progress && ["completed", "failed", "paused", "cancelled"].includes(event.type) && next.progress.lead) {
      next.progress.lead = {
        ...next.progress.lead,
        status: event.type === "completed" ? "complete" : event.type === "cancelled" ? "cancelled" : event.type === "paused" ? "retrying" : "failed",
        activity: event.type === "completed" ? "settled" : next.progress.lead.activity,
        activeTools: [],
        updatedAt: event.at,
      };
    }
    const terminalLead = next.progress?.lead && event.type === "completed" ? next.progress.lead : undefined;
    const effectivePatch = agentPatch ?? (terminalLead ? { target: { kind: "lead" as const }, agent: terminalLead } : undefined);
    let agent: { target: WikiAgentTarget; record: WikiAgentRecord } | undefined;
    if (effectivePatch) {
      const existing = await readAgentRecordFile(paths(runId).agent(effectivePatch.target));
      agent = { target: effectivePatch.target, record: buildAgentRecord(existing, effectivePatch) };
    }
    assertStateLifecycle(next, runId);
    await persistSnapshot(next, agent, releaseActive);
    return event;
  };

  return {
    async create(input: CreateWikiRunState) {
      return await writeExclusive(async () => {
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
        await claimText(activeFile, `${JSON.stringify({ version: WIKI_FORMAT, runId: input.id })}\n`);
        const state: WikiRunState = {
          version: WIKI_FORMAT,
          id: input.id,
          cwd: path.resolve(input.cwd),
          ...(input.focus ? { focus: input.focus } : {}),
          status: "running",
          createdAt: input.at,
          updatedAt: input.at,
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
      return await ensure(runId);
    },

    async list() {
      let entries: string[];
      try {
        entries = await readdir(runsRoot);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const valid = entries.filter((entry) => SAFE_ID.test(entry));
      const states = await Promise.all(valid.map((entry) => ensure(entry)));
      return states.filter((state): state is WikiRunState => state !== undefined)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },

    async transition(runId: string, transition: WikiProductionTransition, authority?: WikiExecutionAuthority) {
      return await writeExclusive(async () => {
        const current = await ensure(runId);
        if (!current) throw new Error(`Unknown Wiki run: ${runId}`);
        if (TERMINAL.has(current.status)) throw new Error(`Terminal Wiki run ${runId} is immutable`);
        if (authority && (current.attempt !== authority.attempt || current.executionToken !== authority.executionToken || current.status !== "running")) {
          throw new Error("Wiki execution authority is no longer current");
        }
        const commit = (
          event: WikiRunEventInput,
          mutate?: (state: WikiRunState) => WikiRunState,
          terminal = false,
        ) => commitLifecycle(runId, event, mutate, terminal, undefined, terminal);
        switch (transition.kind) {
          case "started":
            if (current.attempt !== 0) throw new Error("Wiki run may be started only once");
            return await commit({ at: transition.at, type: "started", message: "Started Wiki production" });
          case "attempt_started":
            if (current.status !== "running" || current.attempt !== 0 || current.executionToken) throw new Error("The initial Wiki attempt may start only once");
            return await commit({ at: transition.at, type: "stage", stage: "prepare", message: "Preparing candidate Wiki" },
              (state) => ({ ...state, attempt: 1, executionToken: transition.executionToken, pid: transition.owner.pid }));
          case "plan_pinned": {
            const plan = Object.freeze(parseProductionPlan(transition.plan, runId));
            if (current.productionPlan) throw new Error("Wiki production plan is already pinned");
            return await commit({ at: transition.at, type: "stage", stage: current.progress?.stage ?? "prepare", message: "Pinned Wiki production plan" },
              (state) => ({ ...state, productionPlan: plan }));
          }
          case "stage_entered":
            if (current.status !== "running" || !current.productionPlan) throw new Error("Wiki stage requires a pinned running production plan");
            return await commit({ at: transition.at, type: "stage", stage: transition.stage, message: stageMessage(transition.stage), ...(transition.budgets ? { budgets: transition.budgets } : {}) });
          case "lead_completed":
            return await commit({ at: transition.at, type: "stage", stage: current.progress?.stage ?? "lead", message: "Wiki Lead finished" },
              (state) => ({ ...state, leadSummary: transition.summary }));
          case "paused":
            if (current.status !== "running") throw new Error("Only a running Wiki run may pause");
            return await commit({ at: transition.at, type: "paused", message: transition.pause.summary, reason: transition.pause.reason,
              ...(transition.pause.retryAt ? { retryAt: transition.pause.retryAt } : {}) }, (state) => {
                const next = { ...state, status: "paused" as const, pause: transition.pause };
                delete next.executionToken;
                delete next.pid;
                return next;
              });
          case "interrupted":
          case "manual_paused":
            if (current.status !== "running") throw new Error("Only a running Wiki run may pause");
            return await commit({ at: transition.at, type: "paused", message: transition.kind === "interrupted" ? "Recovered interrupted Wiki run" : "Wiki run paused" },
              (state) => {
                const next = { ...state, status: "paused" as const, pause: undefined };
                delete next.executionToken;
                delete next.pid;
                return next;
              });
          case "resumed":
            if (current.status !== "paused") throw new Error("Only a paused Wiki run may resume");
            return await commit({ at: transition.at, type: "resumed", message: "Wiki run resumed" }, (state) => ({
              ...state, status: "running", attempt: state.attempt + 1, executionToken: transition.executionToken, pid: transition.owner.pid, error: undefined, pause: undefined,
            }));
          case "cancelled":
            if (current.status !== "running" && current.status !== "paused") throw new Error("Only an active Wiki run may be cancelled");
            return await commit({ at: transition.at, type: "cancelled", message: "Wiki run cancelled" }, (state) => {
              const next = { ...state, status: "cancelled" as const, completedAt: transition.at };
              delete next.executionToken;
              delete next.pid;
              return next;
            }, true);
          case "failed":
            if (current.status !== "running") throw new Error("Only a running Wiki run may fail");
            return await commit({ at: transition.at, type: "failed", message: transition.error }, (state) => {
              const next = { ...state, status: "failed" as const, error: transition.error, completedAt: transition.at };
              delete next.executionToken;
              delete next.pid;
              return next;
            }, true);
          case "warning":
            return await commit({ at: transition.at, type: "warning", message: transition.warning.message, code: transition.warning.code, detail: transition.warning.message },
              (state) => ({ ...state, warnings: [...(state.warnings ?? []), transition.warning] }));
          case "published":
            if (current.status !== "running" || current.leadSummary === undefined) {
              throw new Error("Wiki publication requires a completed Lead on a running run");
            }
            return await commit({ at: transition.at, type: "completed", message: "Wiki published" }, (state) => {
              const next = {
                ...state, status: "succeeded" as const,
                publication: { pages: transition.pages, sourceFingerprint: transition.sourceFingerprint, finalTreeDigest: transition.finalTreeDigest },
                completedAt: transition.at,
              };
              delete next.executionToken;
              delete next.pid;
              return next;
            }, true);
        }
      });
    },

    async recordObservation(runId: string, observation: WikiLeadObservation, authority: WikiExecutionAuthority) {
      const state = await ensure(runId);
      if (!state) throw new Error(`Unknown Wiki run: ${runId}`);
      if (state.status !== "running" || state.attempt !== authority.attempt || state.executionToken !== authority.executionToken) return undefined;
      const target = observationTarget(observation);
      const existing = target
        ? await readAgentRecordFile(paths(runId).agent(target)) ?? projectQueuedAgent(state, target)
        : undefined;
      const projected = projectObservation(state, existing, observation);
      if (!projected) return undefined;
      if (projected.record && projected.target) {
        await writeAgentRecord(runId, projected.target, projected.record, Boolean(projected.event));
      }
      if (projected.event) {
        remember(projected.state);
        await writeState(projected.state);
        return projected.event;
      }
      remember(projected.state);
      return undefined;
    },

    async readAgent(runId: string, target: WikiAgentTarget) {
      const state = await ensure(runId);
      if (!state) throw new Error(`Unknown Wiki run: ${runId}`);
      const record = await readAgentRecordFile(paths(runId).agent(target));
      if (record) return record;
      return projectQueuedAgent(state, target);
    },

    async assertActive(runId: string, authority: WikiExecutionAuthority): Promise<void> {
      const state = await readState(runId);
      if (!state || state.status !== "running" || state.attempt !== authority.attempt || state.executionToken !== authority.executionToken) {
        throw new Error(`Wiki Lead execution ${authority.attempt}/${authority.executionToken} is no longer active`);
      }
    },

    async executionOwner(runId: string): Promise<"live" | "stale" | "absent"> {
      const state = await readState(runId);
      if (!state) throw new Error(`Unknown Wiki run: ${runId}`);
      if (state.status !== "running" || !state.pid) return "absent";
      return processIsAlive(state.pid) ? "live" : "stale";
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

  function buildAgentRecord(existing: WikiAgentRecord | undefined, patch: AgentPatch): WikiAgentRecord {
    return parseAgentRecord({
      ...(existing ?? {}),
      agent: patch.agent,
      process: limitAgentProcess(patch.process ?? existing?.process ?? []),
      ...(patch.receipt ? { receipt: patch.receipt } : {}),
      ...(patch.sessionFile ?? existing?.sessionFile ? { sessionFile: patch.sessionFile ?? existing?.sessionFile } : {}),
      ...(patch.execution ?? existing?.execution ? { execution: patch.execution ?? existing?.execution } : {}),
    });
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

function cloneRunState(state: WikiRunState): WikiRunState {
  const { productionPlan, ...rest } = state;
  const cloned = structuredClone(rest) as WikiRunState;
  if (productionPlan) cloned.productionPlan = productionPlan;
  return cloned;
}

function durableSnapshot(state: WikiRunState): Record<string, unknown> {
  const { productionPlan: _plan, ...rest } = state;
  if (!rest.progress) return rest;
  const { recentActivity: _activity, ...progress } = rest.progress;
  return { ...rest, progress };
}

function assertStateLifecycle(state: WikiRunState, expectedId: string): void {
  if (state.id !== expectedId) throw new Error(`Invalid Wiki run state: ${expectedId}`);
  if (state.status === "running" && state.attempt > 0 && !state.executionToken
    || state.status !== "running" && state.executionToken
    || TERMINAL.has(state.status) !== Boolean(state.completedAt)
    || state.status === "succeeded" && (!state.publication || state.leadSummary === undefined)
    || state.status === "failed" && !state.error) throw new Error(`Invalid Wiki run state lifecycle: ${expectedId}`);
}

function parseState(value: unknown, expectedId: string): WikiRunState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Wiki run state: ${expectedId}`);
  const state = value as Partial<WikiRunState> & Record<string, unknown>;
  assertExactKeys(state, ["version", "id", "cwd", "focus", "status", "createdAt", "updatedAt", "completedAt",
    "error", "pause", "warnings", "progress", "attempt", "executionToken", "productionPlan", "leadSummary", "publication", "pid"], "Wiki run state");
  if (state.version !== WIKI_FORMAT) {
    throw new UnsupportedWikiRunVersionError(`runs/${expectedId}/run.json`, state.version);
  }
  if (state.id !== expectedId || typeof state.cwd !== "string"
    || !["running", "paused", "succeeded", "failed", "cancelled"].includes(state.status ?? "")
    || typeof state.createdAt !== "string" || typeof state.updatedAt !== "string"
    || !Number.isInteger(state.attempt) || (state.attempt ?? -1) < 0
    || (state.executionToken !== undefined && !isToken(state.executionToken))
    || (state.pid !== undefined && (!Number.isSafeInteger(state.pid) || state.pid < 1))
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
  const progress = parseProgress(state.progress);
  if (progress) parsed.progress = progress;
  else delete parsed.progress;
  assertStateLifecycle(parsed, expectedId);
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
  return Object.freeze(structuredClone(plan as WikiProductionPlan));
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
  const usage = parseContextStats(raw.usage);
  const budgets = parseExecutionBudgets(raw.budgets);
  return {
    stage: raw.stage,
    ...(lead ? { lead } : {}),
    ...(currentBatch ? { currentBatch } : {}),
    ...(batches?.length ? { batches } : {}),
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
    || !["agent", "tool", "retry", "compaction", "warning", "failure"].includes(raw.kind ?? "")
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

export function projectAgent(state: WikiRunState, agent: WikiAgentSnapshot): WikiRunState {
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

const AGGREGATE_USAGE_FIELDS = ["turns", "toolCalls", "input", "output", "cacheRead", "cacheWrite", "total", "cost"] as const;

function projectUsage(state: WikiRunState, telemetry: WikiAgentTelemetry, previous?: WikiAgentSnapshot): WikiRunState {
  if (!telemetry.usage) return state;
  return projectAgentUsage(state, {
    target: telemetry.target,
    attempt: telemetry.attempt,
    usage: telemetry.usage,
  }, previous);
}

function projectAgentUsage(
  state: WikiRunState,
  agent: Pick<WikiAgentSnapshot, "target" | "attempt" | "usage">,
  previous?: Pick<WikiAgentSnapshot, "attempt" | "usage">,
): WikiRunState {
  if (!agent.usage) return state;
  const progress = state.progress ?? { stage: "lead" as const };
  const totals = { ...(progress.usage ?? {}) };
  for (const field of AGGREGATE_USAGE_FIELDS) {
    const current = agent.usage[field];
    if (current === undefined) continue;
    const prior = previous?.attempt === agent.attempt ? previous.usage?.[field] : undefined;
    const delta = prior === undefined ? current : Math.max(0, current - prior);
    totals[field] = (totals[field] ?? 0) + delta;
  }
  return {
    ...state,
    progress: { ...progress, usage: totals },
  };
}

function parseExecutionBudgets(value: unknown): WikiExecutionBudgets | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<WikiExecutionBudgets> & Record<string, unknown>;
  const fields = ["maxDelegatedTasks", "maxDelegateBatches", "maxTurnsPerSession", "maxToolCallsPerSession"] as const;
  if (Object.keys(raw).some((key) => !fields.includes(key as typeof fields[number]))) return undefined;
  if (fields.some((field) => !Number.isInteger(raw[field]) || (raw[field] ?? 0) < 1)) return undefined;
  return raw as WikiExecutionBudgets;
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

export function projectActivity(state: WikiRunState, process: WikiActivityEntry[]): WikiRunState {
  const progress = state.progress;
  if (!progress || process.length === 0) return state;
  const existing = progress.recentActivity ?? [];
  const known = new Set(existing.map(activityIdentity));
  const merged = [...existing];
  for (const entry of process) {
    const identity = activityIdentity(entry);
    if (known.has(identity)) continue;
    known.add(identity);
    merged.push(entry);
  }
  if (merged.length === existing.length) return state;
  merged.sort((left, right) => left.at.localeCompare(right.at) || left.sequence - right.sequence);
  return { ...state, progress: { ...progress, recentActivity: merged.slice(-20) } };
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

export function projectQueuedAgent(state: WikiRunState, target: WikiAgentTarget): WikiAgentRecord | undefined {
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

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}

async function activeRunId(file: string): Promise<string | undefined> {
  try {
    const text = (await readFile(file, "utf8")).trim();
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new UnsupportedWikiRunVersionError(file, text); }
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== WIKI_FORMAT) {
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



export function projectObservation(
  state: WikiRunState,
  existing: WikiAgentRecord | undefined,
  observation: WikiLeadObservation,
): WikiProjectedObservation | undefined {
  if (observation.kind === "progress") {
    const next = {
      ...state,
      updatedAt: state.updatedAt,
      progress: { ...(state.progress ?? { stage: "lead" as const }), lastMessage: observation.message },
    };
    return { state: next };
  }
  if (observation.kind === "batch") {
    const at = observation.tasks.reduce((latest, task) => task.updatedAt && task.updatedAt > latest ? task.updatedAt : latest, state.updatedAt);
    const completed = observation.tasks.filter((task) => ["complete", "incomplete", "failed"].includes(task.status)).length;
    const notify = observation.phase === "queued" || observation.phase === "completed";
    const event = notify ? {
      version: WIKI_FORMAT, runId: state.id, at,
      type: "delegate" as const, message: `Wiki delegate batch ${observation.batch} ${observation.phase}`,
      phase: observation.phase === "queued" ? "queued" as const : "settled" as const,
      batch: observation.batch, tasks: observation.tasks, completed, total: observation.tasks.length,
      ...(observation.taskId ? { taskId: observation.taskId } : {}),
    } : undefined;
    return { state: applyProjectedEvent(state, {
      version: WIKI_FORMAT, runId: state.id, at,
      type: "delegate" as const, message: `Wiki delegate batch ${observation.batch} ${observation.phase}`,
      phase: observation.phase === "queued" ? "queued" : "settled",
      batch: observation.batch, tasks: observation.tasks, completed, total: observation.tasks.length,
      ...(observation.taskId ? { taskId: observation.taskId } : {}),
    }, undefined), ...(event ? { event } : {}) };
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
    if ((existing?.agent.attempt ?? 0) > saved.attempt) return undefined;
    let base = existing;
    if (observation.telemetry) {
      base = {
        agent: mergeAgentCheckpoint(observation.telemetry, existing?.agent, { role: saved.task.role }),
        process: observation.telemetry.process ?? existing?.process ?? [],
        ...(existing?.receipt ? { receipt: existing.receipt } : {}),
        ...(observation.telemetry.sessionFile ?? existing?.sessionFile ? { sessionFile: observation.telemetry.sessionFile ?? existing?.sessionFile } : {}),
      };
    }
    const record = runtimeAgentRecord(target, saved, base, observation.telemetry?.sampledAt ?? state.updatedAt);
    const event = {
      version: WIKI_FORMAT, runId: state.id,
      at: observation.telemetry?.sampledAt ?? state.updatedAt,
      type: "delegate" as const, message: saved.receipt.summary, phase: "settled" as const,
      batch: observation.batch, taskId: observation.taskId, completed: 1, total: 1,
    };
    let next = observation.telemetry?.usage ? projectUsage(state, observation.telemetry, existing?.agent) : state;
    next = applyProjectedEvent(next, event, record);
    return { state: next, event, record, target };
  }
  if (observation.kind === "telemetry") {
    if (!sameTarget(observation.target, observation.telemetry.target)) throw new Error("Wiki telemetry target does not match its observation target");
    const telemetry = observation.telemetry;
    if ((existing?.agent.attempt ?? 0) > telemetry.attempt) return undefined;
    const agent = mergeAgentCheckpoint(telemetry, existing?.agent, {});
    const record: WikiAgentRecord = {
      ...(existing ?? { process: [] }),
      agent,
      process: limitAgentProcess(telemetry.process ?? existing?.process ?? []),
      ...(telemetry.sessionFile ?? existing?.sessionFile ? { sessionFile: telemetry.sessionFile ?? existing?.sessionFile } : {}),
    };
    let next = projectAgent(state, agent);
    next = projectActivity(next, record.process);
    if (telemetry.usage) next = projectUsage(next, telemetry, existing?.agent);
    return { state: next, record, target: telemetry.target };
  }
  const queued = existing ?? projectQueuedAgent(state, observation.target);
  const projected = observation.target.kind === "lead" ? state.progress?.lead ?? {
    target: observation.target, role: "lead" as const, status: "running" as const, attempt: state.attempt || 1,
    activity: "starting" as const, activeTools: [], health: observation.status, updatedAt: observation.at,
  } : undefined;
  const agent = queued?.agent ?? projected;
  if (!agent) return undefined;
  const record: WikiAgentRecord = {
    ...(queued ?? { process: [] }),
    agent: { ...agent, health: observation.status, updatedAt: observation.at },
    process: queued?.process ?? [],
  };
  return { state: projectAgent(state, record.agent), record, target: observation.target };
}

function observationTarget(observation: WikiLeadObservation): WikiAgentTarget | undefined {
  if (observation.kind === "telemetry" || observation.kind === "health") return observation.target;
  if (observation.kind === "task_settled") return { kind: "task", batch: observation.batch, taskId: observation.taskId };
  return undefined;
}

function applyProjectedEvent(state: WikiRunState, event: WikiRunEvent, record?: WikiAgentRecord): WikiRunState {
  let next = { ...state, updatedAt: event.at };
  const projectedProgress = progressFromEvent(next.progress, event);
  if (projectedProgress) next.progress = projectedProgress;
  if (record) {
    next = projectAgent(next, record.agent);
    next = projectActivity(next, record.process);
  }
  return next;
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
