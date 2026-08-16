import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createWikiArtifactStore } from "./artifact-store.js";
import { projectWikiAgentOutcome } from "./delegate-contracts.js";
import { removePath } from "./files.js";
import { inspectWiki, verifyPinnedSourcePlan } from "./inspect.js";
import { createPiLeadRuntime, type PiWikiRoleModels } from "./lead-runtime.js";
import { createWikiPublicationStore } from "./publication-store.js";
import {
  createWikiRunLedger,
  resultFromState,
  type WikiProductionTransition,
  type WikiExecutionAuthority,
  type WikiRunLedger,
  type WikiRunState,
} from "./run-ledger.js";
import {
  WikiRunResultError,
  type WikiAgentInspection,
  type WikiAgentTarget,
  type WikiProducerRequest,
  type WikiProducer,
  type WikiRunControl,
  type WikiRunEvent,
  type WikiRunHandle,
  type WikiRunUpdate,
  type WikiRunView,
} from "./producer-types.js";
import {
  WIKI_MANUAL_PAUSE,
  type WikiLeadExecutionRequest,
  type WikiLeadRuntime,
  type WikiProductionPlan,
} from "./runtime-types.js";
import { readWikiSessionTranscript } from "./session-transcript.js";
import { digestProductionSkillTree, materializeProductionSkill, skillWorkspacePath } from "./skill-store.js";
import { loadWikiWorkspace, ensureWikiWorkspaceInternalIgnore, type WikiGenerationProfile, type WikiRoleModelConfig } from "./workspace.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const RESULT_POLL_MS = 50;
const CONTROL_SETTLE_MS = 1_000;

export interface ProductionRuntimeOptions {
  getModel?: () => Model<Api> | undefined;
  getThinkingLevel?: () => ThinkingLevel | undefined;
  getModelRegistry?: () => ModelRegistry | undefined;
  /** The only variable production seam: Pi in production, deterministic Lead in tests. */
  createLead?: (plan: WikiProductionPlan) => WikiLeadRuntime;
  /** @internal Deterministic lifecycle dependencies. */
  now?: () => Date;
  createId?: () => string;
  cleanupPath?: (location: string) => Promise<void>;
  fault?: (point: "afterPublication") => void | Promise<void>;
}

interface ActiveAttempt {
  number: number;
  executionToken: string;
  readonly controller: AbortController;
  settled: Promise<void>;
}

interface ProcessRunRegistry {
  ledgers: Map<string, WikiRunLedger>;
  runs: Map<string, WikiProductionRun>;
}

const PROCESS_RUNS: ProcessRunRegistry = { ledgers: new Map(), runs: new Map() };

/** Workspace/run registry. Lifecycle knowledge remains inside each WikiProductionRun. */
export class WikiProductionRuns implements WikiProducer {
  private readonly createId: () => string;

  constructor(private readonly options: ProductionRuntimeOptions = {}) {
    this.createId = options.createId ?? randomUUID;
  }

  async start(request: WikiProducerRequest): Promise<WikiRunHandle> {
    const workspace = await loadWikiWorkspace(request.cwd);
    const ledger = this.ledger(workspace.root);
    const id = this.createId();
    const at = this.timestamp();
    await ledger.create({ id, cwd: workspace.root, ...(normalizedFocus(request.focus) ? { focus: normalizedFocus(request.focus) } : {}), at });
    const run = this.run(workspace.root, id, ledger);
    await run.start();
    return run.handle();
  }

  async open(runId: string, cwd: string): Promise<WikiRunHandle | undefined> {
    const workspaceRoot = await locateWikiWorkspaceRoot(cwd);
    if (!workspaceRoot) return undefined;
    const ledger = this.ledger(workspaceRoot);
    if (!(await ledger.read(runId))) return undefined;
    const run = this.run(workspaceRoot, runId, ledger);
    await run.recover();
    return run.handle();
  }

  async list(cwd: string): Promise<WikiRunView[]> {
    const workspaceRoot = await locateWikiWorkspaceRoot(cwd);
    if (!workspaceRoot) return [];
    return (await this.ledger(workspaceRoot).list()).map(toView);
  }

  private run(workspaceRoot: string, runId: string, ledger: WikiRunLedger): WikiProductionRun {
    const key = runKey(workspaceRoot, runId);
    let run = PROCESS_RUNS.runs.get(key);
    if (!run) {
      run = new WikiProductionRun(path.resolve(workspaceRoot), runId, ledger, this.options);
      PROCESS_RUNS.runs.set(key, run);
    }
    return run;
  }

  private ledger(workspaceRoot: string): WikiRunLedger {
    const root = path.join(path.resolve(workspaceRoot), ".okf-wiki");
    let ledger = PROCESS_RUNS.ledgers.get(root);
    if (!ledger) { ledger = createWikiRunLedger(root); PROCESS_RUNS.ledgers.set(root, ledger); }
    return ledger;
  }

  private timestamp(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
}

/** @internal Host model resolution and deterministic Lead construction. */
export function createConfiguredWikiProducer(options: ProductionRuntimeOptions = {}): WikiProducer {
  return new WikiProductionRuns(options);
}

/** Run-scoped deep module owning execution, recovery, controls, updates and cleanup. */
class WikiProductionRun {
  private active?: ActiveAttempt;
  private deferredResume?: WikiExecutionAuthority;
  private publicationCritical = false;
  private readonly hub = new EventEmitter();
  private readonly ownerToken = randomUUID();

  constructor(
    private readonly workspaceRoot: string,
    private readonly runId: string,
    private readonly ledger: WikiRunLedger,
    private readonly options: ProductionRuntimeOptions,
  ) { this.hub.setMaxListeners(0); }

  async start(): Promise<void> {
    await this.commit({ kind: "started", at: this.timestamp() });
    const authority = await this.beginAttempt("attempt_started");
    this.launch(authority);
  }

  async recover(): Promise<void> {
    const state = await this.state();
    if (state.status === "succeeded") {
      if (state.productionPlan) await this.cleanup(state.productionPlan, false);
      await createWikiPublicationStore({ workspace: state.cwd }).acknowledge(this.runId);
      return;
    }
    if (!TERMINAL.has(state.status) && state.productionPlan) {
      const publication = createWikiPublicationStore({ workspace: state.productionPlan.sourcePlan.workspaceRoot });
      const reconciliation = await publication.reconcile(this.runId);
      if (reconciliation.state === "published") {
        if (state.leadSummary === undefined) {
          throw new Error(`Committed Wiki publication ${this.runId} has incomplete run provenance`);
        }
        await this.cleanup(state.productionPlan);
        await this.commit({
          kind: "published", at: this.timestamp(), pages: [...reconciliation.pages],
          sourceFingerprint: reconciliation.sourceFingerprint,
          finalTreeDigest: reconciliation.finalTreeDigest,
        });
        await publication.acknowledge(this.runId);
        return;
      }
    }
    if (state.status === "running" && !this.active) {
      const ownership = await this.ledger.executionOwner(this.runId);
      if (ownership !== "live") await this.commit({ kind: "interrupted", at: this.timestamp() }, currentAuthority(state));
    }
  }

  handle(): WikiRunHandle {
    return {
      id: this.runId,
      view: async () => toView(await this.state()),
      updates: (after = 0, signal?: AbortSignal) => this.updateStream(after, signal),
      result: async () => await this.waitForResult(),
      control: async (action) => await this.control(action),
      inspectAgent: async (target) => await this.inspectAgent(target),
    };
  }

  private launch(authority: WikiExecutionAuthority): void {
    if (this.active) return;
    const controller = new AbortController();
    const active: ActiveAttempt = { number: authority.attempt, executionToken: authority.executionToken, controller, settled: Promise.resolve() };
    this.active = active;
    const pending = this.execute(controller, authority);
    active.settled = pending;
    const settled = async () => {
      if (this.active !== active) return;
      this.active = undefined;
      if (this.deferredResume) {
        const deferred = this.deferredResume;
        this.deferredResume = undefined;
        const current = await this.ledger.read(this.runId).catch(() => undefined);
        if (current?.status === "running" && current.attempt === deferred.attempt && current.executionToken === deferred.executionToken) this.launch(deferred);
      }
    };
    void pending.then(settled, settled);
  }

  private async execute(controller: AbortController, authority: WikiExecutionAuthority): Promise<void> {
    const { attempt, executionToken } = authority;
    try {
      let state = await this.state();
      let plan = state.productionPlan;
      const preparation = plan ? "resume" as const : "fresh" as const;
      if (plan) await resumeProductionPlan(plan, this.runId);
      else {
        plan = await prepareProductionPlan(state.cwd, this.runId, state.focus, this.options);
        await this.assertCurrent(authority, controller.signal);
        await this.commitForAttempt(authority, controller.signal, { kind: "plan_pinned", at: this.timestamp(), plan });
      }
      await this.assertCurrent(authority, controller.signal);
      state = await this.state();
      plan = state.productionPlan!;
      const leadRecord = await this.ledger.readAgent(this.runId, { kind: "lead" });
      if (leadRecord?.sessionFile) plan = { ...plan, leadSessionFile: leadRecord.sessionFile, leadSessionAttempt: leadRecord.agent.attempt };
      await this.commitForAttempt(authority, controller.signal, { kind: "stage_entered", at: this.timestamp(), stage: "lead", budgets: plan.budgets });
      const lead = createProductionLead(plan, this.options);
      const request: WikiLeadExecutionRequest = {
        runId: this.runId, cwd: state.cwd, focus: state.focus, signal: controller.signal, preparation, attempt, executionToken, ...plan,
        record: async (observation) => {
          await this.assertCurrent(authority, controller.signal);
          const event = await this.ledger.recordObservation(this.runId, observation, authority);
          if (event) await this.publishCommitted(event);
        },
      };
      const outcome = await lead.run(request);
      await this.assertCurrent(authority, controller.signal);
      if (outcome.kind === "pause") {
        await this.commitForAttempt(authority, controller.signal, { kind: "paused", at: this.timestamp(), pause: {
          reason: outcome.reason, summary: outcome.summary, ...(outcome.retryAt ? { retryAt: outcome.retryAt } : {}),
        } });
        return;
      }
      await this.commitForAttempt(authority, controller.signal, { kind: "lead_completed", at: this.timestamp(), summary: outcome.summary });
      await this.commitForAttempt(authority, controller.signal, { kind: "stage_entered", at: this.timestamp(), stage: "validate" });
      await verifyPinnedSourcePlan(plan.sourcePlan);
      await this.assertCurrent(authority, controller.signal);
      const seal = await this.seal(plan, authority);
      await this.assertCurrent(authority, controller.signal);
      await verifyPinnedSourcePlan(plan.sourcePlan);
      await this.commitForAttempt(authority, controller.signal, { kind: "stage_entered", at: this.timestamp(), stage: "publish" });
      const publication = createWikiPublicationStore({ workspace: plan.sourcePlan.workspaceRoot });
      this.publicationCritical = true;
      try {
        const published = await publication.publish(this.runId, { sourceFingerprint: plan.sourcePlan.fingerprint, summary: outcome.summary }, seal);
        try { await this.options.fault?.("afterPublication"); }
        catch (cause) { throw new WikiProductionCrashFault(cause); }
        await this.cleanup(plan);
        await this.commit({
          kind: "published", at: this.timestamp(), pages: [...published.pages], sourceFingerprint: published.sourceFingerprint, finalTreeDigest: published.finalTreeDigest,
        }, authority);
        await publication.acknowledge(this.runId);
      } finally { this.publicationCritical = false; }
    } catch (error) {
      if (error instanceof WikiProductionCrashFault) return;
      if (controller.signal.aborted) return;
      const current = await this.ledger.read(this.runId);
      if (!current || current.status !== "running" || current.attempt !== attempt || current.executionToken !== executionToken) return;
      const message = error instanceof Error ? error.message : String(error);
      await this.commit({ kind: "failed", at: this.timestamp(), error: message }, authority);
    }
  }

  private async seal(plan: WikiProductionPlan, authority: WikiExecutionAuthority) {
    const module = await import("./wiki-lead-run.js");
    return await module.sealWikiLeadRunForPublication({
      workspace: plan.sourcePlan.workspaceRoot,
      runId: this.runId,
      candidateWikiRoot: plan.candidateWikiRoot,
      policy: plan.generation,
      sourcePlan: plan.sourcePlan,
      language: plan.language,
      requiredSections: plan.generation.templates.requiredSections,
      requiredProfileCoverage: plan.generation.review.mustCover,
      publicationAt: this.timestamp(),
      executionFence: { runStateFile: path.join(this.workspaceRoot, ".okf-wiki", "runs", this.runId, "run-state.json"), ...authority },
    });
  }

  private async cleanup(plan: WikiProductionPlan, recordWarning = true): Promise<void> {
    const runRoot = path.join(this.workspaceRoot, ".okf-wiki", "runs", this.runId);
    const targets = [
      plan.runSessionDirectory,
      plan.skillRoot,
      path.dirname(plan.candidateWikiRoot),
      path.join(runRoot, "publication-preimage"),
      path.join(runRoot, "publication-finalization.json"),
    ];
    const remove = this.options.cleanupPath ?? (async (location: string) => await removePath(location, { recursive: true, force: true }));
    const failures: string[] = [];
    for (const target of targets) {
      try { await remove(target); }
      catch (error) { failures.push(`${path.relative(runRoot, target)}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try { await removeStagedEntries(runRoot, remove); }
    catch (error) { failures.push(`staged files: ${error instanceof Error ? error.message : String(error)}`); }
    if (failures.length && recordWarning) {
      const warning = { code: "cleanup_failed" as const, message: failures.join("; "), at: this.timestamp() };
      await this.commit({ kind: "warning", at: warning.at, warning });
    }
  }

  private async control(action: WikiRunControl): Promise<WikiRunView> {
    const state = await this.state();
    if (TERMINAL.has(state.status)) throw new Error(`Terminal Wiki run ${this.runId} cannot be controlled`);
    if (this.publicationCritical) throw new Error(`Wiki run ${this.runId} is committing publication and cannot be controlled`);
    if (action === "pause") {
      if (state.status !== "running") throw new Error(`Wiki run ${this.runId} is not running`);
      const authority = currentAuthority(state);
      const active = this.active;
      active?.controller.abort(WIKI_MANUAL_PAUSE);
      await settleBounded(active?.settled);
      await this.commit({ kind: "manual_paused", at: this.timestamp() }, authority);
    } else if (action === "resume") {
      if (state.status !== "paused") throw new Error(`Wiki run ${this.runId} is not paused`);
      const authority = await this.beginAttempt("resumed");
      if (this.active) this.deferredResume = authority;
      else this.launch(authority);
    } else {
      this.deferredResume = undefined;
      this.active?.controller.abort();
      await settleBounded(this.active?.settled);
      await this.commit({ kind: "cancelled", at: this.timestamp() }, state.status === "running" ? currentAuthority(state) : undefined);
    }
    return toView(await this.state());
  }

  private async assertCurrent(authority: WikiExecutionAuthority, signal: AbortSignal): Promise<void> {
    if (signal.aborted || !this.active || this.active.controller.signal !== signal || this.active.number !== authority.attempt
      || this.active.executionToken !== authority.executionToken) throw new Error("Wiki attempt is no longer current");
    const state = await this.state();
    if (state.status !== "running" || state.attempt !== authority.attempt || state.executionToken !== authority.executionToken) throw new Error("Wiki attempt is no longer current");
  }

  private async commitForAttempt(authority: WikiExecutionAuthority, signal: AbortSignal, transition: WikiProductionTransition): Promise<void> {
    await this.assertCurrent(authority, signal);
    await this.commit(transition, authority);
  }

  private async commit(transition: WikiProductionTransition, authority?: WikiExecutionAuthority): Promise<void> {
    const event = await this.ledger.transition(this.runId, transition, authority);
    await this.publishCommitted(event);
  }

  private async beginAttempt(kind: "attempt_started" | "resumed"): Promise<WikiExecutionAuthority> {
    const executionToken = randomUUID();
    await this.commit({ kind, at: this.timestamp(), executionToken, owner: { ownerToken: this.ownerToken, pid: process.pid } });
    const state = await this.state();
    if (state.executionToken !== executionToken) throw new Error("Wiki execution token was not durably committed");
    return { attempt: state.attempt, executionToken };
  }

  private async publishCommitted(event: WikiRunEvent): Promise<void> {
    const update = (await this.ledger.updates(this.runId, event.sequence - 1)).find((candidate) => candidate.event.sequence === event.sequence);
    if (!update) throw new Error(`Missing durable Wiki update ${this.runId}/${event.sequence}`);
    this.hub.emit("update", { event: update.event, view: toView(update.state) } satisfies WikiRunUpdate);
  }

  private async *updateStream(after: number, signal?: AbortSignal): AsyncIterable<WikiRunUpdate> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let cursor = Math.max(0, Math.trunc(after));
    try {
      while (!combined.aborted) {
        for (const update of await this.ledger.updates(this.runId, cursor)) {
          if (combined.aborted || update.event.sequence <= cursor) continue;
          cursor = update.event.sequence;
          yield { event: update.event, view: toView(update.state) };
          if (isTerminalEvent(update.event)) return;
        }
        await waitForUpdate(this.hub, combined);
      }
    } finally { controller.abort(); }
  }

  private async waitForResult() {
    while (true) {
      const state = await this.state();
      if (TERMINAL.has(state.status)) {
        const execution = this.active?.settled;
        if (execution) await execution;
        const settled = await this.state();
        if (settled.status === "succeeded") return resultFromState(settled);
        if (settled.status === "failed" || settled.status === "cancelled") {
          throw new WikiRunResultError(this.runId, settled.status, settled.error ?? `Wiki run ${settled.status}`);
        }
        throw new Error(`Terminal Wiki run ${this.runId} regressed to ${settled.status}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, RESULT_POLL_MS));
    }
  }

  private async inspectAgent(target: WikiAgentTarget): Promise<WikiAgentInspection | undefined> {
    const state = await this.state();
    const record = await this.ledger.readAgent(this.runId, target);
    const agent = record?.agent ?? (target.kind === "lead" ? state.progress?.lead : undefined);
    if (!agent) return undefined;
    const ref = record?.receipt?.outputs?.at(-1);
    let handoff: string | undefined;
    if (ref) { try { handoff = await createWikiArtifactStore({ workspace: state.cwd }).read(ref); } catch { handoff = undefined; } }
    return {
      runId: this.runId,
      agent,
      process: record?.process ?? [],
      ...(record?.sessionFile ? { messages: await readWikiSessionTranscript(record.sessionFile) } : {}),
      ...(record?.receipt ? { outcome: projectWikiAgentOutcome(record.receipt) } : {}),
      ...(handoff !== undefined ? { handoff } : {}),
      ...(ref?.relativePath ? { handoffPath: ref.relativePath } : {}),
    };
  }

  private async state(): Promise<WikiRunState> {
    const state = await this.ledger.read(this.runId);
    if (!state) throw new Error(`Unknown Wiki run: ${this.runId}`);
    return state;
  }

  private timestamp(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
}

class WikiProductionCrashFault extends Error {
  constructor(cause: unknown) { super("Injected Wiki production process crash", { cause }); }
}

async function prepareProductionPlan(cwd: string, runId: string, focus: string | undefined, options: ProductionRuntimeOptions): Promise<WikiProductionPlan> {
  const workspace = await loadWikiWorkspace(cwd);
  const publication = createWikiPublicationStore({ workspace: workspace.root });
  await publication.recoverPending();
  await ensureWikiWorkspaceInternalIgnore(workspace.root);
  const sourcePlan = await inspectWiki(cwd);
  const candidateWikiRoot = await publication.prepareCandidate(runId);
  const skillRoot = await materializeProductionSkill(workspace.root, runId, undefined, "fresh");
  const skillTreeDigest = await digestProductionSkillTree(skillRoot);
  const runRoot = path.join(workspace.root, ".okf-wiki", "runs", runId);
  return {
    sourcePlan,
    candidateWikiRoot,
    skillRoot,
    skillTreeDigest,
    language: workspace.language,
    generation: structuredClone(workspace.wiki.generation),
    maxConcurrentAgents: workspace.wiki.maxConcurrentAgents,
    budgets: {
      maxDelegatedTasks: workspace.wiki.maxDelegatedTasks,
      maxDelegateBatches: workspace.wiki.maxDelegateBatches,
      maxTurnsPerSession: workspace.wiki.maxTurnsPerSession,
      maxToolCallsPerSession: workspace.wiki.maxToolCallsPerSession,
    },
    models: pinRoleModels(workspace.wiki.models, options),
    runSessionDirectory: path.join(runRoot, "sessions"),
    transientRetries: workspace.wiki.transientRetries,
    baseRetryDelayMs: workspace.wiki.baseRetryDelayMs,
    sessionTimeoutMs: workspace.wiki.sessionTimeoutSeconds * 1_000,
    prompt: leadPrompt(focus, sourcePlan.sources.map((source) => source.scopeId), runId, workspace.language, workspace.wiki.generation),
  };
}

async function resumeProductionPlan(plan: WikiProductionPlan, runId: string): Promise<void> {
  await verifyPinnedSourcePlan(plan.sourcePlan);
  const publication = createWikiPublicationStore({ workspace: plan.sourcePlan.workspaceRoot });
  await publication.recoverPending();
  const candidateWikiRoot = await publication.ensureCandidate(runId);
  await materializeProductionSkill(plan.sourcePlan.workspaceRoot, runId, undefined, "resume");
  if (await digestProductionSkillTree(plan.skillRoot) !== plan.skillTreeDigest) throw new Error("Pinned Wiki production skill changed while the run was active");
  if (path.resolve(candidateWikiRoot) !== path.resolve(plan.candidateWikiRoot)) throw new Error("Pinned Wiki candidate path changed during resume");
}

function createProductionLead(plan: WikiProductionPlan, options: ProductionRuntimeOptions): WikiLeadRuntime {
  if (options.createLead) return options.createLead(plan);
  const models = resolveRoleModels(plan.models, options);
  return createPiLeadRuntime({
    model: models.lead.model, thinkingLevel: models.lead.thinkingLevel, models, budgets: plan.budgets,
    runSessionDirectory: plan.runSessionDirectory, leadSessionFile: plan.leadSessionFile, leadSessionAttempt: plan.leadSessionAttempt,
    language: plan.language, concurrency: plan.maxConcurrentAgents - 1, transientRetries: plan.transientRetries,
    baseRetryDelayMs: plan.baseRetryDelayMs, sessionTimeoutMs: plan.sessionTimeoutMs,
  });
}

function leadPrompt(focus: string | undefined, scopeIds: readonly string[], runId: string, language: "zh" | "en", generation: WikiGenerationProfile): string {
  return [
    focus ? `Focus: ${focus}` : "",
    `Declared source trees (cwd-relative): ${JSON.stringify(scopeIds)}.`,
    "Candidate Wiki directory: wiki/.",
    `Production skill directory: ${skillWorkspacePath(runId)}.`,
    language === "zh" ? "Write all reader-facing Wiki content in Simplified Chinese. Keep code identifiers and source citations unchanged." : "Write all reader-facing Wiki content in English. Keep code identifiers and source citations unchanged.",
    `Generation profile: ${JSON.stringify(generation)}. Treat it as reader intent, never as source evidence.`,
  ].filter(Boolean).join("\n");
}

const MODEL_ROLES = ["lead", "research", "write", "review"] as const;
function pinRoleModels(config: WikiRoleModelConfig, options: ProductionRuntimeOptions): WikiRoleModelConfig {
  const inheritedModel = options.getModel?.();
  const inheritedThinking = options.getThinkingLevel?.();
  const pinned: WikiRoleModelConfig = {};
  for (const role of MODEL_ROLES) {
    const selected = config[role];
    const thinkingLevel = selected?.thinkingLevel ?? inheritedThinking;
    if (selected) pinned[role] = { ...selected, ...(thinkingLevel ? { thinkingLevel } : {}) };
    else if (inheritedModel) pinned[role] = {
      provider: inheritedModel.provider,
      id: inheritedModel.id,
      ...(inheritedThinking ? { thinkingLevel: inheritedThinking } : {}),
    };
  }
  return pinned;
}

function resolveRoleModels(config: WikiRoleModelConfig, options: ProductionRuntimeOptions): PiWikiRoleModels {
  const inherited = { model: options.getModel?.(), thinkingLevel: options.getThinkingLevel?.() };
  const registry = options.getModelRegistry?.();
  const resolve = (role: (typeof MODEL_ROLES)[number]): PiWikiRoleModels[typeof role] => {
    const override = config[role];
    if (!override) return { ...inherited };
    const model = inherited.model?.provider === override.provider && inherited.model.id === override.id
      ? inherited.model
      : registry?.find(override.provider, override.id);
    if (!model) throw new Error(`Pinned Wiki ${role} model is unavailable: ${override.provider}/${override.id}`);
    return { model, thinkingLevel: override.thinkingLevel ?? inherited.thinkingLevel };
  };
  return { lead: resolve("lead"), research: resolve("research"), write: resolve("write"), review: resolve("review") };
}

function toView(state: WikiRunState): WikiRunView {
  return {
    id: state.id, cwd: state.cwd, ...(state.focus ? { focus: state.focus } : {}), status: state.status,
    createdAt: state.createdAt, updatedAt: state.updatedAt, ...(state.completedAt ? { completedAt: state.completedAt } : {}),
    lastEventSequence: state.lastEventSequence, ...(state.error ? { error: state.error } : {}),
    ...(state.pause ? { pause: state.pause } : {}), ...(state.warnings?.length ? { warnings: state.warnings } : {}), ...(state.progress ? { progress: state.progress } : {}),
  };
}

async function removeStagedEntries(root: string, remove: (location: string) => Promise<void>): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const location = path.join(root, entry.name);
    if (entry.name === "lead-operation.lock" || entry.name === "candidate-transaction.json" || entry.name.endsWith(".candidate") || entry.name.includes(".tmp-")) {
      await remove(location);
    } else if (entry.isDirectory()) await removeStagedEntries(location, remove);
  }
}

function runKey(workspaceRoot: string, runId: string): string { return `${path.resolve(workspaceRoot)}\0${runId}`; }
function currentAuthority(state: WikiRunState): WikiExecutionAuthority {
  if (state.status !== "running" || !state.executionToken) throw new Error("Wiki run has no active execution authority");
  return { attempt: state.attempt, executionToken: state.executionToken };
}

async function locateWikiWorkspaceRoot(cwd: string): Promise<string | undefined> {
  let current = path.resolve(cwd);
  while (true) {
    try { if ((await stat(path.join(current, ".okf-wiki"))).isDirectory()) return current; }
    catch (error) { if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
function normalizedFocus(value: string | undefined): string | undefined { return value?.trim() || undefined; }
function isTerminalEvent(event: WikiRunEvent): boolean { return event.type === "completed" || event.type === "failed" || event.type === "cancelled"; }
async function waitForUpdate(hub: EventEmitter, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const complete = () => { clearTimeout(timer); hub.off("update", complete); signal.removeEventListener("abort", complete); resolve(); };
    const timer = setTimeout(complete, RESULT_POLL_MS);
    hub.once("update", complete);
    signal.addEventListener("abort", complete, { once: true });
  });
}
async function settleBounded(execution: Promise<void> | undefined): Promise<boolean> {
  if (!execution) return true;
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    execution.then(() => true, () => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), CONTROL_SETTLE_MS); }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}
