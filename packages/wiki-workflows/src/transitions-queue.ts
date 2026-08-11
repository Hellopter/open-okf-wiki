/**
 * Graph expansion transitions: afterSuccess, queue*, ensure*, join fan-in.
 *
 * Functions take a TransitionHost so WikiWorkflowEngine stays a thin owner of state.
 * No @earendil-works/* or executor.ts imports.
 */

import { createHash } from "node:crypto";
import { parseReviewSubmission } from "./control-submissions.js";
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
const REQUIRED_DRY_COVERAGE_AUDITS = DEFAULT_WIKI_WORKFLOW_POLICY.research.requiredDryCoverageAudits;
const MAX_EXPAND_ROUNDS = DEFAULT_WIKI_WORKFLOW_POLICY.research.maxExpandRounds;
const MAX_AUDIT_ROUNDS = DEFAULT_WIKI_WORKFLOW_POLICY.research.maxAuditRounds;
const MAX_EXPAND_SCOPES_PER_BATCH = DEFAULT_WIKI_WORKFLOW_POLICY.maxExpandScopesPerBatch;
const MISSING_PAGE_SHA256 = "missing";

/** Minimal surface the engine exposes to transition/queue helpers. */
export interface TransitionHost {
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
}

export async function validateWriteNodeResult(host: TransitionHost, node: WikiNode): Promise<void> {
  const run = host.requireRun();
  const input = pagePacketInputFor(node);
  const submitted = node.result;
  if (!isRecord(submitted) || submitted.page !== input.page.path || typeof submitted.sha256 !== "string") {
    throw new Error(`Writer did not submit the assigned page: ${input.page.path}`);
  }
  const currentSha256 = await hashWikiPage(run.cwd, input.page.path);
  if (currentSha256 !== submitted.sha256) throw new Error(`Page changed after validation: ${input.page.path}`);
  if (input.intent === "repair" && input.checkNoProgress) {
    const afterSha256 = await hashWikiPage(run.cwd, input.page.path) ?? MISSING_PAGE_SHA256;
    if (afterSha256 === input.beforeSha256) {
      host.markTerminalRun("blocked", `Repair made no change to ${input.page.path}`, node.id, undefined, {
        code: "repair_no_progress",
        page: input.page.path,
      });
    }
  }
}

export async function tryJoinAfterSuccess(host: TransitionHost, node: WikiNode): Promise<void> {
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
    // Match critical findings by content fingerprint (kind+evidence), not finding id.
    // Finding ids include scopeId, so re-reported audit findings get new ids but the
    // same content fingerprint when they restate prior knowledge.
    const priorCriticalContent = new Set(researchInput.priorResearchIds.flatMap((researchId) => {
      const result = run.nodes.find((candidate) => candidate.id === researchId)?.result;
      return isResearchReceipt(result)
        ? result.findings
          .filter((finding) => finding.priority === "critical")
          .map((finding) => finding.contentFingerprint)
        : [];
    }));
    const currentReceipts = liveSiblingIds
      .map((id) => run.nodes.find((candidate) => candidate.id === id)?.result)
      .filter((result): result is WikiResearchReceipt => isResearchReceipt(result));
    const auditDry = researchInput.continuationMode === "audit"
      && currentReceipts.every((receipt) => receipt.criticalGapSignatures.length === 0
        && receipt.findings
          .filter((finding) => finding.priority === "critical")
          .every((finding) => priorCriticalContent.has(finding.contentFingerprint)));
    queueSynthesis(host, {
      dependsOn: liveSiblingIds,
      researchIds: receiptIds,
      supplementalBatch: researchInput.batch,
      mode: researchInput.structuralRoundId ? "structural" : researchInput.continuationMode,
      dryAuditPasses: auditDry ? researchInput.dryAuditPasses + 1 : 0,
      priorSynthesisNodeId: researchInput.priorSynthesisNodeId,
      structuralRoundId: researchInput.structuralRoundId,
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

export async function afterSuccess(host: TransitionHost, node: WikiNode): Promise<void> {
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
      // Fan-in is handled exclusively by tryJoinAfterSuccess after markNodeSucceeded.
      return;
    case "synthesis": {
      // Submission contract already validated at wiki_submit_synthesis time.
      const synthesis = node.result as WikiSynthesisResult;
      const input = synthesisInputFor(node);
      if (synthesis.decision === "expand") {
        queueSupplementalResearch(host, node.id, synthesis.researchScopes, input);
        return;
      }
      // Happy path: when research reports no unresolved critical gaps, skip the
      // dry-coverage audit wave and go straight to writers.
      if (
        input.dryAuditPasses < REQUIRED_DRY_COVERAGE_AUDITS
        && researchIdsHaveUnresolvedCriticalGaps(host, input.researchIds)
      ) {
        queueCoverageAudit(host, [node.id], node.id, input);
        return;
      }
      queuePageWriters(host, node.id, synthesis.spec);
      return;
    }
    case "validate": {
      const validation = parseValidation(node.result);
      node.result = validation;
      await maybeCompleteVerification(host, node);
      return;
    }
    case "review": {
      const review = parseReviewSubmission(node.result);
      node.result = review;
      ensureReviewSubmissionFitsRun(host, node, review);
      await maybeCompleteVerification(host, node);
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
  const scopes: WikiResearchScope[] = sourcePaths.map((sourcePath) => ({
    id: `source-survey:${sourcePath}`,
    sourcePaths: [sourcePath],
    task: [
      `Bounded survey of ${sourcePath}: cover entry points, main flows, boundaries, and state/data within this source only.`,
      "Submit one complete research handoff in a single pass; do not aim for an exhaustive encyclopedia.",
    ].join(" "),
  }));
  return queueResearch(host, inspectNodeId, scopes, 0, "research", "Research");
}

export function queueSupplementalResearch(host: TransitionHost, synthesisNodeId: string, scopes: WikiResearchScope[], parent: SynthesisNodeInput): WikiNode[] {
  const nextRound = parent.supplementalBatch + 1;
  ensureResearchRoundAvailable(host, nextRound, "expand");
  return queueResearch(host, 
    synthesisNodeId,
    scopes,
    nextRound,
    "research",
    "Research",
    parent.mode === "structural" ? "structural" : "supplemental",
    parent.priorSynthesisNodeId,
    parent.structuralRoundId,
    parent.trigger,
    parent.researchIds,
    0,
  );
}

export function queueCoverageAudit(host: TransitionHost, dependsOn: string[], synthesisNodeId: string, parent: SynthesisNodeInput): WikiNode[] {
  const nextRound = parent.supplementalBatch + 1;
  // Structural re-audits grow/replan coverage (expand budget). Pure dry-coverage
  // confirmation rounds use the audit budget.
  const budgetKind = parent.mode === "structural" || parent.structuralRoundId ? "expand" : "audit";
  ensureResearchRoundAvailable(host, nextRound, budgetKind);
  const sourcePaths = uniqueStrings(host.requireRun().inspection?.sourcePaths ?? []);
  const scopeId = deterministicGroupId("coverage-audit", {
    batch: nextRound,
    synthesisNodeId: parent.priorSynthesisNodeId ?? synthesisNodeId,
    researchIds: [...parent.researchIds].sort(),
    mode: parent.mode,
    structuralRoundId: parent.structuralRoundId ?? null,
  });
  const scope: WikiResearchScope = {
    id: scopeId,
    sourcePaths,
    task: [
      "Bounded critical-gap audit against prior research findings only.",
      "Report missing critical gaps versus already-recorded findings;",
      "do not re-survey sources for encyclopedia coverage.",
      "Prefer empty findings when prior critical coverage already holds.",
    ].join(" "),
  };
  return queueResearch(host, 
    dependsOn,
    [scope],
    nextRound,
    "research",
    "Research",
    "audit",
    parent.priorSynthesisNodeId ?? synthesisNodeId,
    parent.structuralRoundId,
    parent.trigger,
    parent.researchIds,
    parent.dryAuditPasses,
  );
}

export function queueResearch(host: TransitionHost, 
  dependsOn: string | string[],
  scopes: WikiResearchScope[],
  batch: number,
  phaseId: "research",
  phaseTitle: "Research",
  continuationMode: ResearchNodeInput["continuationMode"] = "initial",
  priorSynthesisNodeId?: string,
  structuralRoundId?: string,
  trigger?: unknown,
  priorResearchIds: string[] = [],
  dryAuditPasses = 0,
): WikiNode[] {
  const researchGroupId = researchGroupIdFor(batch, scopes, continuationMode);
  return scopes.map((scope) => queueNode(host, 
    "research",
    batch === 0 ? `Survey: ${scope.id}` : `Research: ${scope.id}`,
    Array.isArray(dependsOn) ? dependsOn : [dependsOn],
    { batch, scope, continuationMode, dryAuditPasses, priorSynthesisNodeId, structuralRoundId, trigger, researchGroupId, priorResearchIds },
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
    structural ? "Re-synthesize Wiki Structure" : input.supplementalBatch === 0 ? "Synthesize Wiki Spec" : "Re-synthesize Wiki Spec",
    input.dependsOn,
    { ...input, round: run.round, inspection: run.inspection, focus: run.focus },
    phaseRefForKind("synthesis"),
  );
}

export function queueStructuralResearch(host: TransitionHost, dependsOn: string[], synthesisNodeId: string, trigger: unknown): WikiNode[] {
  const synthesis = host.nodeById(synthesisNodeId);
  if (!synthesis) throw new Error(`Unknown synthesis node: ${synthesisNodeId}`);
  const input = synthesisInputFor(synthesis);
  return queueCoverageAudit(host, dependsOn, synthesisNodeId, {
    ...input,
    mode: "structural",
    dryAuditPasses: 0,
    priorSynthesisNodeId: synthesisNodeId,
    structuralRoundId: dependsOn.join(":"),
    trigger,
  });
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
  // Sync reservation: concurrent write joins can both pass an empty check and
  // then race past await materializeIndexes. Queue validate+review before any
  // await so the second caller always observes the first reservation.
  const existing = run.nodes.filter((node) => (node.kind === "validate" || node.kind === "review")
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
    nodes = [
      queueNode(host, "validate", "Validate Wiki", sourceNodeIds, common, verify),
      queueNode(host, "review", "Review Wiki", sourceNodeIds, common, verify),
    ];
  }
  // Indexes are only required before validate/review execute, not before enqueue.
  await host.materializeIndexes(run.cwd, specForSynthesis(run, synthesisNodeId));
  return nodes;
}

export async function maybeCompleteVerification(host: TransitionHost, node: WikiNode): Promise<void> {
  const run = host.requireRun();
  const verificationGroupId = recordValue(node.input, "verificationGroupId");
  if (typeof verificationGroupId !== "string") throw new Error("Verification node has no group ID");
  // Prefer live peers only. After invalidation, generation counters can collapse
  // and reuse verificationGroupId; dead nodes must not pin or block completion.
  const pair = run.nodes.filter((candidate) => (candidate.kind === "validate" || candidate.kind === "review")
    && valueIs(candidate.input, "verificationGroupId", verificationGroupId)
    && !["invalidated", "cancelled"].includes(candidate.status));
  const validationNode = pair.find((candidate) => candidate.kind === "validate");
  const reviewNode = pair.find((candidate) => candidate.kind === "review");
  if (!validationNode || !reviewNode
    || ![validationNode, reviewNode].every((candidate) => candidate.id === node.id || candidate.status === "succeeded")) return;
  if (run.nodes.some((candidate) => !["invalidated", "cancelled", "failed", "blocked"].includes(candidate.status)
    && candidate.dependsOn.includes(validationNode.id) && candidate.dependsOn.includes(reviewNode.id))) return;

  const validation = parseValidation(validationNode.result);
  const review = parseReviewSubmission(reviewNode.result);
  // Scope no-progress fingerprints to this plan/synthesis lineage so a structural
  // replan's first verification is not false-blocked by an older plan's defect set.
  const synthesisNodeId = synthesisNodeIdFor(node, run);
  if (!validation.ok && validationIssuesFingerprint(validation.issues) === previousValidationSignature(host, validationNode.id, synthesisNodeId)) {
    host.markTerminalRun("blocked", "Validation produced the same unresolved error set twice", validationNode.id, undefined, {
      code: "same_validation_twice",
      issues: validation.issues,
    });
    return;
  }
  if (review.defects.length && defectsFingerprint(review.defects) === previousReviewSignature(host, reviewNode.id, synthesisNodeId)) {
    host.markTerminalRun("blocked", "Review produced the same unresolved defect set twice", reviewNode.id, undefined, {
      code: "same_defects_twice",
      defects: review.defects.map(defectAsRecord),
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

  const spec = specForSynthesis(run, synthesisNodeId);
  const routedReview = routeReviewDefects(review, spec);
  const dependsOn = [validationNode.id, reviewNode.id];
  const structural = structuralValidation.length > 0
    || review.defects.some((defect) => defect.kind === "topology" || defect.kind === "coverage");
  if (structural) {
    const resyntheses = new Set(run.nodes
      .filter((candidate) => candidate.kind === "synthesis" && !["invalidated", "cancelled"].includes(candidate.status))
      .map((candidate) => synthesisInputFor(candidate))
      .filter((input) => input.mode === "structural" && input.structuralRoundId)
      .map((input) => input.structuralRoundId)).size;
    if (resyntheses >= MAX_STRUCTURAL_RESYNTHESES) {
      host.markTerminalRun("blocked", `Structural review exceeded the ${MAX_STRUCTURAL_RESYNTHESES}-resynthesis budget`, reviewNode.id, undefined, {
        code: "structural_resynthesis_budget",
        defects: review.defects.map(defectAsRecord),
        issues: structuralValidation,
        remainingBudget: {
          structuralResyntheses: 0,
          maxStructuralResyntheses: MAX_STRUCTURAL_RESYNTHESES,
          used: resyntheses,
        },
      });
      return;
    }
    queueStructuralResearch(host, dependsOn, synthesisNodeId, { validation, review: routedReview });
    return;
  }

  const pagePaths = uniqueStrings([
    ...validation.issues.flatMap((issue) => issue.page ? [issue.page] : []),
    ...review.defects.flatMap((defect) => "page" in defect ? [defect.page] : []),
  ]);
  if (pagePaths.length) {
    await queuePageRepairs(host, dependsOn, synthesisNodeId, pagePaths, { validation, review: routedReview });
    return;
  }
  queueNode(host, "finalize", "Finalize Wiki", dependsOn, { synthesisNodeId, verificationGroupId }, phaseRefForKind("finalize"));
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
    const beforeSha256 = await hashWikiPage(run.cwd, page.path) ?? MISSING_PAGE_SHA256;
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
    ? await hashWikiPage(run.cwd, overview.page.path) ?? MISSING_PAGE_SHA256
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

export function ensureResearchRoundAvailable(host: TransitionHost, nextRound: number, kind: "expand" | "audit"): void {
  const run = host.requireRun();
  const maxResearchRounds = run.maxResearchRounds;
  if (nextRound >= maxResearchRounds) {
    throw new WikiBudgetExhaustedError(
      `Research reached the ${maxResearchRounds}-round limit before coverage saturated`,
      "research_rounds_exhausted",
      { nextRound, maxResearchRounds, kind },
    );
  }

  if (kind === "audit") {
    const used = countAuditResearchGroups(host);
    if (used >= MAX_AUDIT_ROUNDS) {
      throw new WikiBudgetExhaustedError(
        `Research reached the ${MAX_AUDIT_ROUNDS}-audit-round limit before coverage saturated`,
        "audit_rounds_exhausted",
        { nextRound, used, maxAuditRounds: MAX_AUDIT_ROUNDS },
      );
    }
    return;
  }

  const used = countExpandResearchGroups(host);
  if (used >= MAX_EXPAND_ROUNDS) {
    throw new WikiBudgetExhaustedError(
      `Research reached the ${MAX_EXPAND_ROUNDS}-expand-round limit before coverage saturated`,
      "expand_rounds_exhausted",
      { nextRound, used, maxExpandRounds: MAX_EXPAND_ROUNDS },
    );
  }
}

export function countAuditResearchGroups(host: TransitionHost): number {
  const groups = new Set<string>();
  for (const node of host.requireRun().nodes) {
    if (node.kind !== "research") continue;
    if (node.status === "invalidated" || node.status === "cancelled") continue;
    try {
      const input = researchInputFor(node);
      if (input.continuationMode === "audit" && !input.structuralRoundId) {
        groups.add(input.researchGroupId);
      }
    } catch {
      // Ignore malformed nodes when counting budgets.
    }
  }
  return groups.size;
}

export function countExpandResearchGroups(host: TransitionHost): number {
  const groups = new Set<string>();
  for (const node of host.requireRun().nodes) {
    if (node.kind !== "research") continue;
    if (node.status === "invalidated" || node.status === "cancelled") continue;
    try {
      const input = researchInputFor(node);
      const isExpand = input.continuationMode === "supplemental"
        || input.continuationMode === "structural"
        || Boolean(input.structuralRoundId);
      if (isExpand) groups.add(input.researchGroupId);
    } catch {
      // Ignore malformed nodes when counting budgets.
    }
  }
  return groups.size;
}

export function validateControlSubmission(host: TransitionHost, node: WikiNode, submission: WikiControlSubmission): void {
  if (node.kind === "synthesis") {
    ensureSynthesisSubmissionFitsRun(host, submission as WikiSynthesisResult, synthesisInputFor(node));
    return;
  }
  if (node.kind === "review") ensureReviewSubmissionFitsRun(host, node, submission as ReturnType<typeof parseReviewSubmission>);
}

export function ensureSynthesisSubmissionFitsRun(host: TransitionHost, synthesis: WikiSynthesisResult, input: SynthesisNodeInput): void {
  if (synthesis.decision === "expand") {
    if (!researchIdsHaveUnresolvedCriticalGaps(host, input.researchIds)) {
      throw new Error(
        "Expand is rejected when research receipts report no unresolved critical gaps; finalize the WikiSpec instead",
      );
    }
    ensureExpandScopesBindCriticalGaps(host, synthesis.researchScopes, input.researchIds);
    ensureResearchRoundAvailable(host, input.supplementalBatch + 1, "expand");
    if (synthesis.researchScopes.length > MAX_EXPAND_SCOPES_PER_BATCH) {
      throw new Error(
        `Expand may request at most ${MAX_EXPAND_SCOPES_PER_BATCH} research scopes per batch (got ${synthesis.researchScopes.length})`,
      );
    }
    ensureNewResearchScopes(host, synthesis.researchScopes);
    ensureResearchSourcePaths(host, synthesis.researchScopes);
    return;
  }
  ensureSynthesisSpecReceipts(host, synthesis.spec, input);
}

/**
 * Each expand scope must reference at least one unresolved critical gap
 * (question text or signature substring in scope id/task).
 */
export function ensureExpandScopesBindCriticalGaps(
  host: TransitionHost,
  scopes: readonly WikiResearchScope[],
  researchIds: readonly string[],
): void {
  const gaps = criticalGapBindings(host, researchIds);
  if (gaps.length === 0) {
    throw new Error("Expand requires unresolved critical gap questions from research receipts");
  }
  for (const scope of scopes) {
    const haystack = `${scope.id}\n${scope.task}`.toLowerCase();
    const bound = gaps.some((gap) => {
      const question = gap.question.toLowerCase();
      const signature = gap.signature.toLowerCase();
      return (question.length > 0 && haystack.includes(question))
        || (signature.length >= 8 && haystack.includes(signature.slice(0, 8)))
        || gap.tokens.some((token) => token.length >= 4 && haystack.includes(token));
    });
    if (!bound) {
      throw new Error(
        `Expand scope "${scope.id}" must reference an unresolved critical gap in its id or task (gap questions: ${gaps.map((g) => g.question).slice(0, 3).join("; ")})`,
      );
    }
  }
}

function criticalGapBindings(
  host: TransitionHost,
  researchIds: readonly string[],
): Array<{ signature: string; question: string; tokens: string[] }> {
  const run = host.requireRun();
  const gaps: Array<{ signature: string; question: string; tokens: string[] }> = [];
  for (const researchId of researchIds) {
    const result = run.nodes.find((candidate) => candidate.id === researchId)?.result;
    if (!isResearchReceipt(result)) continue;
    const questions = result.criticalGapQuestions ?? [];
    const signatures = result.criticalGapSignatures ?? [];
    const count = Math.max(questions.length, signatures.length);
    for (let index = 0; index < count; index++) {
      const question = questions[index] ?? "";
      const signature = signatures[index] ?? "";
      if (!question && !signature) continue;
      const tokens = question
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fff]+/i)
        .filter((token) => token.length >= 4)
        .slice(0, 8);
      gaps.push({ signature, question, tokens });
    }
  }
  return gaps;
}

/**
 * True when any research receipt for the given node ids still has critical gap
 * signatures. Used to hard-reject expand-without-gaps and to skip dry audits
 * on the happy path.
 *
 * Per policy: if every receipt in `researchIds` has
 * `criticalGapSignatures.length === 0`, there are no unresolved critical gaps.
 * Missing/non-receipt results are ignored; an empty receipt set is "no gaps".
 */
export function researchIdsHaveUnresolvedCriticalGaps(host: TransitionHost, researchIds: readonly string[]): boolean {
  const run = host.requireRun();
  for (const researchId of researchIds) {
    const result = run.nodes.find((candidate) => candidate.id === researchId)?.result;
    if (!isResearchReceipt(result)) continue;
    if (result.criticalGapSignatures.length > 0) return true;
  }
  return false;
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
  ensureReviewTargets(review.defects, specForSynthesis(host.requireRun(), synthesisNodeId));
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
  const researchNodes = input.researchIds
    .map((nodeId) => host.requireRun().nodes.find((node) => node.id === nodeId))
    .filter((node): node is WikiNode => node?.kind === "research" && isResearchReceipt(node.result));
  const latestBatch = Math.max(...researchNodes.map((node) => researchInputFor(node).batch));
  const criticalGapCount = researchNodes
    .filter((node) => researchInputFor(node).batch === latestBatch)
    .reduce((total, node) => total + (node.result as WikiResearchReceipt).criticalGapSignatures.length, 0);
  if (criticalGapCount > 0) {
    throw new Error(`WikiSpec cannot finalize with ${criticalGapCount} unresolved critical research gap(s)`);
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
  return {
    id,
    kind,
    label,
    phaseId: phase?.id ?? `phase:${id}`,
    phaseTitle: phase?.title ?? phaseTitleFor(kind),
    status: "queued",
    dependsOn,
    attempt: 0,
    inputFingerprint: stableStringify(parsed),
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
      && valueIs(node.input, "synthesisNodeId", synthesisNodeId))
    .map((node) => parseReviewSubmission(node.result));
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
