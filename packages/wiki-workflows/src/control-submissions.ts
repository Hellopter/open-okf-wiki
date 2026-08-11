import { Buffer } from "node:buffer";
import { Type } from "typebox";
import { DEFAULT_WIKI_WORKFLOW_POLICY } from "./policy.js";
import { parseEvidenceReference as parseEvidenceReferenceShape } from "./research-evidence.js";
import type {
  WikiResearchArtifact,
  WikiReviewDefect,
  WikiReviewResult,
  WikiSpec,
  WikiSynthesisResult,
} from "./workflow-types.js";
import { isSafeWikiPagePath } from "./wiki-path.js";

/** Maximum UTF-8 size of a structured research artifact. */
export const MAX_RESEARCH_ARTIFACT_BYTES = DEFAULT_WIKI_WORKFLOW_POLICY.artifacts.researchBytes;
/** Maximum UTF-8 size of a synthesis or review JSON artifact. */
export const MAX_CONTROL_ARTIFACT_BYTES = DEFAULT_WIKI_WORKFLOW_POLICY.artifacts.controlBytes;

/**
 * The tool protocol transports only a pointer. Its literal path keeps strict
 * providers from accepting a stale or arbitrary workspace file.
 */
export function artifactSubmissionSchema(artifactPath: string) {
  return Type.Object({
    artifactPath: Type.Literal(artifactPath, { description: "Exact handoff artifact path supplied for this node" }),
  }, { additionalProperties: false });
}

export class WikiControlSubmissionSizeError extends Error {
  readonly code = "submission_too_large";

  constructor(
    readonly label: string,
    readonly sizeBytes: number,
    readonly limitBytes = MAX_CONTROL_ARTIFACT_BYTES,
  ) {
    super(`${label} exceeds the ${limitBytes}-byte control payload limit`);
  }
}

/** Validate a pointer-only control call before reading its expected artifact. */
export function parseArtifactSubmission(value: unknown, expectedArtifactPath: string): string {
  assertControlSubmissionSize(value, "Control submission");
  if (!isRecord(value) || value.artifactPath !== expectedArtifactPath || Object.keys(value).length !== 1) {
    throw new Error(`Control submission must reference the exact artifact path: ${expectedArtifactPath}`);
  }
  return expectedArtifactPath;
}

/** Decode and validate the JSON artifact that carries a synthesis result. */
export function parseSynthesisArtifact(content: string): WikiSynthesisResult {
  return parseSynthesisSubmission(parseJsonArtifact(content, "Synthesis artifact"));
}

/** Decode and validate the JSON artifact that carries one bounded research result. */
export function parseResearchArtifact(content: string): WikiResearchArtifact {
  return parseResearchSubmission(parseJsonArtifact(content, "Research artifact"));
}

/** Decode and validate the JSON artifact that carries a review result. */
export function parseReviewArtifact(content: string): WikiReviewResult {
  return parseReviewSubmission(parseJsonArtifact(content, "Review artifact"));
}

/** Validate an opaque Markdown handoff without normalizing its bytes. */
export function parseMarkdownArtifact(content: string, label = "Markdown artifact"): string {
  assertTextArtifactSize(content, label, MAX_RESEARCH_ARTIFACT_BYTES);
  if (!content.trim()) throw new Error(`${label} must contain Markdown`);
  return content;
}

export function parseResearchSubmission(value: unknown): WikiResearchArtifact {
  assertControlSubmissionSize(value, "Research submission");
  if (!isRecord(value)) throw new Error("Research submission must be an object");
  assertExactKeys(value, ["summary", "findings", "gaps"], "Research submission");
  if (!Array.isArray(value.findings) || !Array.isArray(value.gaps)) {
    throw new Error("Research submission must include findings and gaps arrays");
  }
  const findingKeys = new Set<string>();
  const findings = value.findings.map((finding) => {
    if (!isRecord(finding)) throw new Error("Research submission contains an invalid finding");
    assertExactKeys(finding, ["kind", "title", "readerQuestion", "priority", "evidence"], "Research finding");
    if (!isFindingKind(finding.kind)) throw new Error("Research finding kind is invalid");
    if (!isPriority(finding.priority)) throw new Error("Research finding priority is invalid");
    if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
      throw new Error("Research finding evidence must be a non-empty array");
    }
    const evidence = [...new Set(finding.evidence.map((item) => parseEvidenceReference(item, "Research finding evidence")))];
    const parsed = {
      kind: finding.kind,
      title: requiredText(finding.title, "Research finding title"),
      readerQuestion: requiredText(finding.readerQuestion, "Research finding reader question"),
      priority: finding.priority,
      evidence,
    };
    const key = `${parsed.kind}\u0000${[...evidence].sort().join("\u0000")}`;
    if (findingKeys.has(key)) throw new Error("Research submission repeats a finding with the same kind and evidence");
    findingKeys.add(key);
    return parsed;
  });
  const gaps = value.gaps.map((gap) => {
    if (!isRecord(gap)) throw new Error("Research submission contains an invalid gap");
    assertExactKeys(gap, ["question", "priority", "sourcePaths"], "Research gap");
    if (!isPriority(gap.priority)) throw new Error("Research gap priority is invalid");
    if (!Array.isArray(gap.sourcePaths) || gap.sourcePaths.length === 0) {
      throw new Error("Research gap sourcePaths must be a non-empty array");
    }
    return {
      question: requiredText(gap.question, "Research gap question"),
      priority: gap.priority,
      sourcePaths: [...new Set(gap.sourcePaths.map((item) => requiredText(item, "Research gap source path")))],
    };
  });
  return { summary: requiredText(value.summary, "Research summary"), findings, gaps };
}

/** Canonicalize the synthesis decision before it can expand or finalize the DAG. */
export function parseSynthesisSubmission(value: unknown): WikiSynthesisResult {
  assertControlSubmissionSize(value, "Synthesis submission");
  if (!isRecord(value) || (value.decision !== "expand" && value.decision !== "finalize")) {
    throw new Error("Synthesis submission must choose expand or finalize");
  }
  const synthesisRationale = requiredText(value.rationale, "Synthesis rationale");
  if (value.decision === "expand") {
    assertExactKeys(value, ["decision", "researchScopes", "rationale"], "Synthesis expansion");
    if (hasOwn(value, "spec")) throw new Error("Synthesis expansion must not include spec");
    if (!Array.isArray(value.researchScopes)) throw new Error("Synthesis expansion must include researchScopes");
    if (value.researchScopes.length === 0) throw new Error("Synthesis must request at least one supplemental research scope");
    return { decision: "expand", researchScopes: parseResearchScopes(value.researchScopes, "Synthesis"), rationale: synthesisRationale };
  }
  assertExactKeys(value, ["decision", "spec", "rationale"], "Final synthesis");
  if (hasOwn(value, "researchScopes")) throw new Error("Final synthesis must not include researchScopes");
  if (!hasOwn(value, "spec")) throw new Error("Final synthesis must include spec");
  return { decision: "finalize", spec: parseWikiSpec(value.spec), rationale: synthesisRationale };
}

/** Canonicalize the reviewer's typed control submission before it changes the DAG. */
export function parseReviewSubmission(value: unknown): WikiReviewResult {
  assertControlSubmissionSize(value, "Reviewer submission");
  if (!isRecord(value)) throw new Error("Reviewer submission must be an object");
  assertExactKeys(value, ["defects", "summary"], "Reviewer submission");
  if (!Array.isArray(value.defects)) throw new Error("Reviewer submission must include defects as an array");
  const summary = requiredText(value.summary, "Review summary");
  const defects = value.defects.map((defect) => {
    if (!isRecord(defect) || !isReviewKind(defect.kind)) throw new Error("Reviewer returned an invalid defect");
    if (isLocalReviewKind(defect.kind)) {
      assertExactKeys(defect, ["kind", "page", "detail"], "Local review defect");
      return {
        kind: defect.kind,
        page: parseWikiPath(defect.page, "Review defect page"),
        detail: requiredText(defect.detail, "Review defect detail"),
      };
    }
    assertExactKeys(defect, ["kind", "detail"], "Structural review defect");
    return {
      kind: defect.kind,
      detail: requiredText(defect.detail, "Review defect detail"),
    };
  });
  return { defects, summary };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`);
  return value.trim();
}

function parseWikiSpec(value: unknown): WikiSpec {
  if (!isRecord(value)) throw new Error("Final WikiSpec must be an object");
  assertAllowedKeys(value, ["domains", "crossLinks", "sharedTerms", "omissions"], "Final WikiSpec");
  if (!Array.isArray(value.domains)) throw new Error("Final WikiSpec must include domains as an array");
  const crossLinkValues = value.crossLinks === undefined ? [] : value.crossLinks;
  const sharedTermValues = value.sharedTerms === undefined ? [] : value.sharedTerms;
  const omissionValues = value.omissions === undefined ? [] : value.omissions;
  if (!Array.isArray(crossLinkValues)) throw new Error("Final WikiSpec crossLinks must be an array when provided");
  if (!Array.isArray(sharedTermValues)) throw new Error("Final WikiSpec sharedTerms must be an array when provided");
  if (!Array.isArray(omissionValues)) throw new Error("Final WikiSpec omissions must be an array when provided");
  const domainIds = new Set<string>();
  const pagePaths = new Set<string>();
  const domains = value.domains.map((domain) => {
    if (!isRecord(domain) || !Array.isArray(domain.pages)) throw new Error("WikiSpec contains an invalid domain");
    assertExactKeys(domain, ["id", "title", "purpose", "pages"], "WikiSpec domain");
    const id = parseDomainId(domain.id, "WikiSpec domain ID");
    if (domainIds.has(id)) throw new Error(`WikiSpec contains duplicate domain ID: ${id}`);
    domainIds.add(id);
    if (domain.pages.length === 0) throw new Error(`WikiSpec domain ${id} must include at least one page`);
    const pages = domain.pages.map((page) => parseSpecPage(page, id, pagePaths));
    return {
      id,
      title: requiredText(domain.title, `WikiSpec domain title for ${id}`),
      purpose: requiredText(domain.purpose, `WikiSpec domain purpose for ${id}`),
      pages,
    };
  });
  if (domains.length === 0) throw new Error("WikiSpec must include at least one domain");
  const overviewDomain = domains.find((domain) => domain.id === "overview");
  const overviewPages = domains.flatMap((domain) => domain.pages.filter((page) => page.pageType === "overview"));
  if (!overviewDomain || overviewDomain.pages.length !== 1 || overviewPages.length !== 1
    || overviewDomain.pages[0] !== overviewPages[0] || overviewPages[0].path !== "overview/overview.md") {
    throw new Error("WikiSpec must contain exactly one receipt-free overview page at overview/overview.md");
  }
  if (overviewPages[0].findingIds.length !== 0) {
    throw new Error("WikiSpec overview page must not select research findings");
  }
  if (pagePaths.size < 2) throw new Error("WikiSpec must contain at least one content page in addition to Overview");

  const linkKeys = new Set<string>();
  const crossLinks = crossLinkValues.map((link) => {
    if (!isRecord(link)) throw new Error("WikiSpec contains an invalid cross-link");
    assertExactKeys(link, ["fromPath", "toPath", "purpose"], "WikiSpec cross-link");
    const fromPath = parseWikiPath(link.fromPath, "WikiSpec cross-link source");
    const toPath = parseWikiPath(link.toPath, "WikiSpec cross-link target");
    if (!pagePaths.has(fromPath) || !pagePaths.has(toPath)) throw new Error(`WikiSpec cross-link must target declared pages: ${fromPath} -> ${toPath}`);
    const key = `${fromPath}\u0000${toPath}`;
    if (linkKeys.has(key)) throw new Error(`WikiSpec repeats cross-link: ${fromPath} -> ${toPath}`);
    linkKeys.add(key);
    return { fromPath, toPath, purpose: requiredText(link.purpose, `WikiSpec cross-link purpose for ${fromPath}`) };
  });
  const termNames = new Set<string>();
  const sharedTerms = sharedTermValues.map((term) => {
    if (!isRecord(term)) throw new Error("WikiSpec contains an invalid shared term");
    assertExactKeys(term, ["term", "definition"], "WikiSpec shared term");
    const name = requiredText(term.term, "WikiSpec shared term");
    if (termNames.has(name)) throw new Error(`WikiSpec repeats shared term: ${name}`);
    termNames.add(name);
    return { term: name, definition: requiredText(term.definition, `WikiSpec definition for ${name}`) };
  });
  const omittedIds = new Set<string>();
  const omissions = omissionValues.map((omission) => {
    if (!isRecord(omission)) throw new Error("WikiSpec contains an invalid omission");
    assertExactKeys(omission, ["findingId", "rationale"], "WikiSpec omission");
    const findingId = requiredText(omission.findingId, "WikiSpec omission finding ID");
    if (omittedIds.has(findingId)) throw new Error(`WikiSpec repeats omission: ${findingId}`);
    omittedIds.add(findingId);
    return { findingId, rationale: requiredText(omission.rationale, `WikiSpec omission rationale for ${findingId}`) };
  });
  return { domains, crossLinks, sharedTerms, omissions };
}

function parseSpecPage(value: unknown, domainId: string, pagePaths: Set<string>) {
  if (!isRecord(value) || !Array.isArray(value.findingIds)) {
    throw new Error(`WikiSpec domain ${domainId} contains an invalid page`);
  }
  assertExactKeys(value, ["pageType", "path", "title", "purpose", "findingIds"], `WikiSpec page in ${domainId}`);
  const path = parseWikiPath(value.path, `WikiSpec page path for ${domainId}`);
  if (!path.startsWith(`${domainId}/`)) {
    throw new Error(`WikiSpec page ${path} must be contained by its domain directory ${domainId}/`);
  }
  if (pagePaths.has(path)) throw new Error(`WikiSpec repeats page path: ${path}`);
  pagePaths.add(path);
  const findingIdSet = new Set<string>();
  const findingIds = value.findingIds.map((findingId) => {
    const parsed = requiredText(findingId, `WikiSpec finding for ${path}`);
    if (findingIdSet.has(parsed)) throw new Error(`WikiSpec page ${path} repeats finding: ${parsed}`);
    findingIdSet.add(parsed);
    return parsed;
  });
  const pageType = parsePageType(value.pageType, `WikiSpec page type for ${path}`);
  if (pageType === "overview" && path !== "overview/overview.md") throw new Error("WikiSpec overview page must be overview/overview.md");
  if (pageType !== "overview" && findingIds.length === 0) throw new Error(`WikiSpec page ${path} must select research findings`);
  return {
    pageType,
    path,
    title: requiredText(value.title, `WikiSpec page title for ${path}`),
    purpose: requiredText(value.purpose, `WikiSpec page purpose for ${path}`),
    findingIds,
  };
}

function parseEvidenceReference(value: unknown, label: string): string {
  const reference = requiredText(value, label);
  return parseEvidenceReferenceShape(reference, label).raw;
}

function isFindingKind(value: unknown): value is WikiResearchArtifact["findings"][number]["kind"] {
  return value === "domain" || value === "concept" || value === "flow" || value === "boundary" || value === "state-data";
}

function isPriority(value: unknown): value is WikiResearchArtifact["gaps"][number]["priority"] {
  return value === "critical" || value === "normal";
}

function parsePageType(value: unknown, label: string): "overview" | "architecture" | "module" | "flow" | "concept" {
  if (value === "overview" || value === "architecture" || value === "module" || value === "flow" || value === "concept") return value;
  throw new Error(`${label} is invalid`);
}

function parseResearchScopes(value: unknown[], owner: string) {
  const scopeIds = new Set<string>();
  return value.map((scope) => {
    if (!isRecord(scope)) throw new Error(`${owner} returned an invalid research scope`);
    assertExactKeys(scope, ["id", "sourcePaths", "task"], `${owner} research scope`);
    const id = requiredText(scope.id, "Research scope ID");
    if (scopeIds.has(id)) throw new Error(`${owner} returned duplicate research scope: ${id}`);
    scopeIds.add(id);
    if (!Array.isArray(scope.sourcePaths) || scope.sourcePaths.length === 0) {
      throw new Error(`${owner} research scope ${id} must include sourcePaths`);
    }
    const sourcePaths = new Set<string>();
    for (const sourcePath of scope.sourcePaths) {
      const parsed = requiredText(sourcePath, `Research source path for ${id}`);
      if (sourcePaths.has(parsed)) throw new Error(`${owner} research scope ${id} repeats source path: ${parsed}`);
      sourcePaths.add(parsed);
    }
    return { id, sourcePaths: [...sourcePaths], task: requiredText(scope.task, `Research task for ${id}`) };
  });
}

function parseWikiPath(value: unknown, label: string): string {
  const path = requiredText(value, label);
  if (!isSafeWikiPagePath(path)) throw new Error(`${label} is invalid: ${path}`);
  return path;
}

function parseDomainId(value: unknown, label: string): string {
  const id = requiredText(value, label);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`${label} is invalid: ${id}`);
  return id;
}

function isReviewKind(value: unknown): value is WikiReviewDefect["kind"] {
  return isLocalReviewKind(value) || value === "topology" || value === "coverage";
}

function isLocalReviewKind(value: unknown): value is "evidence" | "link" | "depth" | "diagram" {
  return value === "evidence" || value === "link" || value === "depth" || value === "diagram";
}

function assertControlSubmissionSize(value: unknown, label: string): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON-serializable`);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");
  if (sizeBytes > MAX_CONTROL_ARTIFACT_BYTES) {
    throw new WikiControlSubmissionSizeError(label, sizeBytes);
  }
}

function parseJsonArtifact(content: string, label: string): unknown {
  assertTextArtifactSize(content, label, MAX_CONTROL_ARTIFACT_BYTES);
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

function assertTextArtifactSize(content: string, label: string, limitBytes: number): void {
  if (typeof content !== "string") throw new Error(`${label} must be text`);
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > limitBytes) {
    throw new WikiControlSubmissionSizeError(label, sizeBytes, limitBytes);
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const actual = Object.keys(value);
  const unexpected = actual.find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${label} contains unsupported field: ${unexpected}`);
  const missing = keys.find((key) => !hasOwn(value, key));
  if (missing) throw new Error(`${label} must include ${missing}`);
}

function assertAllowedKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${label} contains unsupported field: ${unexpected}`);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
