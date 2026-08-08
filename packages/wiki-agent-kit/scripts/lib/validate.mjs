/** Minimal OKF v0.2 bundle validation, index projection, and immutable sealing. */

import fs from "node:fs";
import path from "node:path";
import YAML, { parseDocument } from "yaml";
import {
  analysisDir,
  bundleDir,
  bundleManifestPath,
  coverageReviewPath,
  evidenceDir,
  frozenSourcesDir,
  inputsDir,
  planPath,
  qualityReportPath,
  QUALITY_REPORT_IDS,
} from "./paths.mjs";
import { hashTree, isInside, readJson, sha256, writeJson } from "./artifacts.mjs";
import { verifyFrozenSnapshot } from "./freeze.mjs";

const RESERVED_FILENAMES = new Set(["index.md", "log.md"]);
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LINE_FRAGMENT_RE = /^L(\d+)(?:-L(\d+))?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const GENERATED_BY = "okf-wiki-agent/0.1.0";
const PAGE_MATRIX_COLUMNS = ["page", "coverage units", "evidence brief", "diagram"];
const MERMAID_DIRECTIVES = new Set([
  "architecture-beta",
  "block-beta",
  "classdiagram",
  "erdiagram",
  "flowchart",
  "gantt",
  "gitgraph",
  "graph",
  "journey",
  "kanban",
  "mindmap",
  "pie",
  "quadrantchart",
  "requirementdiagram",
  "sankey-beta",
  "sequencediagram",
  "statediagram",
  "statediagram-v2",
  "timeline",
  "xychart-beta",
]);

function walkBundle(dir, base = "", result = { markdown: [], unsafe: [] }) {
  if (!fs.existsSync(dir)) return result;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      result.unsafe.push(rel.replace(/\\/g, "/"));
    } else if (ent.isDirectory()) {
      walkBundle(abs, rel, result);
    } else if (ent.isFile() && ent.name.endsWith(".md")) {
      result.markdown.push({ abs, rel: rel.replace(/\\/g, "/") });
    }
  }
  return result;
}

export function parseMarkdownFrontmatter(text) {
  const opening = text.match(/^---\r?\n/);
  if (!opening) return { ok: false, error: "missing YAML frontmatter" };
  const close = text.indexOf("\n---", opening[0].length);
  if (close < 0) return { ok: false, error: "unclosed frontmatter" };
  const raw = text.slice(opening[0].length, close);
  const doc = parseDocument(raw, { prettyErrors: false, uniqueKeys: true, maxAliasCount: 0 });
  if (doc.errors.length) return { ok: false, error: `invalid YAML frontmatter: ${doc.errors[0].message}` };
  if (doc.contents === null || !doc.contents || !Array.isArray(doc.contents.items)) {
    return { ok: false, error: "frontmatter must be a YAML mapping" };
  }
  const data = doc.toJSON();
  if (!data || Array.isArray(data) || typeof data !== "object") return { ok: false, error: "frontmatter must be a YAML mapping" };
  return { ok: true, data, body: text.slice(close + 4) };
}

function renderDocument(data, body) {
  return `---\n${YAML.stringify(data, { indent: 2, lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" })}---\n${body.replace(/^\r?\n/, "").replace(/\s*$/, "\n")}`;
}

function lineCount(file) {
  const text = fs.readFileSync(file, "utf8");
  if (!text) return 0;
  return (text.match(/\n/g) ?? []).length + (text.endsWith("\n") ? 0 : 1);
}

function parseLinks(text) {
  const links = [];
  MARKDOWN_LINK_RE.lastIndex = 0;
  let match;
  while ((match = MARKDOWN_LINK_RE.exec(text)) !== null) links.push({ label: match[1], target: match[2] });
  return links;
}

function isExternal(target) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("/") || target.startsWith("#");
}

function validateLineTarget(file, fragment, label, errors) {
  const match = fragment.match(LINE_FRAGMENT_RE);
  if (!match) {
    errors.push(`${label}: source reference must use #Lx or #Lx-Ly`);
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  const lines = lineCount(file);
  if (start < 1 || end < start || end > lines) {
    errors.push(`${label}: source line range is out of bounds (file lines=${lines})`);
  }
}

function validateSourceResource(entry, sources, label, errors) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`${label}: sources entries must be mappings with id and resource`);
    return;
  }
  if (typeof entry.id !== "string" || !entry.id.trim()) {
    errors.push(`${label}: source id must be a non-empty string`);
  }
  const resource = entry.resource;
  if (typeof resource !== "string" || !resource.trim()) {
    errors.push(`${label}: source resource must be a non-empty string`);
    return;
  }
  const hashAt = resource.indexOf("#");
  const rawPath = hashAt < 0 ? "" : resource.slice(0, hashAt);
  const fragment = hashAt < 0 ? "" : resource.slice(hashAt + 1);
  if (!rawPath.startsWith("inputs/sources/") || rawPath.includes("\\") || rawPath.split("/").includes("..")) {
    errors.push(`${label}: source resource must be run-relative under inputs/sources/`);
    return;
  }
  const sourceFile = path.resolve(path.dirname(sources), rawPath.slice("inputs/".length));
  if (!isInside(sources, sourceFile) || !fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
    errors.push(`${label}: source resource does not resolve to a frozen file: ${resource}`);
    return;
  }
  validateLineTarget(sourceFile, fragment, `${label}: ${resource}`, errors);
}

function validateCitationLink({ rel, pageAbs, target, bundle, sources, errors }) {
  if (isExternal(target)) return false;
  const hashAt = target.indexOf("#");
  if (hashAt < 0) return false;
  const rawPath = target.slice(0, hashAt);
  const fragment = target.slice(hashAt + 1);
  if (!rawPath || rawPath.includes("\\")) return false;
  const resolved = path.resolve(path.dirname(pageAbs), rawPath);
  if (!isInside(sources, resolved)) return false;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    errors.push(`${rel}: source citation does not resolve to a frozen file: ${target}`);
    return true;
  }
  validateLineTarget(resolved, fragment, `${rel}: ${target}`, errors);
  return true;
}

function validateInternalLink({ rel, pageAbs, target, bundle, errors }) {
  if (isExternal(target)) return;
  const rawPath = target.split("#", 1)[0];
  if (!rawPath || !rawPath.endsWith(".md")) return;
  const resolved = path.resolve(path.dirname(pageAbs), rawPath);
  if (!isInside(bundle, resolved) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    errors.push(`${rel}: broken internal Markdown link: ${target}`);
  }
}

function isConceptPath(rel) {
  const parts = rel.split("/");
  if (parts[0] === "domains" && parts.length === 3) return SLUG_RE.test(parts[1]) && (parts[2] === "overview.md" || `${parts[2].replace(/\.md$/, "")}`.match(SLUG_RE));
  return parts[0] === "concepts" && parts.length === 2 && SLUG_RE.test(parts[1].replace(/\.md$/, ""));
}

function validatePagePath(rel, frontmatter, errors) {
  if (!isConceptPath(rel)) {
    errors.push(`${rel}: page must be domains/<domain>/(overview|<concept>).md or concepts/<concept>.md`);
    return;
  }
  const parts = rel.split("/");
  if (parts[0] === "domains" && parts[2] === "overview.md" && frontmatter.type !== "domain") {
    errors.push(`${rel}: domain overview must use type: domain`);
  }
  if (parts[0] === "domains" && parts[2] !== "overview.md" && frontmatter.type === "domain") {
    errors.push(`${rel}: only overview.md may use type: domain`);
  }
}

function markdownCell(value) {
  return value.trim().replace(/^`(.+)`$/, "$1").trim();
}

function parseTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const row = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map(markdownCell);
  return row.length ? row : null;
}

function planSection(markdown, name) {
  const lines = markdown.split(/\r?\n/);
  const heading = new RegExp(`^#{1,6}\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const index = lines.findIndex((line) => heading.test(line));
  if (index < 0) return [];
  const section = [];
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    if (/^#{1,6}\s+/.test(lines[cursor])) break;
    section.push(lines[cursor]);
  }
  return section;
}

function parseCoverageUnits(value) {
  const codeSpans = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()).filter(Boolean);
  if (codeSpans.length) return codeSpans;
  return value
    .split(/[,;]/)
    .map((item) => markdownCell(item))
    .filter((item) => item && !/^none$/i.test(item));
}

function parsePageMatrix(runRootPath, errors) {
  let plan;
  try {
    plan = fs.readFileSync(planPath(runRootPath), "utf8");
  } catch {
    errors.push("missing analysis/plan.md");
    return { entries: [], errors: ["missing analysis/plan.md"] };
  }
  if (!plan.trim()) {
    errors.push("analysis/plan.md is empty");
    return { entries: [], errors: ["analysis/plan.md is empty"] };
  }

  const section = planSection(plan, "Page Matrix");
  const headerIndex = section.findIndex((line) => parseTableRow(line));
  if (headerIndex < 0 || !section[headerIndex + 1]) {
    const message = "analysis/plan.md must contain a Page Matrix Markdown table";
    errors.push(message);
    return { entries: [], errors: [message] };
  }
  const header = parseTableRow(section[headerIndex]).map((value) => value.toLowerCase());
  const separator = parseTableRow(section[headerIndex + 1]);
  const missingColumns = PAGE_MATRIX_COLUMNS.filter((name) => !header.includes(name));
  if (!separator || separator.some((cell) => !/^:?-{3,}:?$/.test(cell)) || missingColumns.length) {
    const message = `Page Matrix must have columns: ${PAGE_MATRIX_COLUMNS.join(", ")}`;
    errors.push(message);
    return { entries: [], errors: [message] };
  }
  const columns = Object.fromEntries(header.map((name, index) => [name, index]));
  const entries = [];
  const matrixErrors = [];
  for (const line of section.slice(headerIndex + 2)) {
    if (!line.trim()) continue;
    const row = parseTableRow(line);
    // A plan may continue with prose after its contiguous matrix table.
    if (!row) break;
    if (row.length !== header.length) {
      matrixErrors.push(`Page Matrix row has ${row.length} cells; expected ${header.length}`);
      continue;
    }
    const page = markdownCell(row[columns.page] ?? "");
    const evidence = markdownCell(row[columns["evidence brief"]] ?? "");
    const diagram = markdownCell(row[columns.diagram] ?? "").toLowerCase();
    const coverageUnits = parseCoverageUnits(row[columns["coverage units"]] ?? "");
    if (!page || page.startsWith("/") || page.includes("\\") || page.split("/").includes("..") || !isConceptPath(page)) {
      matrixErrors.push(`Page Matrix has an invalid bundle-relative page: ${page || "(empty)"}`);
    }
    if (!coverageUnits.length) matrixErrors.push(`Page Matrix ${page || "row"} must name at least one coverage unit`);
    if (!evidence.startsWith("analysis/evidence/") || evidence.includes("\\") || evidence.split("/").includes("..")) {
      matrixErrors.push(`Page Matrix ${page || "row"} evidence brief must be under analysis/evidence/: ${evidence || "(empty)"}`);
    } else {
      const evidenceAbs = path.resolve(runRootPath, evidence);
      if (!isInside(evidenceDir(runRootPath), evidenceAbs) || !fs.existsSync(evidenceAbs) || !fs.statSync(evidenceAbs).isFile()) {
        matrixErrors.push(`Page Matrix ${page || "row"} evidence brief is missing: ${evidence}`);
      } else {
        const brief = fs.readFileSync(evidenceAbs, "utf8");
        if (!brief.trim()) matrixErrors.push(`Page Matrix ${page || "row"} evidence brief is empty: ${evidence}`);
        if (!/inputs\/sources\/[^\s)#]+#L\d+(?:-L\d+)?/.test(brief)) {
          matrixErrors.push(`Page Matrix ${page || "row"} evidence brief has no frozen-source citation: ${evidence}`);
        }
      }
    }
    if (!new Set(["required", "useful", "omitted"]).has(diagram)) {
      matrixErrors.push(`Page Matrix ${page || "row"} diagram must be required, useful, or omitted`);
    }
    entries.push({ page, evidence, diagram, coverageUnits });
  }
  if (!entries.length) matrixErrors.push("Page Matrix must contain at least one page row");
  const duplicates = entries.map((entry) => entry.page).filter((page, index, all) => page && all.indexOf(page) !== index);
  if (duplicates.length) matrixErrors.push(`Page Matrix contains duplicate page rows: ${[...new Set(duplicates)].join(", ")}`);
  errors.push(...matrixErrors);
  return { entries, errors: matrixErrors };
}

function extractMermaidFences(markdown) {
  const lines = markdown.split(/\r?\n/);
  const fences = [];
  let open = null;
  let genericMarker = null;
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)(`{3,})\s*(\S*)\s*$/.exec(lines[index]);
    if (open) {
      if (match && match[2].length >= open.marker.length && !match[3]) {
        fences.push({ body: open.lines.join("\n"), line: open.line, closed: true });
        open = null;
      } else {
        open.lines.push(lines[index]);
      }
      continue;
    }
    if (genericMarker) {
      if (match && match[2].length >= genericMarker.length && !match[3]) genericMarker = null;
      continue;
    }
    if (match && match[3].toLowerCase() === "mermaid") {
      open = { marker: match[2], line: index + 1, lines: [] };
    } else if (match && match[3]) {
      genericMarker = match[2];
    }
  }
  if (open) fences.push({ body: open.lines.join("\n"), line: open.line, closed: false });
  return fences;
}

function mermaidSyntaxError(body) {
  const first = body.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!first) return "diagram is empty";
  if (!MERMAID_DIRECTIVES.has(first)) return `unknown Mermaid diagram directive: ${first}`;
  const flowchart = first === "flowchart" || first === "graph";
  if (flowchart && (/(?:^|\n|\s)end\s*[[({]/.test(body) || /-->\s*end\s*(?:$|\n|;)/m.test(body))) {
    return "flowchart uses reserved word `end` as a node id";
  }
  if (/[[({][^)\]}]*;[^)\]}]*[)\]}]/.test(body)) return "diagram contains a semicolon inside a label";
  if (/[[({][^)\]}]*[<>][^)\]}]*[)\]}]/.test(body)) return "diagram contains an unescaped angle bracket inside a label";
  return null;
}

function validateMermaidFences(markdown, rel, errors) {
  const fences = extractMermaidFences(markdown);
  for (const fence of fences) {
    if (!fence.closed) {
      errors.push(`${rel}: Mermaid fence opened on line ${fence.line} is not closed`);
      continue;
    }
    const syntaxError = mermaidSyntaxError(fence.body);
    if (syntaxError) errors.push(`${rel}: Mermaid fence on line ${fence.line} is invalid: ${syntaxError}`);
  }
  return fences;
}

const QUALITY_REPORTS = [
  { id: "coverage", file: coverageReviewPath, mustPass: false },
  ...QUALITY_REPORT_IDS.map((id) => ({ id, file: (runRootPath) => qualityReportPath(runRootPath, id), mustPass: true })),
];

function reportField(markdown, name) {
  const matches = [...markdown.matchAll(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "gim"))];
  return matches.length === 1 ? matches[0][1].trim() : null;
}

/** Parse the host-required review verdict format without trusting agent-authored state. */
export function parseQualityReports(runRootPath, { ids } = {}) {
  const requested = ids === undefined ? null : new Set(ids);
  if (requested) {
    const known = new Set(QUALITY_REPORTS.map((spec) => spec.id));
    for (const id of requested) {
      if (!known.has(id)) throw new Error(`unknown quality report: ${id}`);
    }
  }
  const reports = [];
  const errors = [];
  for (const spec of QUALITY_REPORTS.filter((candidate) => !requested || requested.has(candidate.id))) {
    const file = spec.file(runRootPath);
    const rel = path.relative(runRootPath, file).replace(/\\/g, "/");
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      const error = `missing quality report: ${rel}`;
      reports.push({ id: spec.id, path: rel, valid: false, verdict: null, errors: [error] });
      errors.push(error);
      continue;
    }
    const markdown = fs.readFileSync(file, "utf8");
    const verdict = reportField(markdown, "Verdict");
    const affectedPages = reportField(markdown, "Affected pages");
    const findings = reportField(markdown, "Findings");
    const requiredRepair = reportField(markdown, "Required repair");
    const reportErrors = [];
    if (verdict !== "PASS" && verdict !== "FAIL") reportErrors.push(`${rel}: Verdict must be PASS or FAIL`);
    if (!affectedPages) reportErrors.push(`${rel}: Affected pages must be a non-empty line`);
    if (!findings) reportErrors.push(`${rel}: Findings must be a non-empty line`);
    if (!requiredRepair) reportErrors.push(`${rel}: Required repair must be a non-empty line`);
    if (verdict === "FAIL" && (/^none$/i.test(findings || "") || /^none$/i.test(requiredRepair || ""))) {
      reportErrors.push(`${rel}: FAIL reports must name findings and required repair`);
    }
    if (spec.mustPass && verdict !== "PASS") reportErrors.push(`${rel}: final quality report must pass before sealing`);
    reports.push({ id: spec.id, path: rel, valid: reportErrors.length === 0, verdict: verdict ?? null, errors: reportErrors });
    errors.push(...reportErrors);
  }
  return { ok: errors.length === 0, reports, errors };
}

function validateMatrixCoverage(runRootPath, matrix, errors) {
  const inventory = readJson(path.join(inputsDir(runRootPath), "inventory.json"));
  const covered = new Set(matrix.entries.flatMap((entry) => entry.coverageUnits));
  const missing = (inventory?.coverageUnits ?? [])
    .filter((unit) => unit?.required && typeof unit.id === "string" && !covered.has(unit.id))
    .map((unit) => unit.id);
  if (missing.length) errors.push(`Page Matrix does not cover required units: ${missing.join(", ")}`);
}

/** Validate the pre-approval plan and the two bounded coverage-review reports. */
export function validatePlanningQuality(runRootPath) {
  const errors = [];
  const pageMatrix = parsePageMatrix(runRootPath, errors);
  validateMatrixCoverage(runRootPath, pageMatrix, errors);
  const coverage = parseQualityReports(runRootPath, { ids: ["coverage", "coverage-rereview"] });
  errors.push(...coverage.errors);
  return { ok: errors.length === 0, errors, pageMatrix, coverage };
}

function validatePageMatrix(runRootPath, matrix, pages, errors) {
  const byPage = new Map(matrix.entries.map((entry) => [entry.page, entry]));
  for (const page of pages) {
    if (!byPage.has(page.rel)) errors.push(`${page.rel}: page is not declared in the Page Matrix`);
  }
  for (const entry of matrix.entries) {
    const page = pages.find((candidate) => candidate.rel === entry.page);
    if (!page) {
      errors.push(`Page Matrix declares a page that was not written: ${entry.page}`);
      continue;
    }
    const mermaidCount = page.mermaidFences.length;
    if (entry.diagram === "required" && mermaidCount === 0) errors.push(`${entry.page}: Page Matrix requires a Mermaid diagram`);
    if (entry.diagram === "omitted" && mermaidCount > 0) errors.push(`${entry.page}: Page Matrix marks Mermaid as omitted but the page contains a diagram`);
  }
  validateMatrixCoverage(runRootPath, matrix, errors);
}

function validateRootIndex(bundle, errors) {
  const rootIndex = path.join(bundle, "index.md");
  if (!fs.existsSync(rootIndex)) {
    errors.push("bundle/index.md is missing");
    return;
  }
  const parsed = parseMarkdownFrontmatter(fs.readFileSync(rootIndex, "utf8"));
  if (!parsed.ok) {
    errors.push(`index.md: ${parsed.error}`);
    return;
  }
  const keys = Object.keys(parsed.data);
  if (keys.length !== 1 || parsed.data.okf_version !== "0.2") {
    errors.push('index.md frontmatter must contain only okf_version: "0.2"');
  }
}

/** Host-owned metadata. Agent-authored type/title/sources are never invented here. */
export function stampBundleMetadata(runRootPath, { generatedAt = new Date().toISOString() } = {}) {
  const bundle = bundleDir(runRootPath);
  const errors = [];
  for (const { abs, rel } of walkBundle(bundle).markdown) {
    if (path.posix.basename(rel) === "index.md") continue;
    const parsed = parseMarkdownFrontmatter(fs.readFileSync(abs, "utf8"));
    if (!parsed.ok) {
      errors.push(`${rel}: ${parsed.error}`);
      continue;
    }
    const next = { ...parsed.data };
    if (next.status === undefined) next.status = "draft";
    next.generated = { by: GENERATED_BY, at: generatedAt };
    fs.writeFileSync(abs, renderDocument(next, parsed.body), "utf8");
  }
  return { ok: errors.length === 0, errors };
}

/** Validate an existing generated bundle without mutating it. */
export function validateBundle(runRootPath) {
  const bundle = bundleDir(runRootPath);
  const sources = frozenSourcesDir(runRootPath);
  const errors = [];
  const warnings = [];
  const snapshot = verifyFrozenSnapshot(runRootPath);
  if (!snapshot.ok) errors.push(...snapshot.errors.map((error) => `frozen snapshot integrity failed: ${error}`));
  if (!fs.existsSync(bundle)) errors.push("bundle directory is missing");
  const scan = walkBundle(bundle);
  for (const rel of scan.unsafe) errors.push(`${rel}: symlinks are not allowed in bundle/`);
  validateRootIndex(bundle, errors);
  const pageMatrix = parsePageMatrix(runRootPath, errors);

  const pages = [];
  for (const { abs, rel } of scan.markdown) {
    const name = path.posix.basename(rel);
    if (name === "index.md") continue;
    if (name === "log.md") {
      errors.push(`${rel}: log.md is reserved and not emitted by this producer`);
      continue;
    }
    const text = fs.readFileSync(abs, "utf8");
    const parsed = parseMarkdownFrontmatter(text);
    if (!parsed.ok) {
      errors.push(`${rel}: ${parsed.error}`);
      continue;
    }
    const mermaidFences = validateMermaidFences(parsed.body, rel, errors);
    pages.push({ rel, mermaidFences });
    validatePagePath(rel, parsed.data, errors);
    for (const key of ["type", "title", "status"]) {
      if (typeof parsed.data[key] !== "string" || !parsed.data[key].trim()) errors.push(`${rel}: frontmatter missing non-empty ${key}`);
    }
    if (parsed.data.status !== "draft") errors.push(`${rel}: status must be draft`);
    const generated = parsed.data.generated;
    if (!generated || typeof generated !== "object" || Array.isArray(generated) || generated.by !== GENERATED_BY || typeof generated.at !== "string" || !generated.at) {
      errors.push(`${rel}: generated must be host metadata with by and at`);
    }
    if (!Array.isArray(parsed.data.sources) || parsed.data.sources.length === 0) {
      errors.push(`${rel}: frontmatter sources must be a non-empty array`);
    } else {
      const resources = new Set();
      const ids = new Set();
      for (const entry of parsed.data.sources) {
        const resource = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.resource : undefined;
        const id = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.id : undefined;
        if (typeof resource === "string" && resources.has(resource)) errors.push(`${rel}: duplicate source resource: ${resource}`);
        if (typeof resource === "string") resources.add(resource);
        if (typeof id === "string" && ids.has(id)) errors.push(`${rel}: duplicate source id: ${id}`);
        if (typeof id === "string") ids.add(id);
        validateSourceResource(entry, sources, rel, errors);
      }
    }
    let citationCount = 0;
    for (const link of parseLinks(parsed.body)) {
      if (validateCitationLink({ rel, pageAbs: abs, target: link.target, bundle, sources, errors })) citationCount++;
      validateInternalLink({ rel, pageAbs: abs, target: link.target, bundle, errors });
    }
    if (!citationCount) errors.push(`${rel}: page has no frozen-source Markdown citation with #Lx-Ly`);
  }
  validatePageMatrix(runRootPath, pageMatrix, pages, errors);
  if (!pages.length) warnings.push("bundle has no concept or domain pages yet");
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    pageCount: pages.length,
    pageMatrix: { ok: pageMatrix.errors.length === 0, entries: pageMatrix.entries, errors: pageMatrix.errors },
    snapshot,
  };
}

/** Regenerate root and directory navigation after agent-authored pages are complete. */
export function regenerateIndexes(runRootPath) {
  const bundle = bundleDir(runRootPath);
  fs.mkdirSync(bundle, { recursive: true });
  let written = 0;
  function writeIndex(directory, rel = "") {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));
    const dirs = entries.filter((entry) => entry.isDirectory());
    const pages = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !RESERVED_FILENAMES.has(entry.name));
    for (const entry of dirs) writeIndex(path.join(directory, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
    if (!rel) {
      fs.writeFileSync(path.join(directory, "index.md"), '---\nokf_version: "0.2"\n---\n\n# Wiki\n', "utf8");
      written++;
      return;
    }
    const lines = ["# Index", ""];
    if (dirs.length) {
      lines.push("## Directories", "");
      for (const entry of dirs) lines.push(`- [${entry.name}/](./${entry.name}/index.md)`);
      lines.push("");
    }
    if (pages.length) {
      lines.push("## Pages", "");
      for (const entry of pages) lines.push(`- [${entry.name.replace(/\.md$/, "")}](./${entry.name})`);
      lines.push("");
    }
    fs.writeFileSync(path.join(directory, "index.md"), `${lines.join("\n")}\n`, "utf8");
    written++;
  }
  writeIndex(bundle);
  return { written };
}

export function sealBundle(runRootPath, validation) {
  if (!validation?.ok) throw new Error("cannot seal an invalid bundle");
  const quality = parseQualityReports(runRootPath);
  if (!quality.ok) throw new Error(`cannot seal without passing quality reports: ${quality.errors.join("; ")}`);
  const manifestPath = bundleManifestPath(runRootPath);
  if (fs.existsSync(manifestPath)) throw new Error("bundle is already sealed; create a new run to regenerate it");
  const tree = hashTree(bundleDir(runRootPath));
  const manifest = {
    version: 2,
    sealedAt: new Date().toISOString(),
    bundleDigest: tree.digest,
    fileCount: tree.fileCount,
    files: tree.files,
    validationDigest: sha256(JSON.stringify({ pageCount: validation.pageCount, errors: validation.errors })),
  };
  writeJson(manifestPath, manifest);
  return manifest;
}

export function bundleSealStatus(runRootPath) {
  const manifestPath = bundleManifestPath(runRootPath);
  if (!fs.existsSync(manifestPath)) return { sealed: false, valid: false, manifest: null };
  const manifest = readJson(manifestPath);
  const tree = hashTree(bundleDir(runRootPath));
  return {
    sealed: true,
    valid: manifest?.version === 2 && manifest.bundleDigest === tree.digest,
    manifest,
    actualDigest: tree.digest,
  };
}
