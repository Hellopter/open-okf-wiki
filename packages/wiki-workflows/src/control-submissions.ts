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

const wikiPagePath = Type.String({ minLength: 1, description: "Wiki-relative Markdown page path" });
const pageTitle = Type.String({ minLength: 1, description: "Reader-facing page title" });
const pagePurpose = Type.String({ minLength: 1, description: "Question the page answers" });
const sourceReference = Type.String({ minLength: 1, description: "Workspace-relative path#Lx-Ly" });
const researchScopeId = Type.String({ minLength: 1, description: "Distinct research scope ID" });
const researchSourcePath = Type.String({ minLength: 1, description: "Declared workspace source root to inspect" });
const researchTask = Type.String({ minLength: 1, description: "Bounded source research task" });
const domainId = Type.String({ minLength: 1, pattern: "^[a-z0-9][a-z0-9-]*$", description: "Stable documentation domain ID and output directory" });
const sectionTitle = Type.String({ minLength: 1, description: "Required page section" });
const pageType = Type.Union([
  Type.Literal("overview"),
  Type.Literal("architecture"),
  Type.Literal("module"),
  Type.Literal("flow"),
  Type.Literal("concept"),
]);
const rationale = Type.String({ minLength: 1, description: "Why this research or Wiki contract fits the current scope" });
const defectId = Type.String({ minLength: 1, description: "Stable actionable defect ID" });
const defectPage = Type.String({ minLength: 1, description: "Affected Wiki page" });
const defectDetail = Type.String({ minLength: 1, description: "Specific correction needed" });
const reviewSummary = Type.String({ minLength: 1, description: "Concise overall review result" });
const diagramKind = Type.Union([
  Type.Literal("flowchart"),
  Type.Literal("sequence"),
  Type.Literal("state"),
  Type.Literal("er"),
  Type.Literal("class"),
]);
const diagramRequirement = Type.Object({
  kind: diagramKind,
  applicability: Type.Union([Type.Literal("required"), Type.Literal("not_applicable")]),
  purpose: pagePurpose,
  reason: Type.Optional(Type.String({ minLength: 1, description: "Why this diagram is not applicable" })),
}, { additionalProperties: false });

const researchScopeSchema = Type.Object({
  id: researchScopeId,
  sourcePaths: Type.Array(researchSourcePath, { minItems: 1 }),
  task: researchTask,
}, { additionalProperties: false });

const specPage = Type.Object({
  pageType,
  path: wikiPagePath,
  title: pageTitle,
  purpose: pagePurpose,
  sources: Type.Array(sourceReference, { minItems: 1 }),
  requiredSections: Type.Array(sectionTitle, { minItems: 1 }),
  diagrams: Type.Array(diagramRequirement, { minItems: 1 }),
}, { additionalProperties: false });

const wikiSpecSchema = Type.Object({
  domains: Type.Array(Type.Object({
    id: domainId,
    title: pageTitle,
    purpose: pagePurpose,
    pages: Type.Array(specPage, { minItems: 1 }),
    researchScopeIds: Type.Array(researchScopeId),
  }, { additionalProperties: false }), { minItems: 1 }),
  crossLinks: Type.Array(Type.Object({
    fromPath: wikiPagePath,
    toPath: wikiPagePath,
    purpose: pagePurpose,
  }, { additionalProperties: false })),
  sharedTerms: Type.Array(Type.Object({
    term: Type.String({ minLength: 1 }),
    definition: Type.String({ minLength: 1 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const synthesisSubmissionSchema = Type.Union([
  Type.Object({
    decision: Type.Literal("expand"),
    researchScopes: Type.Array(researchScopeSchema, { minItems: 1, maxItems: MAX_RESEARCH_SCOPES_PER_BATCH }),
    rationale,
  }, { additionalProperties: false }),
  Type.Object({
    decision: Type.Literal("finalize"),
    spec: wikiSpecSchema,
    rationale,
  }, { additionalProperties: false }),
]);

export const reviewSubmissionSchema = Type.Object({
  defects: Type.Array(Type.Object({
    id: defectId,
    domainId,
    page: defectPage,
    kind: Type.Union([
      Type.Literal("evidence"),
      Type.Literal("link"),
      Type.Literal("format"),
      Type.Literal("topology"),
      Type.Literal("coverage"),
      Type.Literal("depth"),
      Type.Literal("diagram"),
    ]),
    detail: defectDetail,
  }, { additionalProperties: false })),
  summary: reviewSummary,
}, { additionalProperties: false });

/** Canonicalize the synthesis decision before it can expand or finalize the DAG. */
export function parseSynthesisSubmission(value: unknown): WikiSynthesisResult {
  if (!isRecord(value) || (value.decision !== "expand" && value.decision !== "finalize")) {
    throw new Error("Synthesis submission must choose expand or finalize");
  }
  const synthesisRationale = requiredText(value.rationale, "Synthesis rationale");
  if (value.decision === "expand") {
    if (!Array.isArray(value.researchScopes)) throw new Error("Synthesis expansion must include researchScopes");
    if (value.researchScopes.length === 0 || value.researchScopes.length > MAX_RESEARCH_SCOPES_PER_BATCH) {
      throw new Error(`Synthesis may request 1 to ${MAX_RESEARCH_SCOPES_PER_BATCH} supplemental research scopes`);
    }
    return { decision: "expand", researchScopes: parseResearchScopes(value.researchScopes, "Synthesis"), rationale: synthesisRationale };
  }
  return { decision: "finalize", spec: parseWikiSpec(value.spec), rationale: synthesisRationale };
}

/** Canonicalize the reviewer's typed control submission before it changes the DAG. */
export function parseReviewSubmission(value: unknown): WikiReviewResult {
  if (!isRecord(value) || !Array.isArray(value.defects)) {
    throw new Error("Reviewer submission must include defects and summary");
  }
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
  return { defects, summary: requiredText(value.summary, "Review summary") };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`);
  return value.trim();
}

function parseWikiSpec(value: unknown): WikiSpec {
  if (!isRecord(value) || !Array.isArray(value.domains) || !Array.isArray(value.crossLinks) || !Array.isArray(value.sharedTerms)) {
    throw new Error("Final WikiSpec must include domains, crossLinks, and sharedTerms");
  }
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
    const reason = diagram.reason === undefined ? undefined : requiredText(diagram.reason, `WikiSpec diagram reason for ${path}`);
    if (diagram.applicability === "not_applicable" && !reason) throw new Error(`WikiSpec page ${path} must explain a non-applicable ${diagram.kind} diagram`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
