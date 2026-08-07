/**
 * Host-facing API used by the Pi extension tools.
 *
 * These functions deliberately accept workspace/run identifiers rather than
 * shell arguments. Checkpoint, gate, and candidate validation modules remain
 * the authority for every state transition.
 */

import fs from "node:fs";
import path from "node:path";
import { readCurrent, resolveActiveRun } from "./active-run.mjs";
import { verifyCheckpoint, verifyReviewLeaf } from "./checkpoints.mjs";
import { freezeRun, listRuns } from "./freeze.mjs";
import { verifyPlanGate, writePlanGateReceipt } from "./gate.mjs";
import { ensureRuntimeManifest } from "./install.mjs";
import { publishArtifacts } from "./publish.mjs";
import { prepareRun } from "./prepare.mjs";
import { addCloneSource, addPathSource, listSources as listSourceEntries } from "./sources.mjs";
import { mergeSurveyReceipts as mergeSurveyReceiptFiles } from "./survey.mjs";
import { candidateSealStatus, regenerateIndexes, sealCandidate, validateWorkdir } from "./validate.mjs";
import { findWorkspaceConfig } from "./paths.mjs";
import { initWorkspace as initializeWorkspaceDocument, loadWorkspace as loadWorkspaceDocument } from "./workspace.mjs";

function activeRun(root, runId) {
  const run = resolveActiveRun(root, { preferredRunId: runId });
  if (!run) throw new Error(runId ? `active run is not ${runId}` : "no active run");
  return run;
}

function piSource(source) {
  const origin = source.origin || {};
  return {
    ...source,
    kind: origin.type === "clone" ? "clone" : "linked",
    ...(origin.type === "clone" ? { url: origin.remoteUrl } : { root: origin.linkedPath || path.resolve(source.path || ".") }),
  };
}

function runSummary(root, meta) {
  if (!meta || meta.status === "corrupt") return meta || { status: "missing" };
  try {
    const workdir = path.resolve(root, meta.workdir);
    const seal = candidateSealStatus(workdir);
    if (seal.sealed) return { ...meta, status: seal.valid ? "sealed" : "tampered" };
    const gate = verifyPlanGate(workdir, meta.runId, meta.methodDigest);
    if (gate.ok) return { ...meta, status: "write-ready" };
    return { ...meta, status: fs.existsSync(path.join(workdir, "analysis", "spec.json")) ? "planned" : "frozen" };
  } catch (error) {
    return { ...meta, status: "invalid", error: error.message };
  }
}

/**
 * Create or reopen a workspace, bind it to the Pi extension, and optionally
 * register its first source. `source.type` is `path` or `clone`.
 */
export function initializePiWorkspace(root, { name, wikiLanguage = "en", force = false, runtime, source } = {}) {
  const status = initWorkspace(root, { name, wikiLanguage, force, runtime });
  let sourceResult = null;
  if (source?.type === "path") {
    sourceResult = addPathSource(root, { linkedPath: source.path, id: source.id, ignore: source.ignore });
  } else if (source?.type === "clone") {
    sourceResult = addCloneSource(root, { url: source.url, id: source.id, ref: source.ref, depth: source.depth });
  } else if (source !== undefined) {
    throw new Error("source.type must be path or clone");
  }
  return {
    ok: true,
    created: status.created,
    workspace: loadWorkspaceDocument(root),
    configPath: findWorkspaceConfig(root)?.path,
    runtime: status.runtime,
    runtimeInstalled: status.runtimeInstalled,
    source: sourceResult?.source ?? null,
    hint: sourceResult?.hint ?? null,
  };
}

/**
 * Adapter-facing initializer. The Pi extension must supply its own workflow
 * descriptor so the workspace records the semantic identity it will execute.
 */
export function initWorkspace(root, { name, wikiLanguage = "en", force = false, runtime, runtimeDefinition } = {}) {
  const definition = runtime || runtimeDefinition;
  if (!definition) {
    throw new Error("Pi runtime descriptor is required to initialize a Wiki workspace");
  }
  const initialized = initializeWorkspaceDocument(root, { name, wikiLanguage, force });
  const runtimeResult = ensureRuntimeManifest(root, definition);
  return {
    ...workspaceStatus(root, initialized.workspace),
    created: initialized.created,
    configPath: initialized.configPath,
    runtime: runtimeResult.runtime,
    runtimeInstalled: runtimeResult.installed,
  };
}

/** Refresh the Pi runtime binding from the adapter's descriptor wrapper. */
export function ensureRuntime(root, { runtimeDefinition, runtime, ...definition } = {}) {
  return ensureRuntimeManifest(root, runtimeDefinition || runtime || definition);
}

/** Return undefined only when a workspace has not yet been initialized. */
export function loadWorkspace(root) {
  if (!findWorkspaceConfig(root)) return undefined;
  return workspaceStatus(root, loadWorkspaceDocument(root));
}

function workspaceStatus(root, workspace) {
  const active = resolveActiveRun(root);
  return {
    root: path.resolve(root),
    initialized: true,
    name: workspace.name,
    wikiLanguage: workspace.wikiLanguage,
    activeRunId: active?.runId,
    sources: (workspace.sources || []).map(piSource),
  };
}

/** Return workspace, source, active-run, and recent-run state for `/wiki status`. */
export function getWorkspaceStatus(root) {
  const workspace = loadWorkspaceDocument(root);
  const active = resolveActiveRun(root);
  return {
    ...workspaceStatus(root, workspace),
    runtime: "pi",
    sources: listSources(root),
    current: readCurrent(root),
    active: active
      ? { runId: active.runId, workdir: active.workdir, source: active.source, status: runSummary(root, active.meta).status }
      : null,
    runs: listRuns(root).slice(0, 10).map((meta) => runSummary(root, meta)),
  };
}

/** Pi adapter source naming: clone returns a clone-kind source summary. */
export function addClonedSource(root, { url, id, ref, depth } = {}) {
  return piSource(addCloneSource(root, { url, id, ref, depth }).source);
}

/** Pi adapter source naming: linked path returns a linked-kind source summary. */
export function addLinkedSource(root, { path: linkedPath, id, ignore } = {}) {
  return piSource(addPathSource(root, { linkedPath, id, ignore }).source);
}

export function listSources(root) {
  return listSourceEntries(root).map(piSource);
}

/** A direct equivalent of the workflow's survey receipt merge host operation. */
export function mergeRunSurveyReceipts(root, { runId, pass, labelsPath } = {}) {
  return mergeSurveyReceiptFiles(activeRun(root, runId).workdir, { pass, labelsPath });
}

export function mergeSurveyReceipts(root, options = {}) {
  return mergeRunSurveyReceipts(root, options);
}

/** Publish an artifact-list file as the next immutable checkpoint. */
export function publishRunArtifacts(root, { runId, phase, artifactsJsonPath } = {}) {
  const run = activeRun(root, runId);
  return publishArtifacts(root, run, { phase, artifactsJsonPath });
}

export function publishCheckpoint(root, options = {}) {
  return publishRunArtifacts(root, options);
}

/** Evaluate the current plan gate without changing state. */
export function checkRunPlanGate(root, { runId } = {}) {
  const run = activeRun(root, runId);
  return verifyPlanGate(run.workdir, run.runId, run.meta.methodDigest);
}

/** Persist a successful plan-gate receipt and authorize the write edge. */
export function approveRunPlanGate(root, { runId } = {}) {
  const run = activeRun(root, runId);
  const { result, receipt } = writePlanGateReceipt(run.workdir, run.runId, run.meta.methodDigest);
  return { ...result, receipt, current: readCurrent(root) };
}

export function openPlanGate(root, options = {}) {
  return approveRunPlanGate(root, options);
}

export function checkPlanGate(root, options = {}) {
  return checkRunPlanGate(root, options);
}

/**
 * Validate and seal a write candidate. The caller must publish its returned
 * validation report through `publishRunArtifacts` to transition to `sealed`.
 */
export function validateRunCandidate(root, { runId } = {}) {
  const run = activeRun(root, runId);
  const gate = verifyPlanGate(run.workdir, run.runId, run.meta.methodDigest);
  if (!gate.ok) return { ok: false, errors: gate.errors || ["plan gate is not valid"], current: readCurrent(root) };

  const write = verifyCheckpoint(run.workdir, "write");
  if (!write.ok || write.checkpoint.status !== "complete") {
    return { ok: false, errors: ["missing or invalid write checkpoint", ...(write.errors || [])], current: readCurrent(root) };
  }
  const review = verifyReviewLeaf(run.workdir, run.current);
  if (!review.ok) return { ok: false, errors: ["missing or invalid final review checkpoint", ...review.errors], current: readCurrent(root) };

  let defects = null;
  try {
    defects = JSON.parse(fs.readFileSync(path.join(run.workdir, "analysis", "defects.json"), "utf8"));
  } catch {
    // The response below is intentionally a validation failure, not a host exception.
  }
  if (defects?.version !== 2 || defects?.clean !== true || !Array.isArray(defects.defects) || defects.defects.length !== 0) {
    return { ok: false, errors: ["final review is not clean or defects.json is invalid"], current: readCurrent(root) };
  }

  const seal = candidateSealStatus(run.workdir);
  if (seal.sealed) {
    if (!seal.valid) throw new Error("sealed candidate was modified; use /wiki --retry write");
    return {
      ok: true,
      alreadySealed: true,
      manifest: seal.manifest,
      reviewCheckpointDigest: review.checkpoint.checkpointDigest,
      current: readCurrent(root),
    };
  }
  regenerateIndexes(path.join(run.workdir, "candidate"));
  const result = validateWorkdir(run.workdir);
  const manifest = result.ok ? sealCandidate(run.workdir, result) : null;
  return { ...result, manifest, reviewCheckpointDigest: review.checkpoint.checkpointDigest, current: readCurrent(root) };
}

export function validateCandidate(root, options = {}) {
  return validateRunCandidate(root, options);
}

/** Return the active (or explicitly selected) run's absolute data-plane roots. */
export function getRunPaths(root, { runId } = {}) {
  const run = resolveActiveRun(root, { preferredRunId: runId });
  if (!run) return undefined;
  return {
    root: path.resolve(root),
    runId: run.runId,
    workdir: run.workdir,
    inputsDir: path.join(run.workdir, "inputs"),
    sourcesDir: path.join(run.workdir, "sources"),
    methodDir: path.join(run.workdir, "method"),
    analysisDir: path.join(run.workdir, "analysis"),
    candidateDir: path.join(run.workdir, "candidate"),
  };
}

// These aliases make the host contract discoverable from a single import.
export { freezeRun, prepareRun };
