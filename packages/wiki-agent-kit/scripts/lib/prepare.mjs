/** Deterministic entry-state preparation for the native /wiki workflow. */

import path from "node:path";
import { assertInstalledAssets } from "./install.mjs";
import { freezeRun } from "./freeze.mjs";
import { resolveActiveRun } from "./active-run.mjs";
import { retryFromPhase } from "./run-state.mjs";
import { verifyPlanGate } from "./gate.mjs";
import { verifyCheckpoint, verifyReviewLeaf } from "./checkpoints.mjs";
import { candidateSealStatus } from "./validate.mjs";

export const PREPARE_MODES = new Set(["auto", "plan", "write", "retry-plan", "retry-write"]);

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

function writeReady(run) {
  const plan = checkpoint(run.workdir, "plan");
  if (!plan || plan.status !== "complete") return { ok: false, plan, errors: ["missing valid plan checkpoint"] };
  const gate = verifyPlanGate(run.workdir, run.runId, run.meta.methodDigest);
  return { ok: gate.ok, plan, gate, errors: gate.errors || [] };
}

function pendingValidation(run) {
  const seal = candidateSealStatus(run.workdir);
  if (!seal.sealed) return { ok: false, seal };
  if (!seal.valid) throw new Error("candidate manifest is tampered; use /wiki --retry write");
  const review = verifyReviewLeaf(run.workdir, run.current);
  return review.ok ? { ok: true, seal, review } : { ok: false, seal, review };
}

function validateEnvelope(root, mode, run, pending) {
  return envelope({
    root,
    mode,
    run,
    startAt: "validate",
    inputCheckpointDigest: pending.review.checkpoint.checkpointDigest,
    summary: `resuming validate checkpoint for ${run.runId}`,
  });
}

/**
 * Create, recover, or reset the run selected by a user-visible workflow mode.
 * It never accepts runtime identity; that is recovered from current.json only.
 */
export function prepareRun(root, { mode = "auto", focus } = {}) {
  if (!PREPARE_MODES.has(mode)) throw new Error(`invalid prepare mode: ${mode}`);
  const normalizedFocus = normalizeFocus(focus);
  assertInstalledAssets(root);
  let active = resolveActiveRun(root);

  if (mode === "retry-plan" || mode === "retry-write") {
    if (!active) throw new Error(`no active run for ${mode}`);
    if (mode === "retry-write") {
      const ready = writeReady(active);
      if (!ready.ok) throw new Error(`cannot retry write: ${ready.errors.join("; ")}`);
    }
    const retried = retryFromPhase(root, active.runId, mode === "retry-plan" ? "plan" : "write");
    return envelope({
      root,
      mode,
      run: retried,
      startAt: mode === "retry-plan" ? "plan" : "write",
      inputCheckpointDigest: retried.ancestor.checkpointDigest,
      summary: `reset ${retriesLabel(mode)} outputs for ${retried.runId}`,
    });
  }

  if (mode === "write") {
    if (!active) throw new Error("no active run for write; run /wiki --plan first");
    const ready = writeReady(active);
    if (!ready.ok) throw new Error(`active run is not write-ready: ${ready.errors.join("; ")}`);
    const pending = pendingValidation(active);
    if (pending.ok) return validateEnvelope(root, mode, active, pending);
    return envelope({
      root,
      mode,
      run: active,
      startAt: "write",
      inputCheckpointDigest: ready.plan.checkpointDigest,
      summary: `resuming write from plan checkpoint for ${active.runId}`,
    });
  }

  // A focus requests a distinct investigation. Sealed/blocked runs are not
  // resumed implicitly: callers use explicit retry modes for those graph edges.
  if (!active || normalizedFocus || ["sealed", "blocked"].includes(active.current?.status)) {
    return fresh(root, mode, normalizedFocus);
  }

  const discovery = checkpoint(active.workdir, "discover");
  if (mode === "plan") {
    if (discovery?.status === "complete" && !checkpoint(active.workdir, "plan")) {
      return envelope({
        root,
        mode,
        run: active,
        startAt: "plan",
        inputCheckpointDigest: discovery.checkpointDigest,
        summary: `resuming planning from discovery checkpoint for ${active.runId}`,
      });
    }
    return fresh(root, mode, normalizedFocus);
  }

  const ready = writeReady(active);
  if (ready.ok) {
    const pending = pendingValidation(active);
    if (pending.ok) return validateEnvelope(root, mode, active, pending);
    return envelope({
      root,
      mode,
      run: active,
      startAt: "write",
      inputCheckpointDigest: ready.plan.checkpointDigest,
      summary: `resuming write from plan checkpoint for ${active.runId}`,
    });
  }
  if (discovery?.status === "complete") {
    return envelope({
      root,
      mode,
      run: active,
      startAt: "plan",
      inputCheckpointDigest: discovery.checkpointDigest,
      summary: `resuming planning from discovery checkpoint for ${active.runId}`,
    });
  }
  return envelope({
    root,
    mode,
    run: active,
    startAt: "survey",
    inputCheckpointDigest: null,
    summary: `resuming survey for ${active.runId}`,
  });
}

function retriesLabel(mode) {
  return mode === "retry-plan" ? "plan" : "write";
}
