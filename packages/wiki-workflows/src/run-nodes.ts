/**
 * Typed node inputs, parsers, path helpers, fingerprints, and pure engine utilities.
 *
 * Pure module: no @earendil-works/* or executor imports.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WikiArtifactKind, WikiArtifactRef } from "./artifact-store.js";
import {
  parseReviewSubmission,
  parseSynthesisSubmission,
} from "./control-submissions.js";
import { DEFAULT_WIKI_WORKFLOW_POLICY } from "./policy.js";
import type { WikiInspection, WikiValidation, WikiValidationIssue } from "./types.js";
import { clone, isRecord, pathIsInside, stableStringify, uniqueStrings } from "./util.js";
import {
  type WikiNode,
  type WikiNodeHistoryEntry,
  type WikiNodeKind,
  type WikiNodeMetrics,
  type WikiResearchArtifact,
  type WikiResearchFinding,
  type WikiResearchReceipt,
  type WikiResearchScope,
  type WikiReviewDefect,
  type WikiRunSnapshot,
  type WikiSpec,
  type WikiSynthesisResult,
} from "./workflow-types.js";

const MAX_NODE_OUTPUT_CHARS = DEFAULT_WIKI_WORKFLOW_POLICY.maxNodeOutputChars;
const MAX_NODE_HISTORY_ENTRIES = DEFAULT_WIKI_WORKFLOW_POLICY.maxNodeHistoryEntries;
const MAX_NODE_HISTORY_CHARS = DEFAULT_WIKI_WORKFLOW_POLICY.maxNodeHistoryChars;

export function roleFor(kind: WikiNodeKind): "researcher" | "synthesizer" | "writer" | "reviewer" {
  if (kind === "research") return "researcher";
  if (kind === "synthesis") return "synthesizer";
  if (kind === "write") return "writer";
  if (kind === "review") return "reviewer";
  throw new Error(`Node ${kind} is not agent-executed`);
}

export function artifactKindForNode(kind: WikiNodeKind): WikiArtifactKind | undefined {
  if (kind === "inspect") return "inspection";
  if (kind === "research") return "research";
  if (kind === "synthesis") return "synthesis";
  if (kind === "validate") return "validation";
  if (kind === "review") return "review";
  if (kind === "write") return "write_report";
  if (kind === "finalize") return "finalization";
  return undefined;
}

export function normalizeNodeResult(kind: WikiNodeKind, value: unknown): unknown {
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
    case "write":
      return value;
    case "research":
      throw new Error("Research results must be projected after pre-persist validation");
  }
}

export function parseInspection(value: unknown): WikiInspection {
  if (!isRecord(value) || typeof value.root !== "string" || typeof value.sourceFingerprint !== "string"
    || !isStringArray(value.sourcePaths) || value.sourcePaths.length === 0
    || (value.mode !== "generate" && value.mode !== "refresh")) {
    throw new Error("Inspect returned an invalid Wiki inspection");
  }
  return {
    ...value,
    sourcePaths: uniqueStrings(value.sourcePaths),
    existingPages: isStringArray(value.existingPages) ? uniqueStrings(value.existingPages).sort() : [],
    refreshRequiresGenerateReason: typeof value.refreshRequiresGenerateReason === "string"
      ? value.refreshRequiresGenerateReason
      : undefined,
  } as WikiInspection;
}

export function parseValidation(value: unknown): WikiValidation {
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

export function isValidationIssue(value: unknown): value is WikiValidationIssue {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string"
    && (value.page === undefined || typeof value.page === "string");
}

export interface ResearchNodeInput {
  batch: number;
  scope: WikiResearchScope;
  researchGroupId: string;
  priorResearchIds: string[];
  continuationMode: "initial" | "supplemental" | "structural" | "audit";
  dryAuditPasses: number;
  priorSynthesisNodeId?: string;
  structuralRoundId?: string;
  trigger?: unknown;
}

export interface SynthesisNodeInput {
  researchIds: string[];
  supplementalBatch: number;
  mode: "initial" | "supplemental" | "structural" | "audit";
  dryAuditPasses: number;
  round: number;
  inspection?: WikiInspection;
  focus?: string;
  priorSynthesisNodeId?: string;
  structuralRoundId?: string;
  trigger?: unknown;
}

export interface QueueSynthesisInput {
  dependsOn: string[];
  researchIds: string[];
  supplementalBatch: number;
  mode: SynthesisNodeInput["mode"];
  dryAuditPasses: number;
  priorSynthesisNodeId?: string;
  structuralRoundId?: string;
  trigger?: unknown;
}

export interface PagePacketInput {
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

/**
 * Known per-kind queue inputs. Full discriminant `WikiNode` remains incremental;
 * runtime `parseNodeInput` at queue boundaries is the enforcement contract.
 */
export type WikiNodeInputByKind = {
  research: ResearchNodeInput;
  synthesis: SynthesisNodeInput;
  write: PagePacketInput;
  inspect: Record<string, unknown>;
  validate: Record<string, unknown>;
  review: Record<string, unknown>;
  finalize: Record<string, unknown>;
};

/** Parse and normalize node input for a kind; throws on invalid known shapes. */
export function parseNodeInput<K extends WikiNodeKind>(kind: K, value: unknown): WikiNodeInputByKind[K] {
  switch (kind) {
    case "research":
      return parseResearchNodeInput(value) as WikiNodeInputByKind[K];
    case "synthesis":
      return parseSynthesisNodeInput(value) as WikiNodeInputByKind[K];
    case "write":
      return parsePagePacketInput(value) as WikiNodeInputByKind[K];
    case "inspect":
    case "validate":
    case "review":
    case "finalize":
      if (!isRecord(value)) throw new Error(`${kind} node has an invalid input`);
      return value as WikiNodeInputByKind[K];
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown node kind: ${String(_exhaustive)}`);
    }
  }
}

export function parseResearchNodeInput(value: unknown): ResearchNodeInput {
  if (!isRecord(value) || !Number.isInteger(value.batch) || (value.batch as number) < 0
    || (value.continuationMode !== "initial" && value.continuationMode !== "supplemental" && value.continuationMode !== "structural" && value.continuationMode !== "audit")
    || !Number.isInteger(value.dryAuditPasses) || (value.dryAuditPasses as number) < 0
    || !isRecord(value.scope)
    || typeof value.scope.id !== "string" || !value.scope.id.trim() || typeof value.scope.task !== "string" || !value.scope.task.trim()
    || !Array.isArray(value.scope.sourcePaths) || value.scope.sourcePaths.length === 0 || !value.scope.sourcePaths.every((entry) => typeof entry === "string" && entry.trim())
    || typeof value.researchGroupId !== "string" || !value.researchGroupId
    || !Array.isArray(value.priorResearchIds) || !value.priorResearchIds.every((id) => typeof id === "string")) {
    throw new Error("Research node has an invalid input");
  }
  const continuationMode = value.continuationMode as ResearchNodeInput["continuationMode"];
  return {
    batch: value.batch as number,
    scope: {
      id: value.scope.id,
      sourcePaths: uniqueStrings(value.scope.sourcePaths as string[]),
      task: value.scope.task,
    },
    researchGroupId: value.researchGroupId,
    priorResearchIds: [...(value.priorResearchIds as string[])],
    continuationMode,
    dryAuditPasses: value.dryAuditPasses as number,
    priorSynthesisNodeId: typeof value.priorSynthesisNodeId === "string" ? value.priorSynthesisNodeId : undefined,
    structuralRoundId: typeof value.structuralRoundId === "string" ? value.structuralRoundId : undefined,
    trigger: value.trigger,
  };
}

export function researchInputFor(node: WikiNode): ResearchNodeInput {
  return parseResearchNodeInput(node.input);
}

export function sameResearchBatch(node: WikiNode, expected: ResearchNodeInput): boolean {
  try {
    const input = researchInputFor(node);
    return input.researchGroupId === expected.researchGroupId;
  } catch {
    return false;
  }
}

export function parseSynthesisNodeInput(value: unknown): SynthesisNodeInput {
  if (!isRecord(value) || !Number.isInteger(value.supplementalBatch) || (value.supplementalBatch as number) < 0 || !Number.isInteger(value.round)
    || (value.mode !== "initial" && value.mode !== "supplemental" && value.mode !== "structural" && value.mode !== "audit")
    || !Number.isInteger(value.dryAuditPasses) || (value.dryAuditPasses as number) < 0
    || !Array.isArray(value.researchIds) || !value.researchIds.every((id) => typeof id === "string")) {
    throw new Error("Synthesis node has an invalid input");
  }
  return {
    researchIds: [...(value.researchIds as string[])],
    supplementalBatch: value.supplementalBatch as number,
    mode: value.mode as SynthesisNodeInput["mode"],
    dryAuditPasses: value.dryAuditPasses as number,
    round: value.round as number,
    inspection: isRecord(value.inspection) ? value.inspection as unknown as WikiInspection : undefined,
    focus: typeof value.focus === "string" ? value.focus : undefined,
    priorSynthesisNodeId: typeof value.priorSynthesisNodeId === "string" ? value.priorSynthesisNodeId : undefined,
    structuralRoundId: typeof value.structuralRoundId === "string" ? value.structuralRoundId : undefined,
    trigger: value.trigger,
  };
}

export function synthesisInputFor(node: WikiNode): SynthesisNodeInput {
  return parseSynthesisNodeInput(node.input);
}

export function parsePagePacketInput(value: unknown): PagePacketInput {
  if (!isRecord(value) || (value.intent !== "draft" && value.intent !== "overview" && value.intent !== "repair")
    || typeof value.synthesisNodeId !== "string" || typeof value.domainId !== "string" || !isSpecPage(value.page)
    || !Array.isArray(value.researchIds) || !value.researchIds.every((id) => typeof id === "string")
    || !Array.isArray(value.writePaths) || value.writePaths.length !== 1 || !value.writePaths.every((entry) => typeof entry === "string")
    || !Array.isArray(value.wikiReadPaths) || !value.wikiReadPaths.every((entry) => typeof entry === "string")
    || typeof value.writeGroupId !== "string" || !value.writeGroupId
    || (value.checkNoProgress === true && typeof value.beforeSha256 !== "string")) {
    throw new Error("write node has an invalid page packet");
  }
  return {
    intent: value.intent,
    synthesisNodeId: value.synthesisNodeId,
    domainId: value.domainId,
    page: clone(value.page),
    researchIds: [...value.researchIds],
    writePaths: [...value.writePaths],
    wikiReadPaths: [...value.wikiReadPaths],
    writeGroupId: value.writeGroupId,
    repairRound: typeof value.repairRound === "number" ? value.repairRound : undefined,
    feedback: value.feedback,
    beforeSha256: typeof value.beforeSha256 === "string" ? value.beforeSha256 : undefined,
    checkNoProgress: value.checkNoProgress === true,
  };
}

export function pagePacketInputFor(node: WikiNode): PagePacketInput {
  try {
    return parsePagePacketInput(node.input);
  } catch {
    throw new Error(`${node.kind} node has an invalid page packet`);
  }
}

export function safePagePacketInput(node: WikiNode): PagePacketInput | undefined {
  try {
    return pagePacketInputFor(node);
  } catch {
    return undefined;
  }
}

export function writePathsFor(node: WikiNode): string[] | undefined {
  if (node.kind !== "write") return undefined;
  return pagePacketInputFor(node).writePaths;
}

/** Every agent receives only the source roots needed for its assigned work. */
export function readRootsFor(node: WikiNode, run: WikiRunSnapshot): string[] | undefined {
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
export function wikiReadPathsFor(node: WikiNode, run: WikiRunSnapshot): string[] | undefined {
  if (node.kind === "write") return pagePacketInputFor(node).wikiReadPaths;
  if (node.kind === "synthesis" && run.effectiveMode === "refresh") {
    return (run.inspection?.existingPages ?? []).map(workspaceWikiPath);
  }
  if (node.kind !== "review") return undefined;
  const spec = specForSynthesis(run, synthesisNodeIdFor(node, run));
  return uniqueStrings([
    "wiki/index.md",
    ...specPages(spec).map(({ page }) => workspaceWikiPath(page.path)),
    ...derivedIndexWikiPaths(spec),
    ...(run.inspection?.existingPages ?? []).map(workspaceWikiPath),
  ]);
}

export function derivedIndexWikiPaths(spec: WikiSpec): string[] {
  const directories = new Set<string>();
  for (const { page } of specPages(spec)) {
    let directory = path.posix.dirname(page.path);
    while (directory && directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories].sort().map((directory) => `wiki/${directory}/index.md`);
}

/** Coordinator-authored evidence of the exact pages a writer was assigned. */
export async function writeReport(
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

export function workspaceWikiPath(pagePath: string): string {
  const result = `wiki/${pagePath}`;
  if (result === "wiki/index.md") throw new Error("Page writers may not write the root Wiki index");
  return result;
}

export function synthesisNodeIdFor(node: WikiNode, run: WikiRunSnapshot): string {
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

export function specForSynthesis(run: WikiRunSnapshot, synthesisNodeId: string): WikiSpec {
  const node = run.nodes.find((candidate) => candidate.id === synthesisNodeId && candidate.kind === "synthesis");
  if (!node || !isSynthesisFinalizeResult(node.result)) throw new Error(`No finalized WikiSpec exists for synthesis node ${synthesisNodeId}`);
  return node.result.spec;
}

export function isSynthesisFinalizeResult(value: unknown): value is Extract<WikiSynthesisResult, { decision: "finalize" }> {
  return isRecord(value) && value.decision === "finalize" && isRecord(value.spec)
    && Array.isArray(value.spec.domains)
    && Array.isArray(value.spec.crossLinks)
    && Array.isArray(value.spec.sharedTerms)
    && Array.isArray(value.spec.omissions);
}

export function ensureReviewTargets(defects: WikiReviewDefect[], spec: WikiSpec): void {
  const pages = new Set(specPages(spec).map(({ page }) => page.path));
  for (const defect of defects) {
    if ("page" in defect && !pages.has(normalizePagePath(defect.page))) throw new Error(`Review defect targets unknown page: ${defect.page}`);
  }
}

export function repairInputForPage(input: Record<string, unknown>, pagePath: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const review = input.review;
  if (isRecord(review) && Array.isArray(review.defects)) {
    result.review = { defects: review.defects.filter((defect) => isRecord(defect) && defect.page === pagePath) };
  }
  const validation = input.validation;
  if (isRecord(validation) && Array.isArray(validation.issues)) {
    result.validation = { issues: validation.issues.filter((issue) => isRecord(issue) && issue.page === pagePath) };
  }
  return Object.keys(result).length ? result : input;
}

export function structuralFeedbackForPage(trigger: unknown, pagePath: string): Record<string, unknown> | undefined {
  if (!isRecord(trigger)) return undefined;
  const result = repairInputForPage(trigger, pagePath);
  return result === trigger ? undefined : result;
}

export function specPages(spec: WikiSpec): Array<{ domain: WikiSpec["domains"][number]; page: WikiSpec["domains"][number]["pages"][number] }> {
  return spec.domains.flatMap((domain) => domain.pages.map((page) => ({ domain, page })));
}

export function overviewPage(spec: WikiSpec): ReturnType<typeof specPages>[number] {
  const overviews = specPages(spec).filter(({ page }) => page.pageType === "overview" && page.path === "overview/overview.md");
  if (overviews.length !== 1) throw new Error("WikiSpec must contain exactly one overview/overview.md page");
  return overviews[0]!;
}

export function normalizePagePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^wiki\//, "");
}

export function shouldWriteContentPage(run: WikiRunSnapshot, pagePath: string, synthesisMode: SynthesisNodeInput["mode"]): boolean {
  if (run.effectiveMode === "generate" || synthesisMode === "structural") return true;
  const target = normalizePagePath(pagePath);
  const existing = new Set((run.inspection?.existingPages ?? []).map(normalizePagePath));
  const impacted = new Set((run.inspection?.impactedPages ?? []).map(normalizePagePath));
  return !existing.has(target) || impacted.has(target);
}

export function relatedWikiPaths(spec: WikiSpec, pagePath: string, readableRelatedPaths: ReadonlySet<string>): string[] {
  const paths = spec.crossLinks
    .flatMap((link) => link.fromPath === pagePath ? [link.toPath] : link.toPath === pagePath ? [link.fromPath] : [])
    .filter((candidate) => readableRelatedPaths.has(candidate));
  return uniqueStrings([workspaceWikiPath(pagePath), ...paths.map(workspaceWikiPath)]);
}

export function relativeWikiHref(fromPath: string, toPath: string): string {
  return path.posix.relative(path.posix.dirname(fromPath), toPath);
}

export function routeReviewDefects(review: { defects: WikiReviewDefect[]; summary: string }, spec: WikiSpec): Record<string, unknown> {
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

export function researchIdsForPage(run: WikiRunSnapshot, page: WikiSpec["domains"][number]["pages"][number]): string[] {
  return selectResearchIdsForFindings([...run.nodes].reverse().filter((candidate) => candidate.kind === "research"
    && candidate.status === "succeeded" && isResearchReceipt(candidate.result)), page);
}

export function selectResearchIdsForFindings(
  researchNodes: WikiNode[],
  page: WikiSpec["domains"][number]["pages"][number],
): string[] {
  const selected: string[] = [];
  for (const findingId of page.findingIds) {
    const candidates = researchNodes.filter((candidate) => isResearchReceipt(candidate.result)
      && candidate.result.findings.some((finding) => finding.id === findingId));
    candidates.sort((left, right) => researchInputFor(left).scope.sourcePaths.length - researchInputFor(right).scope.sourcePaths.length);
    const research = candidates[0];
    if (!research) throw new Error(`No completed research receipt exists for page ${page.path} finding ${findingId}`);
    selected.push(research.id);
  }
  return uniqueStrings(selected);
}

export async function hashWikiPage(cwd: string, pagePath: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(path.resolve(cwd, workspaceWikiPath(pagePath)));
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

export function isSpecPage(value: unknown): value is WikiSpec["domains"][number]["pages"][number] {
  return isRecord(value)
    && typeof value.pageType === "string"
    && ["overview", "architecture", "module", "flow", "concept"].includes(value.pageType)
    && typeof value.path === "string" && typeof value.title === "string" && typeof value.purpose === "string"
    && isStringArray(value.findingIds);
}

export function isSourceDriftResult(value: unknown): value is { sourceDrift: true; inspection: WikiInspection } {
  return isRecord(value) && value.sourceDrift === true && isRecord(value.inspection)
    && typeof value.inspection.sourceFingerprint === "string";
}

export function recordStringArray(value: unknown, key: string): string[] {
  return isRecord(value) && Array.isArray(value[key]) && value[key].every((item) => typeof item === "string")
    ? value[key] as string[]
    : [];
}

export function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return [...left].sort().every((item, index) => item === [...right].sort()[index]);
}

export function isResearchReceipt(value: unknown): value is WikiResearchReceipt {
  return isRecord(value)
    && typeof value.scopeId === "string"
    && typeof value.task === "string"
    && typeof value.sourceFingerprint === "string"
    && Array.isArray(value.findings) && value.findings.every((finding) => isRecord(finding)
      && typeof finding.id === "string"
      && (finding.priority === "critical" || finding.priority === "normal")
      && typeof finding.contentFingerprint === "string")
    && isStringArray(value.criticalGapSignatures)
    && isStringArray(value.criticalGapQuestions)
    && isArtifactRef(value.artifact);
}

export function isArtifactRef(value: unknown): value is WikiArtifactRef {
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

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function inspectionFingerprint(inspection: WikiInspection): string {
  return stableStringify({
    changed: inspection.changed,
    changedPaths: inspection.changedPaths,
    sourcePaths: inspection.sourcePaths,
    sourceFingerprint: inspection.sourceFingerprint,
  });
}

export function retainedOutput(output: string | undefined): string | undefined {
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

export function retainedHistory(history: WikiNodeHistoryEntry[] | undefined): WikiNodeHistoryEntry[] | undefined {
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

export function retainedText(text: string, limit: number): string {
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

export function defectsFingerprint(defects: WikiReviewDefect[]): string {
  return stableStringify(defects.map((defect) => ({
    page: "page" in defect ? normalizePagePath(defect.page) : undefined,
    kind: defect.kind,
    detail: normalizeIssueText(defect.detail),
  })).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))));
}

export function validationIssuesFingerprint(issues: WikiValidationIssue[]): string {
  return stableStringify(issues.map((issue) => ({
    code: issue.code.trim().toLowerCase(),
    page: issue.page ? normalizePagePath(issue.page) : undefined,
    message: normalizeIssueText(issue.message),
  })).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))));
}

export function isStructuralValidationIssue(issue: WikiValidationIssue): boolean {
  return issue.code === "spec-page" || issue.code === "wiki-index" || issue.code === "cross-link";
}

export function normalizeIssueText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function mergeMetrics(current: WikiNodeMetrics, update?: Partial<WikiNodeMetrics>, incremental = false): WikiNodeMetrics {
  if (!update) return current;
  const next = { ...current, ...update };
  if (incremental) {
    if (update.compactions !== undefined) next.compactions = current.compactions + update.compactions;
    if (update.autoRetries !== undefined) next.autoRetries = current.autoRetries + update.autoRetries;
  }
  return next;
}

export function valueIs(value: unknown, key: string, expected: unknown): boolean {
  return isRecord(value) && value[key] === expected;
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

export function normalizeText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

export function isMissingArtifactError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Required ") && error.message.includes(" handoff artifact is missing:");
}

export function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
