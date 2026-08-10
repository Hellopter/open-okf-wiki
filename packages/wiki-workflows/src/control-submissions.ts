import { Type } from "typebox";
import type { WikiPlanResult, WikiReviewDefect, WikiReviewResult } from "./workflow-types.js";

export const MAX_RESEARCH_SCOPES = 4;

const nonEmptyString = Type.String({ minLength: 1 });
const wikiPagePath = Type.String({ minLength: 1, description: "Wiki-relative Markdown page path" });
const pageTitle = Type.String({ minLength: 1, description: "Reader-facing page title" });
const pagePurpose = Type.String({ minLength: 1, description: "Question the page answers" });
const sourceReference = Type.String({ minLength: 1, description: "Workspace-relative path#Lx-Ly" });
const researchScopeId = Type.String({ minLength: 1, description: "Distinct research scope ID" });
const researchTask = Type.String({ minLength: 1, description: "Bounded source research task" });
const planRationale = Type.String({ minLength: 1, description: "Why this page set and research split fit the current scope" });
const defectId = Type.String({ minLength: 1, description: "Stable actionable defect ID" });
const defectPage = Type.String({ minLength: 1, description: "Affected Wiki page" });
const defectDetail = Type.String({ minLength: 1, description: "Specific correction needed" });
const reviewSummary = Type.String({ minLength: 1, description: "Concise overall review result" });

export const planSubmissionSchema = Type.Object({
  pages: Type.Array(Type.Object({
    path: wikiPagePath,
    title: pageTitle,
    purpose: pagePurpose,
    sources: Type.Array(sourceReference, { minItems: 1 }),
  }, { additionalProperties: false }), { minItems: 1 }),
  researchScopes: Type.Array(Type.Object({
    id: researchScopeId,
    task: researchTask,
  }, { additionalProperties: false }), { maxItems: MAX_RESEARCH_SCOPES }),
  rationale: planRationale,
}, { additionalProperties: false });

export const reviewSubmissionSchema = Type.Object({
  defects: Type.Array(Type.Object({
    id: defectId,
    page: defectPage,
    kind: Type.Union([
      Type.Literal("evidence"),
      Type.Literal("link"),
      Type.Literal("format"),
      Type.Literal("topology"),
      Type.Literal("coverage"),
    ]),
    detail: defectDetail,
  }, { additionalProperties: false })),
  summary: reviewSummary,
}, { additionalProperties: false });

/**
 * Canonicalize the planner's typed control submission. This runs both at tool
 * invocation time and before the engine expands the DAG, so mocks and future
 * executor implementations cannot bypass the workflow contract.
 */
export function parsePlanSubmission(value: unknown): WikiPlanResult {
  if (!isRecord(value) || !Array.isArray(value.pages) || !Array.isArray(value.researchScopes)) {
    throw new Error("Planner submission must include pages, researchScopes, and rationale");
  }
  const rationale = requiredText(value.rationale, "Planner rationale");
  if (value.researchScopes.length > MAX_RESEARCH_SCOPES) {
    throw new Error(`Planner may request at most ${MAX_RESEARCH_SCOPES} research scopes`);
  }

  const pagePaths = new Set<string>();
  const pages = value.pages.map((page) => {
    if (!isRecord(page)) throw new Error("Planner returned an invalid page plan");
    const path = requiredText(page.path, "Planner page path");
    if (path !== String(page.path) || !isWikiPagePath(path)) throw new Error(`Planner returned an invalid page path: ${path}`);
    if (pagePaths.has(path)) throw new Error(`Planner returned duplicate page path: ${path}`);
    pagePaths.add(path);
    if (!Array.isArray(page.sources) || page.sources.length === 0) throw new Error(`Planner page ${path} must include source evidence`);
    const sources = page.sources.map((source) => requiredText(source, `Planner source for ${path}`));
    return {
      path,
      title: requiredText(page.title, `Planner title for ${path}`),
      purpose: requiredText(page.purpose, `Planner purpose for ${path}`),
      sources,
    };
  });
  if (pages.length === 0) throw new Error("Planner must submit at least one Wiki page");

  const scopeIds = new Set<string>();
  const researchScopes = value.researchScopes.map((scope) => {
    if (!isRecord(scope)) throw new Error("Planner returned an invalid research scope");
    const id = requiredText(scope.id, "Research scope ID");
    if (scopeIds.has(id)) throw new Error(`Planner returned duplicate research scope: ${id}`);
    scopeIds.add(id);
    return { id, task: requiredText(scope.task, `Research task for ${id}`) };
  });
  return { pages, researchScopes, rationale };
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

function isWikiPagePath(value: string): boolean {
  if (!value.endsWith(".md")) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !normalized.startsWith("wiki/") && !normalized.split("/").some((part) => part === "" || part === "." || part === "..");
}

function isReviewKind(value: unknown): value is WikiReviewDefect["kind"] {
  return value === "evidence" || value === "link" || value === "format" || value === "topology" || value === "coverage";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
