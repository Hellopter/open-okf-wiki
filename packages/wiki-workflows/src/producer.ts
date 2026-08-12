import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createWikiRunLedger,
  resultFromState,
  type WikiRunLedger,
  type WikiRunState,
} from "./run-ledger.js";
import {
  WikiRunResultError,
  type WikiLeadExecutionRequest,
  type WikiProducerOptions,
  type WikiProducerRequest,
  type WikiRunControl,
  type WikiRunEvent,
  type WikiRunHandle,
  type WikiRunView,
  type WikiContextStats,
  type WikiTaskInspection,
  type WikiTaskSnapshot,
  type WikiHistoryEntry,
} from "./producer-types.js";
import { createWikiArtifactStore } from "./artifact-store.js";
import type { WikiDelegateReceipt } from "./delegate-contracts.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const EVENT_POLL_MS = 50;
const CONTROL_SETTLE_MS = 1_000;

function taskIdFrom(data?: Record<string, unknown>): string | undefined {
  if (!data) return undefined;
  if (typeof data.taskId === "string" && data.taskId) return data.taskId;
  if (data.task && typeof data.task === "object") {
    const task = data.task as { id?: unknown };
    if (typeof task.id === "string" && task.id) return task.id;
  }
  return undefined;
}

function snapshotFromReceipt(receipt: WikiDelegateReceipt): WikiTaskSnapshot {
  return {
    id: receipt.id,
    role: receipt.role,
    status: receipt.status,
    summary: receipt.summary,
    attempts: receipt.attempts,
  };
}

/**
 * Deep Wiki production Module. Callers see one run interface; model execution,
 * durable recovery, validation and publication remain behind it.
 */
export class WikiProducer {
  private readonly ledgers = new Map<string, WikiRunLedger>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly createId: () => string;

  /** @internal Construct through createProductionWikiProducer outside isolated tests. */
  constructor(private readonly options: WikiProducerOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async start(request: WikiProducerRequest): Promise<WikiRunHandle> {
    const cwd = path.resolve(request.cwd);
    const ledger = this.ledger(cwd);
    const id = this.createId();
    const at = this.timestamp();
    await ledger.create({
      id,
      cwd,
      operation: request.operation ?? "update",
      ...(normalizedFocus(request.focus) ? { focus: normalizedFocus(request.focus) } : {}),
      at,
    });
    await this.emit(ledger, id, "started", `Started Wiki ${request.operation ?? "update"}`);
    this.launch(ledger, id);
    return this.handle(ledger, id);
  }

  async open(runId: string, cwd: string): Promise<WikiRunHandle | undefined> {
    const ledger = this.ledger(path.resolve(cwd));
    if (!(await ledger.read(runId))) return undefined;
    return await this.recover(ledger, runId);
  }

  /** Latest first; the first running/paused item is the latest recoverable run. */
  async list(cwd: string): Promise<WikiRunView[]> {
    return (await this.ledger(path.resolve(cwd)).list()).map(toView);
  }

  private async recover(ledger: WikiRunLedger, runId: string): Promise<WikiRunHandle> {
    const state = (await ledger.read(runId))!;
    if (state.status === "running" && !this.executions.has(runId)) {
      await ledger.update(runId, (current) => ({ ...current, status: "paused" }));
      await this.emit(ledger, runId, "paused", "Recovered interrupted Wiki run");
    }
    return this.handle(ledger, runId);
  }

  private handle(ledger: WikiRunLedger, runId: string): WikiRunHandle {
    return {
      id: runId,
      view: async () => toView(await requiredState(ledger, runId)),
      events: (after = 0) => this.eventStream(ledger, runId, after),
      result: async () => await this.waitForResult(ledger, runId),
      control: async (action) => await this.control(ledger, runId, action),
      inspect: async (taskId) => await inspectTask(ledger, runId, taskId),
    };
  }

  private launch(ledger: WikiRunLedger, runId: string): void {
    if (this.executions.has(runId)) return;
    const execution = this.execute(ledger, runId).finally(() => {
      this.executions.delete(runId);
      this.controllers.delete(runId);
      void ledger.read(runId).then((state) => {
        if (state?.status === "running") this.launch(ledger, runId);
      });
    });
    this.executions.set(runId, execution);
  }

  private async execute(ledger: WikiRunLedger, runId: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    try {
      let state = await ledger.update(runId, (current) => ({ ...current, attempt: current.attempt + 1 }));
      const base = {
        runId,
        cwd: state.cwd,
        operation: state.operation,
        focus: state.focus,
        signal: controller.signal,
        preparation: state.attempt === 1 ? "fresh" as const : "resume" as const,
      };
      await this.emit(ledger, runId, "progress", "Preparing candidate Wiki", { stage: "prepare" });
      const prepared = await this.options.adapters.prepare(base);
      throwIfAborted(controller.signal);
      if (base.preparation === "fresh") {
        state = await ledger.update(runId, (current) => ({ ...current, sourceFingerprint: prepared.sourceFingerprint }));
      } else if (!state.sourceFingerprint || state.sourceFingerprint !== prepared.sourceFingerprint) {
        throw new Error("Repository sources changed while the Wiki run was paused; start a new update run");
      }
      await this.emit(ledger, runId, "progress", "Running Wiki lead", { stage: "lead" });
      const lead = await this.options.adapters.createLead({ ...base, ...prepared });
      const leadContext: WikiLeadExecutionRequest = {
        ...base,
        ...prepared,
        attempt: state.attempt,
        report: async (message, data) => { await this.emit(ledger, runId, "progress", message, data); },
      };
      const leadOutcome = await lead.run(leadContext);
      throwIfAborted(controller.signal);
      await ledger.update(runId, (current) => ({ ...current, output: leadOutcome }));
      if (leadOutcome.kind === "pause") {
        await ledger.update(runId, (current) => ({
          ...current,
          status: "paused",
          pause: { reason: leadOutcome.reason, summary: leadOutcome.summary, retryAt: leadOutcome.retryAt },
        }));
        await this.emit(ledger, runId, "paused", leadOutcome.summary, {
          reason: leadOutcome.reason,
          ...(leadOutcome.retryAt ? { retryAt: leadOutcome.retryAt } : {}),
        });
        return;
      }
      await this.emit(ledger, runId, "progress", "Validating candidate Wiki", { stage: "validate" });
      const validation = await this.options.adapters.validate({ ...base, ...prepared, leadOutcome });
      throwIfAborted(controller.signal);
      await this.emit(ledger, runId, "progress", "Publishing candidate Wiki", { stage: "publish" });
      const publication = await this.options.adapters.publish({ ...base, ...prepared, leadOutcome, validation });
      throwIfAborted(controller.signal);
      const completedAt = this.timestamp();
      await ledger.update(runId, (current) => ({
        ...current,
        status: "succeeded",
        publication,
        completedAt,
        updatedAt: completedAt,
      }));
      await this.emit(ledger, runId, "completed", "Wiki published");
      await ledger.releaseActive(runId);
    } catch (error) {
      const current = await ledger.read(runId);
      if (!current || current.status === "paused" || current.status === "cancelled") return;
      const message = error instanceof Error ? error.message : String(error);
      const completedAt = this.timestamp();
      await ledger.update(runId, (state) => ({ ...state, status: "failed", error: message, completedAt }));
      await this.emit(ledger, runId, "failed", message);
      await ledger.releaseActive(runId);
    }
  }

  private async control(ledger: WikiRunLedger, runId: string, action: WikiRunControl): Promise<WikiRunView> {
    const state = await requiredState(ledger, runId);
    if (TERMINAL.has(state.status)) throw new Error(`Terminal Wiki run ${runId} cannot be controlled`);
    if (action === "pause") {
      if (state.status !== "running") throw new Error(`Wiki run ${runId} is not running`);
      await ledger.update(runId, (current) => ({ ...current, status: "paused" }));
      this.controllers.get(runId)?.abort();
      await settleBounded(this.executions.get(runId));
      await this.emit(ledger, runId, "paused", "Wiki run paused");
    } else if (action === "resume") {
      if (state.status !== "paused") throw new Error(`Wiki run ${runId} is not paused`);
      await ledger.update(runId, (current) => ({ ...current, status: "running", error: undefined, pause: undefined }));
      await this.emit(ledger, runId, "resumed", "Wiki run resumed");
      this.launch(ledger, runId);
    } else {
      await ledger.update(runId, (current) => ({ ...current, status: "cancelled", completedAt: this.timestamp() }));
      this.controllers.get(runId)?.abort();
      await settleBounded(this.executions.get(runId));
      await this.emit(ledger, runId, "cancelled", "Wiki run cancelled");
      await ledger.releaseActive(runId);
    }
    return toView(await requiredState(ledger, runId));
  }

  private async *eventStream(ledger: WikiRunLedger, runId: string, after: number): AsyncIterable<WikiRunEvent> {
    let cursor = Math.max(0, Math.trunc(after));
    while (true) {
      const events = await ledger.events(runId, cursor);
      for (const event of events) {
        cursor = event.sequence;
        yield event;
      }
      const state = await requiredState(ledger, runId);
      if (TERMINAL.has(state.status) && cursor >= state.lastEventSequence) return;
      await poll();
    }
  }

  private async waitForResult(ledger: WikiRunLedger, runId: string) {
    while (true) {
      const state = await requiredState(ledger, runId);
      if (state.status === "succeeded") return resultFromState(state);
      if (state.status === "failed" || state.status === "cancelled") {
        throw new WikiRunResultError(runId, state.status, state.error ?? `Wiki run ${state.status}`);
      }
      await poll();
    }
  }

  private async emit(
    ledger: WikiRunLedger,
    runId: string,
    type: WikiRunEvent["type"],
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    await ledger.append(runId, { at: this.timestamp(), type, message, ...(data ? { data } : {}) });
    const taskId = taskIdFrom(data);
    if (taskId && (data?.receipt !== undefined || data?.history !== undefined || data?.usage !== undefined)) {
      const existing = await ledger.readTask(runId, taskId);
      await ledger.writeTask(runId, taskId, {
        ...(existing ?? {}),
        ...(data?.receipt && typeof data.receipt === "object" ? { receipt: data.receipt as WikiDelegateReceipt } : {}),
        ...(Array.isArray(data?.history) ? { history: data.history as WikiHistoryEntry[] } : {}),
        ...(data?.usage !== undefined ? { usage: data.usage as WikiContextStats } : {}),
        updatedAt: this.timestamp(),
      });
    }
  }

  private ledger(cwd: string): WikiRunLedger {
    const root = path.resolve(this.options.ledgerRoot?.(cwd) ?? path.join(cwd, ".okf-wiki"));
    let ledger = this.ledgers.get(root);
    if (!ledger) {
      ledger = createWikiRunLedger(root);
      this.ledgers.set(root, ledger);
    }
    return ledger;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function toView(state: WikiRunState): WikiRunView {
  return {
    id: state.id,
    cwd: state.cwd,
    operation: state.operation,
    ...(state.focus ? { focus: state.focus } : {}),
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...(state.completedAt ? { completedAt: state.completedAt } : {}),
    lastEventSequence: state.lastEventSequence,
    ...(state.error ? { error: state.error } : {}),
    ...(state.pause ? { pause: state.pause } : {}),
    ...(state.progress ? { progress: state.progress } : {}),
  };
}

async function inspectTask(ledger: WikiRunLedger, runId: string, taskId: string): Promise<WikiTaskInspection | undefined> {
  const state = await requiredState(ledger, runId);
  const sidecar = await ledger.readTask(runId, taskId);
  const fromProgress = state.progress?.tasks?.find((task) => task.id === taskId);
  const task = fromProgress ?? (sidecar?.receipt ? snapshotFromReceipt(sidecar.receipt) : undefined);
  if (!task) return undefined;
  const receipt = sidecar?.receipt;
  const history = sidecar?.history;
  const usage = sidecar?.usage ?? task.usage;
  const ref = receipt?.outputs?.at(-1);
  let handoff: string | undefined;
  const handoffPath = ref?.relativePath;
  if (ref) {
    try {
      handoff = await createWikiArtifactStore({ workspace: state.cwd }).read(ref);
    } catch {
      handoff = undefined;
    }
  }
  return {
    runId,
    task,
    ...(receipt ? { receipt } : {}),
    ...(handoff !== undefined ? { handoff } : {}),
    ...(handoffPath ? { handoffPath } : {}),
    ...(history ? { history } : {}),
    ...(usage ? { usage } : {}),
    processAvailable: Array.isArray(history) && history.length > 0,
  };
}

async function poll(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, EVENT_POLL_MS));
}

async function requiredState(ledger: WikiRunLedger, runId: string): Promise<WikiRunState> {
  const state = await ledger.read(runId);
  if (!state) throw new Error(`Unknown Wiki run: ${runId}`);
  return state;
}

function normalizedFocus(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

async function settleBounded(execution: Promise<void> | undefined): Promise<void> {
  if (!execution) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    execution.catch(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, CONTROL_SETTLE_MS); }),
  ]);
  if (timer) clearTimeout(timer);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Wiki run was interrupted");
}
