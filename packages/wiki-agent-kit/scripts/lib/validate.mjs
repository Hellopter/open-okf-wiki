/** Mechanical candidate validation, local source-link resolution, and sealing. */

import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { candidateDir, candidateManifestPath } from "./paths.mjs";
import { hashTree, isInside, readJson, writeJson } from "./artifacts.mjs";

const RESERVED = new Set(["index.md", "log.md"]);
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LINE_FRAGMENT_RE = /^L(\d+)(?:-L(\d+))?$/;
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
const MEANINGFUL_CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

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

export function normalizeWikiLanguage(value) {
  const raw = String(value ?? "en").trim().toLowerCase();
  if (raw === "zh" || raw === "zh-cn" || raw === "zh_cn" || raw === "zh-hans") return "zh";
  if (raw === "en" || raw.startsWith("en-")) return "en";
  return raw || "en";
}

export function isChineseWikiLanguage(value) {
  return normalizeWikiLanguage(value) === "zh";
}

/** Strip fenced/inline code so language checks focus on prose. */
export function proseWithoutCode(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/\[[^\]]*\]\(([^)]+)\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

/** Body text used for locale checks: ignore code, links, and heading lines. */
export function proseBodyForLanguageCheck(text) {
  return proseWithoutCode(text)
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, " ")
    .replace(/^\s*[-*+]\s+/gm, " ")
    .replace(/^\s*\d+\.\s+/gm, " ");
}

export function containsCjk(text) {
  return CJK_RE.test(String(text ?? ""));
}

export function containsMeaningfulCjk(text) {
  const prose = proseBodyForLanguageCheck(text);
  const matches = prose.match(new RegExp(MEANINGFUL_CJK_RE, "g")) ?? [];
  return matches.length >= 2;
}

function headingTexts(body) {
  const headings = [];
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (match) headings.push(match[1].trim());
  }
  return headings;
}

function hasRequiredSection(body, section) {
  const wanted = String(section ?? "").trim().toLowerCase();
  if (!wanted) return false;
  return headingTexts(body).some((heading) => heading.toLowerCase() === wanted);
}

function loadRunPolicyLanguage(workdir) {
  const policyPath = path.join(workdir, "inputs", "run-policy.json");
  if (!fs.existsSync(policyPath)) return null;
  try {
    const policy = readJson(policyPath);
    return policy?.wikiLanguage ?? null;
  } catch {
    return null;
  }
}

function conceptDisplay(abs, fallbackName) {
  try {
    const parsed = parseFrontmatter(fs.readFileSync(abs, "utf8"));
    if (!parsed.ok) return { title: fallbackName, description: "" };
    const title =
      typeof parsed.data.title === "string" && parsed.data.title.trim()
        ? parsed.data.title.trim()
        : fallbackName;
    const description =
      typeof parsed.data.description === "string" ? parsed.data.description.trim() : "";
    return { title, description };
  } catch {
    return { title: fallbackName, description: "" };
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

  const wikiLanguage = normalizeWikiLanguage(
    opts.wikiLanguage ?? loadRunPolicyLanguage(workdir) ?? spec?.wikiLanguage ?? "en",
  );
  const requireChinese = isChineseWikiLanguage(wikiLanguage);

  const specPaths = new Set();
  const requiredSectionsByPath = new Map();
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
    if (Array.isArray(page.requiredSections) && page.requiredSections.length) {
      requiredSectionsByPath.set(
        rel,
        page.requiredSections.filter((section) => typeof section === "string" && section.trim()),
      );
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
    if (requireChinese) {
      if (typeof parsed.data.title === "string" && parsed.data.title.trim() && !containsCjk(parsed.data.title)) {
        errors.push(`${rel}: Chinese wiki requires CJK text in title`);
      }
      if (
        typeof parsed.data.description === "string" &&
        parsed.data.description.trim() &&
        !containsCjk(parsed.data.description)
      ) {
        errors.push(`${rel}: Chinese wiki requires CJK text in description`);
      }
      if (!containsMeaningfulCjk(parsed.body)) {
        errors.push(`${rel}: Chinese wiki requires meaningful CJK prose in the page body`);
      }
    }
    const requiredSections = requiredSectionsByPath.get(rel) ?? [];
    for (const section of requiredSections) {
      if (!hasRequiredSection(parsed.body, section)) {
        errors.push(`${rel}: missing required section heading: ${section}`);
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
  return {
    ok: !errors.length,
    errors,
    warnings,
    conceptPageCount: conceptRels.length,
    wikiLanguage,
  };
}

/** Mechanically regenerate directory index.md listings (OKF reserved). */
export function regenerateIndexes(dir, opts = {}) {
  if (!fs.existsSync(dir)) return { written: 0 };
  const wikiLanguage = normalizeWikiLanguage(opts.wikiLanguage ?? "en");
  const chinese = isChineseWikiLanguage(wikiLanguage);
  const labels = chinese
    ? { index: "索引", directories: "目录", pages: "页面" }
    : { index: "Index", directories: "Directories", pages: "Pages" };
  let written = 0;
  function walk(current, isRoot) {
    const concepts = [];
    const subdirs = [];
    for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      if (ent.isDirectory()) {
        subdirs.push(ent.name);
        walk(path.join(current, ent.name), false);
      } else if (ent.isFile() && ent.name.endsWith(".md") && !RESERVED.has(ent.name)) {
        concepts.push(ent.name);
      }
    }
    const lines = [];
    if (isRoot) {
      lines.push("---", 'okf_version: "0.2"', "---", "");
    }
    lines.push(`# ${labels.index}`, "");
    if (subdirs.length) {
      lines.push(`## ${labels.directories}`, "");
      for (const child of subdirs.sort()) lines.push(`- [${child}/](./${child}/index.md)`);
      lines.push("");
    }
    if (concepts.length) {
      lines.push(`## ${labels.pages}`, "");
      for (const page of concepts.sort()) {
        const abs = path.join(current, page);
        const fallback = page.replace(/\.md$/, "");
        const display = conceptDisplay(abs, fallback);
        if (display.description) {
          lines.push(`- [${display.title}](./${page}) — ${display.description}`);
        } else {
          lines.push(`- [${display.title}](./${page})`);
        }
      }
      lines.push("");
    }
    fs.writeFileSync(path.join(current, "index.md"), `${lines.join("\n")}\n`, "utf8");
    written++;
  }
  walk(dir, true);
  return { written, wikiLanguage };
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
