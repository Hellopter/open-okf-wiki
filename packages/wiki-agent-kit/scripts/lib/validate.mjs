/**
 * Mechanical OKF + citation validation for staging wiki.
 */

import fs from "node:fs";
import path from "node:path";

const RESERVED = new Set(["index.md", "log.md"]);
const CITE_RE = /\[([^\]]*)\]\((repo:[^)]+)\)/g;
// repo:path#L1-L2  OR  repo:sourceId/path#L1-L2
const REPO_LINK_RE =
  /^repo:(?:([A-Za-z0-9._-]+)\/)?([^#]+?)(?:#L(\d+)(?:-L(\d+))?)?$/;

function walkMd(dir, base = "") {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkMd(abs, rel));
    else if (ent.isFile() && ent.name.endsWith(".md")) out.push({ rel: rel.replace(/\\/g, "/"), abs });
  }
  return out;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { ok: false, error: "missing YAML frontmatter" };
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { ok: false, error: "unclosed frontmatter" };
  const raw = text.slice(4, end).trim();
  /** @type {Record<string, string>} */
  const data = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    data[m[1]] = v;
  }
  return { ok: true, data, body: text.slice(end + 4) };
}

function countLines(fileAbs) {
  try {
    const t = fs.readFileSync(fileAbs, "utf8");
    if (!t) return 0;
    return t.split(/\r?\n/).length;
  } catch {
    return -1;
  }
}

/**
 * @param {string} workdir freeze workdir with wiki/ and sources/
 * @param {{ specPath?: string }} [opts]
 */
export function validateWorkdir(workdir, opts = {}) {
  const wikiDir = path.join(workdir, "wiki");
  const sourcesDir = path.join(workdir, "sources");
  const errors = [];
  const warnings = [];
  const files = walkMd(wikiDir);

  // Prefer explicit opts.specPath; otherwise analysis/ then inputs/
  const specCandidates = opts.specPath
    ? [opts.specPath]
    : [
        path.join(workdir, "analysis", "spec.json"),
        path.join(workdir, "inputs", "spec.json"),
      ];
  let spec = null;
  for (const p of specCandidates) {
    if (!p || !fs.existsSync(p)) continue;
    try {
      spec = JSON.parse(fs.readFileSync(p, "utf8"));
      break;
    } catch (e) {
      errors.push(`spec parse error (${p}): ${e.message}`);
    }
  }

  const conceptRels = [];
  for (const { rel, abs } of files) {
    const base = path.posix.basename(rel);
    if (RESERVED.has(base)) continue;
    conceptRels.push(rel);
    const text = fs.readFileSync(abs, "utf8");
    const fm = parseFrontmatter(text);
    if (!fm.ok) {
      errors.push(`${rel}: ${fm.error}`);
      continue;
    }
    for (const key of ["type", "title", "description"]) {
      if (!fm.data[key] || !String(fm.data[key]).trim()) {
        errors.push(`${rel}: frontmatter missing non-empty ${key}`);
      }
    }
    for (const banned of ["generated", "verified", "stale_after", "okf_version"]) {
      if (fm.data[banned] !== undefined) {
        errors.push(`${rel}: model must not author frontmatter field ${banned}`);
      }
    }

    CITE_RE.lastIndex = 0;
    let m;
    while ((m = CITE_RE.exec(text)) !== null) {
      const link = m[2];
      if (link.includes("sources/")) {
        errors.push(`${rel}: citation must not contain sources/ prefix: ${link}`);
      }
      const rm = link.match(REPO_LINK_RE);
      if (!rm) {
        errors.push(`${rel}: malformed repo citation: ${link}`);
        continue;
      }
      const sourceId = rm[1];
      const filePath = rm[2].replace(/^\//, "");
      const lineStart = rm[3] ? Number(rm[3]) : null;
      const lineEnd = rm[4] ? Number(rm[4]) : lineStart;
      let fileAbs;
      if (sourceId) {
        fileAbs = path.join(sourcesDir, sourceId, filePath);
      } else {
        // single-source: try each source mount
        const mounts = fs.existsSync(sourcesDir) ? fs.readdirSync(sourcesDir) : [];
        if (mounts.length === 1) {
          fileAbs = path.join(sourcesDir, mounts[0], filePath);
        } else if (mounts.length === 0) {
          errors.push(`${rel}: no frozen sources for citation ${link}`);
          continue;
        } else {
          errors.push(`${rel}: multi-source freeze requires repo:<id>/path citation: ${link}`);
          continue;
        }
      }
      if (!fs.existsSync(fileAbs)) {
        errors.push(`${rel}: citation target missing: ${link}`);
        continue;
      }
      if (lineStart != null) {
        const n = countLines(fileAbs);
        if (n < 0 || lineStart < 1 || lineEnd < lineStart || lineEnd > n) {
          errors.push(`${rel}: citation line range out of bounds: ${link} (file lines=${n})`);
        }
      }
    }
  }

  if (spec?.pages) {
    for (const page of spec.pages) {
      if (page.critical === false) continue;
      const p = String(page.path || "").replace(/^\//, "");
      if (!p || RESERVED.has(path.posix.basename(p))) continue;
      const abs = path.join(wikiDir, p);
      if (!fs.existsSync(abs)) {
        errors.push(`critical spec page missing: ${p}`);
      }
    }
  }

  if (conceptRels.length === 0) {
    warnings.push("wiki/ has no concept pages yet");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    conceptPageCount: conceptRels.length,
  };
}

/**
 * Mechanically regenerate directory index.md listings (OKF reserved).
 */
export function regenerateIndexes(wikiDir) {
  if (!fs.existsSync(wikiDir)) return { written: 0 };
  let written = 0;

  function walk(dir, relBase = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const concepts = [];
    const subdirs = [];
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      if (ent.isDirectory()) {
        subdirs.push(ent.name);
        walk(path.join(dir, ent.name), relBase ? `${relBase}/${ent.name}` : ent.name);
      } else if (ent.isFile() && ent.name.endsWith(".md") && !RESERVED.has(ent.name)) {
        concepts.push(ent.name);
      }
    }
    concepts.sort();
    subdirs.sort();
    const lines = ["# Index", ""];
    if (subdirs.length) {
      lines.push("## Directories", "");
      for (const d of subdirs) lines.push(`- [${d}/](./${d}/index.md)`);
      lines.push("");
    }
    if (concepts.length) {
      lines.push("## Pages", "");
      for (const c of concepts) lines.push(`- [${c.replace(/\.md$/, "")}](./${c})`);
      lines.push("");
    }
    fs.writeFileSync(path.join(dir, "index.md"), `${lines.join("\n")}\n`, "utf8");
    written++;
  }

  walk(wikiDir);
  return { written };
}
