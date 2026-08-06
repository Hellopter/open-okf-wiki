/**
 * Deterministic repository inventory → coverage units + tier.
 */

import fs from "node:fs";
import path from "node:path";
import { effectiveSourceIgnores, pathMatchesIgnore } from "./ignores.mjs";
import { resolveSourceAbs } from "./sources.mjs";

const MAX_WALK_FILES = 50_000;

function walkFiles(absRoot, patterns, { maxFiles = MAX_WALK_FILES } = {}) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(absRoot, rel) : absRoot;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const norm = childRel.replace(/\\/g, "/");
      if (pathMatchesIgnore(norm, patterns) || pathMatchesIgnore(`${norm}/`, patterns)) {
        continue;
      }
      if (ent.isDirectory()) {
        // also skip if dir name matches bare defaults
        if (pathMatchesIgnore(norm, patterns)) continue;
        stack.push(norm);
      } else if (ent.isFile()) {
        if (out.length >= maxFiles) {
          throw new Error(`inventory file limit exceeded (${maxFiles}) for ${absRoot}; add ignore rules`);
        }
        out.push(norm);
      }
    }
  }
  return out;
}

function detectBuild(files, topNames) {
  if (topNames.includes("pom.xml")) return "maven";
  if (topNames.some((n) => n.startsWith("build.gradle"))) return "gradle";
  if (topNames.includes("package.json")) return "node";
  if (topNames.includes("pyproject.toml") || topNames.includes("setup.py")) return "python";
  if (topNames.includes("Cargo.toml")) return "rust";
  if (topNames.includes("go.mod")) return "go";
  return "unknown";
}

function detectLanguages(files) {
  const counts = {};
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!ext) continue;
    counts[ext] = (counts[ext] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, n]) => ({ ext, count: n }));
}

/**
 * Surfaces: Maven/Gradle modules, or package.json workspaces-ish top packages, or root.
 */
function detectSurfaces(absRoot, files, build) {
  const surfaces = [];
  if (build === "maven" || build === "gradle") {
    const modules = new Set();
    for (const f of files) {
      if (f.endsWith("pom.xml") || f.endsWith("build.gradle") || f.endsWith("build.gradle.kts")) {
        const dir = path.posix.dirname(f.replace(/\\/g, "/"));
        modules.add(dir === "." ? "." : dir);
      }
    }
    // prefer modules that have src/
    for (const m of modules) {
      const hasSrc = files.some((f) => f.replace(/\\/g, "/").startsWith(m === "." ? "src/" : `${m}/src/`));
      if (hasSrc || m === ".") {
        surfaces.push({ path: m, kind: "module" });
      }
    }
  }
  // node packages
  for (const f of files) {
    if (f === "package.json" || /^(packages|apps|services)\/[^/]+\/package\.json$/.test(f)) {
      const dir = path.posix.dirname(f);
      surfaces.push({ path: dir === "." ? "." : dir, kind: "package" });
    }
  }
  if (surfaces.length === 0) {
    surfaces.push({ path: ".", kind: "root" });
  }
  // de-dupe
  const seen = new Set();
  return surfaces.filter((s) => {
    const k = `${s.kind}:${s.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function inventoryTier({ sourceCount, fileCount, surfaceCount, multiEntry }) {
  if (sourceCount >= 2) return "L3";
  if (fileCount > 2000 || surfaceCount > 4 || multiEntry) return "L2";
  if (fileCount > 200 || surfaceCount > 1) return "L1";
  return "L0";
}

/**
 * @param {string} root workspace root
 * @param {object} workspace
 * @param {{ sourceRoots?: Map<string, string> }} [opts]
 */
export function buildInventory(root, workspace, opts = {}) {
  const sourcesOut = [];
  const units = [];
  let totalFiles = 0;

  for (const src of workspace.sources) {
    const abs = opts.sourceRoots?.get(src.id) ?? resolveSourceAbs(root, src);
    const patterns = effectiveSourceIgnores(src);
    const files = walkFiles(abs, patterns);
    totalFiles += files.length;
    let topNames = [];
    try {
      topNames = fs.readdirSync(abs);
    } catch {
      topNames = [];
    }
    const build = detectBuild(files, topNames);
    const languages = detectLanguages(files);
    const surfaces = detectSurfaces(abs, files, build);
    sourcesOut.push({
      sourceId: src.id,
      build,
      languages,
      fileCount: files.length,
      surfaces,
      effectiveIgnores: patterns,
    });
    // coverage units: source + each surface
    units.push({
      id: src.id,
      kind: "source",
      sourceId: src.id,
      path: ".",
      required: true,
      survey: "always",
      label: src.id,
    });
    for (const s of surfaces) {
      if (s.path === ".") continue;
      units.push({
        id: `${src.id}::${s.path}`,
        kind: "surface",
        sourceId: src.id,
        path: s.path,
        required: true,
        survey: "on-demand",
        label: `${src.id}::${s.path}`,
      });
    }
  }

  const surfaceCount = units.filter((u) => u.kind === "surface").length;
  const tier = inventoryTier({
    sourceCount: workspace.sources.length,
    fileCount: totalFiles,
    surfaceCount,
    multiEntry: surfaceCount > 1,
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    wikiLanguage: workspace.wikiLanguage,
    tier,
    sourceCount: workspace.sources.length,
    fileCount: totalFiles,
    sources: sourcesOut,
    coverageUnits: units,
  };
}

export function writeInventory(workdir, inventory) {
  const inputs = path.join(workdir, "inputs");
  fs.mkdirSync(inputs, { recursive: true });
  const file = path.join(inputs, "inventory.json");
  fs.writeFileSync(file, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  return file;
}
