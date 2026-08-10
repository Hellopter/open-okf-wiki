import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createWikiArtifactStore, type WikiArtifactKind, type WikiArtifactRef, type WikiArtifactStore } from "./artifact-store.js";
import {
  MAX_RESEARCH_SCOPES_PER_BATCH,
  parseReviewSubmission,
  parseSynthesisSubmission,
} from "./control-submissions.js";
import { createPiAgentExecutor, WikiAgentProtocolError } from "./executor.js";
import { inspectWiki } from "./inspect.js";
import { loadWikiPromptGuidance } from "./prompt-guidance.js";
import { latestPhaseIteration } from "./phase-iterations.js";
import { createWikiRunSession, parseWikiRunSession } from "./session.js";
import { isWikiRunSnapshot } from "./snapshot-validation.js";
import type { WikiInspection, WikiMode, WikiValidation, WikiValidationIssue } from "./types.js";
import { finalizeWiki, validateWiki } from "./validate.js";
import {
  EMPTY_NODE_METRICS,
  type WikiAgentExecutionResult,
  type WikiControlSubmission,
  type WikiNode,
  type WikiNodeActivity,
  type WikiNodeHistoryEntry,
  type WikiNodeKind,
  type WikiNodeMetrics,
  type WikiNodeStatus,
  type WikiSpec,
  type WikiSynthesisResult,
  type WikiResearchReceipt,
  type WikiResearchScope,
  type WikiReviewDefect,
  type WikiRunEvent,
  type WikiRunEventKind,
  type WikiRunRequest,
  type WikiRunSession,
  type WikiRunSnapshot,
  type WikiWorkflowDependencies,
  type WikiWorkflowListener,
} from "./workflow-types.js";

const MAX_NODE_ATTEMPTS = 3;
const MAX_CONCURRENT_WRITERS = 4;
const MAX_LOCAL_REPAIR_ROUNDS_PER_PLAN = 3;
const MAX_STRUCTURAL_RESYNTHESES = 1;
const MAX_SUPPLEMENTAL_RESEARCH_BATCHES = 1;
const MAX_NODE_OUTPUT_CHARS = 48 * 1024;
const MAX_NODE_HISTORY_ENTRIES = 48;
const MAX_NODE_HISTORY_CHARS = 24 * 1024;
const MAX_EVENTS = 200;
const ACTIVITY_EVENT_INTERVAL_MS = 250;
const MISSING_PAGE_SHA256 = "missing";

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

  constructor(options: WikiWorkflowEngineOptions = {}) {
    this.dependencies = {
      inspect: options.inspect ?? inspectWiki,
      validate: options.validate ?? validateWiki,
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
    const inspectionNode = this.newNode("inspect", "Inspect Git scope", [], { requestedMode: request.mode }, { id: "inspect", title: "Inspect" });
    this.current = {
      version: 5,
      id: this.newId(),
      cwd: path.resolve(request.cwd),
      requestedMode: request.mode,
      language: request.language === "en" ? "en" : "zh",
      focus: normalizeText(request.focus),
      status: "running",
      round: 0,
      sourceRestartCount: 0,
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
    const session = isWikiRunSnapshot(serialized)
      ? createWikiRunSession(serialized)
      : parseWikiRunSession(serialized);
    if (!session) return undefined;

    this.ensureArtifactStore(session.snapshot.cwd);
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
    this.ensureArtifactStore(snapshot.cwd);
    this.abortControllers();
    await this.copyArtifactsForFork(snapshot, branch);
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
      const research = runnable.filter((node) => node.kind === "research").slice(0, MAX_RESEARCH_SCOPES_PER_BATCH);
      if (research.length > 0) {
        await Promise.all(research.map(async (node) => await this.executeNode(node)));
        continue;
      }
      const pageWrites = runnable.filter((node) => node.kind === "write").slice(0, MAX_CONCURRENT_WRITERS);
      if (pageWrites.length > 0) {
        await Promise.all(pageWrites.map(async (node) => await this.executeNode(node)));
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
      const handoff = await this.persistNodeHandoff(node, result.result);
      if (handoff) node.handoff = handoff;
      node.result = this.normalizeNodeResult(node, result.result, handoff);
      node.output = retainedOutput(result.output ?? node.output);
      node.history = retainedHistory(result.history ?? node.history);
      node.metrics = mergeMetrics(node.metrics, result.metrics);
      // Dynamic expansion can still reject a result. Keep the node running
      // until all result parsing and downstream queueing has completed.
      await this.afterSuccess(node);
      node.status = "succeeded";
      node.activity = { state: "completed", message: "Completed", updatedAt: this.now() };
      node.finishedAt = this.now();
      this.emit("node_succeeded", node.id, node.label);
    } catch (error) {
      if (node.status !== "running") return;
      const loopBudgetExceeded = isLoopBudgetError(error);
      node.status = controller.signal.aborted ? "cancelled" : loopBudgetExceeded ? "blocked" : "failed";
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
      if (run.status === "running" && loopBudgetExceeded) {
        run.status = "blocked";
        run.blockedReason = node.error.message;
        this.emit("run_blocked", node.id, run.blockedReason);
      } else if (run.status === "running" && node.status === "failed") {
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
      const validation = await this.dependencies.validate(run.cwd, specForSynthesis(run, synthesisNodeIdFor(node, run)));
      return { result: validation };
    }
    if (node.kind === "finalize") {
      const latestInspection = await this.dependencies.inspect(run.cwd);
      if (latestInspection.sourceFingerprint !== run.inspection?.sourceFingerprint) {
        return { result: { sourceDrift: true, inspection: latestInspection } };
      }
      const finalization = await this.dependencies.finalize(run.cwd, specForSynthesis(run, synthesisNodeIdFor(node, run)));
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
        ? (submission) => this.validateControlSubmission(node, submission)
        : undefined,
      onActivity: (activity, metrics) => this.updateActivity(node.id, activity, metrics),
      onOutput: (output) => this.updateOutput(node.id, output),
      onHistory: (history) => this.updateHistory(node.id, history),
    });
  }

  private normalizeNodeResult(node: WikiNode, value: unknown, handoff?: WikiArtifactRef): unknown {
    if (node.kind === "research") {
      if (!handoff || handoff.kind !== "research") throw new Error("Researcher did not produce a research handoff artifact");
      return createResearchReceipt(node, this.requireRun(), value, handoff);
    }
    return normalizeNodeResult(node.kind, value);
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
      const content = node.kind === "research"
        ? typeof value === "string" ? value : undefined
        : JSON.stringify(value);
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
      await store.read(researchNode.result.artifact);
      receipts.push({
        scopeId: researchNode.result.scopeId,
        sourcePaths: researchInputFor(researchNode).scope.sourcePaths,
        task: researchNode.result.task,
        artifactPath: store.resolve(researchNode.result.artifact),
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

  private async afterSuccess(node: WikiNode): Promise<void> {
    const run = this.requireRun();
    switch (node.kind) {
      case "inspect": {
        const inspection = parseInspection(node.result);
        run.inspection = inspection;
        run.effectiveMode = run.requestedMode === "generate" ? "generate" : inspection.mode;
        run.inspectionFingerprint = inspectionFingerprint(inspection);
        this.queueInitialSourceSurveys(node.id, inspection);
        return;
      }
      case "research": {
        const researchInput = researchInputFor(node);
        const siblings = run.nodes.filter((candidate) => candidate.kind === "research" && sameResearchBatch(candidate, researchInput));
        if (siblings.every((candidate) => candidate.id === node.id || candidate.status === "succeeded")) {
          const receiptIds = uniqueStrings([
            ...researchInput.priorResearchIds,
            ...siblings.filter((candidate) => candidate.status === "succeeded" || candidate.id === node.id).map((candidate) => candidate.id),
          ]);
          this.queueSynthesis({
            dependsOn: siblings.map((candidate) => candidate.id),
            researchIds: receiptIds,
            supplementalBatch: researchInput.batch,
            mode: researchInput.continuationMode,
            priorSynthesisNodeId: researchInput.priorSynthesisNodeId,
            structuralRoundId: researchInput.structuralRoundId,
            trigger: researchInput.trigger,
          });
        }
        return;
      }
      case "synthesis": {
        // runNode already parsed the model submission before this transition.
        const synthesis = node.result as WikiSynthesisResult;
        const input = synthesisInputFor(node);
        if (synthesis.decision === "expand") {
          this.ensureSynthesisSubmissionFitsRun(synthesis, input);
          this.queueSupplementalResearch(node.id, synthesis.researchScopes, input);
          return;
        }
        this.ensureSynthesisSubmissionFitsRun(synthesis, input);
        this.queuePageWriters(node.id, synthesis.spec);
        return;
      }
      case "write": {
        const input = pagePacketInputFor(node);
        if (input.intent === "repair" && input.checkNoProgress) {
          const afterSha256 = await hashWikiPage(run.cwd, input.page.path) ?? MISSING_PAGE_SHA256;
          if (afterSha256 === input.beforeSha256) {
            run.status = "blocked";
            run.blockedReason = `Repair made no change to ${input.page.path}`;
            this.emit("run_blocked", node.id, run.blockedReason);
            return;
          }
        }
        const siblings = run.nodes.filter((candidate) => candidate.kind === "write" && valueIs(candidate.input, "writeGroupId", input.writeGroupId));
        if (siblings.every((candidate) => candidate.id === node.id || candidate.status === "succeeded")) {
          this.queueValidation(siblings.map((candidate) => candidate.id), input.synthesisNodeId);
        }
        return;
      }
      case "validate": {
        const validation = parseValidation(node.result);
        node.result = validation;
        const synthesisNodeId = synthesisNodeIdFor(node, run);
        if (validation.ok) {
          this.queueNode("review", "Review Wiki", [node.id], {
            validation,
            synthesisNodeId,
            verificationGroupId: recordValue(node.input, "verificationGroupId"),
          }, { id: "verify", title: "Verify" });
        } else {
          const signature = validationIssuesFingerprint(validation.issues);
          if (signature === this.previousValidationSignature(node.id)) {
            run.status = "blocked";
            run.blockedReason = "Validation produced the same unresolved error set twice";
            this.emit("run_blocked", node.id, run.blockedReason);
            return;
          }
          if (validation.issues.some((issue) => !issue.page)) {
            run.status = "blocked";
            run.blockedReason = "Validation found a global safety issue that cannot be routed to one page";
            this.emit("run_blocked", node.id, run.blockedReason);
            return;
          }
          await this.queuePageRepairs([node.id], synthesisNodeId, validation.issues.map((issue) => issue.page!), { validation });
        }
        return;
      }
      case "review": {
        const review = parseReviewSubmission(node.result);
        node.result = review;
        this.ensureReviewSubmissionFitsRun(node, review);
        if (review.defects.length === 0) {
          this.queueNode("finalize", "Finalize Wiki", [node.id], {
            synthesisNodeId: synthesisNodeIdFor(node, run),
            verificationGroupId: recordValue(node.input, "verificationGroupId"),
          }, { id: "verify", title: "Verify" });
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
        const synthesisNodeId = synthesisNodeIdFor(node, run);
        const routedReview = routeReviewDefects(review, specForSynthesis(run, synthesisNodeId));
        const structural = review.defects.some((defect) => defect.kind === "topology" || defect.kind === "coverage");
        if (structural) {
          const resyntheses = new Set(run.nodes
            .filter((candidate) => candidate.kind === "synthesis" && candidate.status !== "invalidated" && candidate.status !== "cancelled")
            .map((candidate) => synthesisInputFor(candidate))
            .filter((input) => input.mode === "structural" && input.structuralRoundId)
            .map((input) => input.structuralRoundId)).size;
          if (resyntheses >= MAX_STRUCTURAL_RESYNTHESES) {
            run.status = "blocked";
            run.blockedReason = `Structural review exceeded the ${MAX_STRUCTURAL_RESYNTHESES}-resynthesis budget`;
            this.emit("run_blocked", node.id, run.blockedReason);
            return;
          }
          this.queueStructuralSynthesis(node.id, synthesisNodeId, routedReview);
        } else await this.queuePageRepairs(
          [node.id],
          synthesisNodeId,
          review.defects.flatMap((defect) => "page" in defect ? [defect.page] : []),
          { review: routedReview },
        );
        return;
      }
      case "finalize": {
        if (isSourceDriftResult(node.result)) {
          if (run.sourceRestartCount >= 1) {
            run.status = "blocked";
            run.blockedReason = "Source fingerprint changed twice during this Wiki run";
            this.emit("run_blocked", node.id, run.blockedReason);
            return;
          }
          run.sourceRestartCount += 1;
          for (const candidate of run.nodes) {
            if (candidate.id === node.id || candidate.status === "cancelled") continue;
            candidate.status = "invalidated";
            candidate.activity = { state: "idle", message: "Invalidated by source drift restart", updatedAt: this.now() };
          }
          run.inspection = undefined;
          run.inspectionFingerprint = undefined;
          this.queueNode("inspect", "Re-inspect Git scope", [], { requestedMode: run.requestedMode, sourceRestart: run.sourceRestartCount }, { id: "inspect", title: "Inspect" });
          return;
        }
        run.status = "succeeded";
        run.completedAt = this.now();
        this.emit("run_completed", undefined, "Wiki validation, review, and finalization passed");
        return;
      }
    }
  }

  private queueInitialSourceSurveys(inspectNodeId: string, inspection: WikiInspection): WikiNode[] {
    const sourcePaths = uniqueStrings(inspection.sourcePaths);
    if (sourcePaths.length === 0) throw new Error("Inspect returned no declared source paths");
    const scopes: WikiResearchScope[] = sourcePaths.map((sourcePath) => ({
        id: `source-survey:${sourcePath}`,
        sourcePaths: [sourcePath],
        task: `Survey ${sourcePath}: identify responsibilities, entry points, verified flows, relationships, and state/data evidence within this source only.`,
      }));
    return this.queueResearch(inspectNodeId, scopes, 0, "research", "Research");
  }

  private queueSupplementalResearch(synthesisNodeId: string, scopes: WikiResearchScope[], parent: SynthesisNodeInput): WikiNode[] {
    return this.queueResearch(
      synthesisNodeId,
      scopes,
      1,
      "research",
      "Research",
      parent.mode === "structural" ? "structural" : "supplemental",
      parent.priorSynthesisNodeId,
      parent.structuralRoundId,
      parent.trigger,
      parent.researchIds,
    );
  }

  private queueResearch(
    dependsOn: string,
    scopes: WikiResearchScope[],
    batch: number,
    phaseId: "research",
    phaseTitle: "Research",
    continuationMode: ResearchNodeInput["continuationMode"] = "initial",
    priorSynthesisNodeId?: string,
    structuralRoundId?: string,
    trigger?: unknown,
    priorResearchIds: string[] = [],
  ): WikiNode[] {
    const researchGroupId = `${phaseId}:${this.newId()}`;
    return scopes.map((scope) => this.queueNode(
      "research",
      batch === 0 ? `Survey: ${scope.id}` : `Research: ${scope.id}`,
      [dependsOn],
      { batch, scope, continuationMode, priorSynthesisNodeId, structuralRoundId, trigger, researchGroupId, priorResearchIds },
      { id: phaseId, title: phaseTitle },
    ));
  }

  private queueSynthesis(input: QueueSynthesisInput): WikiNode | undefined {
    const run = this.requireRun();
    const existing = run.nodes.find((node) => node.kind === "synthesis"
      && sameStringSet(synthesisInputFor(node).researchIds, input.researchIds)
      && synthesisInputFor(node).mode === input.mode
      && !["invalidated", "cancelled", "failed", "blocked"].includes(node.status));
    if (existing) return undefined;
    run.round += 1;
    const structural = input.mode === "structural";
    return this.queueNode(
      "synthesis",
      structural ? "Re-synthesize Wiki Structure" : input.supplementalBatch === 0 ? "Synthesize Wiki Spec" : "Re-synthesize Wiki Spec",
      input.dependsOn,
      { ...input, round: run.round, inspection: run.inspection, focus: run.focus },
      { id: "plan", title: "Plan" },
    );
  }

  private queueStructuralSynthesis(reviewNodeId: string, synthesisNodeId: string, review: unknown): WikiNode | undefined {
    const researchIds = this.requireRun().nodes
      .filter((node) => node.kind === "research" && node.status === "succeeded" && isResearchReceipt(node.result))
      .map((node) => node.id);
    return this.queueSynthesis({
      dependsOn: [reviewNodeId],
      researchIds,
      supplementalBatch: this.hasSupplementalResearch() ? 1 : 0,
      mode: "structural",
      priorSynthesisNodeId: synthesisNodeId,
      structuralRoundId: reviewNodeId,
      trigger: { validation: recordValue(this.nodeById(reviewNodeId)?.input, "validation"), review },
    });
  }

  private queuePageWriters(synthesisNodeId: string, spec: WikiSpec): WikiNode[] {
    const run = this.requireRun();
    const synthesisNode = run.nodes.find((node) => node.id === synthesisNodeId);
    if (!synthesisNode) throw new Error(`Unknown synthesis node: ${synthesisNodeId}`);
    const researchIdsForSynthesis = new Set(synthesisInputFor(synthesisNode).researchIds);
    const researchNodes = run.nodes.filter((node) => node.kind === "research" && node.status === "succeeded" && researchIdsForSynthesis.has(node.id));
    const overview = overviewPage(spec);
    const contentPages = specPages(spec).filter(({ page }) => page.pageType !== "overview");
    const synthesisMode = synthesisInputFor(synthesisNode).mode;
    const selected = contentPages.filter(({ page }) => shouldWriteContentPage(run, page.path, synthesisMode));
    const selectedPaths = new Set(selected.map(({ page }) => page.path));
    const retainedPaths = new Set((run.inspection?.existingPages ?? []).map(normalizePagePath).filter((pagePath) => !selectedPaths.has(pagePath)));
    const writeGroupId = `write:${this.newId()}`;
    const phase = { id: "write", title: "Write" };
    const nodes = selected.map(({ domain, page }) => {
      const researchIds = page.researchScopeIds.map((scopeId) => {
        const research = researchNodes.find((candidate) => isResearchReceipt(candidate.result) && candidate.result.scopeId === scopeId);
        if (!research) throw new Error(`No completed research receipt exists for page ${page.path} scope ${scopeId}`);
        return research.id;
      });
      return this.queueNode(
        "write",
        `Write page: ${page.path}`,
        [synthesisNodeId, ...researchIds],
        {
          intent: "draft",
          synthesisNodeId,
          domainId: domain.id,
          page,
          researchIds,
          writePaths: [workspaceWikiPath(page.path)],
          wikiReadPaths: relatedWikiPaths(spec, page.path, run.effectiveMode === "refresh" ? retainedPaths : new Set()),
          writeGroupId,
          feedback: synthesisMode === "structural" ? structuralFeedbackForPage(synthesisInputFor(synthesisNode).trigger, page.path) : undefined,
        },
        phase,
      );
    });
    const overviewNode = this.queueNode(
      "write",
      "Write Overview",
      nodes.length ? nodes.map((node) => node.id) : [synthesisNodeId],
      {
        intent: "overview",
        synthesisNodeId,
        domainId: overview.domain.id,
        page: overview.page,
        researchIds: [],
        writePaths: [workspaceWikiPath(overview.page.path)],
        wikiReadPaths: contentPages.map(({ page }) => workspaceWikiPath(page.path)),
        writeGroupId,
        feedback: synthesisMode === "structural" ? structuralFeedbackForPage(synthesisInputFor(synthesisNode).trigger, overview.page.path) : undefined,
      },
      phase,
    );
    return [...nodes, overviewNode];
  }

  private queueValidation(sourceNodeIds: string[], synthesisNodeId: string): WikiNode | undefined {
    const verificationGroupId = sourceNodeIds
      .map((id) => this.nodeById(id))
      .filter((candidate): candidate is WikiNode => candidate?.kind === "write")
      .map((candidate) => pagePacketInputFor(candidate).writeGroupId)[0] ?? `verify:${this.newId()}`;
    const existing = this.requireRun().nodes.find((node) => node.kind === "validate"
      && valueIs(node.input, "synthesisNodeId", synthesisNodeId)
      && sameStringSet(recordStringArray(node.input, "sourceNodeIds"), sourceNodeIds)
      && !["invalidated", "cancelled", "failed", "blocked"].includes(node.status));
    if (existing) return undefined;
    return this.queueNode("validate", "Validate Wiki", sourceNodeIds, { sourceNodeIds, synthesisNodeId, verificationGroupId }, { id: "verify", title: "Verify" });
  }

  private async queuePageRepairs(
    dependsOn: string[],
    synthesisNodeId: string,
    pagePaths: string[],
    input: Record<string, unknown>,
  ): Promise<WikiNode[]> {
    const run = this.requireRun();
    const spec = specForSynthesis(this.requireRun(), synthesisNodeId);
    const synthesisNode = this.nodeById(synthesisNodeId);
    if (!synthesisNode) throw new Error(`Unknown synthesis node: ${synthesisNodeId}`);
    const previousRounds = new Set(run.nodes
      .filter((candidate) => candidate.kind === "write")
      .map((candidate) => safePagePacketInput(candidate))
      .filter((packet): packet is PagePacketInput => packet?.intent === "repair" && packet.synthesisNodeId === synthesisNodeId)
      .map((packet) => packet.writeGroupId)).size;
    if (previousRounds >= MAX_LOCAL_REPAIR_ROUNDS_PER_PLAN) {
      run.status = "blocked";
      run.blockedReason = `Local repair exceeded the ${MAX_LOCAL_REPAIR_ROUNDS_PER_PLAN}-round budget for this Plan`;
      this.emit("run_blocked", dependsOn[0], run.blockedReason);
      return [];
    }
    const requested = new Set(pagePaths.map(normalizePagePath));
    const targets = specPages(spec).filter(({ page }) => requested.has(page.path));
    if (targets.length !== requested.size) throw new Error("Repair targets a page outside the current WikiSpec");
    const overview = overviewPage(spec);
    const writeGroupId = `repair:${this.newId()}`;
    const phase = { id: "write", title: "Write" };
    const contentNodes: WikiNode[] = [];
    for (const { domain, page } of targets.filter(({ page }) => page.pageType !== "overview")) {
      const researchIds = researchIdsForPage(run, page);
      const beforeSha256 = await hashWikiPage(run.cwd, page.path) ?? MISSING_PAGE_SHA256;
      contentNodes.push(this.queueNode(
        "write",
        `Repair page: ${page.path}`,
        dependsOn,
        {
          intent: "repair",
          synthesisNodeId,
          domainId: domain.id,
          page,
          researchIds,
          writePaths: [workspaceWikiPath(page.path)],
          wikiReadPaths: relatedWikiPaths(spec, page.path, new Set(specPages(spec).map(({ page: candidate }) => candidate.path).filter((candidate) => !requested.has(candidate)))),
          writeGroupId,
          repairRound: previousRounds + 1,
          feedback: repairInputForPage(input, page.path),
          beforeSha256,
          checkNoProgress: true,
        },
        phase,
      ));
    }
    const overviewIsTarget = requested.has(overview.page.path);
    const overviewBeforeSha256 = overviewIsTarget
      ? await hashWikiPage(run.cwd, overview.page.path) ?? MISSING_PAGE_SHA256
      : undefined;
    const overviewNode = this.queueNode(
      "write",
      overviewIsTarget ? "Repair Overview" : "Refresh Overview",
      contentNodes.length ? contentNodes.map((candidate) => candidate.id) : dependsOn,
      {
        intent: "repair",
        synthesisNodeId,
        domainId: overview.domain.id,
        page: overview.page,
        researchIds: [],
        writePaths: [workspaceWikiPath(overview.page.path)],
        wikiReadPaths: specPages(spec).filter(({ page }) => page.pageType !== "overview").map(({ page }) => workspaceWikiPath(page.path)),
        writeGroupId,
        repairRound: previousRounds + 1,
        feedback: overviewIsTarget ? repairInputForPage(input, overview.page.path) : { reason: "Regenerate Overview after content page repair" },
        beforeSha256: overviewBeforeSha256,
        checkNoProgress: overviewIsTarget,
      },
      phase,
    );
    return [...contentNodes, overviewNode];
  }

  private hasSupplementalResearch(): boolean {
    return this.requireRun().nodes.some((node) => node.kind === "research"
      && !["invalidated", "cancelled"].includes(node.status)
      && researchInputFor(node).batch > 0);
  }

  /** Validate control data against this run before a submit tool records it. */
  private validateControlSubmission(node: WikiNode, submission: WikiControlSubmission): void {
    if (node.kind === "synthesis") {
      this.ensureSynthesisSubmissionFitsRun(submission as WikiSynthesisResult, synthesisInputFor(node));
      return;
    }
    if (node.kind === "review") this.ensureReviewSubmissionFitsRun(node, submission as ReturnType<typeof parseReviewSubmission>);
  }

  private ensureSynthesisSubmissionFitsRun(synthesis: WikiSynthesisResult, input: SynthesisNodeInput): void {
    if (synthesis.decision === "expand") {
      if (this.hasSupplementalResearch()) {
        throw new Error(`Synthesis may request at most ${MAX_SUPPLEMENTAL_RESEARCH_BATCHES} supplemental research batch per run`);
      }
      this.ensureNewResearchScopes(synthesis.researchScopes);
      this.ensureResearchSourcePaths(synthesis.researchScopes);
      return;
    }
    this.ensureSynthesisSpecReceipts(synthesis.spec, input);
  }

  private ensureReviewSubmissionFitsRun(node: WikiNode, review: ReturnType<typeof parseReviewSubmission>): void {
    const synthesisNodeId = synthesisNodeIdFor(node, this.requireRun());
    ensureReviewTargets(review.defects, specForSynthesis(this.requireRun(), synthesisNodeId));
  }

  private ensureNewResearchScopes(scopes: WikiResearchScope[]): void {
    const existingIds = new Set(this.requireRun().nodes
      .filter((node) => node.kind === "research" && !["invalidated", "cancelled"].includes(node.status))
      .map((node) => researchInputFor(node).scope.id));
    for (const scope of scopes) {
      if (existingIds.has(scope.id)) throw new Error(`Supplemental research scope repeats existing scope: ${scope.id}`);
    }
  }

  private ensureResearchSourcePaths(scopes: WikiResearchScope[]): void {
    const allowed = new Set(this.requireRun().inspection?.sourcePaths ?? []);
    for (const scope of scopes) {
      for (const sourcePath of scope.sourcePaths) {
        if (!allowed.has(sourcePath)) throw new Error(`Supplemental research scope ${scope.id} targets undeclared source: ${sourcePath}`);
      }
    }
  }

  private ensureSynthesisSpecReceipts(spec: WikiSpec, input: SynthesisNodeInput): void {
    const receiptIds = new Set(input.researchIds
      .map((nodeId) => this.requireRun().nodes.find((node) => node.id === nodeId)?.result)
      .filter((result): result is WikiResearchReceipt => isResearchReceipt(result))
      .map((receipt) => receipt.scopeId));
    for (const domain of spec.domains) {
      for (const page of domain.pages) {
        for (const scopeId of page.researchScopeIds) {
          if (!receiptIds.has(scopeId)) throw new Error(`WikiSpec page ${page.path} references unknown research scope: ${scopeId}`);
        }
      }
    }
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

  private previousReviewSignature(currentNodeId: string): string | undefined {
    const reviews = this.requireRun().nodes
      .filter((node) => node.kind === "review" && node.id !== currentNodeId && node.status === "succeeded")
      .map((node) => parseReviewSubmission(node.result));
    const latest = reviews.at(-1);
    return latest ? defectsFingerprint(latest.defects) : undefined;
  }

  private previousValidationSignature(currentNodeId: string): string | undefined {
    const validations = this.requireRun().nodes
      .filter((node) => node.kind === "validate" && node.id !== currentNodeId && node.status === "succeeded")
      .map((node) => parseValidation(node.result))
      .filter((validation) => !validation.ok);
    const latest = validations.at(-1);
    return latest ? validationIssuesFingerprint(latest.issues) : undefined;
  }

  private archiveAttempt(node: WikiNode): void {
    node.attemptHistory.push({
      attempt: node.attempt,
      startedAt: node.startedAt,
      finishedAt: node.finishedAt,
      result: clone(node.result),
      output: node.output,
      history: node.history ? clone(node.history) : undefined,
      handoff: node.handoff ? clone(node.handoff) : undefined,
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
  const explicit = latestPhaseIteration(run.nodes, phaseId);
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

/** Retry only independent roots; successful roots deterministically derive the rest of the phase. */
function phaseRetryRoots(nodes: WikiNode[]): WikiNode[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const roots = nodes.filter((node) => !node.dependsOn.some((dependency) => nodeIds.has(dependency)));
  return roots.length ? roots : [nodes[0]!];
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
  node.handoff = undefined;
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
    case "research": return "Research";
    case "synthesis": return "Synthesis";
    case "write": return "Write";
    case "validate": return "Validate";
    case "review": return "Review";
    case "finalize": return "Finalize";
  }
}

function isTerminalRun(snapshot: WikiRunSnapshot): boolean {
  return snapshot.status === "succeeded" || snapshot.status === "failed" || snapshot.status === "blocked" || snapshot.status === "cancelled";
}

function roleFor(kind: WikiNodeKind): "researcher" | "synthesizer" | "writer" | "reviewer" {
  if (kind === "research") return "researcher";
  if (kind === "synthesis") return "synthesizer";
  if (kind === "write") return "writer";
  if (kind === "review") return "reviewer";
  throw new Error(`Node ${kind} is not agent-executed`);
}

function artifactKindForNode(kind: WikiNodeKind): WikiArtifactKind | undefined {
  if (kind === "inspect") return "inspection";
  if (kind === "research") return "research";
  if (kind === "synthesis") return "synthesis";
  if (kind === "validate") return "validation";
  if (kind === "review") return "review";
  if (kind === "write") return "write_report";
  if (kind === "finalize") return "finalization";
  return undefined;
}

async function promptFor(
  node: WikiNode,
  run: WikiRunSnapshot,
  researchReceipts: PromptResearchReceipt[] | undefined,
  artifactWritePath: string | undefined,
): Promise<string> {
  const guidance = await loadWikiPromptGuidance(
    node.kind,
    run.language,
    node.kind === "write" ? { pageTypes: pageTypesFor(node, run) } : undefined,
  );
  switch (node.kind) {
    case "research":
      return `${guidance}\n\n## Assigned Scope\n\`\`\`json\n${prettyJson(researchInputFor(node).scope)}\n\`\`\`\n\n${artifactWriteContext(artifactWritePath, "Markdown research receipt")}`;
    case "synthesis":
      return `${guidance}\n\n${synthesisContext(node, run, researchReceipts)}\n\n${artifactWriteContext(artifactWritePath, "JSON synthesis decision")}`;
    case "write": {
      const packet = pagePacketInputFor(node);
      const repair = packet.feedback !== undefined
        ? `\n\n## Writing Feedback\n\`\`\`json\n${prettyJson(writerFeedbackForPrompt(packet.feedback))}\n\`\`\``
        : "";
      return `${guidance}\n\n${pageWriterContext(node, run, researchReceipts)}${repair}`;
    }
    case "review":
      return `${guidance}\n\n${reviewContext(node, run)}\n\n${artifactWriteContext(artifactWritePath, "JSON review result")}`;
    default:
      throw new Error(`No prompt available for ${node.kind}`);
  }
}

function pageWriterContext(node: WikiNode, run: WikiRunSnapshot, researchReceipts: PromptResearchReceipt[] | undefined): string {
  const input = pagePacketInputFor(node);
  const synthesis = run.nodes.find((candidate) => candidate.id === input.synthesisNodeId)?.result;
  const spec = isSynthesisFinalizeResult(synthesis) ? synthesis.spec : undefined;
  const domain = spec?.domains.find((candidate) => candidate.id === input.domainId);
  const sections = [
    "## Page Packet",
    "```json",
    prettyJson({
      intent: input.intent,
      domain: domain ? { id: domain.id, title: domain.title, purpose: domain.purpose } : undefined,
      page: input.page,
      sharedTerms: spec?.sharedTerms ?? [],
      outgoingCrossLinks: spec?.crossLinks
        .filter((link) => link.fromPath === input.page.path)
        .map((link) => ({ ...link, href: relativeWikiHref(input.page.path, link.toPath) })) ?? [],
      incomingCrossLinks: spec?.crossLinks.filter((link) => link.toPath === input.page.path) ?? [],
      researchReceipts: researchReceipts ?? [],
      sourceRoots: readRootsFor(node, run) ?? [],
      wikiReadPaths: input.wikiReadPaths,
      writePaths: input.writePaths,
    }),
    "```",
  ];
  return sections.join("\n");
}

function pageTypesFor(node: WikiNode, _run: WikiRunSnapshot): Array<"overview" | "architecture" | "module" | "flow" | "concept"> {
  return [pagePacketInputFor(node).page.pageType];
}

function synthesisContext(node: WikiNode, run: WikiRunSnapshot, researchReceipts: PromptResearchReceipt[] | undefined): string {
  const input = synthesisInputFor(node);
  const inspection = input.inspection ?? run.inspection;
  const sections = [
    "## Workspace Context",
    "```json",
    prettyJson({
      mode: run.effectiveMode ?? run.requestedMode,
      focus: input.focus ?? run.focus,
      sourcePaths: inspection?.sourcePaths ?? [],
      existingPages: inspection?.existingPages ?? [],
      impactedPages: inspection?.impactedPages ?? [],
      changedPaths: inspection?.changedPaths ?? [],
    }),
    "```",
  ];
  if (input.mode === "structural") {
    if (!input.priorSynthesisNodeId) throw new Error("Structural synthesis has no prior finalized WikiSpec");
    sections.push(
      "## Prior Final WikiSpec",
      "```json",
      prettyJson(specForSynthesis(run, input.priorSynthesisNodeId)),
      "```",
      "## Structural Validation And Review Trigger",
      "```json",
      prettyJson(structuralTriggerForPrompt(input.trigger)),
      "```",
    );
  }
  sections.push(
    "## Available Research Receipts",
    "Use only the exact `scopeId` values below in page `researchScopeIds`. Read every selected `artifactPath` before planning that page.",
    "```json",
    prettyJson(researchReceipts ?? []),
    "```",
    "## Synthesis Round",
    "```json",
    prettyJson({ mode: input.mode, supplementalBatch: input.supplementalBatch, maxSupplementalBatches: MAX_SUPPLEMENTAL_RESEARCH_BATCHES }),
    "```",
  );
  return sections.join("\n");
}

function artifactWriteContext(path: string | undefined, description: string): string {
  if (!path) throw new Error(`No handoff artifact path is configured for ${description}`);
  return [
    "## Required Handoff Artifact",
    `Write the completed ${description} to this exact workspace-local path before finishing: \`${path}\``,
    "Do not use another path. The workflow records only this artifact.",
  ].join("\n");
}

function reviewContext(node: WikiNode, run: WikiRunSnapshot): string {
  const synthesisNodeId = synthesisNodeIdFor(node, run);
  return [
    "## Review Scope",
    `Focus: ${run.focus ?? "none"}`,
    "## Final WikiSpec",
    "```json",
    prettyJson(specForSynthesis(run, synthesisNodeId)),
    "```",
    "## Validation Context",
    "```json",
    prettyJson(recordValue(node.input, "validation")),
    "```",
  ].join("\n");
}

function writerFeedbackForPrompt(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (Array.isArray(value.defects)) return { defects: value.defects.map(publicReviewDefect).filter(Boolean) };
  if (isRecord(value.review) && Array.isArray(value.review.defects)) {
    return { review: { defects: value.review.defects.map(publicReviewDefect).filter(Boolean) } };
  }
  if (isRecord(value.validation) && Array.isArray(value.validation.issues)) {
    return { validation: { issues: value.validation.issues.map(publicValidationIssue).filter(Boolean) } };
  }
  if (typeof value.reason === "string") return { reason: value.reason };
  return {};
}

function structuralTriggerForPrompt(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const trigger: Record<string, unknown> = {};
  if (isRecord(value.validation) && Array.isArray(value.validation.issues)) {
    trigger.validation = { issues: value.validation.issues.map(publicValidationIssue).filter(Boolean) };
  }
  if (isRecord(value.review) && Array.isArray(value.review.defects)) {
    trigger.review = {
      summary: typeof value.review.summary === "string" ? value.review.summary : undefined,
      defects: value.review.defects.map(publicReviewDefect).filter(Boolean),
    };
  }
  return trigger;
}

function publicReviewDefect(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.detail !== "string") return undefined;
  return typeof value.page === "string"
    ? { kind: value.kind, page: value.page, detail: value.detail }
    : { kind: value.kind, detail: value.detail };
}

function publicValidationIssue(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  return typeof value.page === "string"
    ? { code: value.code, page: value.page, message: value.message }
    : { code: value.code, message: value.message };
}

/** Validate control submissions and local service results before publishing node state. */
function normalizeNodeResult(kind: WikiNodeKind, value: unknown): unknown {
  switch (kind) {
    case "inspect":
      return parseInspection(value);
    case "synthesis":
      return parseSynthesisSubmission(value);
    case "validate":
      return parseValidation(value);
    case "review":
      return parseReviewSubmission(value);
    case "finalize":
      return value;
    case "research":
    case "write":
      return value;
  }
}

function parseInspection(value: unknown): WikiInspection {
  if (!isRecord(value) || typeof value.root !== "string" || typeof value.sourceFingerprint !== "string"
    || !isStringArray(value.sourcePaths) || value.sourcePaths.length === 0
    || (value.mode !== "generate" && value.mode !== "refresh")) {
    throw new Error("Inspect returned an invalid Wiki inspection");
  }
  return {
    ...value,
    sourcePaths: uniqueStrings(value.sourcePaths),
    existingPages: isStringArray(value.existingPages) ? uniqueStrings(value.existingPages).sort() : [],
  } as WikiInspection;
}

function parseValidation(value: unknown): WikiValidation {
  if (!isRecord(value) || typeof value.ok !== "boolean" || !Array.isArray(value.issues) || !value.issues.every(isValidationIssue)
    || !isStringArray(value.pages) || !isStringArray(value.obsoletePages)) {
    throw new Error("Validator returned an invalid result");
  }
  return {
    ok: value.ok,
    issues: value.issues.map((issue) => ({ code: issue.code, page: issue.page, message: issue.message })),
    pages: [...value.pages],
    obsoletePages: [...value.obsoletePages],
  };
}

function isValidationIssue(value: unknown): value is WikiValidationIssue {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string"
    && (value.page === undefined || typeof value.page === "string");
}

function createResearchReceipt(node: WikiNode, run: WikiRunSnapshot, value: unknown, artifact: WikiArtifactRef): WikiResearchReceipt {
  const scope = researchInputFor(node).scope;
  if (typeof value !== "string" || !value.trim()) throw new Error("Researcher must return a Markdown receipt");
  return {
    scopeId: scope.id,
    task: scope.task,
    sourceFingerprint: run.inspection?.sourceFingerprint ?? "unknown",
    artifact,
  };
}

interface ResearchNodeInput {
  batch: number;
  scope: WikiResearchScope;
  researchGroupId: string;
  priorResearchIds: string[];
  continuationMode: "initial" | "supplemental" | "structural";
  priorSynthesisNodeId?: string;
  structuralRoundId?: string;
  trigger?: unknown;
}

interface PromptResearchReceipt {
  scopeId: string;
  sourcePaths: string[];
  task: string;
  artifactPath: string;
}

interface SynthesisNodeInput {
  researchIds: string[];
  supplementalBatch: number;
  mode: "initial" | "supplemental" | "structural";
  round: number;
  inspection?: WikiInspection;
  focus?: string;
  priorSynthesisNodeId?: string;
  structuralRoundId?: string;
  trigger?: unknown;
}

interface QueueSynthesisInput {
  dependsOn: string[];
  researchIds: string[];
  supplementalBatch: number;
  mode: SynthesisNodeInput["mode"];
  priorSynthesisNodeId?: string;
  structuralRoundId?: string;
  trigger?: unknown;
}

interface PagePacketInput {
  intent: "draft" | "overview" | "repair";
  synthesisNodeId: string;
  domainId: string;
  page: WikiSpec["domains"][number]["pages"][number];
  researchIds: string[];
  writePaths: string[];
  wikiReadPaths: string[];
  writeGroupId: string;
  repairRound?: number;
  feedback?: unknown;
  beforeSha256?: string;
  checkNoProgress?: boolean;
}

function researchInputFor(node: WikiNode): ResearchNodeInput {
  const input = node.input;
  if (!isRecord(input) || !Number.isInteger(input.batch) || input.batch < 0
    || (input.continuationMode !== "initial" && input.continuationMode !== "supplemental" && input.continuationMode !== "structural")
    || !isRecord(input.scope)
    || typeof input.scope.id !== "string" || !input.scope.id.trim() || typeof input.scope.task !== "string" || !input.scope.task.trim()
    || !Array.isArray(input.scope.sourcePaths) || input.scope.sourcePaths.length === 0 || !input.scope.sourcePaths.every((value) => typeof value === "string" && value.trim())
    || typeof input.researchGroupId !== "string" || !input.researchGroupId
    || !Array.isArray(input.priorResearchIds) || !input.priorResearchIds.every((value) => typeof value === "string")) {
    throw new Error("Research node has an invalid input");
  }
  return {
    batch: input.batch,
    scope: { id: input.scope.id, sourcePaths: uniqueStrings(input.scope.sourcePaths), task: input.scope.task },
    researchGroupId: input.researchGroupId,
    priorResearchIds: [...input.priorResearchIds],
    continuationMode: input.continuationMode,
    priorSynthesisNodeId: typeof input.priorSynthesisNodeId === "string" ? input.priorSynthesisNodeId : undefined,
    structuralRoundId: typeof input.structuralRoundId === "string" ? input.structuralRoundId : undefined,
    trigger: input.trigger,
  };
}

function sameResearchBatch(node: WikiNode, expected: ResearchNodeInput): boolean {
  try {
    const input = researchInputFor(node);
    return input.researchGroupId === expected.researchGroupId;
  } catch {
    return false;
  }
}

function synthesisInputFor(node: WikiNode): SynthesisNodeInput {
  const input = node.input;
  if (!isRecord(input) || !Number.isInteger(input.supplementalBatch) || input.supplementalBatch < 0 || !Number.isInteger(input.round)
    || (input.mode !== "initial" && input.mode !== "supplemental" && input.mode !== "structural")
    || !Array.isArray(input.researchIds) || !input.researchIds.every((id) => typeof id === "string")) {
    throw new Error("Synthesis node has an invalid input");
  }
  return {
    researchIds: [...input.researchIds],
    supplementalBatch: input.supplementalBatch,
    mode: input.mode,
    round: input.round,
    inspection: isRecord(input.inspection) ? input.inspection as WikiInspection : undefined,
    focus: typeof input.focus === "string" ? input.focus : undefined,
    priorSynthesisNodeId: typeof input.priorSynthesisNodeId === "string" ? input.priorSynthesisNodeId : undefined,
    structuralRoundId: typeof input.structuralRoundId === "string" ? input.structuralRoundId : undefined,
    trigger: input.trigger,
  };
}

function pagePacketInputFor(node: WikiNode): PagePacketInput {
  const input = node.input;
  if (!isRecord(input) || (input.intent !== "draft" && input.intent !== "overview" && input.intent !== "repair")
    || typeof input.synthesisNodeId !== "string" || typeof input.domainId !== "string" || !isSpecPage(input.page)
    || !Array.isArray(input.researchIds) || !input.researchIds.every((id) => typeof id === "string")
    || !Array.isArray(input.writePaths) || input.writePaths.length !== 1 || !input.writePaths.every((value) => typeof value === "string")
    || !Array.isArray(input.wikiReadPaths) || !input.wikiReadPaths.every((value) => typeof value === "string")
    || typeof input.writeGroupId !== "string" || !input.writeGroupId
    || (input.checkNoProgress === true && typeof input.beforeSha256 !== "string")) {
    throw new Error(`${node.kind} node has an invalid page packet`);
  }
  return {
    intent: input.intent,
    synthesisNodeId: input.synthesisNodeId,
    domainId: input.domainId,
    page: clone(input.page),
    researchIds: [...input.researchIds],
    writePaths: [...input.writePaths],
    wikiReadPaths: [...input.wikiReadPaths],
    writeGroupId: input.writeGroupId,
    repairRound: typeof input.repairRound === "number" ? input.repairRound : undefined,
    feedback: input.feedback,
    beforeSha256: typeof input.beforeSha256 === "string" ? input.beforeSha256 : undefined,
    checkNoProgress: input.checkNoProgress === true,
  };
}

function safePagePacketInput(node: WikiNode): PagePacketInput | undefined {
  try {
    return pagePacketInputFor(node);
  } catch {
    return undefined;
  }
}

function writePathsFor(node: WikiNode): string[] | undefined {
  if (node.kind !== "write") return undefined;
  return pagePacketInputFor(node).writePaths;
}

/** Every agent receives only the source roots needed for its assigned work. */
function readRootsFor(node: WikiNode, run: WikiRunSnapshot): string[] | undefined {
  if (node.kind === "research") return researchInputFor(node).scope.sourcePaths;
  if (node.kind === "write") {
    const input = pagePacketInputFor(node);
    if (input.page.pageType === "overview") return run.inspection?.sourcePaths;
    return uniqueStrings(input.researchIds.flatMap((researchId) => {
      const research = run.nodes.find((candidate) => candidate.id === researchId);
      return research?.kind === "research" ? researchInputFor(research).scope.sourcePaths : [];
    }));
  }
  if (node.kind === "review") return run.inspection?.sourcePaths;
  return undefined;
}

/** Wiki reads are exact files, never directory-wide access. */
function wikiReadPathsFor(node: WikiNode, run: WikiRunSnapshot): string[] | undefined {
  if (node.kind === "write") return pagePacketInputFor(node).wikiReadPaths;
  if (node.kind === "synthesis" && run.effectiveMode === "refresh") {
    return (run.inspection?.existingPages ?? []).map(workspaceWikiPath);
  }
  if (node.kind !== "review") return undefined;
  const validation = parseValidation(recordValue(node.input, "validation"));
  const spec = specForSynthesis(run, synthesisNodeIdFor(node, run));
  return uniqueStrings([
    ...specPages(spec).map(({ page }) => workspaceWikiPath(page.path)),
    ...validation.obsoletePages.map(workspaceWikiPath),
  ]);
}

/** Coordinator-authored evidence of the exact pages a writer was assigned. */
async function writeReport(
  cwd: string,
  paths: string[],
): Promise<{ pages: Array<{ path: string; state: "present"; sha256: string; sizeBytes: number } | { path: string; state: "missing" }> }> {
  const workspace = path.resolve(cwd);
  const pages = await Promise.all(paths.map(async (relativePath) => {
    const segments = relativePath.split(/[\\/]/);
    if (segments[0] !== "wiki" || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error(`Writer report path escapes workspace: ${relativePath}`);
    }
    const absolutePath = path.resolve(workspace, ...segments);
    if (!pathIsInside(workspace, absolutePath)) throw new Error(`Writer report path escapes workspace: ${relativePath}`);
    try {
      const bytes = await readFile(absolutePath);
      return {
        path: relativePath,
        state: "present" as const,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
      };
    } catch (error) {
      if (isMissingFileError(error)) return { path: relativePath, state: "missing" as const };
      throw error;
    }
  }));
  return { pages };
}

function workspaceWikiPath(pagePath: string): string {
  const result = `wiki/${pagePath}`;
  if (result === "wiki/index.md") throw new Error("Page writers may not write the root Wiki index");
  return result;
}

function synthesisNodeIdFor(node: WikiNode, run: WikiRunSnapshot): string {
  if (isRecord(node.input) && typeof node.input.synthesisNodeId === "string") return node.input.synthesisNodeId;
  const queue = [...node.dependsOn];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const candidate = run.nodes.find((item) => item.id === id);
    if (!candidate) continue;
    if (candidate.kind === "synthesis") return candidate.id;
    queue.push(...candidate.dependsOn);
  }
  throw new Error(`${node.kind} node has no upstream final synthesis`);
}

function specForSynthesis(run: WikiRunSnapshot, synthesisNodeId: string): WikiSpec {
  const node = run.nodes.find((candidate) => candidate.id === synthesisNodeId && candidate.kind === "synthesis");
  if (!node || !isSynthesisFinalizeResult(node.result)) throw new Error(`No finalized WikiSpec exists for synthesis node ${synthesisNodeId}`);
  return node.result.spec;
}

function isSynthesisFinalizeResult(value: unknown): value is Extract<WikiSynthesisResult, { decision: "finalize" }> {
  return isRecord(value) && value.decision === "finalize" && isRecord(value.spec)
    && Array.isArray(value.spec.domains)
    && Array.isArray(value.spec.crossLinks)
    && Array.isArray(value.spec.sharedTerms);
}

function ensureReviewTargets(defects: WikiReviewDefect[], spec: WikiSpec): void {
  const pages = new Set(specPages(spec).map(({ page }) => page.path));
  for (const defect of defects) {
    if ("page" in defect && !pages.has(normalizePagePath(defect.page))) throw new Error(`Review defect targets unknown page: ${defect.page}`);
  }
}

function repairInputForPage(input: Record<string, unknown>, pagePath: string): Record<string, unknown> {
  const review = input.review;
  if (isRecord(review) && Array.isArray(review.defects)) {
    return {
      review: {
        defects: review.defects.filter((defect) => isRecord(defect) && defect.page === pagePath),
      },
    };
  }
  const validation = input.validation;
  if (isRecord(validation) && Array.isArray(validation.issues)) {
    return { validation: { issues: validation.issues.filter((issue) => isRecord(issue) && issue.page === pagePath) } };
  }
  return input;
}

function structuralFeedbackForPage(trigger: unknown, pagePath: string): Record<string, unknown> | undefined {
  const review = recordValue(trigger, "review");
  if (!isRecord(review) || !Array.isArray(review.defects)) return undefined;
  const defects = review.defects.filter((defect) => isRecord(defect) && defect.page === pagePath);
  return defects.length ? { defects } : undefined;
}

function specPages(spec: WikiSpec): Array<{ domain: WikiSpec["domains"][number]; page: WikiSpec["domains"][number]["pages"][number] }> {
  return spec.domains.flatMap((domain) => domain.pages.map((page) => ({ domain, page })));
}

function overviewPage(spec: WikiSpec): ReturnType<typeof specPages>[number] {
  const overviews = specPages(spec).filter(({ page }) => page.pageType === "overview" && page.path === "overview/overview.md");
  if (overviews.length !== 1) throw new Error("WikiSpec must contain exactly one overview/overview.md page");
  return overviews[0]!;
}

function normalizePagePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^wiki\//, "");
}

function shouldWriteContentPage(run: WikiRunSnapshot, pagePath: string, synthesisMode: SynthesisNodeInput["mode"]): boolean {
  if (run.effectiveMode === "generate" || synthesisMode === "structural") return true;
  const target = normalizePagePath(pagePath);
  const existing = new Set((run.inspection?.existingPages ?? []).map(normalizePagePath));
  const impacted = new Set((run.inspection?.impactedPages ?? []).map(normalizePagePath));
  return !existing.has(target) || impacted.has(target);
}

function relatedWikiPaths(spec: WikiSpec, pagePath: string, readableRelatedPaths: ReadonlySet<string>): string[] {
  const paths = spec.crossLinks
    .flatMap((link) => link.fromPath === pagePath ? [link.toPath] : link.toPath === pagePath ? [link.fromPath] : [])
    .filter((candidate) => readableRelatedPaths.has(candidate));
  return uniqueStrings([workspaceWikiPath(pagePath), ...paths.map(workspaceWikiPath)]);
}

function relativeWikiHref(fromPath: string, toPath: string): string {
  return path.posix.relative(path.posix.dirname(fromPath), toPath);
}

function routeReviewDefects(review: { defects: WikiReviewDefect[]; summary: string }, spec: WikiSpec): Record<string, unknown> {
  const domainsByPage = new Map(specPages(spec).map(({ domain, page }) => [page.path, domain.id]));
  return {
    summary: review.summary,
    defects: review.defects.map((defect) => {
      const key = stableStringify({
        kind: defect.kind,
        page: "page" in defect ? normalizePagePath(defect.page) : undefined,
        detail: normalizeIssueText(defect.detail),
      });
      const id = `defect-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
      if (!("page" in defect)) return { ...defect, id };
      return { ...defect, page: normalizePagePath(defect.page), id, domainId: domainsByPage.get(normalizePagePath(defect.page)) };
    }),
  };
}

function researchIdsForPage(run: WikiRunSnapshot, page: WikiSpec["domains"][number]["pages"][number]): string[] {
  return page.researchScopeIds.map((scopeId) => {
    const research = [...run.nodes].reverse().find((candidate) => candidate.kind === "research"
      && candidate.status === "succeeded"
      && isResearchReceipt(candidate.result)
      && candidate.result.scopeId === scopeId);
    if (!research) throw new Error(`No completed research receipt exists for page ${page.path} scope ${scopeId}`);
    return research.id;
  });
}

async function hashWikiPage(cwd: string, pagePath: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(path.resolve(cwd, workspaceWikiPath(pagePath)));
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function isSpecPage(value: unknown): value is WikiSpec["domains"][number]["pages"][number] {
  return isRecord(value)
    && ["overview", "architecture", "module", "flow", "concept"].includes(value.pageType)
    && typeof value.path === "string" && typeof value.title === "string" && typeof value.purpose === "string"
    && isStringArray(value.researchScopeIds);
}

function isSourceDriftResult(value: unknown): value is { sourceDrift: true; inspection: WikiInspection } {
  return isRecord(value) && value.sourceDrift === true && isRecord(value.inspection)
    && typeof value.inspection.sourceFingerprint === "string";
}

function recordStringArray(value: unknown, key: string): string[] {
  return isRecord(value) && Array.isArray(value[key]) && value[key].every((item) => typeof item === "string")
    ? value[key] as string[]
    : [];
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return [...left].sort().every((item, index) => item === [...right].sort()[index]);
}

function isResearchReceipt(value: unknown): value is WikiResearchReceipt {
  return isRecord(value)
    && typeof value.scopeId === "string"
    && typeof value.task === "string"
    && typeof value.sourceFingerprint === "string"
    && isArtifactRef(value.artifact);
}

function isArtifactRef(value: unknown): value is WikiArtifactRef {
  if (!isRecord(value)) return false;
  return value.version === 1
    && typeof value.runId === "string"
    && typeof value.nodeId === "string"
    && Number.isInteger(value.attempt)
    && typeof value.kind === "string"
    && typeof value.relativePath === "string"
    && typeof value.sha256 === "string"
    && typeof value.sizeBytes === "number"
    && (value.mediaType === "text/markdown" || value.mediaType === "application/json");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function inspectionFingerprint(inspection: WikiInspection): string {
  return stableStringify({
    changed: inspection.changed,
    changedPaths: inspection.changedPaths,
    sourcePaths: inspection.sourcePaths,
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
  return stableStringify(defects.map((defect) => ({
    page: "page" in defect ? normalizePagePath(defect.page) : undefined,
    kind: defect.kind,
    detail: normalizeIssueText(defect.detail),
  })).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))));
}

function validationIssuesFingerprint(issues: WikiValidationIssue[]): string {
  return stableStringify(issues.map((issue) => ({
    code: issue.code.trim().toLowerCase(),
    page: issue.page ? normalizePagePath(issue.page) : undefined,
    message: normalizeIssueText(issue.message),
  })).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))));
}

function normalizeIssueText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
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

function valueIs(value: unknown, key: string, expected: unknown): boolean {
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

function isLoopBudgetError(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes(`at most ${MAX_SUPPLEMENTAL_RESEARCH_BATCHES} supplemental research batch`);
}

function isMissingArtifactError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Required ") && error.message.includes(" handoff artifact is missing:");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function pathIsInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
