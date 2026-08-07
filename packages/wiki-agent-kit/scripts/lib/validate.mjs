/** Minimal OKF v0.2 bundle validation, index projection, and immutable sealing. */

import fs from "node:fs";
import path from "node:path";
import YAML, { parseDocument } from "yaml";
import {
  analysisDir,
  bundleDir,
  bundleManifestPath,
  frozenSourcesDir,
  inputsDir,
  planPath,
} from "./paths.mjs";
import { hashTree, isInside, readJson, sha256, writeJson } from "./artifacts.mjs";
import { verifyFrozenSnapshot } from "./freeze.mjs";

const RESERVED_FILENAMES = new Set(["index.md", "log.md"]);
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LINE_FRAGMENT_RE = /^L(\d+)(?:-L(\d+))?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const GENERATED_BY = "okf-wiki-agent/0.1.0";

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

function validateCoveragePlan(runRootPath, errors) {
  const inventory = readJson(path.join(inputsDir(runRootPath), "inventory.json"));
  let plan = "";
  try {
    plan = fs.readFileSync(planPath(runRootPath), "utf8");
  } catch {
    errors.push("missing analysis/plan.md");
    return;
  }
  if (!plan.trim()) {
    errors.push("analysis/plan.md is empty");
    return;
  }
  const missing = (inventory?.coverageUnits ?? [])
    .filter((unit) => unit?.required)
    .map((unit) => unit.id)
    .filter((id) => typeof id === "string" && !plan.includes(id));
  if (missing.length) errors.push(`plan does not account for required coverage units: ${missing.join(", ")}`);
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
  validateCoveragePlan(runRootPath, errors);

  const pages = [];
  for (const { abs, rel } of scan.markdown) {
    const name = path.posix.basename(rel);
    if (name === "index.md") continue;
    if (name === "log.md") {
      errors.push(`${rel}: log.md is reserved and not emitted by this producer`);
      continue;
    }
    pages.push(rel);
    const parsed = parseMarkdownFrontmatter(fs.readFileSync(abs, "utf8"));
    if (!parsed.ok) {
      errors.push(`${rel}: ${parsed.error}`);
      continue;
    }
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
  if (!pages.length) warnings.push("bundle has no concept or domain pages yet");
  return { ok: errors.length === 0, errors, warnings, pageCount: pages.length, snapshot };
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
