/** The v2 workspace has one authoritative active-run pointer. */

import fs from "node:fs";
import path from "node:path";
import { readJson } from "./artifacts.mjs";
import { loadRunMeta } from "./freeze.mjs";
import { currentRunPath, runDir } from "./paths.mjs";

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

/**
 * @param {string} root
 * @param {{runId: string, workdir: string, phase: string, status?: string, checkpointDigest?: string | null}} data
 */
export function setActiveRun(root, data) {
  if (!data?.runId || !data?.workdir || !data?.phase) {
    throw new Error("active run requires runId, absolute workdir, and phase");
  }
  const current = {
    version: 2,
    runId: data.runId,
    workdir: path.resolve(data.workdir),
    phase: data.phase,
    status: data.status || "active",
    checkpointDigest: data.checkpointDigest || null,
    updatedAt: new Date().toISOString(),
  };
  writeAtomicJson(currentRunPath(root), current);
  return current;
}

/**
 * Resolve only explicit/current run state. The run list is intentionally not a
 * second implicit pointer: workflows must not select a random older run.
 */
export function resolveActiveRun(root, { preferredRunId } = {}) {
  const current = readCurrent(root);
  if (!current?.runId || typeof current.runId !== "string") return null;
  if (preferredRunId && preferredRunId !== current.runId) return null;
  try {
    const meta = loadRunMeta(root, current.runId);
    const workdir = path.resolve(root, meta.workdir);
    if (!fs.existsSync(workdir) && !fs.existsSync(runDir(root, current.runId))) return null;
    if (typeof current.workdir === "string" && fs.existsSync(current.workdir)) {
      return { runId: current.runId, workdir: path.resolve(current.workdir), source: "current", meta, current };
    }
    return { runId: current.runId, workdir, source: "current", meta, current };
  } catch {
    return null;
  }
}
