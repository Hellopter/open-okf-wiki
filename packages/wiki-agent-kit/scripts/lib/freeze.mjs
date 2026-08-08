/** Freeze source inputs into a self-contained v4 run. */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { effectiveSourceIgnores, pathMatchesIgnore } from "./ignores.mjs";
import { buildInventory } from "./inventory.mjs";
import { setActiveRun } from "./active-run.mjs";
import { inputsDir, frozenSourcesDir, analysisDir, bundleDir, evidenceDir, kitMethodDir, qualityReportsDir, runDir, runMethodDir, runsDir, statePath } from "./paths.mjs";
import { assertRuntime } from "./install.mjs";
import { resolveSourceAbs } from "./sources.mjs";
import { loadWorkspace } from "./workspace.mjs";
import { hashTree, isInside, readJson, writeJson } from "./artifacts.mjs";

function gitHead(abs) {
  const result = spawnSync("git", ["-C", abs, "rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Directory symlinks and symlinks that escape the source are deliberately excluded. */
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
      const normalized = childRel.replace(/\\/g, "/");
      if (pathMatchesIgnore(normalized, patterns) || pathMatchesIgnore(`${normalized}/`, patterns)) continue;
      const from = path.join(fromDir, ent.name);
      const to = path.join(toDir, ent.name);
      if (ent.isDirectory()) {
        stack.push(normalized);
      } else if (ent.isFile()) {
        fs.copyFileSync(from, to);
      } else if (ent.isSymbolicLink()) {
        try {
          const real = fs.realpathSync(from);
          if (!isInside(sourceReal, real)) {
            skippedSymlinks.push({ path: normalized, reason: "target escapes source root" });
          } else if (fs.statSync(real).isFile()) {
            fs.copyFileSync(real, to);
          } else {
            skippedSymlinks.push({ path: normalized, reason: "directory symlink not copied" });
          }
        } catch {
          skippedSymlinks.push({ path: normalized, reason: "dangling or unreadable" });
        }
      }
    }
  }
  return { skippedSymlinks };
}

function inventoryMarkdown(inventory) {
  const lines = ["# Repository Inventory", "", `- Tier: ${inventory.tier}`, `- Sources: ${inventory.sourceCount}`, `- Files: ${inventory.fileCount}`, "", "## Required Coverage", ""];
  for (const unit of inventory.coverageUnits) {
    if (!unit.required) continue;
    lines.push(`- \`${unit.id}\` (${unit.kind}, \`${unit.sourceId}/${unit.path}\`)`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function adaptiveDiscovery(inventory) {
  const enabled = inventory.coverageUnits.filter((unit) => unit.required).length > 12 || inventory.sourceCount > 4;
  return { enabled, maxAgents: enabled ? 3 : 0 };
}

function makeRunId() {
  return `${randomUUID().slice(0, 8)}${Date.now().toString(36).slice(-4)}`;
}

function freezeMethod(runRootPath) {
  const source = kitMethodDir();
  if (!fs.existsSync(source)) throw new Error(`missing canonical method pack: ${source}`);
  const destination = runMethodDir(runRootPath);
  fs.cpSync(source, destination, { recursive: true });
  return `sha256:${hashTree(destination).digest}`;
}

/** Create a new v4 run with immutable source inputs and no LLM-authored JSON handoff. */
export function freezeRun(root, { focus } = {}) {
  const workspace = loadWorkspace(root);
  const { runtime } = assertRuntime(root);
  if (!workspace.sources?.length) {
    throw new Error("workspace has no sources; add a source with /wiki source add clone|path ...");
  }
  if (focus !== undefined && focus !== null && (typeof focus !== "string" || !focus.trim())) {
    throw new Error("focus must be a non-empty string when provided");
  }

  const runId = makeRunId();
  const rootDir = runDir(root, runId);
  const inputs = inputsDir(rootDir);
  const sources = frozenSourcesDir(rootDir);
  fs.mkdirSync(sources, { recursive: true });
  fs.mkdirSync(analysisDir(rootDir), { recursive: true });
  fs.mkdirSync(path.join(analysisDir(rootDir), "discovery"), { recursive: true });
  fs.mkdirSync(evidenceDir(rootDir), { recursive: true });
  fs.mkdirSync(qualityReportsDir(rootDir), { recursive: true });
  fs.mkdirSync(path.join(analysisDir(rootDir), "session"), { recursive: true });
  fs.mkdirSync(bundleDir(rootDir), { recursive: true });
  const methodDigest = freezeMethod(rootDir);

  const sourceSnapshots = [];
  const sourceRoots = new Map();
  for (const src of workspace.sources) {
    const abs = resolveSourceAbs(root, src);
    const patterns = effectiveSourceIgnores(src);
    const dest = path.join(sources, src.id);
    const copy = copyTreeFiltered(abs, dest, patterns);
    const tree = hashTree(dest);
    sourceRoots.set(src.id, dest);
    sourceSnapshots.push({
      sourceId: src.id,
      gitHead: gitHead(abs),
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

  const inventory = buildInventory(root, workspace, { sourceRoots });
  const discovery = adaptiveDiscovery(inventory);
  const policy = {
    version: 4,
    wikiLanguage: workspace.wikiLanguage,
    focus: focus?.trim() || null,
    approval: workspace.workflow.approval,
    discovery,
    methodDigest,
    runtime: { kind: runtime.kind, extension: runtime.extension, workflow: runtime.workflow },
  };
  writeJson(path.join(inputs, "snapshot-manifest.json"), { version: 2, sources: sourceSnapshots });
  writeJson(path.join(inputs, "inventory.json"), inventory);
  writeJson(path.join(inputs, "run-policy.json"), policy);
  fs.writeFileSync(path.join(analysisDir(rootDir), "inventory.md"), inventoryMarkdown(inventory), "utf8");

  const state = {
    version: 4,
    runId,
    status: "planning",
    approval: workspace.workflow.approval,
    planDigest: null,
    approvedAt: null,
    sessionPath: null,
    bundle: null,
    quality: { status: "pending", recoveryCount: 0, reports: [], errors: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeJson(statePath(rootDir), state);
  const meta = {
    version: 4,
    runId,
    createdAt: state.createdAt,
    wikiLanguage: workspace.wikiLanguage,
    focus: policy.focus,
    approval: policy.approval,
    inventoryTier: inventory.tier,
    coverageUnitCount: inventory.coverageUnits.length,
    methodDigest,
    runDir: path.relative(root, rootDir),
    runtime: policy.runtime,
  };
  writeJson(path.join(rootDir, "meta.json"), meta);
  const current = setActiveRun(root, { runId, runDir: rootDir, status: state.status, planDigest: null });

  return { runId, runDir: rootDir, meta, inventory, policy, state, current };
}

export function loadRunMeta(root, runId) {
  const metaPath = path.join(runDir(root, runId), "meta.json");
  if (!fs.existsSync(metaPath)) throw new Error(`unknown run: ${runId}`);
  return JSON.parse(fs.readFileSync(metaPath, "utf8"));
}

export function listRuns(root) {
  const directory = runsDir(root);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((id) => fs.existsSync(path.join(directory, id, "meta.json")))
    .map((id) => {
      try {
        return readJson(path.join(directory, id, "meta.json"));
      } catch {
        return { runId: id, status: "corrupt" };
      }
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function isSafeSnapshotSourceId(sourceId) {
  return typeof sourceId === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(sourceId);
}

/** Recompute each frozen source tree. Original linked/clone sources are intentionally irrelevant. */
export function verifyFrozenSnapshot(runRootPath) {
  const errors = [];
  const snapshotPath = path.join(inputsDir(runRootPath), "snapshot-manifest.json");
  let snapshot;
  try {
    snapshot = readJson(snapshotPath);
  } catch (error) {
    return { ok: false, errors: [`invalid snapshot manifest: ${error.message}`] };
  }
  if (!snapshot || !Array.isArray(snapshot.sources)) {
    return { ok: false, errors: ["snapshot manifest must contain a sources array"] };
  }
  const sources = frozenSourcesDir(runRootPath);
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
    const sourceDir = path.resolve(sources, sourceId);
    if (!isInside(sources, sourceDir) || !fs.existsSync(sourceDir)) {
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
    if (tree.digest !== source.contentDigest) errors.push(`content digest mismatch for frozen source: ${sourceId}`);
    if (tree.fileCount !== source.fileCount) errors.push(`file count mismatch for frozen source: ${sourceId}`);
    if (JSON.stringify(tree.files) !== JSON.stringify(source.files)) errors.push(`file manifest mismatch for frozen source: ${sourceId}`);
  }
  const meta = readJson(path.join(runRootPath, "meta.json"));
  if (typeof meta?.methodDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(meta.methodDigest)) {
    errors.push("missing or invalid frozen method digest");
  } else {
    try {
      const actual = `sha256:${hashTree(runMethodDir(runRootPath)).digest}`;
      if (actual !== meta.methodDigest) errors.push("method digest mismatch for frozen run");
    } catch (error) {
      errors.push(`cannot hash frozen method: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
