/**
 * Agent prompt assembly and prompt-context helpers.
 *
 * Pure module: no @earendil-works/* or executor imports.
 */

import path from "node:path";
import { DEFAULT_WIKI_WORKFLOW_POLICY } from "./policy.js";
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
  wikiReadPathsFor,
} from "./run-nodes.js";
import type {
  WikiNode,
  WikiResearchArtifact,
  WikiResearchFinding,
  WikiRunSnapshot,
} from "./workflow-types.js";

const POLICY = DEFAULT_WIKI_WORKFLOW_POLICY;
const REQUIRED_DRY_COVERAGE_AUDITS = POLICY.research.requiredDryCoverageAudits;
const MAX_EXPAND_ROUNDS = POLICY.research.maxExpandRounds;
const MAX_AUDIT_ROUNDS = POLICY.research.maxAuditRounds;
const MAX_EXPAND_SCOPES_PER_BATCH = POLICY.maxExpandScopesPerBatch;

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
): Promise<string> {
  const guidance = await loadWikiPromptGuidance(
    node.kind,
    run.language,
    node.kind === "write" ? { pageTypes: pageTypesFor(node, run) } : undefined,
  );
  let context: string;
  switch (node.kind) {
    case "research":
      context = `${pinnedPolicyContext(run)}\n\n## Assigned Scope\n\`\`\`json\n${prettyJson(researchInputFor(node).scope)}\n\`\`\``;
      break;
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
      context = reviewContext(node, run);
      break;
    default:
      throw new Error(`No prompt available for ${node.kind}`);
  }
  return `${guidance}\n\n${context}\n\n${completionProtocol(node, run)}`;
}

function completionProtocol(node: WikiNode, run: WikiRunSnapshot): string {
  const attempts = run.policy.quality.maxSubmissionAttempts;
  const tools = node.kind === "synthesis"
    ? "Call exactly one: `wiki_submit_synthesis_expand` when critical evidence is missing, or `wiki_submit_synthesis_finalize` when the WikiSpec is ready."
    : node.kind === "research" ? "Call `wiki_submit_research`."
      : node.kind === "write" ? "Call `wiki_submit_page` with the exact assigned page."
        : "Call `wiki_submit_review`.";
  return [
    "## Required Completion Protocol",
    tools,
    `The node succeeds only after one submission tool accepts the complete object. Up to ${attempts} submission attempt${attempts === 1 ? " is" : "s are"} available across the allowed tool(s).`,
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
      researchReceipts: researchReceipts ?? [],
      sourceRoots: readRootsFor(node, run) ?? [],
      terminology: run.policy.terminology,
      wikiReadPaths: input.wikiReadPaths,
      writePaths: input.writePaths,
    }),
    "```",
  ];
  return sections.join("\n");
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
  const usedExpandRounds = countResearchGroups(run, "expand");
  const usedAuditRounds = countResearchGroups(run, "audit");
  sections.push(
    "## Available Research Receipts",
    "Use only the exact finding `id` values below in page `findingIds`. Account for every finding by assigning it to at least one page or adding a justified non-critical entry to `omissions`. Read every selected `artifactPath` before planning.",
    "```json",
    prettyJson(researchReceipts ?? []),
    "```",
    "## Synthesis Round",
    "```json",
    prettyJson({
      mode: input.mode,
      researchRound: input.supplementalBatch + 1,
      maxResearchRounds: run.maxResearchRounds,
      dryCoverageAudits: input.dryAuditPasses,
      requiredDryCoverageAudits: REQUIRED_DRY_COVERAGE_AUDITS,
      maxExpandRounds: MAX_EXPAND_ROUNDS,
      maxAuditRounds: MAX_AUDIT_ROUNDS,
      maxExpandScopesPerBatch: MAX_EXPAND_SCOPES_PER_BATCH,
      remainingExpandRounds: Math.max(0, MAX_EXPAND_ROUNDS - usedExpandRounds),
      remainingAuditRounds: Math.max(0, MAX_AUDIT_ROUNDS - usedAuditRounds),
      preferFinalizeWhenNoCriticalGaps: true,
    }),
    "```",
  );
  return sections.join("\n");
}

/** Count expand or pure-audit research groups already queued on the run. */
export function countResearchGroups(run: WikiRunSnapshot, kind: "expand" | "audit"): number {
  const groups = new Set<string>();
  for (const node of run.nodes) {
    if (node.kind !== "research") continue;
    if (node.status === "invalidated" || node.status === "cancelled") continue;
    try {
      const input = researchInputFor(node);
      if (kind === "audit") {
        if (input.continuationMode === "audit" && !input.structuralRoundId) {
          groups.add(input.researchGroupId);
        }
        continue;
      }
      const isExpand = input.continuationMode === "supplemental"
        || input.continuationMode === "structural"
        || Boolean(input.structuralRoundId);
      if (isExpand) groups.add(input.researchGroupId);
    } catch {
      // Ignore malformed nodes when counting budgets for prompts.
    }
  }
  return groups.size;
}

export function reviewContext(node: WikiNode, run: WikiRunSnapshot): string {
  const synthesisNodeId = synthesisNodeIdFor(node, run);
  return [
    pinnedPolicyContext(run),
    "## Review Scope",
    `Focus: ${run.focus ?? "none"}`,
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
