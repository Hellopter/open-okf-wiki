/** Deterministic entry-state preparation for the native /wiki workflow. */

import fs from "node:fs";
import path from "node:path";
import { assertInstalledAssets } from "./install.mjs";
import { freezeRun, verifyFrozenSnapshot } from "./freeze.mjs";
import { resolveActiveRun } from "./active-run.mjs";
import { retryFromPhase } from "./run-state.mjs";
import { verifyPlanGate } from "./gate.mjs";
import { verifyCheckpoint } from "./checkpoints.mjs";
import { candidateSealStatus } from "./validate.mjs";

export const PREPARE_MODES = new Set(["auto", "plan", "write", "restart", "retry-plan", "retry-write"]);

function normalizeFocus(focus) {
  if (focus === undefined || focus === null) return null;
  if (typeof focus !== "string" || !focus.trim()) throw new Error("focus must be a non-empty string when provided");
  return focus.trim();
}

function envelope({ root, mode, run, startAt, inputCheckpointDigest, summary }) {
  return {
    ok: true,
    status: "ok",
    runId: run.runId,
    workdir: run.workdir,
    workspaceRoot: path.resolve(root),
    mode,
    startAt,
    inputCheckpointDigest: inputCheckpointDigest || null,
    summary,
  };
}

function fresh(root, mode, focus) {
  const created = freezeRun(root, { focus });
  return envelope({
    root,
    mode,
    run: { runId: created.runId, workdir: created.workdir },
    startAt: "survey",
    inputCheckpointDigest: null,
    summary: `created frozen run ${created.runId}`,
  });
}

function checkpoint(workdir, phase) {
  const result = verifyCheckpoint(workdir, phase);
  return result.ok ? result.checkpoint : null;
}

function assertFrozenSnapshot(run) {
  const snapshot = verifyFrozenSnapshot(run.workdir);
  if (!snapshot.ok) {
    throw new Error(`frozen snapshot integrity failed: ${(snapshot.errors || []).join("; ")}`);
  }
}

function writeReady(run) {
  const plan = checkpoint(run.workdir, "plan");
  if (!plan || plan.status !== "complete") return { ok: false, plan, errors: ["missing valid plan checkpoint"] };
  const gate = verifyPlanGate(run.workdir, run.runId, run.meta.methodDigest);
  return { ok: gate.ok, plan, gate, errors: gate.errors || [] };
}

function assertCandidateSealNotTampered(run) {
  const seal = candidateSealStatus(run.workdir);
  if (seal.sealed && !seal.valid) throw new Error("candidate manifest is tampered; use /wiki --retry write");
  return seal;
}

function requirePointerCheckpoint(run, phase) {
  const expectedPhase = phase === "sealed" ? "validate" : phase;
  const verified = checkpoint(run.workdir, expectedPhase);
  if (!verified || verified.status !== "complete") {
    throw new Error(`active run pointer has no valid ${expectedPhase} checkpoint`);
  }
  if (run.current?.checkpointDigest !== verified.checkpointDigest) {
    throw new Error(`active run pointer does not match the ${expectedPhase} checkpoint`);
  }
  return verified;
}

function reviewIsClean(workdir) {
  try {
    const defects = JSON.parse(fs.readFileSync(path.join(workdir, "analysis", "defects.json"), "utf8"));
    return defects?.version === 2 && defects?.clean === true && Array.isArray(defects.defects) && defects.defects.length === 0;
  } catch {
    return false;
  }
}

function checkpointEnvelope(root, mode, run, startAt, checkpointRecord, summary) {
  return envelope({
    root,
    mode,
    run,
    startAt,
    inputCheckpointDigest: checkpointRecord?.checkpointDigest ?? null,
    summary,
  });
}

/**
 * Return the single workflow edge following the active, verified checkpoint.
 * A gate receipt is not a state transition: it authorizes the plan ->
 * write-sources edge while the current pointer remains on plan.
 */
function nextStart(run, mode) {
  const current = run.current || {};
  const phase = current.phase;
  if (current.status === "sealed" || phase === "sealed") {
    throw new Error("active run is sealed; use /wiki --restart to create a new frozen run");
  }
  if (phase === "frozen") {
    if (current.checkpointDigest) throw new Error("frozen run must not have a checkpoint digest");
    return { startAt: "survey", checkpoint: null, summary: `resuming survey for ${run.runId}` };
  }

  if (phase === "discover") {
    const discover = requirePointerCheckpoint(run, phase);
    return { startAt: "plan", checkpoint: discover, summary: `resuming plan for ${run.runId}` };
  }
  if (phase === "plan") {
    const plan = requirePointerCheckpoint(run, phase);
    const ready = writeReady(run);
    return ready.ok
      ? {
          startAt: mode === "plan" ? "ready" : "write-sources",
          checkpoint: plan,
          summary: mode === "plan" ? `plan is ready for explicit write for ${run.runId}` : `resuming write sources for ${run.runId}`,
        }
      : { startAt: "gate", checkpoint: plan, summary: `resuming plan gate for ${run.runId}` };
  }
  if (phase === "write-sources") {
    const sourceWrite = requirePointerCheckpoint(run, phase);
    return { startAt: "write", checkpoint: sourceWrite, summary: `resuming write for ${run.runId}` };
  }
  if (phase === "write") {
    const write = requirePointerCheckpoint(run, phase);
    return { startAt: "review-1", checkpoint: write, summary: `resuming first review for ${run.runId}` };
  }
  const review = phase?.match(/^review-(\d+)$/);
  if (review) {
    const reviewCheckpoint = requirePointerCheckpoint(run, phase);
    if (reviewIsClean(run.workdir)) {
      return { startAt: "validate", checkpoint: reviewCheckpoint, summary: `resuming validation for ${run.runId}` };
    }
    return {
      startAt: `repair-${review[1]}`,
      checkpoint: reviewCheckpoint,
      summary: `resuming repair ${review[1]} for ${run.runId}`,
    };
  }
  const repair = phase?.match(/^repair-(\d+)$/);
  if (repair) {
    const repairCheckpoint = requirePointerCheckpoint(run, phase);
    return {
      startAt: `review-${Number(repair[1]) + 1}`,
      checkpoint: repairCheckpoint,
      summary: `resuming review ${Number(repair[1]) + 1} for ${run.runId}`,
    };
  }
  throw new Error(`unsupported active run phase: ${phase || "(missing)"}`);
}

/**
 * Create, recover, or reset the run selected by a user-visible workflow mode.
 * It never accepts runtime identity; that is recovered from current.json only.
 */
export function prepareRun(root, { mode = "auto", focus } = {}) {
  if (!PREPARE_MODES.has(mode)) throw new Error(`invalid prepare mode: ${mode}`);
  const normalizedFocus = normalizeFocus(focus);
  assertInstalledAssets(root);
  const active = resolveActiveRun(root);

  if (mode === "restart") return fresh(root, mode, normalizedFocus);

  if (mode === "retry-plan" || mode === "retry-write") {
    if (!active) throw new Error(`no active run for ${mode}`);
    assertFrozenSnapshot(active);
    if (mode === "retry-write") {
      const ready = writeReady(active);
      if (!ready.ok) throw new Error(`cannot retry write: ${ready.errors.join("; ")}`);
    }
    const retried = retryFromPhase(root, active.runId, mode === "retry-plan" ? "plan" : "write");
    return envelope({
      root,
      mode,
      run: retried,
      startAt: mode === "retry-plan" ? "plan" : "write-sources",
      inputCheckpointDigest: retried.ancestor.checkpointDigest,
      summary: `reset ${retriesLabel(mode)} outputs for ${retried.runId}`,
    });
  }

  if (!active) {
    if (mode === "write") throw new Error("no active run for write; run /wiki --plan first");
    return fresh(root, mode, normalizedFocus);
  }
  if (normalizedFocus) {
    if (mode === "write") throw new Error("write does not accept a new focus; run /wiki --plan first");
    return fresh(root, mode, normalizedFocus);
  }
  assertFrozenSnapshot(active);

  const next = nextStart(active, mode);
  if (mode === "write" && !["write-sources", "write", "review-1", "validate"].includes(next.startAt) && !/^review-|^repair-/.test(next.startAt)) {
    throw new Error("active run is not write-ready: a valid plan gate is required");
  }

  if (next.startAt === "validate") {
    assertCandidateSealNotTampered(active);
  }
  return checkpointEnvelope(root, mode, active, next.startAt, next.checkpoint, next.summary);
}

function retriesLabel(mode) {
  return mode === "retry-plan" ? "plan" : "write";
}
