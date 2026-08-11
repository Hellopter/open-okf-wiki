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

const REQUIRED_DRY_COVERAGE_AUDITS = DEFAULT_WIKI_WORKFLOW_POLICY.research.requiredDryCoverageAudits;

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
  artifactWritePath: string | undefined,
): Promise<string> {
  const guidance = await loadWikiPromptGuidance(
    node.kind,
    run.language,
    node.kind === "write" ? { pageTypes: pageTypesFor(node, run) } : undefined,
  );
  switch (node.kind) {
    case "research":
      return `${guidance}\n\n## Assigned Scope\n\`\`\`json\n${prettyJson(researchInputFor(node).scope)}\n\`\`\`\n\n${artifactWriteContext(artifactWritePath, "JSON research artifact")}`;
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

export function pageWriterContext(node: WikiNode, run: WikiRunSnapshot, researchReceipts: PromptResearchReceipt[] | undefined): string {
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

export function pageTypesFor(node: WikiNode, _run: WikiRunSnapshot): Array<"overview" | "architecture" | "module" | "flow" | "concept"> {
  return [pagePacketInputFor(node).page.pageType];
}

export function synthesisContext(node: WikiNode, run: WikiRunSnapshot, researchReceipts: PromptResearchReceipt[] | undefined): string {
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
    }),
    "```",
  );
  return sections.join("\n");
}

export function artifactWriteContext(path: string | undefined, description: string): string {
  if (!path) throw new Error(`No handoff artifact path is configured for ${description}`);
  return [
    "## Required Handoff Artifact",
    `Write the completed ${description} to this exact workspace-local path before finishing: \`${path}\``,
    "Do not use another path. The workflow records only this artifact.",
  ].join("\n");
}

export function reviewContext(node: WikiNode, run: WikiRunSnapshot): string {
  const synthesisNodeId = synthesisNodeIdFor(node, run);
  return [
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
