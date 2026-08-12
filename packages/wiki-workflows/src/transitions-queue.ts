/**
 * Graph expansion transitions: atomic success commit, queue*, ensure*, join fan-in.
 *
 * Functions take an internal host so WikiWorkflowEngine stays a thin owner of state.
 * No @earendil-works/* or executor.ts imports.
 */

import { createHash } from "node:crypto";
import { parseReviewSubmission, parseSynthesisSubmission } from "./control-submissions.js";
import { WikiBudgetExhaustedError } from "./failures.js";
import { evaluateJoin, siblingsByGroupKey } from "./join-barrier.js";
import { DEFAULT_WIKI_WORKFLOW_POLICY } from "./policy.js";
import { phaseTitleFor } from "./run-graph.js";
import { phaseRefForKind } from "./workflow-phases.js";
import {
  defectsFingerprint,
  ensureReviewTargets,
  hashWikiPage,
  inspectionFingerprint,
  isResearchReceipt,
  isSourceDriftResult,
  isStructuralValidationIssue,
  normalizePagePath,
  overviewPage,
  pagePacketInputFor,
  parseInspection,
  parseNodeInput,
  parseValidation,
  recordStringArray,
  recordValue,
  relatedWikiPaths,
  repairInputForPage,
  researchIdsForPage,
  researchInputFor,
  reviewInputFor,
  routeReviewDefects,
  safePagePacketInput,
  sameStringSet,
  selectResearchIdsForFindings,
  shouldWriteContentPage,
  specForSynthesis,
  specPages,
  structuralFeedbackForPage,
  synthesisInputFor,
  synthesisNodeIdFor,
  validationIssuesFingerprint,
  valueIs,
  workspaceWikiPath,
  type PagePacketInput,
  type QueueSynthesisInput,
  type ResearchNodeInput,
  type SynthesisNodeInput,
} from "./run-nodes.js";
import type { WikiInspection } from "./types.js";
import { clone, isRecord, stableStringify, uniqueStrings } from "./util.js";
import {
  EMPTY_NODE_METRICS,
  type WikiControlSubmission,
  type WikiCriticalGap,
  type WikiResearchArtifact,
  type WikiNode,
  type WikiNodeKind,
  type WikiResearchReceipt,
  type WikiResearchScope,
  type WikiRunEventKind,
  type WikiRunSnapshot,
  type WikiSpec,
  type WikiSynthesisResult,
} from "./workflow-types.js";

const MAX_LOCAL_REPAIR_ROUNDS_PER_PLAN = DEFAULT_WIKI_WORKFLOW_POLICY.maxLocalRepairRoundsPerPlan;
const MAX_STRUCTURAL_RESYNTHESES = DEFAULT_WIKI_WORKFLOW_POLICY.maxStructuralResyntheses;
const MISSING_PAGE_SHA256 = "missing";

/** Internal adapter for state-machine I/O owned by WikiWorkflowEngine. */
interface WorkflowTransitionContext {
  requireRun(): WikiRunSnapshot;
  nodeById(id: string): WikiNode | undefined;
  now(): string;
  newId(): string;
  emit(kind: WikiRunEventKind, nodeId?: string, message?: string, data?: Record<string, unknown>): void;
  markTerminalRun(
    status: "succeeded" | "failed" | "blocked",
    message: string,
    nodeId?: string,
    at?: string,
    details?: WikiRunSnapshot["blockedDetails"],
  ): void;
  materializeIndexes(cwd: string, spec: WikiSpec): Promise<unknown>;
  wikiRoot(): string;
}

type TransitionHost = WorkflowTransitionContext;
const commitQueues = new WeakMap<WikiRunSnapshot, Promise<void>>();

/**
 * Accept a completed node result and advance the graph as one state-machine
 * operation. Callers do not need to know whether a node must become visible to
 * a fan-in barrier before its successor transition runs.
 */
export async function commitNodeSuccess(host: WorkflowTransitionContext, node: WikiNode): Promise<void> {
  if (node.status !== "running") throw new Error(`Cannot commit ${node.id} from ${node.status}`);

  const run = host.requireRun();
  const previous = commitQueues.get(run) ?? Promise.resolve();
  const operation = previous.then(async () => await commitNodeSuccessNow(host, node));
  commitQueues.set(run, operation.catch(() => {}));
  return await operation;
}

async function commitNodeSuccessNow(host: WorkflowTransitionContext, node: WikiNode): Promise<void> {
  if (node.status !== "running") return;

  const run = host.requireRun();
  const base = clone(run);
  const shadow = clone(base);
  const shadowNode = shadow.nodes.find((candidate) => candidate.id === node.id);
  if (!shadowNode) throw new Error(`Cannot commit missing node ${node.id}`);
  const emissions: Array<Parameters<WorkflowTransitionContext["emit"]>> = [];
  let terminal: Parameters<WorkflowTransitionContext["markTerminalRun"]> | undefined;
  const transactionHost: WorkflowTransitionContext = {
    ...host,
    requireRun: () => shadow,
    nodeById: (id) => shadow.nodes.find((candidate) => candidate.id === id),
    emit: (...args) => { emissions.push(args); },
    markTerminalRun: (...args) => {
      if (isTransitionTerminal(shadow.status)) return;
      const [status, message, , at = host.now(), details] = args;
      shadow.status = status;
      shadow.blockedReason = status === "succeeded" ? undefined : message;
      shadow.blockedDetails = status === "succeeded" ? undefined : details;
      shadow.completedAt = at;
      terminal = args;
    },
  };

  if (shadowNode.kind === "write") await validateWriteNodeResult(transactionHost, shadowNode);

  if (shadowNode.kind === "research" || shadowNode.kind === "write") {
    publishNodeSucceeded(transactionHost, shadowNode);
    await tryJoinAfterSuccess(transactionHost, shadowNode);
  } else if (shadowNode.kind === "validate" || shadowNode.kind === "review") {
    // Verification fan-in observes the committing peer through run.nodes.
    publishNodeSucceeded(transactionHost, shadowNode);
    await afterSuccess(transactionHost, shadowNode);
  } else {
    await afterSuccess(transactionHost, shadowNode);
    // Finalization may terminalize the run before its own success event is emitted.
    if (shadowNode.status === "running") publishNodeSucceeded(transactionHost, shadowNode);
  }

  // Commit is synchronous: no listener can observe the prepared shadow state.
  const terminalState = terminal && {
    status: run.status,
    blockedReason: run.blockedReason,
    blockedDetails: run.blockedDetails,
    completedAt: run.completedAt,
  };
  mergeRun(run, base, shadow);
  if (terminal && terminalState) {
    run.status = terminalState.status;
    run.blockedReason = terminalState.blockedReason;
    run.blockedDetails = terminalState.blockedDetails;
    run.completedAt = terminalState.completedAt;
    host.markTerminalRun(...terminal);
  }
  for (const emission of emissions) host.emit(...emission);
}

function mergeRun(live: WikiRunSnapshot, base: WikiRunSnapshot, shadow: WikiRunSnapshot): void {
  const liveNodes = new Map(live.nodes.map((node) => [node.id, node]));
  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
  for (const shadowNode of shadow.nodes) {
    const liveNode = liveNodes.get(shadowNode.id);
    const baseNode = baseNodes.get(shadowNode.id);
    if (!liveNode || !baseNode) {
      if (!liveNode) live.nodes.push(shadowNode);
      continue;
    }
    mergeChangedFields(liveNode, baseNode, shadowNode, new Set());
  }
  mergeChangedFields(live, base, shadow, new Set(["nodes", "events"]));
}

function mergeChangedFields<T extends object>(
  live: T,
  base: T,
  shadow: T,
  ignored: ReadonlySet<string>,
): void {
  const keys = new Set([...Object.keys(base), ...Object.keys(shadow)]);
  for (const key of keys) {
    if (ignored.has(key)) continue;
    const field = key as keyof T;
    if (sameValue(base[field], shadow[field])) continue;
    if (!(key in shadow)) delete live[field];
    else live[field] = shadow[field];
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function isTransitionTerminal(status: WikiRunSnapshot["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "blocked" || status === "cancelled";
}

function publishNodeSucceeded(host: WorkflowTransitionContext, node: WikiNode): void {
  const finishedAt = host.now();
  node.status = "succeeded";
  node.activity = { state: "completed", message: "Completed", updatedAt: finishedAt };
  node.finishedAt = finishedAt;
  // Drop the live transcript once the durable handoff/result is accepted.
  node.history = undefined;
  node.output = undefined;
  host.emit("node_succeeded", node.id, node.label);
}

async function validateWriteNodeResult(host: WorkflowTransitionContext, node: WikiNode): Promise<void> {
  const run = host.requireRun();
  const input = pagePacketInputFor(node);
  const submitted = node.result;
  if (!isRecord(submitted) || submitted.page !== input.page.path || typeof submitted.sha256 !== "string") {
    throw new Error(`Writer did not submit the assigned page: ${input.page.path}`);
  }
  const currentSha256 = await hashWikiPage(run.cwd, input.page.path, host.wikiRoot());
  if (currentSha256 !== submitted.sha256) throw new Error(`Page changed after validation: ${input.page.path}`);
  if (input.intent === "repair" && input.checkNoProgress) {
    const afterSha256 = await hashWikiPage(run.cwd, input.page.path, host.wikiRoot()) ?? MISSING_PAGE_SHA256;
    if (afterSha256 === input.beforeSha256) {
      host.markTerminalRun("blocked", `Repair made no change to ${input.page.path}`, node.id, undefined, {
        code: "repair_no_progress",
        page: input.page.path,
      });
    }
  }
}

async function tryJoinAfterSuccess(host: WorkflowTransitionContext, node: WikiNode): Promise<void> {
  const run = host.requireRun();
  // Skip fan-in when a local post-check already terminalized the run
  // (e.g. repair no-progress), matching the former early-return path.
  if (run.status !== "running") return;

  if (node.kind === "research") {
    const researchInput = researchInputFor(node);
    // siblingsByGroupKey excludes invalidated nodes so deterministic group ids
    // reused after source-drift restart do not stall or pin dependsOn to dead work.
    const members = siblingsByGroupKey(run.nodes, "research", "researchGroupId", researchInput.researchGroupId);
    const join = evaluateJoin(members);
    if (join.reason !== "all_succeeded") return;

    const liveSiblingIds = members.map((member) => member.id);
    const receiptIds = uniqueStrings([
      ...researchInput.priorResearchIds,
      ...liveSiblingIds,
    ]);
    const currentReceipts = liveSiblingIds
      .map((id) => run.nodes.find((candidate) => candidate.id === id)?.result)
      .filter((result): result is WikiResearchReceipt => isResearchReceipt(result));
    const frontier = criticalGapFrontier(currentReceipts);
    if (frontier.length > 0) {
      queueTargetedResearch(host, liveSiblingIds, frontier, researchInput, receiptIds);
      return;
    }
    queueSynthesis(host, {
      dependsOn: liveSiblingIds,
      researchIds: receiptIds,
      mode: researchInput.priorSynthesisNodeId ? "structural" : "initial",
      priorSynthesisNodeId: researchInput.priorSynthesisNodeId,
      trigger: researchInput.trigger,
    });
    return;
  }

  if (node.kind === "write") {
    const input = pagePacketInputFor(node);
    const members = siblingsByGroupKey(run.nodes, "write", "writeGroupId", input.writeGroupId);
    const join = evaluateJoin(members);
    if (join.reason !== "all_succeeded") return;

    await queueVerification(host, members.map((member) => member.id), input.synthesisNodeId);
  }
}

async function afterSuccess(host: WorkflowTransitionContext, node: WikiNode): Promise<void> {
  const run = host.requireRun();
  switch (node.kind) {
    case "inspect": {
      const inspection = parseInspection(node.result);
      if (run.requestedMode === "refresh" && inspection.refreshRequiresGenerateReason) {
        throw new Error(inspection.refreshRequiresGenerateReason);
      }
      run.inspection = inspection;
      run.effectiveMode = run.requestedMode === "generate" ? "generate" : inspection.mode;
      run.inspectionFingerprint = inspectionFingerprint(inspection);
      queueInitialSourceSurveys(host, node.id, inspection);
      return;
    }
    case "research":
    case "write":
      // Fan-in is handled exclusively by commitNodeSuccess after publishing success.
      return;
    case "synthesis": {
      // Submission contract already validated by the selected synthesis submit tool.
      const synthesis = parseSynthesisSubmission(node.result);
      const input = synthesisInputFor(node);
      queuePageWriters(host, node.id, synthesis.spec);
      return;
    }
    case "validate": {
      const validation = parseValidation(node.result);
      await completeWriteValidation(host, node, validation);
      return;
    }
    case "review": {
      const review = parseReviewSubmission(node.result);
      ensureReviewSubmissionFitsRun(host, node, review);
      await completeSemanticReview(host, node, review);
      return;
    }
    case "finalize": {
      if (isSourceDriftResult(node.result)) {
        if (run.sourceRestartCount >= DEFAULT_WIKI_WORKFLOW_POLICY.maxSourceRestarts) {
          host.markTerminalRun("blocked", "Source fingerprint changed twice during this Wiki run", node.id, undefined, {
            code: "source_drift_blocked",
          });
          return;
        }
        run.sourceRestartCount += 1;
        for (const candidate of run.nodes) {
          if (candidate.id === node.id || candidate.status === "cancelled") continue;
          candidate.status = "invalidated";
          candidate.activity = { state: "idle", message: "Invalidated by source drift restart", updatedAt: host.now() };
        }
        run.inspection = undefined;
        run.inspectionFingerprint = undefined;
        queueNode(host, "inspect", "Re-inspect Git scope", [], { requestedMode: run.requestedMode, sourceRestart: run.sourceRestartCount }, phaseRefForKind("inspect"));
        return;
      }
      host.markTerminalRun("succeeded", "Wiki validation, review, and finalization passed");
      return;
    }
  }
}

export function queueInitialSourceSurveys(host: TransitionHost, inspectNodeId: string, inspection: WikiInspection): WikiNode[] {
  const sourcePaths = uniqueStrings(inspection.sourcePaths);
  if (sourcePaths.length === 0) throw new Error("Inspect returned no declared source paths");
  const surveyScopes: WikiResearchScope[] = sourcePaths.map((sourcePath) => ({
    id: `source-survey:${sourcePath}`,
    sourcePaths: [sourcePath],
    task: [
      `Survey ${sourcePath} to identify cohesive domains, their boundaries, entry points, and cross-domain questions.`,
      "Keep this pass broad. Mark unanswered domain model, core flow, state, invariant, interface, and failure-path questions as explicit critical gaps for targeted domain research.",
      "Stage findings with wiki_research_put_findings, then submit only the final summary and gaps with wiki_submit_research. If rejected, correct every issue and resubmit in this session.",
    ].join(" "),
  }));
  const domainScopes: WikiResearchScope[] = host.requireRun().policy.domains.map((domain) => {
    const roots = uniqueStrings(domain.include
      .map((pattern) => pattern.replaceAll("\\", "/").split("/", 1)[0]!)
      .filter((root) => sourcePaths.includes(root)));
    if (roots.length === 0) {
      throw new Error(`Configured domain ${domain.id} include patterns do not match any declared source root`);
    }
    return {
      id: `domain:${domain.id}`,
      sourcePaths: roots,
      task: [
        `Deeply research the configured domain ${domain.title} (${domain.id}).`,
        `Include patterns: ${domain.include.join(", ")}. Exclude patterns: ${domain.exclude.join(", ") || "none"}.`,
        "Cover its domain model, core flows, states and transitions, invariants, data ownership, interfaces, failure paths, and cross-domain dependencies with claim-level evidence.",
      ].join(" "),
    };
  });
  return queueResearch(host, inspectNodeId, [...surveyScopes, ...domainScopes], 0, "research", "Research");
}

function criticalGapFrontier(receipts: readonly WikiResearchReceipt[]): WikiCriticalGap[] {
  return [...new Map(receipts.flatMap((receipt) => receipt.criticalGaps).map((gap) => [gap.id, gap])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function queueTargetedResearch(
  host: TransitionHost,
  dependsOn: string[],
  frontier: WikiCriticalGap[],
  parent: ResearchNodeInput,
  priorResearchIds: string[],
): WikiNode[] {
  const nextRound = parent.batch + 1;
  ensureResearchRoundAvailable(host, nextRound, frontier);
  const scopes: WikiResearchScope[] = [];
  const targetGapsByScopeId = new Map<string, WikiCriticalGap>();
  for (const gap of frontier) {
    const scope = {
      id: `critical-gap:${gap.id}:round-${nextRound}`,
      sourcePaths: gap.sourcePaths,
      task: gap.question,
    };
    scopes.push(scope);
    targetGapsByScopeId.set(scope.id, gap);
  }
  return queueResearch(host, dependsOn, scopes, nextRound, "research", "Research", "targeted",
    parent.priorSynthesisNodeId, parent.trigger, priorResearchIds, targetGapsByScopeId);
}

export function queueResearch(host: TransitionHost, 
  dependsOn: string | string[],
  scopes: WikiResearchScope[],
  batch: number,
  phaseId: "research",
  phaseTitle: "Research",
  continuationMode: ResearchNodeInput["continuationMode"] = "initial",
  priorSynthesisNodeId?: string,
  trigger?: unknown,
  priorResearchIds: string[] = [],
  targetGapsByScopeId: ReadonlyMap<string, WikiCriticalGap> = new Map(),
): WikiNode[] {
  const researchGroupId = researchGroupIdFor(batch, scopes, continuationMode);
  return scopes.map((scope) => queueNode(host,
    "research",
    batch === 0 ? `Survey: ${scope.id}` : `Research: ${scope.id}`,
    Array.isArray(dependsOn) ? dependsOn : [dependsOn],
    { batch, scope, continuationMode, targetGap: targetGapsByScopeId.get(scope.id), priorSynthesisNodeId, trigger, researchGroupId, priorResearchIds },
    { id: phaseId, title: phaseTitle },
  ));
}

export function queueSynthesis(host: TransitionHost, input: QueueSynthesisInput): WikiNode | undefined {
  const run = host.requireRun();
  const existing = run.nodes.find((node) => node.kind === "synthesis"
    && sameStringSet(synthesisInputFor(node).researchIds, input.researchIds)
    && synthesisInputFor(node).mode === input.mode
    && !["invalidated", "cancelled", "failed", "blocked"].includes(node.status));
  if (existing) return undefined;
  run.round += 1;
  const structural = input.mode === "structural";
  return queueNode(host, 
    "synthesis",
    structural ? "Re-synthesize Wiki Structure" : "Synthesize Wiki Spec",
    input.dependsOn,
    { ...input, round: run.round, inspection: run.inspection, focus: run.focus },
    phaseRefForKind("synthesis"),
  );
}

export function queueStructuralResearch(host: TransitionHost, dependsOn: string[], synthesisNodeId: string, trigger: unknown): WikiNode[] {
  const synthesis = host.nodeById(synthesisNodeId);
  if (!synthesis) throw new Error(`Unknown synthesis node: ${synthesisNodeId}`);
  const input = synthesisInputFor(synthesis);
  const batch = Math.max(0, ...input.researchIds.map((id) => {
    const candidate = host.nodeById(id);
    return candidate?.kind === "research" ? researchInputFor(candidate).batch : 0;
  })) + 1;
  ensureResearchRoundAvailable(host, batch, []);
  const sourcePaths = uniqueStrings(host.requireRun().inspection?.sourcePaths ?? []);
  const scope: WikiResearchScope = {
    id: deterministicGroupId("structural-research", { synthesisNodeId, dependsOn, trigger }),
    sourcePaths,
    task: `Research the structural validation/review defects and gather any missing evidence: ${stableStringify(trigger)}`,
  };
  return queueResearch(host, dependsOn, [scope], batch, "research", "Research", "structural",
    synthesisNodeId, trigger, input.researchIds);
}

export function queuePageWriters(host: TransitionHost, synthesisNodeId: string, spec: WikiSpec): WikiNode[] {
  const run = host.requireRun();
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
  const writeGeneration = countNonRepairWriteGroupsForSynthesis(run, synthesisNodeId);
  const writeGroupId = deterministicGroupId("write", {
    synthesisNodeId,
    intent: "draft",
    generation: writeGeneration,
  });
  const phase = phaseRefForKind("write");
  const nodes = selected.map(({ domain, page }) => {
    const researchIds = selectResearchIdsForFindings(researchNodes, page);
    return queueNode(host, 
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
  const overviewNode = queueNode(host, 
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

export async function queueVerification(host: TransitionHost, sourceNodeIds: string[], synthesisNodeId: string): Promise<WikiNode[]> {
  const run = host.requireRun();
  // Reserve the deterministic Write completion gate synchronously. Semantic
  // review is queued only after this validation succeeds.
  const existing = run.nodes.filter((node) => node.kind === "validate"
    && valueIs(node.input, "synthesisNodeId", synthesisNodeId)
    && sameStringSet(recordStringArray(node.input, "sourceNodeIds"), sourceNodeIds)
    && !["invalidated", "cancelled", "failed", "blocked"].includes(node.status));
  let nodes = existing;
  if (!nodes.length) {
    const verifyGeneration = countVerificationGroupsForSynthesis(run, synthesisNodeId);
    const verificationGroupId = deterministicGroupId("verify", {
      synthesisNodeId,
      intent: "verify",
      generation: verifyGeneration,
      sourceNodeIds: [...sourceNodeIds].sort(),
    });
    const common = { sourceNodeIds, synthesisNodeId, verificationGroupId };
    const verify = phaseRefForKind("validate");
    nodes = [queueNode(host, "validate", "Validate completed pages", sourceNodeIds, common, verify)];
  }
  // Indexes are only required before validate/review execute, not before enqueue.
  await host.materializeIndexes(run.cwd, specForSynthesis(run, synthesisNodeId));
  return nodes;
}

export async function maybeCompleteVerification(host: TransitionHost, node: WikiNode): Promise<void> {
  if (node.kind === "validate") return await completeWriteValidation(host, node, parseValidation(node.result));
  if (node.kind === "review") return await completeSemanticReview(host, node, parseReviewSubmission(node.result));
}

async function completeWriteValidation(host: TransitionHost, validationNode: WikiNode, validation: ReturnType<typeof parseValidation>): Promise<void> {
  const run = host.requireRun();
  const synthesisNodeId = synthesisNodeIdFor(validationNode, run);
  if (!validation.ok && validationIssuesFingerprint(validation.issues) === previousValidationSignature(host, validationNode.id, synthesisNodeId)) {
    host.markTerminalRun("blocked", "Validation produced the same unresolved error set twice", validationNode.id, undefined, {
      code: "same_validation_twice",
      issues: validation.issues,
    });
    return;
  }
  const structuralValidation = validation.issues.filter(isStructuralValidationIssue);
  const unroutableValidation = validation.issues.filter((issue) => !issue.page && !isStructuralValidationIssue(issue));
  if (unroutableValidation.length) {
    host.markTerminalRun("blocked", "Validation found a global safety issue that cannot be routed to one page", validationNode.id, undefined, {
      code: "unroutable_validation",
      issues: unroutableValidation,
    });
    return;
  }

  if (structuralValidation.length) {
    queueStructuralResearch(host, [validationNode.id], synthesisNodeId, { validation });
    return;
  }
  const pagePaths = uniqueStrings(validation.issues.flatMap((issue) => issue.page ? [issue.page] : []));
  if (pagePaths.length) {
    await queuePageRepairs(host, [validationNode.id], synthesisNodeId, pagePaths, { validation });
    return;
  }
  const verificationGroupId = recordValue(validationNode.input, "verificationGroupId");
  if (typeof verificationGroupId !== "string") throw new Error("Validation node has no group ID");
  const existing = run.nodes.filter((candidate) => candidate.kind === "review"
    && valueIs(candidate.input, "verificationGroupId", verificationGroupId)
    && !["invalidated", "cancelled", "failed", "blocked"].includes(candidate.status));
  if (!existing.length) {
    const spec = specForSynthesis(run, synthesisNodeId);
    const domains = spec.domains.filter((domain) => domain.pages.some((page) => page.pageType !== "overview"));
    const domainReviews = domains.map((domain) => queueNode(host, "review", `Review domain: ${domain.title}`, [validationNode.id], {
      sourceNodeIds: [validationNode.id],
      synthesisNodeId,
      verificationGroupId,
      reviewScope: { kind: "domain", domainId: domain.id, pagePaths: domain.pages.map((page) => page.path) },
    }, phaseRefForKind("review")));
    queueNode(host, "review", "Review cross-domain coverage and semantics", domainReviews.map((node) => node.id), {
      sourceNodeIds: domainReviews.map((node) => node.id),
      synthesisNodeId,
      verificationGroupId,
      reviewScope: { kind: "global", domainReviewNodeIds: domainReviews.map((node) => node.id) },
    }, phaseRefForKind("review"));
  }
}

async function completeSemanticReview(host: TransitionHost, reviewNode: WikiNode, review: ReturnType<typeof parseReviewSubmission>): Promise<void> {
  const run = host.requireRun();
  const reviewInput = reviewInputFor(reviewNode);
  if (reviewInput.reviewScope.kind === "domain") return;
  const fragments = reviewInput.reviewScope.domainReviewNodeIds.map((nodeId) => {
    const node = host.nodeById(nodeId);
    if (!node || node.kind !== "review" || node.status !== "succeeded") {
      throw new Error(`Global review is missing completed domain review: ${nodeId}`);
    }
    return parseReviewSubmission(node.result);
  });
  const aggregate = {
    defects: [...fragments.flatMap((fragment) => fragment.defects), ...review.defects],
    summary: [...fragments.map((fragment) => fragment.summary), review.summary].filter(Boolean).join("\n"),
  };
  const synthesisNodeId = synthesisNodeIdFor(reviewNode, run);
  if (aggregate.defects.length && defectsFingerprint(aggregate.defects) === previousReviewSignature(host, reviewNode.id, synthesisNodeId)) {
    host.markTerminalRun("blocked", "Review produced the same unresolved defect set twice", reviewNode.id, undefined, {
      code: "same_defects_twice",
      defects: aggregate.defects.map(defectAsRecord),
    });
    return;
  }
  const spec = specForSynthesis(run, synthesisNodeId);
  const routedReview = routeReviewDefects(aggregate, spec);
  const structural = aggregate.defects.some((defect) => defect.kind === "topology" || defect.kind === "coverage");
  if (structural) {
    const resyntheses = run.nodes
      .filter((candidate) => candidate.kind === "synthesis" && !["invalidated", "cancelled"].includes(candidate.status))
      .map((candidate) => synthesisInputFor(candidate))
      .filter((input) => input.mode === "structural").length;
    if (resyntheses >= MAX_STRUCTURAL_RESYNTHESES) {
      host.markTerminalRun("blocked", `Structural review exceeded the ${MAX_STRUCTURAL_RESYNTHESES}-resynthesis budget`, reviewNode.id, undefined, {
        code: "structural_resynthesis_budget",
        defects: aggregate.defects.map(defectAsRecord),
        remainingBudget: { structuralResyntheses: 0, maxStructuralResyntheses: MAX_STRUCTURAL_RESYNTHESES, used: resyntheses },
      });
      return;
    }
    queueStructuralResearch(host, [reviewNode.id], synthesisNodeId, { review: routedReview });
    return;
  }
  const pagePaths = uniqueStrings(aggregate.defects.flatMap((defect) => "page" in defect ? [defect.page] : []));
  if (pagePaths.length) {
    await queuePageRepairs(host, [reviewNode.id], synthesisNodeId, pagePaths, { review: routedReview });
    return;
  }
  const verificationGroupId = recordValue(reviewNode.input, "verificationGroupId");
  queueNode(host, "finalize", "Publish Wiki", [reviewNode.id], { synthesisNodeId, verificationGroupId }, phaseRefForKind("finalize"));
}

export async function queuePageRepairs(host: TransitionHost, 
  dependsOn: string[],
  synthesisNodeId: string,
  pagePaths: string[],
  input: Record<string, unknown>,
): Promise<WikiNode[]> {
  const run = host.requireRun();
  const spec = specForSynthesis(host.requireRun(), synthesisNodeId);
  const synthesisNode = host.nodeById(synthesisNodeId);
  if (!synthesisNode) throw new Error(`Unknown synthesis node: ${synthesisNodeId}`);
  const previousRounds = new Set(run.nodes
    .filter((candidate) => candidate.kind === "write")
    .map((candidate) => safePagePacketInput(candidate))
    .filter((packet): packet is PagePacketInput => packet?.intent === "repair" && packet.synthesisNodeId === synthesisNodeId)
    .map((packet) => packet.writeGroupId)).size;
  if (previousRounds >= MAX_LOCAL_REPAIR_ROUNDS_PER_PLAN) {
    host.markTerminalRun("blocked", `Local repair exceeded the ${MAX_LOCAL_REPAIR_ROUNDS_PER_PLAN}-round budget for this Plan`, dependsOn[0], undefined, {
      code: "local_repair_budget",
      remainingBudget: {
        localRepairRounds: 0,
        maxLocalRepairRounds: MAX_LOCAL_REPAIR_ROUNDS_PER_PLAN,
        used: previousRounds,
      },
    });
    return [];
  }
  const requested = new Set(pagePaths.map(normalizePagePath));
  const targets = specPages(spec).filter(({ page }) => requested.has(page.path));
  if (targets.length !== requested.size) throw new Error("Repair targets a page outside the current WikiSpec");
  const overview = overviewPage(spec);
  const writeGroupId = deterministicGroupId("repair", {
    synthesisNodeId,
    intent: "repair",
    generation: previousRounds + 1,
  });
  const phase = phaseRefForKind("write");
  const contentNodes: WikiNode[] = [];
  for (const { domain, page } of targets.filter(({ page }) => page.pageType !== "overview")) {
    const researchIds = researchIdsForPage(run, page);
    const beforeSha256 = await hashWikiPage(run.cwd, page.path, host.wikiRoot()) ?? MISSING_PAGE_SHA256;
    contentNodes.push(queueNode(host, 
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
    ? await hashWikiPage(run.cwd, overview.page.path, host.wikiRoot()) ?? MISSING_PAGE_SHA256
    : undefined;
  const overviewNode = queueNode(host, 
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

export function ensureResearchRoundAvailable(host: TransitionHost, nextRound: number, criticalGaps: WikiCriticalGap[]): void {
  const run = host.requireRun();
  const maxResearchRounds = run.maxResearchRounds;
  if (nextRound >= maxResearchRounds) {
    throw new WikiBudgetExhaustedError(
      `Research reached the ${maxResearchRounds}-round limit before coverage saturated`,
      "research_rounds_exhausted",
      { nextRound, maxResearchRounds, criticalGaps },
    );
  }
}

export function validateControlSubmission(host: TransitionHost, node: WikiNode, submission: WikiControlSubmission): void {
  if (node.kind === "research") {
    const input = researchInputFor(node);
    const result = submission as WikiResearchArtifact;
    if (input.continuationMode === "targeted"
      && !result.findings.some((finding) => finding.priority === "critical")
      && !result.gaps.some((gap) => gap.priority === "critical")) {
      throw new Error(`Targeted research for critical gap ${input.targetGap?.id} (${input.targetGap?.question}) must produce a critical finding or retain/refine a critical gap`);
    }
    return;
  }
  if (node.kind === "synthesis") {
    ensureSynthesisSubmissionFitsRun(host, submission as WikiSynthesisResult, synthesisInputFor(node));
    return;
  }
  if (node.kind === "review") ensureReviewSubmissionFitsRun(host, node, submission as ReturnType<typeof parseReviewSubmission>);
}

export function ensureSynthesisSubmissionFitsRun(host: TransitionHost, synthesis: WikiSynthesisResult, input: SynthesisNodeInput): void {
  for (const configured of host.requireRun().policy.domains) {
    const actual = synthesis.spec.domains.find((domain) => domain.id === configured.id);
    if (!actual) throw new Error(`WikiSpec must include configured domain: ${configured.id}`);
    if (actual.title !== configured.title) {
      throw new Error(`WikiSpec configured domain ${configured.id} must use title: ${configured.title}`);
    }
  }
  ensureSynthesisSpecReceipts(host, synthesis.spec, input);
}

/**
 * Deterministic research group id shared by all scopes in one batch.
 * Format: `research:${batch}:${hash(sorted scope ids + continuationMode)}`.
 */
export function researchGroupIdFor(
  batch: number,
  scopes: readonly WikiResearchScope[],
  continuationMode: ResearchNodeInput["continuationMode"],
): string {
  const scopeIds = scopes.map((scope) => scope.id).sort();
  const digest = createHash("sha256")
    .update(stableStringify({ scopeIds, continuationMode }))
    .digest("hex")
    .slice(0, 16);
  return `research:${batch}:${digest}`;
}

/** Stable short group key: `prefix:hex` without random UUIDs. */
export function deterministicGroupId(prefix: string, parts: unknown): string {
  const digest = createHash("sha256").update(stableStringify(parts)).digest("hex").slice(0, 16);
  return `${prefix}:${digest}`;
}

/** Unique non-repair write group count for a synthesis lineage (generation counter). */
function countNonRepairWriteGroupsForSynthesis(run: WikiRunSnapshot, synthesisNodeId: string): number {
  const groups = new Set<string>();
  for (const node of run.nodes) {
    if (node.kind !== "write") continue;
    if (node.status === "invalidated" || node.status === "cancelled") continue;
    try {
      const packet = pagePacketInputFor(node);
      if (packet.synthesisNodeId === synthesisNodeId && packet.intent !== "repair") {
        groups.add(packet.writeGroupId);
      }
    } catch {
      // Ignore malformed write nodes when counting generations.
    }
  }
  return groups.size;
}

function countVerificationGroupsForSynthesis(run: WikiRunSnapshot, synthesisNodeId: string): number {
  const groups = new Set<string>();
  for (const node of run.nodes) {
    if (node.kind !== "validate" && node.kind !== "review") continue;
    if (node.status === "invalidated" || node.status === "cancelled") continue;
    if (!valueIs(node.input, "synthesisNodeId", synthesisNodeId)) continue;
    const groupId = recordValue(node.input, "verificationGroupId");
    if (typeof groupId === "string" && groupId) groups.add(groupId);
  }
  return groups.size;
}

export function ensureReviewSubmissionFitsRun(host: TransitionHost, node: WikiNode, review: ReturnType<typeof parseReviewSubmission>): void {
  const synthesisNodeId = synthesisNodeIdFor(node, host.requireRun());
  const spec = specForSynthesis(host.requireRun(), synthesisNodeId);
  ensureReviewTargets(review.defects, spec);
  const input = reviewInputFor(node);
  if (input.reviewScope.kind === "domain") {
    const allowed = new Set(input.reviewScope.pagePaths);
    for (const defect of review.defects) {
      if ("page" in defect && !allowed.has(normalizePagePath(defect.page))) {
        throw new Error(`Domain review ${input.reviewScope.domainId} targets page outside its scope: ${defect.page}`);
      }
    }
  }
}

export function ensureNewResearchScopes(host: TransitionHost, scopes: WikiResearchScope[]): void {
  const existingIds = new Set(host.requireRun().nodes
    .filter((node) => node.kind === "research" && !["invalidated", "cancelled"].includes(node.status))
    .map((node) => researchInputFor(node).scope.id));
  for (const scope of scopes) {
    if (existingIds.has(scope.id)) throw new Error(`Supplemental research scope repeats existing scope: ${scope.id}`);
  }
}

export function ensureResearchSourcePaths(host: TransitionHost, scopes: WikiResearchScope[]): void {
  const allowed = new Set(host.requireRun().inspection?.sourcePaths ?? []);
  for (const scope of scopes) {
    for (const sourcePath of scope.sourcePaths) {
      if (!allowed.has(sourcePath)) throw new Error(`Supplemental research scope ${scope.id} targets undeclared source: ${sourcePath}`);
    }
  }
}

export function ensureSynthesisSpecReceipts(host: TransitionHost, spec: WikiSpec, input: SynthesisNodeInput): void {
  const receipts = input.researchIds
    .map((nodeId) => host.requireRun().nodes.find((node) => node.id === nodeId)?.result)
    .filter((result): result is WikiResearchReceipt => isResearchReceipt(result));
  const findings = new Map(receipts.flatMap((receipt) => receipt.findings).map((finding) => [finding.id, finding]));
  const selected = new Set(specPages(spec).flatMap(({ page }) => page.findingIds));
  const omitted = new Set(spec.omissions.map((omission) => omission.findingId));
  for (const findingId of [...selected, ...omitted]) {
    if (!findings.has(findingId)) throw new Error(`WikiSpec references unknown research finding: ${findingId}`);
  }
  for (const findingId of selected) {
    if (omitted.has(findingId)) throw new Error(`WikiSpec both selects and omits research finding: ${findingId}`);
  }
  for (const finding of findings.values()) {
    if (!selected.has(finding.id) && !omitted.has(finding.id)) {
      throw new Error(`WikiSpec does not account for research finding: ${finding.id}`);
    }
    if (finding.priority === "critical" && omitted.has(finding.id)) {
      throw new Error(`WikiSpec may not omit critical research finding: ${finding.id}`);
    }
  }
}

export function queueNode(
  host: TransitionHost,
  kind: WikiNodeKind,
  label: string,
  dependsOn: string[],
  input: unknown,
  phase?: { id: string; title: string },
): WikiNode {
  const node = newNode(host, kind, label, dependsOn, input, phase);
  host.requireRun().nodes.push(node);
  host.emit("node_queued", node.id, node.label);
  return node;
}

export function newNode(
  host: TransitionHost,
  kind: WikiNodeKind,
  label: string,
  dependsOn: string[],
  input: unknown,
  phase?: { id: string; title: string },
): WikiNode {
  const now = host.now();
  const id = `${kind}-${host.newId()}`;
  // Runtime parse is the input contract (full discriminant WikiNode is incremental).
  const parsed = parseNodeInput(kind, input);
  const inspectPolicyHash = kind === "inspect" && isRecord(input) && typeof input.policyHash === "string"
    ? input.policyHash
    : undefined;
  return {
    id,
    kind,
    label,
    phaseId: phase?.id ?? `phase:${id}`,
    phaseTitle: phase?.title ?? phaseTitleFor(kind),
    status: "queued",
    dependsOn,
    attempt: 0,
    inputFingerprint: createHash("sha256").update(stableStringify({
      policyHash: inspectPolicyHash ?? host.requireRun().policyHash,
      input: parsed,
    })).digest("hex"),
    input: clone(parsed),
    attemptHistory: [],
    metrics: clone(EMPTY_NODE_METRICS),
    activity: { state: "idle", updatedAt: now },
  };
}

function defectAsRecord(defect: { kind: string; detail: string; page?: string }): Record<string, string> {
  return defect.page
    ? { kind: defect.kind, page: defect.page, detail: defect.detail }
    : { kind: defect.kind, detail: defect.detail };
}

/**
 * Prior review defect fingerprint for no-progress detection.
 * Only compares against prior succeeded reviews that share `synthesisNodeId`
 * so a structural replan's first verification is not false-blocked by an older plan.
 */
export function previousReviewSignature(
  host: TransitionHost,
  currentNodeId: string,
  synthesisNodeId: string,
): string | undefined {
  const run = host.requireRun();
  const reviews = run.nodes
    .filter((node) => node.kind === "review"
      && node.id !== currentNodeId
      && node.status === "succeeded"
      && valueIs(node.input, "synthesisNodeId", synthesisNodeId)
      && reviewInputFor(node).reviewScope.kind === "global")
    .map((node) => {
      const input = reviewInputFor(node);
      const fragments = input.reviewScope.kind === "global"
        ? input.reviewScope.domainReviewNodeIds.map((nodeId) => {
          const fragment = host.nodeById(nodeId);
          return fragment ? parseReviewSubmission(fragment.result) : undefined;
        }).filter((value): value is ReturnType<typeof parseReviewSubmission> => value !== undefined)
        : [];
      const global = parseReviewSubmission(node.result);
      return { defects: [...fragments.flatMap((fragment) => fragment.defects), ...global.defects], summary: global.summary };
    });
  const latest = reviews.at(-1);
  return latest ? defectsFingerprint(latest.defects) : undefined;
}

/**
 * Prior validation issue fingerprint for no-progress detection.
 * Only compares against prior succeeded validates that share `synthesisNodeId`
 * (see previousReviewSignature).
 */
export function previousValidationSignature(
  host: TransitionHost,
  currentNodeId: string,
  synthesisNodeId: string,
): string | undefined {
  const run = host.requireRun();
  const validations = run.nodes
    .filter((node) => node.kind === "validate"
      && node.id !== currentNodeId
      && node.status === "succeeded"
      && valueIs(node.input, "synthesisNodeId", synthesisNodeId))
    .map((node) => parseValidation(node.result))
    .filter((validation) => !validation.ok);
  const latest = validations.at(-1);
  return latest ? validationIssuesFingerprint(latest.issues) : undefined;
}
