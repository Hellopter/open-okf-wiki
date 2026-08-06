/** Deterministic cleanup for graph retry edges, preserving valid ancestors. */

import fs from "node:fs";
import path from "node:path";
import { setActiveRun } from "./active-run.mjs";
import { candidateManifestPath, checkpointsDir } from "./paths.mjs";
import { gateReceiptPath } from "./gate.mjs";
import { loadRunMeta, verifyFrozenSnapshot } from "./freeze.mjs";
import { verifyCheckpoint } from "./checkpoints.mjs";

const PHASES = new Set(["plan", "write"]);

function remove(target, removed, workdir) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
  removed.push(path.relative(workdir, target).replace(/\\/g, "/"));
}

function removeMatching(directory, predicate, removed, workdir) {
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory)) {
    if (predicate(name)) remove(path.join(directory, name), removed, workdir);
  }
}

function recreateWorkdirLayout(workdir) {
  fs.mkdirSync(path.join(workdir, "candidate"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "analysis", "receipts", "survey"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "analysis", "receipts", "semantic"), { recursive: true });
  fs.mkdirSync(checkpointsDir(workdir), { recursive: true });
}

function clearFromPlan(workdir, removed) {
  const analysis = path.join(workdir, "analysis");
  for (const target of [
    path.join(analysis, "spec.json"),
    path.join(analysis, "page-assignments.json"),
    path.join(analysis, "cross-source-contract.json"),
    path.join(analysis, "defects.json"),
    path.join(analysis, "validation.json"),
    gateReceiptPath(workdir),
    path.join(workdir, "candidate"),
    candidateManifestPath(workdir),
    path.join(analysis, "receipts", "review"),
    path.join(analysis, "receipts", "plan-artifacts.json"),
    path.join(analysis, "receipts", "gate-plan.json"),
    path.join(analysis, "receipts", "preflight.json"),
    path.join(analysis, "receipts", "write-sources-artifacts.json"),
    path.join(analysis, "receipts", "write-artifacts.json"),
    path.join(analysis, "receipts", "validate.json"),
    path.join(analysis, "receipts", "validate-artifacts.json"),
  ]) remove(target, removed, workdir);
  removeMatching(
    path.join(analysis, "receipts"),
    (name) => /^(?:review|repair)-artifacts-round-\d+\.json$/.test(name),
    removed,
    workdir,
  );
  removeMatching(
    checkpointsDir(workdir),
    (name) => /^(plan|write(?:-sources)?|review-\d+|repair-\d+|validate)\.json$/.test(name),
    removed,
    workdir,
  );
}

function clearFromWrite(workdir, removed) {
  const analysis = path.join(workdir, "analysis");
  for (const target of [
    path.join(analysis, "defects.json"),
    path.join(analysis, "validation.json"),
    path.join(workdir, "candidate"),
    candidateManifestPath(workdir),
    path.join(analysis, "receipts", "review"),
    path.join(analysis, "receipts", "preflight.json"),
    path.join(analysis, "receipts", "write-sources-artifacts.json"),
    path.join(analysis, "receipts", "write-artifacts.json"),
    path.join(analysis, "receipts", "validate.json"),
    path.join(analysis, "receipts", "validate-artifacts.json"),
  ]) remove(target, removed, workdir);
  removeMatching(
    path.join(analysis, "receipts"),
    (name) => /^(?:review|repair)-artifacts-round-\d+\.json$/.test(name),
    removed,
    workdir,
  );
  removeMatching(
    checkpointsDir(workdir),
    (name) => /^(write(?:-sources)?|review-\d+|repair-\d+|validate)\.json$/.test(name),
    removed,
    workdir,
  );
}

/** Reset only artifacts derived from the selected graph edge. */
export function retryFromPhase(root, runId, fromPhase) {
  if (!PHASES.has(fromPhase)) throw new Error(`unknown retry phase: ${fromPhase}`);
  const meta = loadRunMeta(root, runId);
  const workdir = path.resolve(root, meta.workdir);
  const snapshot = verifyFrozenSnapshot(workdir);
  if (!snapshot.ok) throw new Error(`cannot retry ${fromPhase}: frozen snapshot integrity failed: ${snapshot.errors.join("; ")}`);
  const ancestorPhase = fromPhase === "plan" ? "discover" : "plan";
  const verifiedAncestor = verifyCheckpoint(workdir, ancestorPhase);
  if (!verifiedAncestor.ok || verifiedAncestor.checkpoint.status !== "complete") {
    throw new Error(`cannot retry ${fromPhase}: required ancestor checkpoint is missing or invalid`);
  }
  const removed = [];
  if (fromPhase === "plan") clearFromPlan(workdir, removed);
  else clearFromWrite(workdir, removed);
  recreateWorkdirLayout(workdir);

  const ancestor = verifiedAncestor.checkpoint;
  const current = setActiveRun(root, {
    runId,
    workdir,
    phase: fromPhase === "plan" ? "discover" : "plan",
    status: "active",
    checkpointDigest: ancestor.checkpointDigest,
  });
  return { runId, fromPhase, workdir, removed, ancestor, current };
}
