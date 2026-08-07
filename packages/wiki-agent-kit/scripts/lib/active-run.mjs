/** The sole workspace-level pointer to the active v4 run. */

import fs from "node:fs";
import path from "node:path";
import { readJson } from "./artifacts.mjs";
import { currentRunPath, runDir, runsDir } from "./paths.mjs";

function writeAtomicJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}

export function readCurrent(root) {
  return readJson(currentRunPath(root));
}

export function clearActivePointer(root) {
  fs.rmSync(currentRunPath(root), { force: true });
}

/** @param {{runId:string, runDir:string, status:string, planDigest?:string|null, bundleDigest?:string|null}} data */
export function setActiveRun(root, data) {
  if (!data?.runId || !data?.runDir || !data?.status) {
    throw new Error("active run requires runId, absolute runDir, and status");
  }
  const expected = runDir(root, data.runId);
  if (path.resolve(data.runDir) !== path.resolve(expected)) {
    throw new Error("active run directory does not match its run id");
  }
  const current = {
    version: 4,
    runId: data.runId,
    runDir: path.resolve(data.runDir),
    status: data.status,
    planDigest: data.planDigest ?? null,
    bundleDigest: data.bundleDigest ?? null,
    updatedAt: new Date().toISOString(),
  };
  writeAtomicJson(currentRunPath(root), current);
  return current;
}

/** Resolve only an explicit/current run. Historical runs never become implicit input. */
export function resolveActiveRun(root, { preferredRunId } = {}) {
  const current = readCurrent(root);
  if (current?.version !== 4 || typeof current.runId !== "string" || !current.runId) return null;
  if (preferredRunId && preferredRunId !== current.runId) return null;
  const expected = runDir(root, current.runId);
  if (path.resolve(current.runDir || "") !== path.resolve(expected)) return null;
  const rel = path.relative(runsDir(root), expected);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const metaPath = path.join(expected, "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    const meta = readJson(metaPath);
    if (meta?.version !== 4 || meta.runId !== current.runId) return null;
    return { runId: current.runId, runDir: expected, meta, current, source: "current" };
  } catch {
    return null;
  }
}
