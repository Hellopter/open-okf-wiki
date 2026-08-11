import { randomUUID } from "node:crypto";
import path from "node:path";
import { createWikiArtifactStore, type WikiArtifactRef, type WikiArtifactStore } from "./artifact-store.js";
import {
  WikiAgentContextBudgetError,
  WikiAgentProtocolError,
} from "./agent-errors.js";
import {
  parseResearchArtifact,
  parseResearchSubmission,
} from "./control-submissions.js";
import { createPiAgentExecutor } from "./executor.js";
import {
  errorMessage,
  isWikiBudgetExhaustedError,
  WikiBudgetExhaustedError,
} from "./failures.js";
import { inspectWiki } from "./inspect.js";
import { classifyNodeFailure } from "./node-retry.js";
import {
  DEFAULT_WIKI_WORKFLOW_POLICY,
  validMaxResearchRounds,
} from "./policy.js";
import { promptFor, type PromptResearchReceipt } from "./prompts.js";
import { loadResearchSourceRoots, validateResearchArtifact } from "./research-evidence.js";
import { projectResearchReceipt, researchFindings } from "./research-receipt.js";
import {
  affectedNodeIds,
  isForkableRun,
  isTerminalRun,
  nodesInPhase,
  phaseRetryRoots,
  phaseTitle,
  resetForkedNode,
} from "./run-graph.js";
import { checkRunArtifactHealth } from "./run-health.js";
import {
  artifactKindForNode,
  hashWikiPage,
  inspectionFingerprint,
  isMissingArtifactError,
  isResearchReceipt,
  mergeMetrics,
  normalizeNodeResult,
  normalizeText,
  pagePacketInputFor,
  readRootsFor,
  researchInputFor,
  retainedHistory,
  retainedOutput,
  roleFor,
  specForSynthesis,
  synthesisInputFor,
  synthesisNodeIdFor,
  wikiReadPathsFor,
  writePathsFor,
  writeReport,
} from "./run-nodes.js";
import { createWikiRunSession } from "./session.js";
import { isWikiRunSnapshot } from "./snapshot-validation.js";
import {
  afterSuccess,
  newNode,
  tryJoinAfterSuccess,
  validateControlSubmission,
  validateWriteNodeResult,
  type TransitionHost,
} from "./transitions-queue.js";
import { clone } from "./util.js";
import { phaseRefForKind } from "./workflow-phases.js";
import { finalizeWiki, materializeWikiIndexes, validateWiki, validateWikiPage } from "./validate.js";
import {
  EMPTY_NODE_METRICS,
  type WikiAgentExecutionResult,
  type WikiNode,
  type WikiNodeActivity,
  type WikiNodeHistoryEntry,
  type WikiNodeMetrics,
  type WikiRunEvent,
  type WikiRunEventKind,
  type WikiRunRequest,
  type WikiRunSession,
  type WikiRunSnapshot,
  type WikiWorkflowDependencies,
  type WikiWorkflowListener,
} from "./workflow-types.js";

const MAX_NODE_ATTEMPTS = DEFAULT_WIKI_WORKFLOW_POLICY.maxNodeAttempts;
const MAX_CONCURRENT_RESEARCHERS = DEFAULT_WIKI_WORKFLOW_POLICY.maxConcurrentResearchers;
const MAX_CONCURRENT_WRITERS = DEFAULT_WIKI_WORKFLOW_POLICY.maxConcurrentWriters;
const MAX_EVENTS = DEFAULT_WIKI_WORKFLOW_POLICY.maxEvents;
const ACTIVITY_EVENT_INTERVAL_MS = DEFAULT_WIKI_WORKFLOW_POLICY.activityEventIntervalMs;

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
  private readonly hasInjectedArtifactStore: boolean;
  private artifactStore?: WikiArtifactStore;
  private artifactStoreWorkspace?: string;
  private pumping?: Promise<void>;
  private pendingTerminalEvent?: {
    runId: string;
    kind: "run_completed" | "run_failed" | "run_blocked";
    nodeId?: string;
    message: string;
  };

  constructor(options: WikiWorkflowEngineOptions = {}) {
    this.dependencies = {
      inspect: options.inspect ?? inspectWiki,
      validate: options.validate ?? validateWiki,
      validatePage: options.validatePage ?? validateWikiPage,
      materializeIndexes: options.materializeIndexes ?? materializeWikiIndexes,
      finalize: options.finalize ?? finalizeWiki,
      executor: options.executor ?? createPiAgentExecutor(),
      artifactStore: options.artifactStore,
      now: options.now,
      createId: options.createId,
    };
    this.artifactStore = options.artifactStore;
    this.hasInjectedArtifactStore = options.artifactStore !== undefined;
  }

  start(request: WikiRunRequest): WikiRunSnapshot {
    if (this.current && (this.current.status === "running" || this.current.status === "paused")) {
      throw new Error("A Wiki workflow is already active for this Pi session");
    }
    const createdAt = this.now();
    this.ensureArtifactStore(request.cwd);
    const inspectionNode = newNode(this.transitionHost(), "inspect", "Inspect Git scope", [], { requestedMode: request.mode }, phaseRefForKind("inspect"));
    this.current = {
      version: 8,
      id: this.newId(),
      cwd: path.resolve(request.cwd),
      requestedMode: request.mode,
      language: request.language === "en" ? "en" : "zh",
      focus: normalizeText(request.focus),
      status: "running",
      round: 0,
      sourceRestartCount: 0,
      maxResearchRounds: validMaxResearchRounds(request.maxResearchRounds),
      nodes: [inspectionNode],
      events: [],
      createdAt,
      updatedAt: createdAt,
      revision: 0,
    };
    this.pendingTerminalEvent = undefined;
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
    // Pointer-only session entry; full state is persisted via the history store.
    return this.current ? createWikiRunSession(this.current) : undefined;
  }

  /**
   * Restore from a full WikiRunSnapshot (loaded from the history store).
   * Pointer-only session entries cannot be restored here — the extension must
   * resolve `runId` → history snapshot first. Legacy full-snapshot session
   * payloads are rejected (fail closed).
   */
  restore(serialized: WikiRunSnapshot | unknown): WikiRunSnapshot | undefined {
    if (!isWikiRunSnapshot(serialized)) return undefined;

    this.ensureArtifactStore(serialized.cwd);
    this.abortControllers();
    this.current = clone(serialized);
    this.pendingTerminalEvent = undefined;
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

  /**
   * After restore, verify durable handoffs for succeeded research/synthesis/review
   * nodes. Missing or unreadable artifacts mark the run blocked so resume cannot
   * dispatch into a broken graph. Returns problem strings (empty when healthy).
   */
  async applyRestoredArtifactHealth(): Promise<string[]> {
    const run = this.current;
    if (!run) return [];
    if (run.status !== "paused" && run.status !== "running") return [];
    const store = this.ensureArtifactStore(run.cwd);
    const problems = await checkRunArtifactHealth(run.cwd, run, store);
    if (problems.length === 0) return problems;
    const message = `Missing or unreadable handoff artifacts after restore: ${problems.join("; ")}`;
    this.markTerminalRun("blocked", message, undefined, undefined, {
      code: "missing_handoff_artifacts",
    });
    this.emitPendingTerminalEvent();
    return problems;
  }

  async retryNode(nodeId: string): Promise<WikiRunSnapshot> {
    const node = this.requireNode(nodeId);
    if (node.status === "running") throw new Error("A running node cannot be retried; cancel or wait for it first");
    if (!["succeeded", "failed", "invalidated", "blocked", "cancelled"].includes(node.status)) {
      throw new Error(`Node ${nodeId} is not retryable`);
    }
    return await this.retryRoots([node.id], `Retry requested for ${node.label}`, "node");
  }

  /** Re-run the latest settled execution iteration in one displayed workflow stage. */
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
    const roots = phaseRetryRoots(nodes);
    return await this.retryRoots(roots.map((node) => node.id), `Phase retry requested for ${phaseTitle(nodes[0])}`, "phase", phaseId);
  }

  /** Fork an immutable historical run before retrying one selected node. */
  async forkAndRetryNode(snapshot: WikiRunSnapshot, nodeId: string): Promise<WikiRunSnapshot> {
    return await this.forkAndRetry(snapshot, [nodeId], { nodeId });
  }

  /** Fork an immutable historical run before retrying a complete phase. */
  async forkAndRetryPhase(snapshot: WikiRunSnapshot, phaseId: string): Promise<WikiRunSnapshot> {
    const nodes = nodesInPhase(snapshot, phaseId);
    if (!nodes.length) throw new Error(`Unknown Wiki workflow phase: ${phaseId}`);
    return await this.forkAndRetry(snapshot, phaseRetryRoots(nodes).map((node) => node.id), { phaseId });
  }

  /** True when a node currently has a live AbortController (executor in flight). */
  isNodeLive(nodeId: string): boolean {
    return this.controllers.has(nodeId);
  }

  private async forkAndRetry(
    snapshot: WikiRunSnapshot,
    rootIds: string[],
    source: { nodeId?: string; phaseId?: string },
  ): Promise<WikiRunSnapshot> {
    if (this.current && (this.current.status === "running" || this.current.status === "paused")) {
      throw new Error("A Wiki workflow is already active for this Pi session");
    }
    if (!isForkableRun(snapshot)) {
      throw new Error("Only completed or interrupted Wiki history can be forked for retry");
    }
    const branch = clone(snapshot);
    const now = this.now();
    branch.id = this.newId();
    branch.version = 8;
    // Recover interrupted nodes so fork targets are settled (queued, not running).
    for (const node of branch.nodes) {
      if (node.status !== "running") continue;
      node.status = "queued";
      node.activity = { state: "waiting", message: "Interrupted; forked for retry", updatedAt: now };
    }
    branch.status = "paused";
    branch.createdAt = now;
    branch.updatedAt = now;
    branch.completedAt = undefined;
    branch.blockedReason = undefined;
    branch.blockedDetails = undefined;
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
    this.ensureArtifactStore(snapshot.cwd);
    this.abortControllers();
    await this.copyArtifactsForFork(snapshot, branch);
    this.current = branch;
    this.pendingTerminalEvent = undefined;
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
    run.blockedDetails = undefined;
    run.completedAt = undefined;
    this.pendingTerminalEvent = undefined;
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
    // Re-check durable handoffs before dispatch; missing blobs block the run.
    if (run.status === "paused") {
      const problems = await this.applyRestoredArtifactHealth();
      if (problems.length > 0) {
        throw new Error(`Wiki run cannot resume: ${problems.join("; ")}`);
      }
    }
    if (run.status !== "paused" && run.status !== "blocked") return this.getSnapshot();
    if (run.status === "blocked" && !run.nodes.some((node) => node.status === "queued")) {
      throw new Error("A blocked Wiki run requires targeted node retry or cancellation");
    }
    await this.reconcileGitInputs();
    run.status = "running";
    run.blockedReason = undefined;
    run.blockedDetails = undefined;
    run.completedAt = undefined;
    this.pendingTerminalEvent = undefined;
    this.emit("run_resumed", undefined, "Scheduling resumed");
    this.schedule();
    return this.getSnapshot();
  }

  async cancel(): Promise<WikiRunSnapshot | undefined> {
    const run = this.requireRun();
    if (["succeeded", "cancelled"].includes(run.status)) return this.getSnapshot();
    run.status = "cancelled";
    this.pendingTerminalEvent = undefined;
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

  /**
   * Hard-stop-resume: abort live agents, requeue running nodes, pause the run.
   * Unlike pause (soft: agents may finish), stop aborts immediately but remains resumable.
   * Unlike cancel, nodes return to queued rather than cancelled, and the run is not terminal.
   */
  async stop(): Promise<WikiRunSnapshot | undefined> {
    return this.hardStopResume({
      nodeActivity: "Stopped; will resume after Git re-inspection",
      nodeEvent: "Agent stopped",
      runMessage: "Agents stopped; run paused and can resume",
    });
  }

  /** Called during extension shutdown: same hard-stop-resume path as stop(). */
  async interrupt(): Promise<WikiRunSnapshot | undefined> {
    return this.hardStopResume({
      nodeActivity: "Interrupted; will resume after Git re-inspection",
      nodeEvent: "Interrupted for session shutdown",
      runMessage: "Run interrupted for session shutdown",
    });
  }

  private async hardStopResume(messages: {
    nodeActivity: string;
    nodeEvent: string;
    runMessage: string;
  }): Promise<WikiRunSnapshot | undefined> {
    const run = this.current;
    if (!run) return undefined;
    if (run.status !== "running" && run.status !== "paused") {
      this.abortControllers();
      return this.getSnapshot();
    }
    for (const node of run.nodes) {
      if (node.status !== "running") continue;
      node.status = "queued";
      node.activity = { state: "waiting", message: messages.nodeActivity, updatedAt: this.now() };
      this.emit("node_cancelled", node.id, messages.nodeEvent);
    }
    this.abortControllers();
    run.status = "paused";
    this.emit("run_paused", undefined, messages.runMessage);
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
      const research = runnable.filter((node) => node.kind === "research").slice(0, MAX_CONCURRENT_RESEARCHERS);
      if (research.length > 0) {
        await this.executeBatch(research);
        this.emitPendingTerminalEvent();
        continue;
      }
      const verification = runnable.filter((node) => node.kind === "validate" || node.kind === "review");
      if (verification.length > 0) {
        await this.executeBatch(verification);
        this.emitPendingTerminalEvent();
        continue;
      }
      const pageWrites = runnable.filter((node) => node.kind === "write").slice(0, MAX_CONCURRENT_WRITERS);
      if (pageWrites.length > 0) {
        await this.executeBatch(pageWrites);
      } else {
        await this.executeNode(runnable[0]);
      }
      this.emitPendingTerminalEvent();
    }
  }

  private async executeBatch(nodes: WikiNode[]): Promise<void> {
    const results = await Promise.allSettled(nodes.map(async (node) => await this.executeNode(node)));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
    // Fan-in is handled once per node via tryJoinAfterSuccess / afterSuccess after status=succeeded.
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
      this.markTerminalRun("blocked", `${node.label} reached ${MAX_NODE_ATTEMPTS} attempts`, node.id);
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

    // True after this node has published status=succeeded. Fan-in failures after
    // that point must rethrow so the batch/pump fails the run rather than being
    // swallowed by the "status !== running" early return.
    let completedSuccessfully = false;
    try {
      const result = await this.executeNodeWork(node, controller.signal);
      if (node.status !== "running") return;
      // Research: validate once with workspace source roots, then finalize the
      // handoff, then project a receipt (no second FS pass after persist).
      if (node.kind === "research") {
        const scope = researchInputFor(node).scope;
        const parsed = parseResearchSubmission(result.result);
        const sourceRoots = await loadResearchSourceRoots(run.cwd, scope.sourcePaths);
        validateResearchArtifact(parsed, {
          cwd: run.cwd,
          allowedSourceRoots: scope.sourcePaths,
          sourceRoots,
        });
        const handoff = await this.persistNodeHandoff(node, parsed);
        if (!handoff || handoff.kind !== "research") {
          throw new Error("Researcher did not produce a research handoff artifact");
        }
        node.handoff = handoff;
        node.result = projectResearchReceipt(run, parsed, handoff, scope);
      } else {
        const handoff = await this.persistNodeHandoff(node, result.result);
        if (handoff) node.handoff = handoff;
        node.result = normalizeNodeResult(node.kind, result.result);
      }
      node.output = retainedOutput(result.output ?? node.output);
      node.history = retainedHistory(result.history ?? node.history);
      node.metrics = mergeMetrics(node.metrics, result.metrics);

      // Research/write: mark succeeded first so concurrent siblings see us, then
      // join-barrier fan-in once. Other kinds keep afterSuccess transitions.
      if (node.kind === "research" || node.kind === "write") {
        if (node.kind === "write") await validateWriteNodeResult(this.transitionHost(), node);
        this.markNodeSucceeded(node);
        completedSuccessfully = true;
        await tryJoinAfterSuccess(this.transitionHost(), node);
      } else if (node.kind === "validate" || node.kind === "review") {
        // Peer fan-in in maybeCompleteVerification needs self as succeeded.
        this.markNodeSucceeded(node);
        completedSuccessfully = true;
        await afterSuccess(this.transitionHost(), node);
      } else {
        await afterSuccess(this.transitionHost(), node);
        // afterSuccess may markTerminalRun (finalize drift/success) without
        // changing node status; only publish succeeded while still running.
        if (node.status === "running") {
          this.markNodeSucceeded(node);
          completedSuccessfully = true;
        }
      }
    } catch (error) {
      if (completedSuccessfully) throw error;
      if (node.status !== "running") return;
      const classification = classifyNodeFailure(error, {
        attempt: node.attempt,
        maxAttempts: MAX_NODE_ATTEMPTS,
        aborted: controller.signal.aborted,
      });
      node.status = classification.status;
      if (error instanceof WikiAgentProtocolError || error instanceof WikiAgentContextBudgetError) {
        node.output = retainedOutput(error.output || node.output);
        node.history = retainedHistory(error.history.length ? error.history : node.history);
      }
      node.error = classification.error;
      const finishedAt = this.now();
      node.activity = { state: "completed", message: node.error.message, updatedAt: finishedAt };
      node.finishedAt = finishedAt;
      if (classification.retryable && classification.status === "queued") {
        node.activity = { state: "retrying", message: node.error.message, updatedAt: finishedAt };
        this.emit("node_retried", node.id, node.error.message);
      } else if ((run.status === "running" || run.status === "paused") && classification.terminalRun) {
        this.markTerminalRun(
          classification.terminalRun,
          node.error.message,
          node.id,
          finishedAt,
          terminalDetailsFromFailure(error, classification.error.code),
        );
      }
      if (!(classification.retryable && classification.status === "queued")) {
        this.emit(node.status === "cancelled" ? "node_cancelled" : "node_failed", node.id, node.error.message);
      }
    } finally {
      this.controllers.delete(node.id);
    }
  }

  private markNodeSucceeded(node: WikiNode): void {
    node.status = "succeeded";
    node.activity = { state: "completed", message: "Completed", updatedAt: this.now() };
    node.finishedAt = this.now();
    // Drop live transcript once handoff/result are final — keeps snapshots slim.
    node.history = undefined;
    node.output = undefined;
    this.emit("node_succeeded", node.id, node.label);
  }

  private async executeNodeWork(node: WikiNode, signal: AbortSignal): Promise<WikiAgentExecutionResult> {
    const run = this.requireRun();
    if (node.kind === "inspect") {
      const inspection = await this.dependencies.inspect(run.cwd);
      return { result: inspection };
    }
    if (node.kind === "validate") {
      const validation = await this.dependencies.validate(run.cwd, specForSynthesis(run, synthesisNodeIdFor(node, run)));
      return { result: validation };
    }
    if (node.kind === "finalize") {
      const latestInspection = await this.dependencies.inspect(run.cwd);
      if (latestInspection.sourceFingerprint !== run.inspection?.sourceFingerprint) {
        return { result: { sourceDrift: true, inspection: latestInspection } };
      }
      const finalization = await this.dependencies.finalize(run.cwd, specForSynthesis(run, synthesisNodeIdFor(node, run)), "wiki", this.now());
      return { result: finalization };
    }
    const role = roleFor(node.kind);
    const researchReceipts = await this.researchReceiptsForNode(node);
    const artifactPaths = researchReceipts?.map((receipt) => receipt.artifactPath);
    const artifactWritePath = await this.artifactWritePathForNode(node);
    return await this.dependencies.executor.execute({
      runId: run.id,
      node: clone(node),
      cwd: run.cwd,
      prompt: await promptFor(node, run, researchReceipts, artifactWritePath),
      role,
      readRoots: readRootsFor(node, run),
      artifactPaths,
      wikiReadPaths: wikiReadPathsFor(node, run),
      artifactWritePath,
      writePaths: writePathsFor(node),
      language: run.language,
      signal,
      validateControlSubmission: node.kind === "synthesis" || node.kind === "review"
        ? (submission) => validateControlSubmission(this.transitionHost(), node, submission)
        : undefined,
      validatePageSubmission: node.kind === "write"
        ? async (page) => {
          const spec = specForSynthesis(run, pagePacketInputFor(node).synthesisNodeId);
          const issues = await this.dependencies.validatePage(run.cwd, spec, page);
          if (issues.length) return { ok: false, issues };
          const sha256 = await hashWikiPage(run.cwd, page);
          if (!sha256) return { ok: false, issues: [{ code: "missing-page", message: `Target page is missing: ${page}` }] };
          return { ok: true, submission: { page, sha256 } };
        }
        : undefined,
      onActivity: (activity, metrics) => this.updateActivity(node.id, activity, metrics),
      onOutput: (output) => this.updateOutput(node.id, output),
      onHistory: (history) => this.updateHistory(node.id, history),
    });
  }

  private async persistNodeHandoff(node: WikiNode, value: unknown): Promise<WikiArtifactRef | undefined> {
    const run = this.requireRun();
    const store = this.requireArtifactStore();
    const kind = artifactKindForNode(node.kind);
    if (!kind) return undefined;
    const location = { runId: run.id, nodeId: node.id, attempt: node.attempt, kind };
    if (node.kind === "inspect" || node.kind === "validate" || node.kind === "finalize") {
      return await store.write({ ...location, content: `${JSON.stringify(value)}\n` });
    }
    if (node.kind === "write") {
      const content = `${JSON.stringify(await writeReport(run.cwd, writePathsFor(node) ?? []))}\n`;
      return await store.write({ ...location, content });
    }
    try {
      return await store.finalize(location);
    } catch (error) {
      // Test executors return parsed results directly. The production executor
      // reads the required artifact before returning, so this fallback cannot
      // hide a missing model-authored handoff in normal operation.
      if (!isMissingArtifactError(error)) throw error;
      const content = JSON.stringify(value);
      if (!content) throw error;
      return await store.write({ ...location, content });
    }
  }

  private async artifactWritePathForNode(node: WikiNode): Promise<string | undefined> {
    const kind = artifactKindForNode(node.kind);
    if (!kind || node.kind === "inspect" || node.kind === "validate" || node.kind === "finalize" || node.kind === "write") return undefined;
    const run = this.requireRun();
    return await this.requireArtifactStore().prepare({ runId: run.id, nodeId: node.id, attempt: node.attempt, kind });
  }

  private async researchReceiptsForNode(node: WikiNode): Promise<PromptResearchReceipt[] | undefined> {
    const run = this.requireRun();
    const researchIds = node.kind === "synthesis"
      ? synthesisInputFor(node).researchIds
      : node.kind === "write" ? pagePacketInputFor(node).researchIds : [];
    if (researchIds.length === 0) return undefined;
    const store = this.requireArtifactStore();
    const receipts: PromptResearchReceipt[] = [];
    for (const researchId of researchIds) {
      const researchNode = run.nodes.find((candidate) => candidate.id === researchId && candidate.kind === "research");
      if (!researchNode || !isResearchReceipt(researchNode.result)) continue;
      const parsedArtifact = parseResearchArtifact(await store.read(researchNode.result.artifact));
      receipts.push({
        scopeId: researchNode.result.scopeId,
        sourcePaths: researchInputFor(researchNode).scope.sourcePaths,
        task: researchNode.result.task,
        artifactPath: store.resolve(researchNode.result.artifact),
        findings: researchFindings(researchNode.result.scopeId, parsedArtifact),
        gaps: parsedArtifact.gaps,
      });
    }
    return receipts.length ? receipts : undefined;
  }

  private ensureArtifactStore(cwd: string): WikiArtifactStore {
    const workspace = path.resolve(cwd);
    if (!this.artifactStore || (!this.hasInjectedArtifactStore && this.artifactStoreWorkspace !== workspace)) {
      this.artifactStore = createWikiArtifactStore({ workspace });
      this.artifactStoreWorkspace = workspace;
    }
    return this.artifactStore;
  }

  private requireArtifactStore(): WikiArtifactStore {
    if (!this.artifactStore) throw new Error("Wiki handoff artifact store is unavailable");
    return this.artifactStore;
  }

  private async copyArtifactsForFork(source: WikiRunSnapshot, branch: WikiRunSnapshot): Promise<void> {
    const store = this.requireArtifactStore();
    const copied = await store.copyRun(source.id, branch.id);
    if (copied.length === 0) return;
    const bySource = new Map(copied.map((ref) => [`${ref.nodeId}\u0000${ref.attempt}\u0000${ref.kind}`, ref]));
    for (const node of branch.nodes) {
      if (node.handoff) {
        const copiedRef = bySource.get(`${node.handoff.nodeId}\u0000${node.handoff.attempt}\u0000${node.handoff.kind}`);
        if (copiedRef) node.handoff = copiedRef;
      }
      if (isResearchReceipt(node.result)) {
        const copiedRef = bySource.get(`${node.result.artifact.nodeId}\u0000${node.result.artifact.attempt}\u0000${node.result.artifact.kind}`);
        if (copiedRef) node.result = { ...node.result, artifact: copiedRef };
      }
    }
  }

  private async reconcileGitInputs(): Promise<boolean> {
    const run = this.requireRun();
    if (!run.inspectionFingerprint) return false;
    const latest = await this.dependencies.inspect(run.cwd);
    if (inspectionFingerprint(latest) === run.inspectionFingerprint) return false;

    const inspectNode = [...run.nodes].reverse().find((node) => node.kind === "inspect"
      && !["invalidated", "cancelled"].includes(node.status));
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

  private archiveAttempt(node: WikiNode): void {
    // Slim archive: metrics + error metadata only — omit heavy result/history/output clones.
    // Handoff refs stay (content-addressed pointers; cheap and useful for UI/recovery).
    node.attemptHistory.push({
      attempt: node.attempt,
      startedAt: node.startedAt,
      finishedAt: node.finishedAt,
      handoff: node.handoff ? clone(node.handoff) : undefined,
      error: node.error ? clone(node.error) : undefined,
      metrics: clone(node.metrics),
    });
  }

  private abortControllers(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  private markTerminalRun(
    status: "succeeded" | "failed" | "blocked",
    message: string,
    nodeId?: string,
    at = this.now(),
    details?: WikiRunSnapshot["blockedDetails"],
  ): void {
    const run = this.requireRun();
    if (isTerminalRun(run)) return;
    run.status = status;
    run.blockedReason = status === "succeeded" ? undefined : message;
    // Succeeded clears diagnostics; blocked/failed keep structured details when provided.
    run.blockedDetails = status === "succeeded" ? undefined : details;
    run.completedAt = at;
    this.pendingTerminalEvent = {
      runId: run.id,
      kind: status === "succeeded" ? "run_completed" : status === "failed" ? "run_failed" : "run_blocked",
      nodeId,
      message,
    };
    if (status !== "succeeded") this.abortControllers();
  }

  private emitPendingTerminalEvent(): void {
    const pending = this.pendingTerminalEvent;
    const run = this.current;
    if (!pending || !run || pending.runId !== run.id) return;
    const expectedStatus = pending.kind === "run_completed" ? "succeeded"
      : pending.kind === "run_failed" ? "failed"
        : "blocked";
    if (run.status !== expectedStatus) {
      this.pendingTerminalEvent = undefined;
      return;
    }
    this.pendingTerminalEvent = undefined;
    this.emit(pending.kind, pending.nodeId, pending.message);
  }

  private failRun(error: unknown): void {
    if (!this.current || this.current.status !== "running") return;
    this.markTerminalRun("failed", errorMessage(error));
    this.emitPendingTerminalEvent();
  }

  private emit(kind: WikiRunEventKind, nodeId?: string, message?: string, data?: Record<string, unknown>): void {
    const run = this.current;
    if (!run) return;
    const event: WikiRunEvent = { id: this.newId(), at: this.now(), kind, nodeId, message, data };
    run.events.push(event);
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    run.updatedAt = event.at;
    // Clone once per emit; all listeners share the same snapshot (do not re-clone per listener).
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

  /** Shared host surface for transition/queue free functions. */
  private transitionHost(): TransitionHost {
    return {
      requireRun: () => this.requireRun(),
      nodeById: (id) => this.nodeById(id),
      now: () => this.now(),
      newId: () => this.newId(),
      emit: (kind, nodeId, message, data) => this.emit(kind, nodeId, message, data),
      markTerminalRun: (status, message, nodeId, at, details) => this.markTerminalRun(status, message, nodeId, at, details),
      materializeIndexes: (cwd, spec) => this.dependencies.materializeIndexes(cwd, spec),
    };
  }
}

/** Structured terminal diagnostics from a classified node failure (budget exhaustion, etc.). */
function terminalDetailsFromFailure(
  error: unknown,
  code: string | undefined,
): WikiRunSnapshot["blockedDetails"] {
  const details: NonNullable<WikiRunSnapshot["blockedDetails"]> = {};
  if (code) details.code = code;
  if (isWikiBudgetExhaustedError(error)) {
    const raw = error instanceof WikiBudgetExhaustedError
      ? error.details
      : (error as { details?: Record<string, unknown> }).details;
    if (raw && typeof raw === "object") {
      const remainingBudget: Record<string, number> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "number" && Number.isFinite(value)) remainingBudget[key] = value;
      }
      if (Object.keys(remainingBudget).length > 0) details.remainingBudget = remainingBudget;
    }
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

export function createWikiWorkflowEngine(options: WikiWorkflowEngineOptions = {}): WikiWorkflowEngine {
  return new WikiWorkflowEngine(options);
}
