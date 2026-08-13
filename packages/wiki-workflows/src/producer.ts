import { randomUUID } from "node:crypto";
import { EventEmitter, on } from "node:events";
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
  type WikiAgentInspection,
  type WikiAgentTarget,
  type WikiAgentTelemetry,
} from "./producer-types.js";
import { createWikiArtifactStore } from "./artifact-store.js";
import type { WikiDelegateReceipt } from "./delegate-contracts.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const RESULT_POLL_MS = 50;
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

/**
 * Deep Wiki production Module. Callers see one run interface; model execution,
 * durable recovery, validation and publication remain behind it.
 */
export class WikiProducer {
  private readonly ledgers = new Map<string, WikiRunLedger>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly eventHubs = new Map<string, EventEmitter>();
  private readonly telemetryWarnings = new Set<string>();
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
      events: (after = 0, signal?: AbortSignal) => this.eventStream(ledger, runId, after, signal),
      result: async () => await this.waitForResult(ledger, runId),
      control: async (action) => await this.control(ledger, runId, action),
      inspectAgent: async (target) => await inspectAgent(ledger, runId, target),
      activity: async (options) => await ledger.activity(runId, options),
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
        reportObservability: async (input) => {
          const event = await ledger.commitHealth(runId, input);
          if (event) this.publish(event);
        },
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
      await this.emit(ledger, runId, "completed", "Wiki published", undefined, (current) => ({
        ...current, status: "succeeded", publication, completedAt, updatedAt: completedAt,
      }));
      await ledger.releaseActive(runId);
    } catch (error) {
      if (controller.signal.aborted) return;
      const current = await ledger.read(runId);
      if (!current || current.status === "paused" || current.status === "cancelled") return;
      const message = error instanceof Error ? error.message : String(error);
      const completedAt = this.timestamp();
      await this.emit(ledger, runId, "failed", message, undefined, (state) => ({
        ...state, status: "failed", error: message, completedAt,
      }));
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
      this.controllers.get(runId)?.abort();
      await settleBounded(this.executions.get(runId));
      const completedAt = this.timestamp();
      await this.emit(ledger, runId, "cancelled", "Wiki run cancelled", undefined, (current) => ({
        ...current, status: "cancelled", completedAt,
      }));
      await ledger.releaseActive(runId);
    }
    return toView(await requiredState(ledger, runId));
  }

  private async *eventStream(
    ledger: WikiRunLedger,
    runId: string,
    after: number,
    signal?: AbortSignal,
  ): AsyncIterable<WikiRunEvent> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let cursor = Math.max(0, Math.trunc(after));
    try {
      const live = on(this.hub(runId), "event", { signal: combined });
      for (const event of await ledger.events(runId, cursor)) {
        if (combined.aborted || event.sequence <= cursor) continue;
        cursor = event.sequence;
        yield event;
        if (isTerminalEvent(event)) return;
      }
      for await (const [raw] of live) {
        const event = raw as WikiRunEvent;
        if (event.sequence <= cursor) continue;
        cursor = event.sequence;
        yield event;
        if (isTerminalEvent(event)) return;
      }
    } catch (error) {
      if (!(combined.aborted && isAbortError(error))) throw error;
    } finally {
      controller.abort();
    }
  }

  private async waitForResult(ledger: WikiRunLedger, runId: string) {
    while (true) {
      const state = await requiredState(ledger, runId);
      if (state.status === "succeeded") return resultFromState(state);
      if (state.status === "failed" || state.status === "cancelled") {
        throw new WikiRunResultError(runId, state.status, state.error ?? `Wiki run ${state.status}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, RESULT_POLL_MS));
    }
  }

  private async emit(
    ledger: WikiRunLedger,
    runId: string,
    type: WikiRunEvent["type"],
    message: string,
    data?: Record<string, unknown>,
    mutateState?: (state: WikiRunState) => WikiRunState,
  ): Promise<void> {
    const agentTelemetry = agentTelemetryFrom(data);
    let event: WikiRunEvent | undefined;
    if (agentTelemetry) {
      try {
        event = await ledger.commitAgent(runId, agentTelemetry, message, agentDetailsFrom(data));
      } catch (error) {
        const key = `${runId}:${agentTelemetry.target.kind === "lead" ? "lead" : `${agentTelemetry.target.batch}:${agentTelemetry.target.taskId}`}`;
        if (!this.telemetryWarnings.has(key)) {
          this.telemetryWarnings.add(key);
          process.emitWarning(
            `Wiki agent telemetry update failed: ${error instanceof Error ? error.message : String(error)}`,
            { code: "WIKI_TELEMETRY" },
          );
        }
        return;
      }
    } else {
      const taskId = taskIdFrom(data);
      const input = { at: this.timestamp(), type, message, ...(data ? { data } : {}) };
      if (taskId && data?.receipt && typeof data.receipt === "object") {
        const receipt = data.receipt as WikiDelegateReceipt;
        event = await ledger.commitAgent(runId, {
          target: { kind: "task", batch: requiredBatch(data), taskId },
          attempt: receipt.attempts,
          sampledAt: input.at,
          activity: "settled",
          activeTools: [],
          process: domainActivity(type, message, input.at, data),
          ...(data.usage && typeof data.usage === "object" ? { usage: data.usage } : {}),
        }, message, agentDetailsFrom(data));
      } else {
        const activity = domainActivity(type, message, input.at, data);
        event = mutateState
          ? await ledger.commitTerminal(runId, input, mutateState, activity)
          : await ledger.commitEvent(runId, input, activity);
      }
    }
    if (event) this.publish(event);
  }

  private hub(runId: string): EventEmitter {
    let hub = this.eventHubs.get(runId);
    if (!hub) {
      hub = new EventEmitter();
      hub.setMaxListeners(0);
      this.eventHubs.set(runId, hub);
    }
    return hub;
  }

  private publish(event: WikiRunEvent): void {
    const hub = this.eventHubs.get(event.runId);
    if (!hub) return;
    hub.emit("event", event);
    if (isTerminalEvent(event)) this.eventHubs.delete(event.runId);
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

async function inspectAgent(ledger: WikiRunLedger, runId: string, target: WikiAgentTarget): Promise<WikiAgentInspection | undefined> {
  const state = await requiredState(ledger, runId);
  const record = await ledger.readAgent(runId, target);
  const agent = record?.agent ?? (target.kind === "lead" ? state.progress?.lead : undefined);
  if (!agent) return undefined;
  const ref = record?.receipt?.outputs?.at(-1);
  let handoff: string | undefined;
  if (ref) {
    try { handoff = await createWikiArtifactStore({ workspace: state.cwd }).read(ref); } catch { handoff = undefined; }
  }
  return {
    runId,
    agent,
    process: record?.process ?? [],
    ...(record?.receipt ? { receipt: record.receipt } : {}),
    ...(handoff !== undefined ? { handoff } : {}),
    ...(ref?.relativePath ? { handoffPath: ref.relativePath } : {}),
  };
}

function agentTelemetryFrom(data?: Record<string, unknown>): WikiAgentTelemetry | undefined {
  if (!data?.telemetry || typeof data.telemetry !== "object") return undefined;
  const telemetry = data.telemetry as Partial<WikiAgentTelemetry>;
  return telemetry.target && typeof telemetry.target === "object" ? telemetry as WikiAgentTelemetry : undefined;
}

function agentDetailsFrom(data?: Record<string, unknown>) {
  const receipt = data?.receipt && typeof data.receipt === "object" ? data.receipt as WikiDelegateReceipt : undefined;
  return {
    ...(receipt ? { receipt, role: receipt.role, status: receipt.status } : {}),
  };
}

function domainActivity(type: WikiRunEvent["type"], message: string, at: string, data?: Record<string, unknown>) {
  const taskId = taskIdFrom(data);
  const target = taskId && typeof data?.batch === "number" ? { kind: "task" as const, batch: data.batch, taskId } : undefined;
  const kind = type === "failed" ? "failure" : target ? "agent" : type === "progress" && typeof data?.stage === "string" ? "stage" : "agent";
  return [{ sequence: 0, at, kind, severity: type === "failed" ? "error" : "info", ...(target ? { target } : {}), message, completed: type === "completed" || Boolean(data?.receipt) }] as import("./producer-types.js").WikiActivityEntry[];
}

function requiredBatch(data?: Record<string, unknown>): number {
  if (typeof data?.batch !== "number" || !Number.isInteger(data.batch) || data.batch < 1) {
    throw new Error("Task terminal report requires a positive batch identity");
  }
  return data.batch;
}

function isTerminalEvent(event: WikiRunEvent): boolean {
  return event.type === "completed" || event.type === "failed" || event.type === "cancelled";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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
