import { randomUUID } from "node:crypto";
import path from "node:path";
import { createPiAgentExecutor, WikiAgentProtocolError } from "./executor.js";
import { inspectWiki } from "./inspect.js";
import { loadWikiPromptGuidance } from "./prompt-guidance.js";
import { createWikiRunSession, parseWikiRunSession } from "./session.js";
import type { WikiInspection, WikiMode, WikiValidation } from "./types.js";
import { validateWiki } from "./validate.js";
import {
  EMPTY_NODE_METRICS,
  type WikiAgentExecutionResult,
  type WikiNode,
  type WikiNodeActivity,
  type WikiNodeHistoryEntry,
  type WikiNodeKind,
  type WikiNodeMetrics,
  type WikiNodeStatus,
  type WikiPlanResult,
  type WikiResearchReceipt,
  type WikiReviewDefect,
  type WikiReviewResult,
  type WikiRunEvent,
  type WikiRunEventKind,
  type WikiRunRequest,
  type WikiRunSession,
  type WikiRunSnapshot,
  type WikiWorkflowDependencies,
  type WikiWorkflowListener,
} from "./workflow-types.js";

const MAX_RESEARCH_CONCURRENCY = 4;
const MAX_NODE_ATTEMPTS = 3;
const MAX_STRUCTURAL_REPLANS = 2;
const MAX_NODE_OUTPUT_CHARS = 48 * 1024;
const MAX_NODE_HISTORY_ENTRIES = 48;
const MAX_NODE_HISTORY_CHARS = 24 * 1024;
const MAX_RESEARCH_RECEIPT_CHARS = 16 * 1024;
const MAX_EVENTS = 200;
const ACTIVITY_EVENT_INTERVAL_MS = 250;

export interface WikiWorkflowEngineOptions extends Partial<Omit<WikiWorkflowDependencies, "executor">> {
  executor?: WikiWorkflowDependencies["executor"];
}

/**
 * Wiki-specific dynamic DAG coordinator. It owns only Wiki semantics; Pi owns
 * the model loop, tool execution, retry, compaction, and agent transcripts.
 */
export class WikiWorkflowEngine {
  private readonly dependencies: WikiWorkflowDependencies;
  private current?: WikiRunSnapshot;
  private readonly listeners = new Set<WikiWorkflowListener>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly lastActivityEventAt = new Map<string, number>();
  private pumping?: Promise<void>;

  constructor(options: WikiWorkflowEngineOptions = {}) {
    this.dependencies = {
      inspect: options.inspect ?? inspectWiki,
      validate: options.validate ?? validateWiki,
      executor: options.executor ?? createPiAgentExecutor(),
      now: options.now,
      createId: options.createId,
    };
  }

  start(request: WikiRunRequest): WikiRunSnapshot {
    if (this.current && (this.current.status === "running" || this.current.status === "paused")) {
      throw new Error("A Wiki workflow is already active for this Pi session");
    }
    const createdAt = this.now();
    const inspectionNode = this.newNode("inspect", "Inspect Git scope", [], { requestedMode: request.mode });
    this.current = {
      version: 1,
      id: this.newId(),
      cwd: path.resolve(request.cwd),
      requestedMode: request.mode,
      language: request.language === "en" ? "en" : "zh",
      focus: normalizeText(request.focus),
      status: "running",
      round: 0,
      nodes: [inspectionNode],
      events: [],
      createdAt,
      updatedAt: createdAt,
    };
    this.emit("run_started", undefined, `Started ${request.mode} Wiki run`);
    this.emit("node_queued", inspectionNode.id, inspectionNode.label);
    this.schedule();
    return this.getSnapshot()!;
  }

  getSnapshot(): WikiRunSnapshot | undefined {
    return this.current ? clone(this.current) : undefined;
  }

  listSnapshots(): WikiRunSnapshot[] {
    const snapshot = this.getSnapshot();
    return snapshot ? [snapshot] : [];
  }

  subscribe(listener: WikiWorkflowListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  serialize(): WikiRunSession | undefined {
    return this.current ? createWikiRunSession(this.current) : undefined;
  }

  restore(serialized: WikiRunSession | WikiRunSnapshot | unknown): WikiRunSnapshot | undefined {
    const session = isSnapshot(serialized)
      ? createWikiRunSession(serialized)
      : parseWikiRunSession(serialized);
    if (!session) return undefined;

    this.abortControllers();
    this.current = clone(session.snapshot);
    let recovered = false;
    for (const node of this.current.nodes) {
      if (node.status !== "running") continue;
      node.status = "queued";
      node.activity = { state: "waiting", message: "Interrupted; will re-inspect before dispatch", updatedAt: this.now() };
      recovered = true;
    }
    if (this.current.status === "running") {
      this.current.status = "paused";
      recovered = true;
    }
    if (recovered) this.emit("recovered", undefined, "Recovered run is paused and will re-inspect before dispatch");
    return this.getSnapshot();
  }

  async retryNode(nodeId: string): Promise<WikiRunSnapshot> {
    const node = this.requireNode(nodeId);
    if (node.status === "running") throw new Error("A running node cannot be retried; cancel or wait for it first");
    if (!["succeeded", "failed", "invalidated", "blocked", "cancelled"].includes(node.status)) {
      throw new Error(`Node ${nodeId} is not retryable`);
    }
    return await this.retryRoots([node.id], `Retry requested for ${node.label}`, "node");
  }

  /** Re-run every settled node in one stable execution phase. */
  async retryPhase(phaseId: string): Promise<WikiRunSnapshot> {
    const run = this.requireRun();
    const nodes = nodesInPhase(run, phaseId);
    if (!nodes.length) throw new Error(`Unknown Wiki workflow phase: ${phaseId}`);
    if (nodes.some((node) => node.status === "running")) {
      throw new Error("Wait for running agents in the selected phase to settle before retrying the phase");
    }
    if (nodes.some((node) => !["queued", "succeeded", "failed", "invalidated", "blocked", "cancelled"].includes(node.status))) {
      throw new Error("Selected phase is not retryable");
    }
    return await this.retryRoots(nodes.map((node) => node.id), `Phase retry requested for ${phaseTitle(nodes[0])}`, "phase", phaseId);
  }

  /** Fork an immutable historical run before retrying one selected node. */
  async forkAndRetryNode(snapshot: WikiRunSnapshot, nodeId: string): Promise<WikiRunSnapshot> {
    return await this.forkAndRetry(snapshot, [nodeId], { nodeId });
  }

  /** Fork an immutable historical run before retrying a complete phase. */
  async forkAndRetryPhase(snapshot: WikiRunSnapshot, phaseId: string): Promise<WikiRunSnapshot> {
    const nodes = nodesInPhase(snapshot, phaseId);
    if (!nodes.length) throw new Error(`Unknown Wiki workflow phase: ${phaseId}`);
    return await this.forkAndRetry(snapshot, nodes.map((node) => node.id), { phaseId });
  }

  private async forkAndRetry(
    snapshot: WikiRunSnapshot,
    rootIds: string[],
    source: { nodeId?: string; phaseId?: string },
  ): Promise<WikiRunSnapshot> {
    if (this.current && (this.current.status === "running" || this.current.status === "paused")) {
      throw new Error("A Wiki workflow is already active for this Pi session");
    }
    if (!isTerminalRun(snapshot)) throw new Error("Only completed Wiki history can be forked for retry");
    const branch = clone(snapshot);
    const now = this.now();
    branch.id = this.newId();
    branch.status = "paused";
    branch.createdAt = now;
    branch.updatedAt = now;
    branch.completedAt = undefined;
    branch.blockedReason = undefined;
    branch.parentRunId = snapshot.id;
    branch.forkedFromNodeId = source.nodeId;
    branch.forkedFromPhaseId = source.phaseId;
    branch.forkedAt = now;
    branch.events = [];
    const targets = rootIds.map((id) => branch.nodes.find((node) => node.id === id));
    if (targets.some((node) => !node)) throw new Error("Selected historical retry target no longer exists");
    const settledTargets = targets as WikiNode[];
    if (settledTargets.some((node) => node.status === "running")) {
      throw new Error("Only settled history can be forked for retry");
    }
    this.abortControllers();
    this.current = branch;
    const affected = affectedNodeIds(branch, rootIds);
    for (const node of branch.nodes) {
      if (affected.has(node.id)) resetForkedNode(node, now);
    }
    this.emit("run_forked", undefined, `Forked from Wiki run ${snapshot.id}`);
    return await this.retryRoots(
      rootIds,
      source.phaseId ? `Phase retry requested for ${phaseTitle(settledTargets[0])}` : `Retry requested for ${settledTargets[0]?.label ?? "node"}`,
      source.phaseId ? "phase" : "node",
      source.phaseId,
    );
  }

  private async retryRoots(
    rootIds: string[],
    reason: string,
    kind: "node" | "phase",
    phaseId?: string,
  ): Promise<WikiRunSnapshot> {
    const run = this.requireRun();

    if (await this.reconcileGitInputs()) {
      run.status = "running";
      this.schedule();
      return this.getSnapshot()!;
    }

    this.invalidateFromMany(rootIds, reason, true);
    run.status = "running";
    run.blockedReason = undefined;
    if (kind === "phase") this.emit("phase_retried", undefined, reason, phaseId ? { phaseId } : undefined);
    else this.emit("node_retried", rootIds[0], reason);
    this.schedule();
    return this.getSnapshot()!;
  }

  pause(): WikiRunSnapshot | undefined {
    const run = this.requireRun();
    if (run.status !== "running") return this.getSnapshot();
    run.status = "paused";
    this.emit("run_paused", undefined, "Scheduling paused; active agents may finish");
    return this.getSnapshot();
  }

  async resume(): Promise<WikiRunSnapshot | undefined> {
    const run = this.requireRun();
    if (run.status === "failed") throw new Error("A failed Wiki run requires targeted node retry");
    if (run.status !== "paused" && run.status !== "blocked") return this.getSnapshot();
    if (run.status === "blocked" && !run.nodes.some((node) => node.status === "queued")) {
      throw new Error("A blocked Wiki run requires targeted node retry or cancellation");
    }
    await this.reconcileGitInputs();
    run.status = "running";
    run.blockedReason = undefined;
    this.emit("run_resumed", undefined, "Scheduling resumed");
    this.schedule();
    return this.getSnapshot();
  }

  async cancel(): Promise<WikiRunSnapshot | undefined> {
    const run = this.requireRun();
    if (["succeeded", "cancelled"].includes(run.status)) return this.getSnapshot();
    run.status = "cancelled";
    for (const node of run.nodes) {
      if (node.status === "queued" || node.status === "invalidated" || node.status === "blocked" || node.status === "running") {
        node.status = "cancelled";
        node.activity = { state: "completed", message: "Cancelled", updatedAt: this.now() };
        node.finishedAt = this.now();
        this.emit("node_cancelled", node.id, node.label);
      }
    }
    this.abortControllers();
    run.completedAt = this.now();
    this.emit("run_cancelled", undefined, "Run cancelled");
    return this.getSnapshot();
  }

  /** Called during extension shutdown: preserve the next attempt as queued. */
  async interrupt(): Promise<WikiRunSnapshot | undefined> {
    const run = this.requireRun();
    if (run.status !== "running" && run.status !== "paused") return this.getSnapshot();
    for (const node of run.nodes) {
      if (node.status !== "running") continue;
      node.status = "queued";
      node.activity = { state: "waiting", message: "Interrupted; will resume after Git re-inspection", updatedAt: this.now() };
      this.emit("node_cancelled", node.id, "Interrupted for session shutdown");
    }
    this.abortControllers();
    run.status = "paused";
    this.emit("run_paused", undefined, "Run interrupted for session shutdown");
    return this.getSnapshot();
  }

  /** Useful for tests and non-interactive callers that need a settled snapshot. */
  async waitForIdle(): Promise<WikiRunSnapshot | undefined> {
    while (this.pumping) await this.pumping;
    return this.getSnapshot();
  }

  private schedule(): void {
    if (this.pumping || this.current?.status !== "running") return;
    this.pumping = this.pump().catch((error: unknown) => this.failRun(error)).finally(() => {
      this.pumping = undefined;
      if (this.current?.status === "running" && this.runnableNodes().length > 0) this.schedule();
    });
  }

  private async pump(): Promise<void> {
    while (this.current?.status === "running") {
      const runnable = this.runnableNodes();
      if (runnable.length === 0) return;
      const research = runnable.filter((node) => node.kind === "research").slice(0, MAX_RESEARCH_CONCURRENCY);
      if (research.length > 0) {
        await Promise.all(research.map(async (node) => await this.executeNode(node)));
      } else {
        await this.executeNode(runnable[0]);
      }
    }
  }

  private runnableNodes(): WikiNode[] {
    const run = this.current;
    if (!run || run.status !== "running") return [];
    return run.nodes.filter((node) => node.status === "queued" && node.dependsOn.every((id) => this.nodeById(id)?.status === "succeeded"));
  }

  private async executeNode(node: WikiNode): Promise<void> {
    const run = this.requireRun();
    if (node.attempt >= MAX_NODE_ATTEMPTS) {
      node.status = "blocked";
      node.activity = { state: "waiting", message: "Maximum node attempts reached", updatedAt: this.now() };
      run.status = "blocked";
      run.blockedReason = `${node.label} reached ${MAX_NODE_ATTEMPTS} attempts`;
      this.emit("run_blocked", node.id, run.blockedReason);
      return;
    }
    if (node.result !== undefined || node.error || node.output || node.history?.length) this.archiveAttempt(node);
    node.status = "running";
    node.attempt += 1;
    node.result = undefined;
    node.output = undefined;
    node.history = [];
    node.error = undefined;
    node.metrics = clone(EMPTY_NODE_METRICS);
    node.startedAt = this.now();
    node.finishedAt = undefined;
    node.activity = { state: "running", message: "Starting", updatedAt: this.now() };
    const controller = new AbortController();
    this.controllers.set(node.id, controller);
    this.emit("node_started", node.id, node.label);

    try {
      const result = await this.executeNodeWork(node, controller.signal);
      if (node.status !== "running") return;
      node.result = normalizeNodeResult(node.kind, result.result);
      node.output = retainedOutput(result.output ?? node.output);
      node.history = retainedHistory(result.history ?? node.history);
      node.metrics = mergeMetrics(node.metrics, result.metrics);
      // Dynamic expansion can still reject a result. Keep the node running
      // until all result parsing and downstream queueing has completed.
      this.afterSuccess(node);
      node.status = "succeeded";
      node.activity = { state: "completed", message: "Completed", updatedAt: this.now() };
      node.finishedAt = this.now();
      this.emit("node_succeeded", node.id, node.label);
    } catch (error) {
      if (node.status !== "running") return;
      node.status = controller.signal.aborted ? "cancelled" : "failed";
      if (error instanceof WikiAgentProtocolError) {
        node.output = retainedOutput(error.output || node.output);
        node.history = retainedHistory(error.history.length ? error.history : node.history);
        node.error = {
          message: error.message,
          code: error.code,
          requiredSubmissionTool: error.requiredSubmissionTool,
        };
      } else {
        node.error = { message: errorMessage(error), code: controller.signal.aborted ? "cancelled" : "execution_failed" };
      }
      node.activity = { state: "completed", message: node.error.message, updatedAt: this.now() };
      node.finishedAt = this.now();
      this.emit(node.status === "cancelled" ? "node_cancelled" : "node_failed", node.id, node.error.message);
      if (run.status === "running" && node.status === "failed") {
        run.status = "failed";
        run.blockedReason = `${node.label} failed`;
      }
    } finally {
      this.controllers.delete(node.id);
    }
  }

  private async executeNodeWork(node: WikiNode, signal: AbortSignal): Promise<WikiAgentExecutionResult> {
    const run = this.requireRun();
    if (node.kind === "inspect") {
      const inspection = await this.dependencies.inspect(run.cwd);
      return { result: inspection };
    }
    if (node.kind === "validate") {
      const validation = await this.dependencies.validate(run.cwd);
      return { result: validation };
    }
    const role = roleFor(node.kind);
    return await this.dependencies.executor.execute({
      runId: run.id,
      node: clone(node),
      cwd: run.cwd,
      prompt: await promptFor(node, run),
      role,
      language: run.language,
      signal,
      onActivity: (activity, metrics) => this.updateActivity(node.id, activity, metrics),
      onOutput: (output) => this.updateOutput(node.id, output),
      onHistory: (history) => this.updateHistory(node.id, history),
    });
  }

  private afterSuccess(node: WikiNode): void {
    const run = this.requireRun();
    switch (node.kind) {
      case "inspect": {
        const inspection = parseInspection(node.result);
        run.inspection = inspection;
        run.effectiveMode = run.requestedMode === "generate" ? "generate" : inspection.mode;
        run.inspectionFingerprint = inspectionFingerprint(inspection);
        this.queuePlan("plan", [node.id]);
        return;
      }
      case "plan":
      case "replan": {
        const plan = parsePlan(node.result);
        node.result = plan;
        const phase = { id: `research:${node.id}`, title: "Research" };
        const scopeNodes = plan.researchScopes.map((scope) => this.queueNode(
          "research",
          `Research: ${scope.id}`,
          [node.id],
          scope,
          phase,
        ));
        if (scopeNodes.length === 0) this.queueWrite(node.id, []);
        return;
      }
      case "research": {
        node.result = createResearchReceipt(node, run, node.result);
        const planNodeId = node.dependsOn[0];
        if (!planNodeId) throw new Error("Research node has no plan dependency");
        const siblings = run.nodes.filter((candidate) => candidate.kind === "research" && candidate.dependsOn[0] === planNodeId);
        if (siblings.every((candidate) => candidate.id === node.id || candidate.status === "succeeded")) {
          this.queueWrite(planNodeId, siblings.map((candidate) => candidate.id));
        }
        return;
      }
      case "write":
      case "repair": {
        this.queueNode("validate", "Validate Wiki", [node.id], { sourceNodeId: node.id });
        return;
      }
      case "validate": {
        const validation = parseValidation(node.result);
        node.result = validation;
        if (validation.ok) {
          this.queueNode("review", "Review Wiki", [node.id], { validation });
        } else {
          const signature = stableStringify(validation.errors);
          if (signature === this.previousValidationSignature(node.id)) {
            run.status = "blocked";
            run.blockedReason = "Validation produced the same unresolved error set twice";
            this.emit("run_blocked", node.id, run.blockedReason);
            return;
          }
          this.queueRepair([node.id], { validation });
        }
        return;
      }
      case "review": {
        const review = parseReview(node.result);
        node.result = review;
        if (review.defects.length === 0) {
          run.status = "succeeded";
          run.completedAt = this.now();
          this.emit("run_completed", undefined, "Wiki validation and review passed");
          return;
        }
        const signature = defectsFingerprint(review.defects);
        const previous = this.previousReviewSignature(node.id);
        if (signature === previous) {
          run.status = "blocked";
          run.blockedReason = "Review produced the same unresolved defect set twice";
          this.emit("run_blocked", node.id, run.blockedReason);
          return;
        }
        const structural = review.defects.some((defect) => defect.kind === "topology" || defect.kind === "coverage");
        if (structural) {
          const replans = run.nodes.filter((candidate) => candidate.kind === "replan"
            && candidate.status !== "invalidated" && candidate.status !== "cancelled").length;
          if (replans >= MAX_STRUCTURAL_REPLANS) {
            run.status = "blocked";
            run.blockedReason = `Structural review exceeded the ${MAX_STRUCTURAL_REPLANS}-replan budget`;
            this.emit("run_blocked", node.id, run.blockedReason);
            return;
          }
          this.queuePlan("replan", [node.id]);
        } else this.queueRepair([node.id], { review });
        return;
      }
    }
  }

  private queuePlan(kind: "plan" | "replan", dependsOn: string[]): WikiNode {
    const run = this.requireRun();
    run.round += 1;
    const trigger = kind === "replan"
      ? dependsOn.map((id) => this.nodeById(id)?.result).filter((value) => value !== undefined)
      : undefined;
    return this.queueNode(kind, kind === "plan" ? `Plan Wiki (round ${run.round})` : `Replan Wiki (round ${run.round})`, dependsOn, {
      inspection: run.inspection,
      focus: run.focus,
      round: run.round,
      trigger,
    });
  }

  private queueWrite(planNodeId: string, researchIds: string[]): WikiNode | undefined {
    const run = this.requireRun();
    const existing = run.nodes.find((node) => node.kind === "write"
      && valueIs(node.input, "planNodeId", planNodeId)
      && !["invalidated", "cancelled", "failed", "blocked"].includes(node.status));
    if (existing) return undefined;
    return this.queueNode("write", "Write Wiki", [planNodeId, ...researchIds], { planNodeId, researchIds });
  }

  private queueRepair(dependsOn: string[], input: Record<string, unknown>): WikiNode {
    return this.queueNode("repair", "Repair Wiki", dependsOn, input);
  }

  private queueNode(
    kind: WikiNodeKind,
    label: string,
    dependsOn: string[],
    input: unknown,
    phase?: { id: string; title: string },
  ): WikiNode {
    const node = this.newNode(kind, label, dependsOn, input, phase);
    this.requireRun().nodes.push(node);
    this.emit("node_queued", node.id, node.label);
    return node;
  }

  private newNode(
    kind: WikiNodeKind,
    label: string,
    dependsOn: string[],
    input: unknown,
    phase?: { id: string; title: string },
  ): WikiNode {
    const now = this.now();
    const id = `${kind}-${this.newId()}`;
    return {
      id,
      kind,
      label,
      phaseId: phase?.id ?? `phase:${id}`,
      phaseTitle: phase?.title ?? phaseTitleFor(kind),
      status: "queued",
      dependsOn,
      attempt: 0,
      inputFingerprint: stableStringify(input),
      input: clone(input),
      attemptHistory: [],
      metrics: clone(EMPTY_NODE_METRICS),
      activity: { state: "idle", updatedAt: now },
    };
  }

  private async reconcileGitInputs(): Promise<boolean> {
    const run = this.requireRun();
    if (!run.inspectionFingerprint) return false;
    const latest = await this.dependencies.inspect(run.cwd);
    if (inspectionFingerprint(latest) === run.inspectionFingerprint) return false;

    const inspectNode = run.nodes.find((node) => node.kind === "inspect");
    if (!inspectNode) throw new Error("Run has no inspect node");
    this.invalidateFrom(inspectNode.id, "Git inputs changed since this run was planned", true);
    run.inspection = undefined;
    run.inspectionFingerprint = undefined;
    run.effectiveMode = undefined;
    return true;
  }

  private invalidateFrom(nodeId: string, reason: string, queueRoot: boolean): void {
    this.invalidateFromMany([nodeId], reason, queueRoot);
  }

  private invalidateFromMany(rootIds: string[], reason: string, queueRoots: boolean): void {
    const run = this.requireRun();
    const roots = new Set(rootIds);
    const affected = affectedNodeIds(run, rootIds);
    for (const node of run.nodes) {
      if (!affected.has(node.id)) continue;
      if (node.status === "running") this.controllers.get(node.id)?.abort();
      node.status = roots.has(node.id) && queueRoots ? "queued" : "invalidated";
      node.error = undefined;
      node.activity = { state: "idle", message: reason, updatedAt: this.now() };
      this.emit(roots.has(node.id) && queueRoots ? "node_retried" : "node_invalidated", node.id, reason);
    }
  }

  private updateActivity(nodeId: string, activity: Partial<WikiNodeActivity>, metrics?: Partial<WikiNodeMetrics>): void {
    const node = this.nodeById(nodeId);
    if (!node || node.status !== "running") return;
    node.activity = { ...node.activity, ...activity, updatedAt: this.now() };
    node.metrics = mergeMetrics(node.metrics, metrics, true);
    this.emitActivity(node);
  }

  private updateOutput(nodeId: string, output: string): void {
    const node = this.nodeById(nodeId);
    if (!node || node.status !== "running") return;
    node.output = retainedOutput(output);
    this.emitActivity(node);
  }

  private updateHistory(nodeId: string, history: WikiNodeHistoryEntry[]): void {
    const node = this.nodeById(nodeId);
    if (!node || node.status !== "running") return;
    node.history = retainedHistory(history);
    this.emitActivity(node);
  }

  private emitActivity(node: WikiNode): void {
    const now = Date.now();
    const previous = this.lastActivityEventAt.get(node.id) ?? 0;
    if (now - previous < ACTIVITY_EVENT_INTERVAL_MS) return;
    this.lastActivityEventAt.set(node.id, now);
    this.emit("node_activity", node.id, node.activity.message);
  }

  private previousReviewSignature(currentNodeId: string): string | undefined {
    const reviews = this.requireRun().nodes
      .filter((node) => node.kind === "review" && node.id !== currentNodeId && node.status === "succeeded")
      .map((node) => parseReview(node.result));
    const latest = reviews.at(-1);
    return latest ? defectsFingerprint(latest.defects) : undefined;
  }

  private previousValidationSignature(currentNodeId: string): string | undefined {
    const validations = this.requireRun().nodes
      .filter((node) => node.kind === "validate" && node.id !== currentNodeId && node.status === "succeeded")
      .map((node) => parseValidation(node.result))
      .filter((validation) => !validation.ok);
    const latest = validations.at(-1);
    return latest ? stableStringify(latest.errors) : undefined;
  }

  private archiveAttempt(node: WikiNode): void {
    node.attemptHistory.push({
      attempt: node.attempt,
      startedAt: node.startedAt,
      finishedAt: node.finishedAt,
      result: clone(node.result),
      output: node.output,
      history: node.history ? clone(node.history) : undefined,
      error: node.error ? clone(node.error) : undefined,
      metrics: clone(node.metrics),
    });
  }

  private abortControllers(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  private failRun(error: unknown): void {
    if (!this.current || this.current.status !== "running") return;
    this.current.status = "failed";
    this.current.blockedReason = errorMessage(error);
    this.emit("run_blocked", undefined, this.current.blockedReason);
  }

  private emit(kind: WikiRunEventKind, nodeId?: string, message?: string, data?: Record<string, unknown>): void {
    const run = this.current;
    if (!run) return;
    const event: WikiRunEvent = { id: this.newId(), at: this.now(), kind, nodeId, message, data };
    run.events.push(event);
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    run.updatedAt = event.at;
    const snapshot = clone(run);
    for (const listener of this.listeners) listener(snapshot, event);
  }

  private nodeById(id: string): WikiNode | undefined {
    return this.current?.nodes.find((node) => node.id === id);
  }

  private requireNode(id: string): WikiNode {
    const node = this.nodeById(id);
    if (!node) throw new Error(`Unknown Wiki workflow node: ${id}`);
    return node;
  }

  private requireRun(): WikiRunSnapshot {
    if (!this.current) throw new Error("No Wiki workflow is available");
    return this.current;
  }

  private now(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }

  private newId(): string {
    return this.dependencies.createId?.() ?? randomUUID();
  }
}

export function createWikiWorkflowEngine(options: WikiWorkflowEngineOptions = {}): WikiWorkflowEngine {
  return new WikiWorkflowEngine(options);
}

function nodesInPhase(run: WikiRunSnapshot, phaseId: string): WikiNode[] {
  const explicit = run.nodes.filter((node) => node.phaseId === phaseId);
  if (explicit.length) return explicit;
  const legacyNodeId = phaseId.startsWith("phase:") ? phaseId.slice("phase:".length) : "";
  const start = run.nodes.findIndex((node) => node.id === legacyNodeId);
  if (start < 0) return [];
  const kind = run.nodes[start]?.kind;
  const nodes: WikiNode[] = [];
  for (const node of run.nodes.slice(start)) {
    if (node.phaseId || node.kind !== kind) break;
    nodes.push(node);
  }
  return nodes;
}

function affectedNodeIds(run: WikiRunSnapshot, rootIds: string[]): Set<string> {
  const affected = new Set(rootIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of run.nodes) {
      if (affected.has(node.id) || !node.dependsOn.some((id) => affected.has(id))) continue;
      affected.add(node.id);
      changed = true;
    }
  }
  return affected;
}

function resetForkedNode(node: WikiNode, at: string): void {
  node.status = "invalidated";
  node.attempt = 0;
  node.attemptHistory = [];
  node.result = undefined;
  node.output = undefined;
  node.history = undefined;
  node.error = undefined;
  node.metrics = clone(EMPTY_NODE_METRICS);
  node.startedAt = undefined;
  node.finishedAt = undefined;
  node.activity = { state: "idle", message: "Forked retry", updatedAt: at };
}

function phaseTitle(node: WikiNode | undefined): string {
  return node?.phaseTitle ?? (node ? phaseTitleFor(node.kind) : "phase");
}

function phaseTitleFor(kind: WikiNodeKind): string {
  switch (kind) {
    case "inspect": return "Inspect";
    case "plan": return "Plan";
    case "research": return "Research";
    case "write": return "Write";
    case "validate": return "Validate";
    case "review": return "Review";
    case "repair": return "Repair";
    case "replan": return "Replan";
  }
}

function isTerminalRun(snapshot: WikiRunSnapshot): boolean {
  return snapshot.status === "succeeded" || snapshot.status === "failed" || snapshot.status === "blocked" || snapshot.status === "cancelled";
}

function roleFor(kind: WikiNodeKind): "planner" | "researcher" | "writer" | "reviewer" {
  if (kind === "plan" || kind === "replan") return "planner";
  if (kind === "research") return "researcher";
  if (kind === "write" || kind === "repair") return "writer";
  return "reviewer";
}

async function promptFor(node: WikiNode, run: WikiRunSnapshot): Promise<string> {
  const guidance = await loadWikiPromptGuidance(node.kind, run.language);
  switch (node.kind) {
    case "plan":
    case "replan":
      return `${guidance}\n\n## Runtime Context\nCurrent Git inspection:\n\`\`\`json\n${prettyJson(run.inspection)}\n\`\`\`\nFocus: ${run.focus ?? "none"}\nReplan trigger:\n\`\`\`json\n${prettyJson(node.input)}\n\`\`\``;
    case "research":
      return `${guidance}\n\n## Assigned Scope\n\`\`\`json\n${prettyJson(node.input)}\n\`\`\``;
    case "write":
      return `${guidance}\n\n${writerContext(node, run)}`;
    case "repair":
      return `${guidance}\n\n## Repair Input\n\`\`\`json\n${prettyJson(node.input)}\n\`\`\``;
    case "review":
      return `${guidance}\n\n## Validation Context\n\`\`\`json\n${prettyJson(node.input)}\n\`\`\``;
    default:
      throw new Error(`No prompt available for ${node.kind}`);
  }
}

function writerContext(node: WikiNode, run: WikiRunSnapshot): string {
  const input = node.input as Record<string, unknown>;
  const plan = typeof input.planNodeId === "string"
    ? run.nodes.find((candidate) => candidate.id === input.planNodeId)?.result
    : undefined;
  const receipts = Array.isArray(input.researchIds)
    ? input.researchIds
      .map((id) => run.nodes.find((candidate) => candidate.id === id)?.result)
      .filter((receipt): receipt is WikiResearchReceipt => isResearchReceipt(receipt))
    : [];
  const sections = [
    "## Approved Plan",
    "```json",
    prettyJson(plan),
    "```",
  ];
  for (const receipt of receipts) {
    sections.push(
      `## Research Receipt: ${receipt.scopeId}`,
      `Task: ${receipt.task}`,
      `Source fingerprint: ${receipt.sourceFingerprint}`,
      receipt.markdown,
    );
  }
  return sections.join("\n");
}

/** Validate control submissions and local service results before publishing node state. */
function normalizeNodeResult(kind: WikiNodeKind, value: unknown): unknown {
  switch (kind) {
    case "inspect":
      return parseInspection(value);
    case "plan":
    case "replan":
      return parsePlan(value);
    case "validate":
      return parseValidation(value);
    case "review":
      return parseReview(value);
    case "research":
    case "write":
    case "repair":
      return value;
  }
}

function parseInspection(value: unknown): WikiInspection {
  if (!isRecord(value) || typeof value.root !== "string" || typeof value.sourceFingerprint !== "string" || (value.mode !== "generate" && value.mode !== "refresh")) {
    throw new Error("Inspect returned an invalid Wiki inspection");
  }
  return value as WikiInspection;
}

function parseValidation(value: unknown): WikiValidation {
  if (!isRecord(value) || typeof value.ok !== "boolean" || !isStringArray(value.errors) || !isStringArray(value.pages)) {
    throw new Error("Validator returned an invalid result");
  }
  return { ok: value.ok, errors: [...value.errors], pages: [...value.pages] };
}

function parsePlan(value: unknown): WikiPlanResult {
  if (!isRecord(value) || !Array.isArray(value.pages) || !Array.isArray(value.researchScopes) || typeof value.rationale !== "string") {
    throw new Error("Planner submission must include pages, researchScopes, and rationale");
  }
  const pages = value.pages.map((page) => {
    if (!isRecord(page) || !isWikiPagePath(page.path) || typeof page.title !== "string" || typeof page.purpose !== "string" || !isStringArray(page.sources)) {
      throw new Error("Planner returned an invalid page plan");
    }
    return { path: page.path, title: page.title, purpose: page.purpose, sources: [...page.sources] };
  });
  const seen = new Set<string>();
  const researchScopes = value.researchScopes.slice(0, MAX_RESEARCH_CONCURRENCY).map((scope) => {
    if (!isRecord(scope) || typeof scope.id !== "string" || !scope.id.trim() || typeof scope.task !== "string" || !scope.task.trim() || seen.has(scope.id)) {
      throw new Error("Planner returned invalid or duplicate research scopes");
    }
    seen.add(scope.id);
    return { id: scope.id, task: scope.task };
  });
  return { pages, researchScopes, rationale: value.rationale };
}

function parseReview(value: unknown): WikiReviewResult {
  if (!isRecord(value) || !Array.isArray(value.defects) || typeof value.summary !== "string") {
    throw new Error("Reviewer submission must include defects and summary");
  }
  const defects = value.defects.map((defect) => {
    if (!isRecord(defect) || typeof defect.id !== "string" || typeof defect.page !== "string" || !isReviewKind(defect.kind) || typeof defect.detail !== "string") {
      throw new Error("Reviewer returned an invalid defect");
    }
    return { id: defect.id, page: defect.page, kind: defect.kind, detail: defect.detail };
  });
  return { defects, summary: value.summary };
}

function createResearchReceipt(node: WikiNode, run: WikiRunSnapshot, value: unknown): WikiResearchReceipt {
  const scope = node.input;
  if (!isRecord(scope) || typeof scope.id !== "string" || !scope.id.trim() || typeof scope.task !== "string" || !scope.task.trim()) {
    throw new Error("Research node has an invalid scope");
  }
  if (typeof value !== "string" || !value.trim()) throw new Error("Researcher must return a Markdown receipt");
  return {
    scopeId: scope.id,
    task: scope.task,
    sourceFingerprint: run.inspection?.sourceFingerprint ?? "unknown",
    markdown: retainedText(value.trim(), MAX_RESEARCH_RECEIPT_CHARS),
  };
}

function isResearchReceipt(value: unknown): value is WikiResearchReceipt {
  return isRecord(value)
    && typeof value.scopeId === "string"
    && typeof value.task === "string"
    && typeof value.sourceFingerprint === "string"
    && typeof value.markdown === "string";
}

function isReviewKind(value: unknown): value is WikiReviewDefect["kind"] {
  return value === "evidence" || value === "link" || value === "format" || value === "topology" || value === "coverage";
}

function isWikiPagePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith(".md")) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !normalized.startsWith("wiki/") && !normalized.split("/").some((part) => part === "" || part === "." || part === "..");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function inspectionFingerprint(inspection: WikiInspection): string {
  return stableStringify({
    changed: inspection.changed,
    changedPaths: inspection.changedPaths,
    sourceFingerprint: inspection.sourceFingerprint,
  });
}

function retainedOutput(output: string | undefined): string | undefined {
  if (output === undefined || output.length <= MAX_NODE_OUTPUT_CHARS) return output;
  // Reserve room for the marker as well as the retained tail. This makes the
  // operation idempotent when a streamed result is finalized or archived.
  let retainedLength = MAX_NODE_OUTPUT_CHARS;
  let marker = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    marker = `[..., ${output.length - retainedLength} earlier characters omitted ...]\n`;
    retainedLength = MAX_NODE_OUTPUT_CHARS - marker.length;
  }
  marker = `[... ${output.length - retainedLength} earlier characters omitted ...]\n`;
  return `${marker}${output.slice(-retainedLength)}`;
}

function retainedHistory(history: WikiNodeHistoryEntry[] | undefined): WikiNodeHistoryEntry[] | undefined {
  if (!history?.length) return history;
  const retained: WikiNodeHistoryEntry[] = [];
  let chars = 0;
  for (const entry of history.slice(-MAX_NODE_HISTORY_ENTRIES).reverse()) {
    const remaining = MAX_NODE_HISTORY_CHARS - chars;
    if (remaining <= 0) break;
    const text = retainedText(entry.text, remaining);
    retained.unshift({ ...entry, text });
    chars += text.length;
  }
  return retained;
}

function retainedText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 40) return text.slice(-limit);
  let retainedLength = limit;
  let marker = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    marker = `[... ${text.length - retainedLength} earlier characters omitted ...]\n`;
    const nextLength = Math.max(0, limit - marker.length);
    if (nextLength === retainedLength) break;
    retainedLength = nextLength;
  }
  return `${marker}${text.slice(-retainedLength)}`;
}

function defectsFingerprint(defects: WikiReviewDefect[]): string {
  return stableStringify(defects.map((defect) => ({ page: defect.page, kind: defect.kind, detail: defect.detail })).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))));
}

function mergeMetrics(current: WikiNodeMetrics, update?: Partial<WikiNodeMetrics>, incremental = false): WikiNodeMetrics {
  if (!update) return current;
  const next = { ...current, ...update };
  if (incremental) {
    if (update.compactions !== undefined) next.compactions = current.compactions + update.compactions;
    if (update.autoRetries !== undefined) next.autoRetries = current.autoRetries + update.autoRetries;
  }
  return next;
}

function valueIs(value: unknown, key: string, expected: string): boolean {
  return isRecord(value) && value[key] === expected;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

function normalizeText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object";
}

function isSnapshot(value: unknown): value is WikiRunSnapshot {
  return isRecord(value) && value.version === 1 && typeof value.id === "string" && Array.isArray(value.nodes);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
