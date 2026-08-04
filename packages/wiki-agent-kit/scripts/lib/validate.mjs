/** Mechanical candidate validation, local source-link resolution, and sealing. */

import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { candidateDir, candidateManifestPath } from "./paths.mjs";
import { hashTree, isInside, readJson, writeJson } from "./artifacts.mjs";

const RESERVED = new Set(["index.md", "log.md"]);
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LINE_FRAGMENT_RE = /^L(\d+)(?:-L(\d+))?$/;

function walkMd(dir, base = "", unsafe = []) {
  const out = [];
  if (!fs.existsSync(dir)) return { files: out, unsafe };
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkMd(abs, rel, unsafe).files);
    else if (ent.isFile() && ent.name.endsWith(".md")) out.push({ rel: rel.replace(/\\/g, "/"), abs });
    else if (ent.isSymbolicLink()) unsafe.push(rel.replace(/\\/g, "/"));
  }
  return { files: out, unsafe };
}

function parseFrontmatter(text) {
  const start = text.match(/^---\r?\n/);
  if (!start) return { ok: false, error: "missing YAML frontmatter" };
  const close = text.indexOf("\n---", start[0].length);
  if (close < 0) return { ok: false, error: "unclosed frontmatter" };
  const raw = text.slice(start[0].length, close);
  const doc = parseDocument(raw, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length) return { ok: false, error: `invalid YAML frontmatter: ${doc.errors[0].message}` };
  const data = doc.toJSON();
  if (!data || Array.isArray(data) || typeof data !== "object") {
    return { ok: false, error: "frontmatter must be a YAML mapping" };
  }
  return { ok: true, data, body: text.slice(close + 4) };
}

function countLines(fileAbs) {
  const text = fs.readFileSync(fileAbs, "utf8");
  if (!text) return 0;
  const newlineCount = (text.match(/\n/g) ?? []).length;
  return newlineCount + (text.endsWith("\n") ? 0 : 1);
}

function parseLinks(text) {
  const links = [];
  MARKDOWN_LINK_RE.lastIndex = 0;
  let match;
  while ((match = MARKDOWN_LINK_RE.exec(text)) !== null) {
    links.push({ label: match[1], target: match[2] });
  }
  return links;
}

function validateCitation({ rel, pageAbs, target, candidate, sources, errors }) {
  if (target.startsWith("repo:")) {
    errors.push(`${rel}: legacy repo: citations are not clickable; use a relative source link`);
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("/")) return false;
  const hashAt = target.indexOf("#");
  if (hashAt < 0) return false;
  const fragment = target.slice(hashAt + 1);
  const lineMatch = fragment.match(LINE_FRAGMENT_RE);
  if (!lineMatch) return false;
  const targetPath = target.slice(0, hashAt);
  const fileAbs = path.resolve(path.dirname(pageAbs), targetPath);
  if (!isInside(sources, fileAbs) || !fs.existsSync(fileAbs) || !fs.statSync(fileAbs).isFile()) {
    errors.push(`${rel}: citation target must resolve to a frozen source file: ${target}`);
    return true;
  }
  const start = Number(lineMatch[1]);
  const end = lineMatch[2] ? Number(lineMatch[2]) : start;
  const lines = countLines(fileAbs);
  if (start < 1 || end < start || end > lines) {
    errors.push(`${rel}: citation line range out of bounds: ${target} (file lines=${lines})`);
  }
  return true;
}

function validateInternalLink({ rel, pageAbs, target, candidate, errors }) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("#")) return;
  const targetPath = target.split("#", 1)[0];
  if (!targetPath || !targetPath.endsWith(".md")) return;
  const targetAbs = path.resolve(path.dirname(pageAbs), targetPath);
  if (!isInside(candidate, targetAbs) || !fs.existsSync(targetAbs)) {
    errors.push(`${rel}: broken internal Markdown link: ${target}`);
  }
}

function safeCandidatePage(candidate, pagePath) {
  const raw = String(pagePath ?? "");
  if (
    !raw ||
    raw.includes("\\") ||
    raw.split("/").includes("..") ||
    path.isAbsolute(raw) ||
    RESERVED.has(path.posix.basename(raw))
  ) {
    return null;
  }
  const resolved = path.resolve(candidate, raw);
  return isInside(candidate, resolved) ? resolved : null;
}

function isRegularFile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/** @param {string} workdir freeze workdir with candidate/ and sources/ */
export function validateWorkdir(workdir, opts = {}) {
  const candidate = opts.candidateDir ?? candidateDir(workdir);
  const sources = path.join(workdir, "sources");
  const errors = [];
  const warnings = [];
  const scan = walkMd(candidate);
  const files = scan.files;
  for (const rel of scan.unsafe) errors.push(`${rel}: symlinks are not allowed in candidate/`);
  const specPath = opts.specPath ?? path.join(workdir, "analysis", "spec.json");
  let spec = null;
  try {
    spec = readJson(specPath);
  } catch (error) {
    errors.push(`spec parse error (${specPath}): ${error.message}`);
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    errors.push(`missing or invalid Spec: ${specPath}`);
  } else if (!Array.isArray(spec.pages)) {
    errors.push(`Spec pages must be an array: ${specPath}`);
  }

  const specPaths = new Set();
  for (const page of spec?.pages ?? []) {
    if (!page || typeof page !== "object") {
      errors.push("Spec page must be an object");
      continue;
    }
    const target = safeCandidatePage(candidate, page.path);
    if (!target) {
      errors.push(`Spec page has unsafe path: ${page.path ?? "?"}`);
      continue;
    }
    const rel = path.relative(candidate, target).replace(/\\/g, "/");
    specPaths.add(rel);
    if (page.critical !== false && !isRegularFile(target)) {
      errors.push(`critical spec page missing: ${page.path}`);
    }
  }

  const conceptRels = [];
  for (const { rel, abs } of files) {
    if (RESERVED.has(path.posix.basename(rel))) continue;
    conceptRels.push(rel);
    if (spec && !specPaths.has(rel)) {
      errors.push(`${rel}: concept page is absent from the Spec`);
    }
    const parsed = parseFrontmatter(fs.readFileSync(abs, "utf8"));
    if (!parsed.ok) {
      errors.push(`${rel}: ${parsed.error}`);
      continue;
    }
    for (const key of ["type", "title", "description"]) {
      if (typeof parsed.data[key] !== "string" || !parsed.data[key].trim()) {
        errors.push(`${rel}: frontmatter missing non-empty ${key}`);
      }
    }
    for (const banned of ["generated", "verified", "stale_after", "okf_version"]) {
      if (Object.hasOwn(parsed.data, banned)) {
        errors.push(`${rel}: model must not author frontmatter field ${banned}`);
      }
    }
    let citationCount = 0;
    for (const link of parseLinks(parsed.body)) {
      if (validateCitation({ rel, pageAbs: abs, target: link.target, candidate, sources, errors })) {
        citationCount++;
      }
      validateInternalLink({ rel, pageAbs: abs, target: link.target, candidate, errors });
    }
    if (!citationCount) errors.push(`${rel}: concept page has no Source Citation with #Lx-Ly`);
  }

  if (!conceptRels.length) warnings.push("candidate/ has no concept pages yet");
  return { ok: !errors.length, errors, warnings, conceptPageCount: conceptRels.length };
}

/** Mechanically regenerate directory index.md listings (OKF reserved). */
export function regenerateIndexes(dir) {
  if (!fs.existsSync(dir)) return { written: 0 };
  let written = 0;
  function walk(current) {
    const concepts = [];
    const subdirs = [];
    for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      if (ent.isDirectory()) {
        subdirs.push(ent.name);
        walk(path.join(current, ent.name));
      } else if (ent.isFile() && ent.name.endsWith(".md") && !RESERVED.has(ent.name)) {
        concepts.push(ent.name);
      }
    }
    const lines = ["# Index", ""];
    if (subdirs.length) {
      lines.push("## Directories", "");
      for (const child of subdirs.sort()) lines.push(`- [${child}/](./${child}/index.md)`);
      lines.push("");
    }
    if (concepts.length) {
      lines.push("## Pages", "");
      for (const page of concepts.sort()) lines.push(`- [${page.replace(/\.md$/, "")}](./${page})`);
      lines.push("");
    }
    fs.writeFileSync(path.join(current, "index.md"), `${lines.join("\n")}\n`, "utf8");
    written++;
  }
  walk(dir);
  return { written };
}

export function sealCandidate(workdir, validation) {
  if (!validation.ok) throw new Error("cannot seal an invalid candidate");
  if (fs.existsSync(candidateManifestPath(workdir))) {
    throw new Error("candidate is already sealed; run: ow retry --run <id> --from write");
  }
  const candidate = candidateDir(workdir);
  const tree = hashTree(candidate);
  const manifest = {
    version: 1,
    sealedAt: new Date().toISOString(),
    candidateDigest: tree.digest,
    fileCount: tree.fileCount,
    files: tree.files,
  };
  writeJson(candidateManifestPath(workdir), manifest);
  return manifest;
}

export function isCandidateSealed(workdir) {
  return fs.existsSync(candidateManifestPath(workdir));
}

/** Return the state of a sealed candidate without changing it. */
export function candidateSealStatus(workdir) {
  const manifestPath = candidateManifestPath(workdir);
  if (!fs.existsSync(manifestPath)) return { sealed: false, valid: false, manifest: null };
  const manifest = readJson(manifestPath);
  const tree = hashTree(candidateDir(workdir));
  return {
    sealed: true,
    valid: manifest?.candidateDigest === tree.digest,
    manifest,
    actualDigest: tree.digest,
  };
}
