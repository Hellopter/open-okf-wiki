import { lstat } from "node:fs/promises";
import path from "node:path";
import { autofixWikiTreeCitations } from "./citations-autofix.js";
import {
  type SourceRootMap,
  sourceRootMapFromSources,
  validateCitationResolve,
} from "./citations-canonicalize.js";
import {
  parseSourceCitations,
  type SourceCitation,
  validateCitationFormat,
} from "./citations-parse.js";
import {
  isSurfaceUnitId,
  makeSourceUnit,
  makeSurfaceUnit,
  parseSurfaceUnitId,
  type CoverageObligation,
  type CoveragePlan,
  type CoverageUnit,
} from "./coverage-types.js";
import { assertAbsolutePath, assertNoSymlinkComponents } from "./paths.js";
import { deriveWikiGraph } from "./wiki-links.js";
import {
  isReservedWikiPath,
  loadWikiPageRecords,
  type WikiPageRecord,
  WIKI_MAX_FILE_BYTES,
} from "./wiki-tree.js";

/** Soft caps for mechanical publication validation. */
export const WIKI_VALIDATE_MAX_FILES = 500;
export const WIKI_VALIDATE_MAX_FILE_BYTES = WIKI_MAX_FILE_BYTES;

export type ValidateWikiOptions = {
  /**
   * Pinned Repository Snapshot roots for Source Citation resolve (ADR 0008).
   * When omitted, only citation *format* is checked (and pages need ≥1 citation).
   */
  sources?: Array<{ id: string; path: string }>;
  /**
   * When true (default), every `.md` page must contain at least one Source Citation.
   */
  requireCitations?: boolean;
  /**
   * Spec pages that must exist as markdown under the wiki tree.
   * Entries with `critical: false` are skipped; omitted critical defaults to true.
   */
  requiredPages?: Array<{ path: string; critical?: boolean }>;
  /**
   * When true and `sources` are provided, mechanically clamp off-by-one citation
   * line ranges (and canonicalize targets) on disk before validation.
   * Default false — callers / workflows may also invoke {@link autofixWikiTreeCitations}
   * explicitly before validate.
   */
  autofixCitations?: boolean;
  /** Line slack for {@link autofixCitations} (default 1 — true off-by-one). */
  lineSlack?: number;
  /**
   * Optional plan-coverage obligations. When provided, each required unit must
   * be covered by at least one concept page citation (fail-closed).
   */
  coveragePlan?: Pick<CoveragePlan, "requiredUnits"> | CoveragePlan;
  /**
   * Explicit unit → page bindings. When set, the named page must exist and
   * cover the unit (stronger than tree-wide unit coverage).
   */
  coverageObligations?: readonly CoverageObligation[];
  /**
   * Force multi-source cross-flow checks even when `sources` length is 1.
   * Defaults to `sources.length >= 2` when omitted.
   */
  multiSource?: boolean;
};
export type ValidateWikiResult = {
  ok: boolean;
  errors: string[];
  /**
   * Non-blocking quality notes (OKF SHOULDs, e.g. missing `description`).
   * Never affect `ok` — OKF consumers must not reject on optional fields.
   */
  warnings: string[];
  /** Count of `.md` pages found when walk succeeded far enough. */
  pageCount?: number;
  /** Total files walked (md + non-md), when available. */
  fileCount?: number;
  /** Total Source Citations found across pages. */
  citationCount?: number;
};

/**
 * Mechanically validate a staging / publication-candidate Wiki tree before publish.
 *
 * Checks:
 * - Absolute path, real directory, no symlink components
 * - At least one `.md` file
 * - Concept `.md` pages: YAML frontmatter with non-empty `type` + `title` (OKF + product)
 * - Reserved `index.md` / `log.md`: exempt from concept frontmatter and citations
 * - Source Citations on concept pages (format + optional Snapshot resolve) — ADR 0008
 * - No symlinks inside the tree
 * - Soft caps: ≤ {@link WIKI_VALIDATE_MAX_FILES} files, each ≤ 1MB
 * - Optional plan coverage (SOURCE_COVERAGE / SURFACE_COVERAGE) when
 *   {@link ValidateWikiOptions.coveragePlan} / `coverageObligations` are provided
 * - Cross-source Flow pages must cite ≥2 source ids when multi-source
 */
export async function validateWikiTree(
  dir: string,
  options: ValidateWikiOptions = {},
): Promise<ValidateWikiResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Citations required when Snapshot sources are supplied (publish path) unless
  // explicitly disabled. Pure frontmatter/caps checks omit sources.
  // Reserved OKF files (index.md / log.md) never require citations.
  const requireCitations = options.requireCitations ?? Boolean(options.sources?.length);
  const sourceMap: SourceRootMap | undefined = options.sources
    ? sourceRootMapFromSources(options.sources)
    : undefined;
  const registeredSourceIds = (options.sources ?? []).map((s) => s.id);
  let citationCount = 0;

  let resolved: string;
  try {
    resolved = path.resolve(assertAbsolutePath(dir, "wikiDir"));
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings,
    };
  }

  let rootInfo;
  try {
    rootInfo = await lstat(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { ok: false, errors: [`wiki directory does not exist: ${resolved}`], warnings };
    }
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings,
    };
  }

  if (rootInfo.isSymbolicLink()) {
    return { ok: false, errors: [`wikiDir is a symlink: ${resolved}`], warnings };
  }
  if (!rootInfo.isDirectory()) {
    return { ok: false, errors: [`wikiDir is not a directory: ${resolved}`], warnings };
  }

  try {
    await assertNoSymlinkComponents(resolved, "wikiDir");
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings,
    };
  }

  // Mechanical autofix (canonicalize + off-by-one line clamp) before load/validate.
  if (options.autofixCitations && sourceMap) {
    await autofixWikiTreeCitations(resolved, sourceMap, {
      lineSlack: options.lineSlack,
    });
  }

  const { pages, scan, loadIssues } = await loadWikiPageRecords(resolved, {
    maxFileBytes: WIKI_VALIDATE_MAX_FILE_BYTES,
  });
  errors.push(...scan.issues.map((issue) => issue.message));
  errors.push(...loadIssues.map((issue) => issue.message));

  const fileCount = scan.files.length;
  const pageCount = scan.files.filter((file) =>
    file.relativePath.toLowerCase().endsWith(".md"),
  ).length;

  if (fileCount > WIKI_VALIDATE_MAX_FILES) {
    errors.push(`wiki tree has ${fileCount} files (max ${WIKI_VALIDATE_MAX_FILES})`);
  }

  if (pageCount < 1) {
    errors.push(`wiki tree has no markdown pages: ${resolved}`);
  }

  for (const page of pages) {
    const reserved = isReservedWikiPath(page.relativePath);
    if (reserved) {
      // OKF reserved listing/history files: no concept frontmatter or citations.
      continue;
    }
    const hasType = Boolean(page.values.type);
    const hasTitle = Boolean(page.values.title);
    if (!hasType || !hasTitle) {
      if (!hasType && !hasTitle) {
        errors.push(`${page.relativePath}: missing YAML frontmatter with non-empty type and title`);
      } else if (!hasType) {
        errors.push(`${page.relativePath}: missing YAML frontmatter with non-empty type`);
      } else {
        errors.push(`${page.relativePath}: missing YAML frontmatter with non-empty title`);
      }
    }
    // OKF v0.2 SHOULD: description feeds index generation, search, and previews.
    if (page.hasFrontmatter && !page.values.description) {
      warnings.push(`${page.relativePath}: missing frontmatter description (OKF v0.2 recommended)`);
    }
    const citations = parseSourceCitations(page.content);
    citationCount += citations.length;
    if (requireCitations && citations.length === 0) {
      errors.push(`${page.relativePath}: missing Source Citation ([Source](repo:…#L…))`);
    }
    errors.push(...validateCitationFormat(citations, page.relativePath));
    if (sourceMap) {
      errors.push(...(await validateCitationResolve(citations, page.relativePath, sourceMap)));
    }
  }

  // Broken internal links are quality notes, never rejection (OKF §6.1: a
  // missing target may be not-yet-written knowledge).
  for (const broken of deriveWikiGraph(
    pages.map((page) => ({ path: page.relativePath, content: page.content })),
  ).brokenLinks) {
    warnings.push(`${broken.from}: broken internal link (${broken.target})`);
  }

  // Spec critical pages must exist as markdown (Phase 3 EvaluationPolicy).
  if (options.requiredPages && options.requiredPages.length > 0) {
    const present = new Set(
      scan.files
        .filter((file) => file.relativePath.toLowerCase().endsWith(".md"))
        .map((file) => file.relativePath.replace(/\\/g, "/")),
    );
    for (const page of options.requiredPages) {
      const critical = page.critical !== false;
      if (!critical) continue;
      const rel = page.path.replace(/\\/g, "/").replace(/^\.\//, "");
      if (!rel || isReservedWikiPath(rel)) continue;
      if (!present.has(rel)) {
        errors.push(`critical page missing: ${rel}`);
      }
    }
  }

  // Plan coverage obligations (fail-closed when options provided).
  const conceptPages = pages.filter((page) => !isReservedWikiPath(page.relativePath));
  // Prefer freeze source ids; fall back to ids declared on the coverage plan.
  const coverageSourceIds =
    registeredSourceIds.length > 0
      ? registeredSourceIds
      : uniqueSourceIdsFromPlan(options.coveragePlan, options.coverageObligations);
  const coverageMultiSource =
    options.multiSource ??
    (coverageSourceIds.length >= 2 || (options.sources?.length ?? 0) >= 2);
  errors.push(
    ...validateCoverageObligations({
      pages: conceptPages,
      coveragePlan: options.coveragePlan,
      coverageObligations: options.coverageObligations,
      registeredSourceIds: coverageSourceIds,
      multiSource: coverageMultiSource,
    }),
  );

  // Cross-source Flow / multi-sourceId pages: citations must hit ≥2 source ids.
  if (coverageMultiSource) {
    errors.push(
      ...validateCrossSourceFlows({
        pages: conceptPages,
        registeredSourceIds: coverageSourceIds,
        multiSource: coverageMultiSource,
      }),
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    pageCount,
    fileCount,
    citationCount,
  };
}

type PageCitationIndex = {
  page: WikiPageRecord;
  citations: SourceCitation[];
  /** Distinct source ids observed on this page. */
  sourceIds: Set<string>;
  /** (sourceId → repo-relative paths cited). */
  pathsBySource: Map<string, Set<string>>;
};

/**
 * Mechanical SOURCE_COVERAGE / SURFACE_COVERAGE checks.
 * Exported for unit tests of pure obligation logic.
 */
export function validateCoverageObligations(input: {
  pages: readonly WikiPageRecord[];
  coveragePlan?: Pick<CoveragePlan, "requiredUnits"> | CoveragePlan;
  coverageObligations?: readonly CoverageObligation[];
  registeredSourceIds: readonly string[];
  multiSource: boolean;
}): string[] {
  const errors: string[] = [];
  const required = input.coveragePlan?.requiredUnits ?? [];
  const obligations = input.coverageObligations ?? [];
  if (required.length === 0 && obligations.length === 0) {
    return errors;
  }

  const pageIndex = buildPageCitationIndex(
    input.pages,
    input.registeredSourceIds,
    input.multiSource,
  );
  const pagesByPath = new Map(pageIndex.map((row) => [normalizeWikiRel(row.page.relativePath), row]));

  // Explicit unit → page obligations (strongest).
  const obligatedUnitIds = new Set<string>();
  for (const obligation of obligations) {
    const unitId = obligation.unitId.trim();
    const pagePath = normalizeWikiRel(obligation.pagePath);
    if (!unitId || !pagePath) continue;
    obligatedUnitIds.add(unitId);
    const row = pagesByPath.get(pagePath);
    if (!row) {
      errors.push(
        coverageErrorForUnitId(
          unitId,
          `page missing for obligation unit "${unitId}" (expected ${pagePath})`,
        ),
      );
      continue;
    }
    const unit = unitFromObligationId(unitId, required);
    if (!unit) {
      // Unknown unit id still fails closed when obligations are declared.
      errors.push(`SOURCE_COVERAGE: unknown coverage unit "${unitId}" for page ${pagePath}`);
      continue;
    }
    if (!pageCoversUnit(row, unit)) {
      errors.push(
        coverageError(
          unit,
          `${pagePath} does not cover unit "${unit.id}"`,
        ),
      );
    }
  }

  // Required units without an explicit page obligation: any concept page may cover.
  for (const unit of required) {
    if (obligatedUnitIds.has(unit.id)) continue;
    const covered = pageIndex.some((row) => pageCoversUnit(row, unit));
    if (!covered) {
      errors.push(coverageError(unit, `no page covers unit "${unit.id}"`));
    }
  }

  return errors;
}

/**
 * Flow pages (type: Flow) or pages declaring multiple sourceIds must cite ≥2
 * registered source ids when multi-source is active.
 */
export function validateCrossSourceFlows(input: {
  pages: readonly WikiPageRecord[];
  registeredSourceIds: readonly string[];
  multiSource: boolean;
}): string[] {
  if (!input.multiSource) return [];
  const errors: string[] = [];
  const registered = new Set(input.registeredSourceIds);

  for (const page of input.pages) {
    if (!pageNeedsCrossSourceCitations(page)) continue;
    const citations = parseSourceCitations(page.content);
    const citedIds = new Set<string>();
    for (const citation of citations) {
      const parsed = parseCitationSourcePath(
        citation.target,
        input.registeredSourceIds,
        true,
      );
      if (parsed && registered.has(parsed.sourceId)) {
        citedIds.add(parsed.sourceId);
      }
    }
    if (citedIds.size < 2) {
      const got = citedIds.size === 0 ? "none" : [...citedIds].sort().join(", ");
      errors.push(
        `CROSS_SOURCE_FLOW: ${page.relativePath} must cite ≥2 source ids (got: ${got})`,
      );
    }
  }
  return errors;
}

function pageNeedsCrossSourceCitations(page: WikiPageRecord): boolean {
  const type = (page.values.type ?? "").trim().toLowerCase();
  if (type === "flow") return true;
  const declared = parseFrontmatterSourceIds(page.values);
  return declared.length >= 2;
}

/** Parse optional frontmatter `sourceIds` / `sourceids` as comma or space separated. */
function parseFrontmatterSourceIds(values: Readonly<Record<string, string>>): string[] {
  const raw = values.sourceids ?? values.sourceIds ?? "";
  if (!raw.trim()) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildPageCitationIndex(
  pages: readonly WikiPageRecord[],
  registeredSourceIds: readonly string[],
  multiSource: boolean,
): PageCitationIndex[] {
  return pages.map((page) => {
    const citations = parseSourceCitations(page.content);
    const sourceIds = new Set<string>();
    const pathsBySource = new Map<string, Set<string>>();
    for (const citation of citations) {
      const parsed = parseCitationSourcePath(
        citation.target,
        registeredSourceIds,
        multiSource,
      );
      if (!parsed) continue;
      sourceIds.add(parsed.sourceId);
      let paths = pathsBySource.get(parsed.sourceId);
      if (!paths) {
        paths = new Set();
        pathsBySource.set(parsed.sourceId, paths);
      }
      paths.add(parsed.repoPath);
    }
    return { page, citations, sourceIds, pathsBySource };
  });
}

/**
 * Split a citation target into sourceId + repo path.
 * Multi-source: requires registered id prefix.
 * Single-source: bare path counts as the sole registered id (when exactly one).
 */
export function parseCitationSourcePath(
  target: string,
  registeredSourceIds: readonly string[],
  multiSource: boolean,
): { sourceId: string; repoPath: string } | undefined {
  const normalized = target.trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) {
    return undefined;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  const idSet = new Set(registeredSourceIds);

  // sources/<id>/rest mount form
  if (segments[0] === "sources" && segments.length >= 3 && idSet.has(segments[1]!)) {
    return { sourceId: segments[1]!, repoPath: segments.slice(2).join("/") };
  }

  if (segments.length >= 2 && idSet.has(segments[0]!)) {
    return { sourceId: segments[0]!, repoPath: segments.slice(1).join("/") };
  }

  if (multiSource) {
    return undefined;
  }

  // Single-source bare path.
  if (registeredSourceIds.length === 1) {
    return { sourceId: registeredSourceIds[0]!, repoPath: segments.join("/") };
  }
  // No registered ids: treat as anonymous single-source path under "".
  if (registeredSourceIds.length === 0) {
    return { sourceId: "", repoPath: segments.join("/") };
  }
  return undefined;
}

function pageCoversUnit(row: PageCitationIndex, unit: CoverageUnit): boolean {
  if (unit.kind === "source") {
    if (unit.sourceId === "") {
      return row.citations.length > 0;
    }
    return row.sourceIds.has(unit.sourceId);
  }
  // Surface: need a citation under the surface path within the source.
  const paths = row.pathsBySource.get(unit.sourceId);
  if (!paths || paths.size === 0) return false;
  const surfacePath = (unit.path ?? ".").replace(/\\/g, "/");
  if (surfacePath === "." || surfacePath === "") {
    // Root surface: any path under this source covers it.
    return true;
  }
  for (const cited of paths) {
    if (cited === surfacePath || cited.startsWith(`${surfacePath}/`)) {
      return true;
    }
  }
  return false;
}

function unitFromObligationId(
  unitId: string,
  required: readonly CoverageUnit[],
): CoverageUnit | undefined {
  const fromRequired = required.find((u) => u.id === unitId);
  if (fromRequired) return fromRequired;
  // Synthesize from contract id conventions when plan is absent.
  if (isSurfaceUnitId(unitId)) {
    const parsed = parseSurfaceUnitId(unitId);
    if (!parsed) return undefined;
    return makeSurfaceUnit(parsed.sourceId, parsed.path);
  }
  const bare = unitId.trim();
  if (!bare) return undefined;
  // Bare source slug (contract: unitIdForSource = sourceId).
  try {
    return makeSourceUnit(bare);
  } catch {
    return { id: bare, kind: "source", sourceId: bare };
  }
}

function coverageError(unit: CoverageUnit, detail: string): string {
  const code = unit.kind === "source" ? "SOURCE_COVERAGE" : "SURFACE_COVERAGE";
  return `${code}: ${detail}`;
}

function coverageErrorForUnitId(unitId: string, detail: string): string {
  if (isSurfaceUnitId(unitId)) {
    return `SURFACE_COVERAGE: ${detail}`;
  }
  return `SOURCE_COVERAGE: ${detail}`;
}

function normalizeWikiRel(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function uniqueSourceIdsFromPlan(
  plan: Pick<CoveragePlan, "requiredUnits"> | CoveragePlan | undefined,
  obligations: readonly CoverageObligation[] | undefined,
): string[] {
  const ids = new Set<string>();
  for (const unit of plan?.requiredUnits ?? []) {
    if (unit.sourceId) ids.add(unit.sourceId);
  }
  for (const obligation of obligations ?? []) {
    const unit = unitFromObligationId(obligation.unitId, plan?.requiredUnits ?? []);
    if (unit?.sourceId) ids.add(unit.sourceId);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}
