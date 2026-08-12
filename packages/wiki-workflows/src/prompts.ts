/**
 * Agent prompt assembly and prompt-context helpers.
 *
 * Pure module: no @earendil-works/* or executor imports.
 */

import { Buffer } from "node:buffer";
import path from "node:path";
import { loadWikiPromptGuidance } from "./prompt-guidance.js";
import { isRecord } from "./util.js";
import {
  isSynthesisFinalizeResult,
  pagePacketInputFor,
  readRootsFor,
  researchInputFor,
  specForSynthesis,
  synthesisInputFor,
  synthesisNodeIdFor,
  reviewInputFor,
  wikiReadPathsFor,
} from "./run-nodes.js";
import type {
  WikiNode,
  WikiResearchArtifact,
  WikiResearchFinding,
  WikiReviewFragmentContext,
  WikiRunSnapshot,
} from "./workflow-types.js";

export interface PromptResearchReceipt {
  scopeId: string;
  sourcePaths: string[];
  task: string;
  artifactPath: string;
  findings: WikiResearchFinding[];
  gaps: WikiResearchArtifact["gaps"];
}

export async function promptFor(
  node: WikiNode,
  run: WikiRunSnapshot,
  researchReceipts: PromptResearchReceipt[] | undefined,
  reviewFragments?: WikiReviewFragmentContext,
): Promise<string> {
  const guidance = await loadWikiPromptGuidance(
    node.kind,
    run.language,
    node.kind === "write" ? { pageTypes: pageTypesFor(node, run) } : undefined,
  );
  let context: string;
  switch (node.kind) {
    case "research": {
      const input = researchInputFor(node);
      context = `${pinnedPolicyContext(run)}\n\n## Assigned Scope\n\`\`\`json\n${prettyJson({
        ...input.scope,
        targetGap: input.targetGap,
      })}\n\`\`\``;
      break;
    }
    case "synthesis":
      context = synthesisContext(node, run, researchReceipts);
      break;
    case "write": {
      const packet = pagePacketInputFor(node);
      const repair = packet.feedback !== undefined
        ? `\n\n## Writing Feedback\n\`\`\`json\n${prettyJson(writerFeedbackForPrompt(packet.feedback))}\n\`\`\``
        : "";
      context = `${pageWriterContext(node, run, researchReceipts)}${repair}`;
      break;
    }
    case "review":
      context = reviewContext(node, run, reviewFragments);
      break;
    default:
      throw new Error(`No prompt available for ${node.kind}`);
  }
  return `${guidance}\n\n${context}\n\n${completionProtocol(node, run)}`;
}

function completionProtocol(node: WikiNode, run: WikiRunSnapshot): string {
  const attempts = run.policy.quality.maxSubmissionAttempts;
  const tools = node.kind === "synthesis"
    ? "Build the plan with `wiki_plan_put_domain`, `wiki_plan_remove_domain`, and `wiki_plan_set_coordination`; query `wiki_spec_get_domain` and `wiki_submission_status`. Then call `wiki_submit_synthesis_finalize` with only the rationale when the staged WikiSpec is ready."
    : node.kind === "research" ? "Upsert findings as stable {slot,finding} entries in batches of at most 20 with `wiki_research_put_findings`; retract invalid slots with `wiki_research_remove_finding`; query `wiki_research_findings`, `wiki_research_scopes`, or `wiki_submission_status`; then call `wiki_submit_research` with only summary and gaps."
      : node.kind === "write" ? "Call `wiki_submit_page` with the exact assigned page."
        : "Upsert defects as stable {slot,defect} entries in batches of at most 20 with `wiki_review_put_defects`; retract resolved slots with `wiki_review_remove_defect`; query `wiki_review_defects` or `wiki_submission_status`; then call `wiki_submit_review` with only the summary.";
  return [
    "## Required Completion Protocol",
    tools,
    `The node succeeds only after one terminal submission tool accepts its required payload. Up to ${attempts} submission attempt${attempts === 1 ? " is" : "s are"} available across the allowed tool(s).`,
    "Do not finish with prose, a JSON code block, or a handoff file. After acceptance, stop.",
  ].join("\n");
}

export function pageWriterContext(node: WikiNode, run: WikiRunSnapshot, researchReceipts: PromptResearchReceipt[] | undefined): string {
  const input = pagePacketInputFor(node);
  const synthesis = run.nodes.find((candidate) => candidate.id === input.synthesisNodeId)?.result;
  const spec = isSynthesisFinalizeResult(synthesis) ? synthesis.spec : undefined;
  const domain = spec?.domains.find((candidate) => candidate.id === input.domainId);
  const sections = [
    pinnedPolicyContext(run),
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
      research: writerResearchContext(input.page.findingIds, researchReceipts),
      sourceRoots: readRootsFor(node, run) ?? [],
      terminology: run.policy.terminology,
      wikiReadPaths: input.wikiReadPaths,
      writePaths: input.writePaths,
    }),
    "```",
  ];
  return sections.join("\n");
}

function writerResearchContext(findingIds: readonly string[], receipts: PromptResearchReceipt[] | undefined) {
  const selected = (receipts ?? []).flatMap((receipt) => receipt.findings.filter((finding) => findingIds.includes(finding.id)));
  if (Buffer.byteLength(JSON.stringify(selected), "utf8") <= 16 * 1024) return { inlineFindings: selected };
  return {
    findingIds,
    instruction: "Use wiki_research_findings to retrieve the assigned findings in bounded pages.",
  };
}

export function pageTypesFor(
  node: WikiNode,
  _run: WikiRunSnapshot,
): Array<"overview" | "domain" | "architecture" | "module" | "flow" | "concept" | "state" | "data"> {
  return [pagePacketInputFor(node).page.pageType];
}

export function synthesisContext(node: WikiNode, run: WikiRunSnapshot, researchReceipts: PromptResearchReceipt[] | undefined): string {
  const input = synthesisInputFor(node);
  const inspection = input.inspection ?? run.inspection;
  const sections = [
    pinnedPolicyContext(run),
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
    const priorSpec = specForSynthesis(run, input.priorSynthesisNodeId);
    sections.push(
      "## Preseeded Prior WikiSpec",
      "The prior WikiSpec is already staged. Use `wiki_submission_status` and paged `wiki_spec_get_domain` to inspect it; mutate only what the structural trigger requires.",
      "```json",
      prettyJson({
        domains: priorSpec.domains.map((domain) => ({ id: domain.id, title: domain.title, pageCount: domain.pages.length })),
        domainCount: priorSpec.domains.length,
        pageCount: priorSpec.domains.reduce((count, domain) => count + domain.pages.length, 0),
        crossLinkCount: priorSpec.crossLinks.length,
        sharedTermCount: priorSpec.sharedTerms.length,
        omissionCount: priorSpec.omissions.length,
      }),
      "```",
      "## Structural Validation And Review Trigger",
      "```json",
      prettyJson(structuralTriggerForPrompt(input.trigger)),
      "```",
    );
  }
  sections.push(
    "## Available Research Catalog",
    "Use `wiki_research_scopes` and paged `wiki_research_findings` to retrieve findings. Account for every exact finding `id` by assigning it to at least one page or adding a justified non-critical entry to `omissions`.",
    "```json",
    prettyJson((researchReceipts ?? []).map((receipt) => ({
      scopeId: receipt.scopeId,
      sourcePaths: receipt.sourcePaths,
      task: receipt.task,
      findingCount: receipt.findings.length,
    }))),
    "```",
  );
  return sections.join("\n");
}

export function reviewContext(node: WikiNode, run: WikiRunSnapshot, fragments?: WikiReviewFragmentContext): string {
  const synthesisNodeId = synthesisNodeIdFor(node, run);
  const scope = reviewInputFor(node).reviewScope;
  const responsibility = scope.kind === "domain"
    ? {
      kind: "domain",
      domainId: scope.domainId,
      pagePaths: scope.pagePaths,
      instruction: "Review only these pagePaths. Report page-local evidence, link, depth, and diagram defects; do not review or target pages outside this domain scope.",
    }
    : {
      kind: "global",
      instruction: "Use the domain review fragments as prior findings. Review cross-domain consistency, overview accuracy, coverage, and topology; supplement missing defects and do not repeat equivalent fragment defects.",
    };
  return [
    pinnedPolicyContext(run),
    "## Review Scope",
    `Focus: ${run.focus ?? "none"}`,
    "```json",
    prettyJson(responsibility),
    "```",
    ...(scope.kind === "global" ? [
      "## Domain Review Fragments",
      "These bounded fragments are inputs to the global review. Reconcile and deduplicate them before submitting only new global defects.",
      "```json",
      prettyJson(fragments ?? { fragments: [], omittedFragmentCount: 0 }),
      "```",
    ] : []),
    "## Final WikiSpec",
    "```json",
    prettyJson(specForSynthesis(run, synthesisNodeId)),
    "```",
    "## Candidate Wiki Files",
    "```json",
    prettyJson(wikiReadPathsFor(node, run) ?? []),
    "```",
  ].join("\n");
}

function pinnedPolicyContext(run: WikiRunSnapshot): string {
  return [
    "## Pinned Workspace Policy",
    "Treat configured terminology as canonical. The final WikiSpec must contain every configured domain with the exact configured id and title. Do not inspect or cite excluded paths.",
    "```json",
    prettyJson({
      terminology: run.policy.terminology,
      configuredDomains: run.policy.domains,
      excludedPaths: run.policy.exclude,
    }),
    "```",
  ].join("\n");
}

export function writerFeedbackForPrompt(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (Array.isArray(value.defects)) return { defects: value.defects.map(publicReviewDefect).filter(Boolean) };
  const feedback: Record<string, unknown> = {};
  if (isRecord(value.review) && Array.isArray(value.review.defects)) {
    feedback.review = { defects: value.review.defects.map(publicReviewDefect).filter(Boolean) };
  }
  if (isRecord(value.validation) && Array.isArray(value.validation.issues)) {
    feedback.validation = { issues: value.validation.issues.map(publicValidationIssue).filter(Boolean) };
  }
  if (Object.keys(feedback).length) return feedback;
  if (typeof value.reason === "string") return { reason: value.reason };
  return {};
}

export function structuralTriggerForPrompt(value: unknown): unknown {
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

export function publicReviewDefect(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.detail !== "string") return undefined;
  return typeof value.page === "string"
    ? { kind: value.kind, page: value.page, detail: value.detail }
    : { kind: value.kind, detail: value.detail };
}

export function publicValidationIssue(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  return typeof value.page === "string"
    ? { code: value.code, page: value.page, message: value.message }
    : { code: value.code, message: value.message };
}

function relativeWikiHref(fromPath: string, toPath: string): string {
  return path.posix.relative(path.posix.dirname(fromPath), toPath);
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}
