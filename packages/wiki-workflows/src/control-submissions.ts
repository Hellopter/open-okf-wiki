import { Buffer } from "node:buffer";
import { Type } from "typebox";
import type {
  WikiDiagramKind,
  WikiReviewDefect,
  WikiReviewResult,
  WikiSpec,
  WikiSynthesisResult,
} from "./workflow-types.js";

/** Maximum research agents the engine dispatches concurrently. */
export const MAX_RESEARCH_SCOPES_PER_BATCH = 4;
/** Maximum UTF-8 size of a model-authored handoff artifact. */
export const MAX_CONTROL_ARTIFACT_BYTES = 1024 * 1024;

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

/** Decode and validate the JSON artifact that carries a review result. */
export function parseReviewArtifact(content: string): WikiReviewResult {
  return parseReviewSubmission(parseJsonArtifact(content, "Review artifact"));
}

/** Validate an opaque Markdown handoff without normalizing its bytes. */
export function parseMarkdownArtifact(content: string, label = "Markdown artifact"): string {
  assertTextArtifactSize(content, label);
  if (!content.trim()) throw new Error(`${label} must contain Markdown`);
  return content;
}

/** Canonicalize the synthesis decision before it can expand or finalize the DAG. */
export function parseSynthesisSubmission(value: unknown): WikiSynthesisResult {
  assertControlSubmissionSize(value, "Synthesis submission");
  if (!isRecord(value) || (value.decision !== "expand" && value.decision !== "finalize")) {
    throw new Error("Synthesis submission must choose expand or finalize");
  }
  const synthesisRationale = requiredText(value.rationale, "Synthesis rationale");
  if (value.decision === "expand") {
    if (hasOwn(value, "spec")) throw new Error("Synthesis expansion must not include spec");
    if (!Array.isArray(value.researchScopes)) throw new Error("Synthesis expansion must include researchScopes");
    if (value.researchScopes.length === 0 || value.researchScopes.length > MAX_RESEARCH_SCOPES_PER_BATCH) {
      throw new Error(`Synthesis may request 1 to ${MAX_RESEARCH_SCOPES_PER_BATCH} supplemental research scopes`);
    }
    return { decision: "expand", researchScopes: parseResearchScopes(value.researchScopes, "Synthesis"), rationale: synthesisRationale };
  }
  if (hasOwn(value, "researchScopes")) throw new Error("Final synthesis must not include researchScopes");
  if (!hasOwn(value, "spec")) throw new Error("Final synthesis must include spec");
  return { decision: "finalize", spec: parseWikiSpec(value.spec), rationale: synthesisRationale };
}

/** Canonicalize the reviewer's typed control submission before it changes the DAG. */
export function parseReviewSubmission(value: unknown): WikiReviewResult {
  assertControlSubmissionSize(value, "Reviewer submission");
  if (!isRecord(value)) throw new Error("Reviewer submission must be an object");
  if (!Array.isArray(value.defects)) throw new Error("Reviewer submission must include defects as an array");
  const summary = requiredText(value.summary, "Review summary");
  const defectIds = new Set<string>();
  const defects = value.defects.map((defect) => {
    if (!isRecord(defect) || !isReviewKind(defect.kind)) throw new Error("Reviewer returned an invalid defect");
    const id = requiredText(defect.id, "Review defect ID");
    if (defectIds.has(id)) throw new Error(`Reviewer returned duplicate defect ID: ${id}`);
    defectIds.add(id);
    return {
      id,
      domainId: requiredText(defect.domainId, `Review domain for ${id}`),
      page: requiredText(defect.page, `Review page for ${id}`),
      kind: defect.kind,
      detail: requiredText(defect.detail, `Review detail for ${id}`),
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
  if (!Array.isArray(value.domains)) throw new Error("Final WikiSpec must include domains as an array");
  if (!Array.isArray(value.crossLinks)) throw new Error("Final WikiSpec must include crossLinks as an array");
  if (!Array.isArray(value.sharedTerms)) throw new Error("Final WikiSpec must include sharedTerms as an array");
  const domainIds = new Set<string>();
  const pagePaths = new Set<string>();
  const domains = value.domains.map((domain) => {
    if (!isRecord(domain) || !Array.isArray(domain.pages) || !Array.isArray(domain.researchScopeIds)) throw new Error("WikiSpec contains an invalid domain");
    const id = parseDomainId(domain.id, "WikiSpec domain ID");
    if (domainIds.has(id)) throw new Error(`WikiSpec contains duplicate domain ID: ${id}`);
    domainIds.add(id);
    if (domain.pages.length === 0) throw new Error(`WikiSpec domain ${id} must include at least one page`);
    const scopeIds = new Set<string>();
    const researchScopeIds = domain.researchScopeIds.map((scopeId) => {
      const parsed = requiredText(scopeId, `WikiSpec research scope for ${id}`);
      if (scopeIds.has(parsed)) throw new Error(`WikiSpec domain ${id} repeats research scope: ${parsed}`);
      scopeIds.add(parsed);
      return parsed;
    });
    const pages = domain.pages.map((page) => parseSpecPage(page, id, pagePaths));
    return {
      id,
      title: requiredText(domain.title, `WikiSpec domain title for ${id}`),
      purpose: requiredText(domain.purpose, `WikiSpec domain purpose for ${id}`),
      pages,
      researchScopeIds,
    };
  });
  if (domains.length === 0) throw new Error("WikiSpec must include at least one domain");
  const overviewDomain = domains.find((domain) => domain.id === "overview");
  const overviewPages = domains.flatMap((domain) => domain.pages.filter((page) => page.pageType === "overview"));
  if (!overviewDomain || overviewDomain.pages.length !== 1 || overviewDomain.researchScopeIds.length !== 0 || overviewPages.length !== 1
    || overviewDomain.pages[0] !== overviewPages[0] || overviewPages[0].path !== "overview/overview.md") {
    throw new Error("WikiSpec must contain exactly one receipt-free overview page at overview/overview.md");
  }

  const linkKeys = new Set<string>();
  const crossLinks = value.crossLinks.map((link) => {
    if (!isRecord(link)) throw new Error("WikiSpec contains an invalid cross-link");
    const fromPath = parseWikiPath(link.fromPath, "WikiSpec cross-link source");
    const toPath = parseWikiPath(link.toPath, "WikiSpec cross-link target");
    if (!pagePaths.has(fromPath) || !pagePaths.has(toPath)) throw new Error(`WikiSpec cross-link must target declared pages: ${fromPath} -> ${toPath}`);
    const key = `${fromPath}\u0000${toPath}`;
    if (linkKeys.has(key)) throw new Error(`WikiSpec repeats cross-link: ${fromPath} -> ${toPath}`);
    linkKeys.add(key);
    return { fromPath, toPath, purpose: requiredText(link.purpose, `WikiSpec cross-link purpose for ${fromPath}`) };
  });
  const termNames = new Set<string>();
  const sharedTerms = value.sharedTerms.map((term) => {
    if (!isRecord(term)) throw new Error("WikiSpec contains an invalid shared term");
    const name = requiredText(term.term, "WikiSpec shared term");
    if (termNames.has(name)) throw new Error(`WikiSpec repeats shared term: ${name}`);
    termNames.add(name);
    return { term: name, definition: requiredText(term.definition, `WikiSpec definition for ${name}`) };
  });
  return { domains, crossLinks, sharedTerms };
}

function parseSpecPage(value: unknown, domainId: string, pagePaths: Set<string>) {
  if (!isRecord(value) || !Array.isArray(value.sources) || !Array.isArray(value.requiredSections) || !Array.isArray(value.diagrams)) {
    throw new Error(`WikiSpec domain ${domainId} contains an invalid page`);
  }
  const path = parseWikiPath(value.path, `WikiSpec page path for ${domainId}`);
  if (!path.startsWith(`${domainId}/`)) {
    throw new Error(`WikiSpec page ${path} must be contained by its domain directory ${domainId}/`);
  }
  if (pagePaths.has(path)) throw new Error(`WikiSpec repeats page path: ${path}`);
  pagePaths.add(path);
  if (value.sources.length === 0) throw new Error(`WikiSpec page ${path} must include source evidence`);
  if (value.requiredSections.length === 0) throw new Error(`WikiSpec page ${path} must include required sections`);
  if (value.diagrams.length === 0) throw new Error(`WikiSpec page ${path} must declare diagram applicability`);
  const diagramKinds = new Set<WikiDiagramKind>();
  const diagrams = value.diagrams.map((diagram) => {
    if (!isRecord(diagram) || !isDiagramKind(diagram.kind) || (diagram.applicability !== "required" && diagram.applicability !== "not_applicable")) {
      throw new Error(`WikiSpec page ${path} contains an invalid diagram requirement`);
    }
    if (diagramKinds.has(diagram.kind)) throw new Error(`WikiSpec page ${path} repeats diagram kind: ${diagram.kind}`);
    diagramKinds.add(diagram.kind);
    if (diagram.applicability === "required" && hasOwn(diagram, "reason")) {
      throw new Error(`WikiSpec required ${diagram.kind} diagram for ${path} must not include reason`);
    }
    const reason = diagram.applicability === "not_applicable"
      ? requiredText(diagram.reason, `WikiSpec diagram reason for ${path}`)
      : undefined;
    const applicability: "required" | "not_applicable" = diagram.applicability === "required" ? "required" : "not_applicable";
    return { kind: diagram.kind, applicability, purpose: requiredText(diagram.purpose, `WikiSpec diagram purpose for ${path}`), reason };
  });
  return {
    pageType: parsePageType(value.pageType, `WikiSpec page type for ${path}`),
    path,
    title: requiredText(value.title, `WikiSpec page title for ${path}`),
    purpose: requiredText(value.purpose, `WikiSpec page purpose for ${path}`),
    sources: value.sources.map((source) => requiredText(source, `WikiSpec source for ${path}`)),
    requiredSections: value.requiredSections.map((section) => requiredText(section, `WikiSpec required section for ${path}`)),
    diagrams,
  };
}

function parsePageType(value: unknown, label: string): "overview" | "architecture" | "module" | "flow" | "concept" {
  if (value === "overview" || value === "architecture" || value === "module" || value === "flow" || value === "concept") return value;
  throw new Error(`${label} is invalid`);
}

function parseResearchScopes(value: unknown[], owner: string) {
  const scopeIds = new Set<string>();
  return value.map((scope) => {
    if (!isRecord(scope)) throw new Error(`${owner} returned an invalid research scope`);
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
  if (!isWikiPagePath(path)) throw new Error(`${label} is invalid: ${path}`);
  return path;
}

function parseDomainId(value: unknown, label: string): string {
  const id = requiredText(value, label);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`${label} is invalid: ${id}`);
  return id;
}

function isWikiPagePath(value: string): boolean {
  if (!value.endsWith(".md")) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !normalized.startsWith("wiki/")
    && !normalized.split("/").some((part) => part === "" || part === "." || part === ".." || part === "index.md");
}

function isReviewKind(value: unknown): value is WikiReviewDefect["kind"] {
  return value === "evidence" || value === "link" || value === "format" || value === "topology" || value === "coverage" || value === "depth" || value === "diagram";
}

function isDiagramKind(value: unknown): value is WikiDiagramKind {
  return value === "flowchart" || value === "sequence" || value === "state" || value === "er" || value === "class";
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
  assertTextArtifactSize(content, label);
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

function assertTextArtifactSize(content: string, label: string): void {
  if (typeof content !== "string") throw new Error(`${label} must be text`);
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > MAX_CONTROL_ARTIFACT_BYTES) {
    throw new WikiControlSubmissionSizeError(label, sizeBytes);
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
