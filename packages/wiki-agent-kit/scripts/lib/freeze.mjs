/**
 * Freeze sources + internal method pack into a run workdir; record digests and effective ignores.
 * Source files are copied directly into the run workdir.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { effectiveSourceIgnores, pathMatchesIgnore } from "./ignores.mjs";
import { buildInventory, writeInventory } from "./inventory.mjs";
import { setActiveRun } from "./active-run.mjs";
import { normalizeLimits } from "./limits.mjs";
import { KIT_ROOT, kitMethodDir, runDir, runsDir } from "./paths.mjs";
import { resolveSourceAbs } from "./sources.mjs";
import { loadWorkspace } from "./workspace.mjs";
import { hashTree, isInside, readJson, writeJson } from "./artifacts.mjs";

function gitHead(abs) {
  const r = spawnSync("git", ["-C", abs, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim();
  return null;
}

/**
 * Copy a filtered source tree into destAbs.
 * Directory symlinks are never materialised; escaping / dangling file symlinks are skipped.
 */
function copyTreeFiltered(srcAbs, destAbs, patterns) {
  fs.mkdirSync(destAbs, { recursive: true });
  const sourceReal = fs.realpathSync(srcAbs);
  const skippedSymlinks = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const fromDir = rel ? path.join(srcAbs, rel) : srcAbs;
    const toDir = rel ? path.join(destAbs, rel) : destAbs;
    fs.mkdirSync(toDir, { recursive: true });
    let entries;
    try {
      entries = fs.readdirSync(fromDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const norm = childRel.replace(/\\/g, "/");
      if (pathMatchesIgnore(norm, patterns)) continue;
      const from = path.join(fromDir, ent.name);
      const to = path.join(toDir, ent.name);
      if (ent.isDirectory()) {
        stack.push(norm);
      } else if (ent.isFile()) {
        fs.copyFileSync(from, to);
      } else if (ent.isSymbolicLink()) {
        try {
          const real = fs.realpathSync(from);
          if (!isInside(sourceReal, real)) {
            skippedSymlinks.push({ path: norm, reason: "target escapes source root" });
          } else if (fs.statSync(real).isFile()) {
            fs.copyFileSync(real, to);
          } else {
            skippedSymlinks.push({ path: norm, reason: "directory symlink not copied" });
          }
        } catch {
          skippedSymlinks.push({ path: norm, reason: "dangling or unreadable" });
        }
      }
    }
  }
  return { skippedSymlinks };
}

function copyMethod(destMethodDir) {
  const from = kitMethodDir();
  if (!fs.existsSync(from)) {
    throw new Error(`missing canonical method pack: ${from}`);
  }
  fs.cpSync(from, destMethodDir, { recursive: true });
  const { digest } = hashTree(destMethodDir);
  return { digest, path: destMethodDir };
}

/**
 * Create a new run, freeze sources+internal method pack, and write inventory.
 * This is a host primitive; the public CLI entry point is `ow prepare`.
 */
export function freezeRun(root, { focus } = {}) {
  const workspace = loadWorkspace(root);
  if (!workspace.sources?.length) {
    throw new Error("workspace has no sources; run: ow source add clone|path …");
  }

  const runId = randomUUID().slice(0, 8) + Date.now().toString(36).slice(-4);
  const rdir = runDir(root, runId);
  const workdir = path.join(rdir, "workdir");
  fs.mkdirSync(path.join(workdir, "sources"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "inputs"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "analysis"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "candidate"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "analysis", "receipts", "survey"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "analysis", "receipts", "semantic"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "analysis", "checkpoints"), { recursive: true });

  const sourceSnapshots = [];
  const sourceRoots = new Map();
  for (const src of workspace.sources) {
    const abs = resolveSourceAbs(root, src);
    const patterns = effectiveSourceIgnores(src);
    const head = gitHead(abs);
    const dest = path.join(workdir, "sources", src.id);
    const copy = copyTreeFiltered(abs, dest, patterns);
    const tree = hashTree(dest);
    sourceRoots.set(src.id, dest);
    sourceSnapshots.push({
      sourceId: src.id,
      gitHead: head,
      contentDigest: tree.digest,
      fileCount: tree.fileCount,
      files: tree.files,
      skippedSymlinks: copy.skippedSymlinks,
      effectiveIgnores: patterns,
      applyDefaultIgnores: src.applyDefaultIgnores !== false,
      presets: src.presets ?? [],
      userIgnore: src.ignore ?? [],
    });
  }

  const method = copyMethod(path.join(workdir, "method"));

  const inventory = buildInventory(root, workspace, { sourceRoots });
  writeInventory(workdir, inventory);
  writeJson(path.join(workdir, "inputs", "snapshot-manifest.json"), {
    version: 1,
    sources: sourceSnapshots,
  });

  const runPolicy = {
    version: 3,
    wikiLanguage: workspace.wikiLanguage,
    focus: focus || null,
    tier: inventory.tier,
    hostCli: {
      node: process.execPath,
      script: path.join(KIT_ROOT, "scripts", "ow.mjs"),
      workspaceRoot: root,
    },
    limits: normalizeLimits(undefined, { sourceCount: inventory.sourceCount }),
  };
  fs.writeFileSync(
    path.join(workdir, "inputs", "run-policy.json"),
    `${JSON.stringify(runPolicy, null, 2)}\n`,
    "utf8",
  );

  const meta = {
    runId,
    createdAt: new Date().toISOString(),
    wikiLanguage: workspace.wikiLanguage,
    focus: focus || null,
    methodDigest: method.digest,
    sources: sourceSnapshots,
    inventoryTier: inventory.tier,
    coverageUnitCount: inventory.coverageUnits.length,
    workdir: path.relative(root, workdir),
  };
  fs.writeFileSync(path.join(rdir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  // Empty discovery-map shell is planning input. Discover writes the filled analysis version;
  // the gate prefers that version when it contains domains.
  const emptyMap = {
    version: 1,
    sources: inventory.sources.map((s) => ({
      sourceId: s.sourceId,
      role: null,
      entryPoints: [],
      surfaces: s.surfaces,
      purpose: null,
      evidencePaths: [],
    })),
    domains: [],
    flows: [],
    concepts: [],
    openQuestions: [],
    coverageUnits: inventory.coverageUnits,
  };
  fs.writeFileSync(
    path.join(workdir, "inputs", "discovery-map.json"),
    `${JSON.stringify(emptyMap, null, 2)}\n`,
    "utf8",
  );

  const current = setActiveRun(root, {
    runId,
    workdir,
    phase: "frozen",
    status: "active",
  });

  return {
    runId,
    runDir: rdir,
    workdir,
    meta,
    inventory,
    current,
  };
}

export function loadRunMeta(root, runId) {
  const metaPath = path.join(runDir(root, runId), "meta.json");
  if (!fs.existsSync(metaPath)) throw new Error(`unknown run: ${runId}`);
  return JSON.parse(fs.readFileSync(metaPath, "utf8"));
}

export function listRuns(root) {
  const dir = runsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((id) => fs.existsSync(path.join(dir, id, "meta.json")))
    .map((id) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, id, "meta.json"), "utf8"));
      } catch {
        return { runId: id, status: "corrupt" };
      }
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function isSafeSnapshotSourceId(sourceId) {
  return typeof sourceId === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(sourceId);
}

/**
 * Recompute every frozen source tree and compare it with the snapshot manifest.
 * This intentionally verifies the run copy itself rather than its original source.
 */
export function verifyFrozenSnapshot(workdir) {
  const errors = [];
  const snapshotPath = path.join(workdir, "inputs", "snapshot-manifest.json");
  let snapshot;
  try {
    snapshot = readJson(snapshotPath);
  } catch (error) {
    return { ok: false, errors: [`invalid snapshot manifest: ${error.message}`] };
  }
  if (!snapshot || !Array.isArray(snapshot.sources)) {
    return { ok: false, errors: ["snapshot manifest must contain a sources array"] };
  }

  const sourcesRoot = path.join(workdir, "sources");
  const seen = new Set();
  for (const source of snapshot.sources) {
    const sourceId = source?.sourceId;
    if (!isSafeSnapshotSourceId(sourceId)) {
      errors.push(`invalid snapshot source id: ${sourceId}`);
      continue;
    }
    if (seen.has(sourceId)) {
      errors.push(`duplicate snapshot source id: ${sourceId}`);
      continue;
    }
    seen.add(sourceId);

    const sourceDir = path.resolve(sourcesRoot, sourceId);
    if (!isInside(sourcesRoot, sourceDir) || !fs.existsSync(sourceDir)) {
      errors.push(`missing frozen source: ${sourceId}`);
      continue;
    }

    let tree;
    try {
      tree = hashTree(sourceDir);
    } catch (error) {
      errors.push(`cannot hash frozen source ${sourceId}: ${error.message}`);
      continue;
    }
    if (tree.digest !== source.contentDigest) {
      errors.push(`content digest mismatch for frozen source: ${sourceId}`);
    }
    if (tree.fileCount !== source.fileCount) {
      errors.push(`file count mismatch for frozen source: ${sourceId}`);
    }
    if (JSON.stringify(tree.files) !== JSON.stringify(source.files)) {
      errors.push(`file manifest mismatch for frozen source: ${sourceId}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
