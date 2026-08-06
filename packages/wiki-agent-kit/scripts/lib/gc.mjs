/**
 * Garbage-collect inactive runs and unreferenced CAS objects.
 *
 * Default policy: keep the active current run (always) and up to `keepRuns`
 * newest runs by createdAt (including the current run when present). Delete
 * other run directories, then delete CAS objects not referenced by remaining
 * runs' snapshot-manifest file digests.
 */

import fs from "node:fs";
import path from "node:path";
import { readJson } from "./artifacts.mjs";
import { readCurrent } from "./active-run.mjs";
import { listRuns, loadRunMeta } from "./freeze.mjs";
import { digestFromObjectPath, walkObjects } from "./objects.mjs";
import { objectsDir, runDir, runsDir } from "./paths.mjs";

function collectReferencedDigests(root, keepRunIds) {
  const digests = new Set();
  let incomplete = false;
  for (const runId of keepRunIds) {
    let workdir;
    try {
      const meta = loadRunMeta(root, runId);
      workdir = path.resolve(root, meta.workdir);
    } catch {
      incomplete = true;
      continue;
    }
    const snapshot = readJson(path.join(workdir, "inputs", "snapshot-manifest.json"));
    if (!snapshot?.sources) {
      incomplete = true;
      continue;
    }
    for (const source of snapshot.sources) {
      if (!Array.isArray(source.files)) {
        incomplete = true;
        continue;
      }
      for (const file of source.files) {
        if (file?.sha256) digests.add(String(file.sha256).toLowerCase());
      }
    }
  }
  return { digests, incomplete };
}

function pruneEmptyShards(root) {
  const base = path.join(objectsDir(root), "sha256");
  if (!fs.existsSync(base)) return 0;
  let removed = 0;
  for (const shard of fs.readdirSync(base, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    const shardDir = path.join(base, shard.name);
    const remaining = fs.readdirSync(shardDir).filter((name) => !name.startsWith(".tmp-"));
    if (remaining.length === 0) {
      fs.rmSync(shardDir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

/**
 * Select run ids to keep: always include current pointer; fill with newest
 * runs until `keepRuns` total (or only current when keepRuns is 0).
 */
export function selectRunsToKeep(allMetas, currentRunId, keepRuns) {
  const sorted = [...allMetas].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
  );
  const keep = new Set();
  if (currentRunId) keep.add(currentRunId);
  if (keepRuns <= 0) return keep;
  for (const meta of sorted) {
    if (keep.size >= keepRuns) break;
    keep.add(meta.runId);
  }
  // Current may push size above keepRuns; that is intentional protection.
  return keep;
}

/**
 * @param {string} root
 * @param {{ keepRuns?: number, dryRun?: boolean, runs?: boolean, objects?: boolean }} [opts]
 */
export function gcWorkspace(root, opts = {}) {
  const keepRuns = Number.isFinite(opts.keepRuns) ? Math.max(0, Math.floor(opts.keepRuns)) : 3;
  const dryRun = Boolean(opts.dryRun);
  const doRuns = opts.runs !== false;
  const doObjects = opts.objects !== false;

  const current = readCurrent(root);
  const all = listRuns(root);
  const keep = selectRunsToKeep(all, current?.runId, keepRuns);

  const deletedRuns = [];
  if (doRuns) {
    const known = new Set(all.map((m) => m.runId));
    for (const meta of all) {
      if (keep.has(meta.runId)) continue;
      const dir = runDir(root, meta.runId);
      if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
      deletedRuns.push(meta.runId);
    }
    const dir = runsDir(root);
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (keep.has(name) || deletedRuns.includes(name)) continue;
        const candidate = path.join(dir, name);
        if (!fs.statSync(candidate).isDirectory()) continue;
        // Orphan dirs without meta.json still count as reclaimable.
        if (known.has(name) && keep.has(name)) continue;
        if (!dryRun) fs.rmSync(candidate, { recursive: true, force: true });
        deletedRuns.push(name);
      }
    }
  }

  let objectsDeleted = 0;
  let objectsKept = 0;
  let objectPruneSkipped = false;
  let objectPruneReason = null;
  let shardsRemoved = 0;

  if (doObjects) {
    const remainingIds = listRuns(root).map((m) => m.runId);
    for (const id of keep) {
      if (!remainingIds.includes(id)) remainingIds.push(id);
    }

    const { digests, incomplete } = collectReferencedDigests(root, remainingIds);
    if (incomplete && digests.size === 0 && remainingIds.length > 0) {
      objectPruneSkipped = true;
      objectPruneReason = "kept run missing snapshot-manifest files[]; object prune skipped";
    } else if (incomplete && remainingIds.length > 0) {
      objectPruneReason =
        "some kept runs missing full files[]; pruning only digests absent from remaining manifests";
    }

    if (!objectPruneSkipped) {
      for (const objectAbs of walkObjects(root)) {
        const digest = digestFromObjectPath(objectAbs);
        if (digests.has(digest)) {
          objectsKept += 1;
          continue;
        }
        if (!dryRun) fs.rmSync(objectAbs, { force: true });
        objectsDeleted += 1;
      }
      if (!dryRun) shardsRemoved = pruneEmptyShards(root);
    }
  }

  return {
    ok: true,
    dryRun,
    keepRuns,
    keptRuns: [...keep],
    deletedRuns,
    objectsDeleted,
    objectsKept,
    objectPruneSkipped,
    objectPruneReason,
    shardsRemoved,
  };
}
