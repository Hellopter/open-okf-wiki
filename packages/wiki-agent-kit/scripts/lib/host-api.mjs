/** Small host API for the v4 persistent-agent wiki workflow. */

import fs from "node:fs";
import path from "node:path";
import { readCurrent, resolveActiveRun, setActiveRun } from "./active-run.mjs";
import { freezeRun, listRuns, verifyFrozenSnapshot } from "./freeze.mjs";
import { ensureRuntimeManifest } from "./install.mjs";
import {
  analysisDir,
  bundleDir,
  coverageReviewPath,
  discoveryDir,
  frozenSourcesDir,
  inputsDir,
  planPath,
  reviewPath,
  runLockPath,
  sessionDir,
  statePath,
} from "./paths.mjs";
import { sha256File, readJson, writeJson } from "./artifacts.mjs";
import { addCloneSource, addPathSource, listSources as listSourceEntries } from "./sources.mjs";
import { bundleSealStatus, regenerateIndexes, sealBundle, stampBundleMetadata, validateBundle } from "./validate.mjs";
import { findWorkspaceConfig } from "./paths.mjs";
import { initWorkspace as initializeWorkspaceDocument, loadWorkspace as loadWorkspaceDocument } from "./workspace.mjs";

const RUN_STATUSES = new Set(["planning", "proposed", "writing", "validating", "paused", "stopped", "failed", "complete"]);

function normalizeOwner(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new Error("run lock owner must be a non-empty string up to 256 characters");
  }
  return value.trim();
}

function activeRun(root, runId) {
  const run = resolveActiveRun(root, { preferredRunId: runId });
  if (!run) throw new Error(runId ? `active run is not ${runId}` : "no active run");
  return run;
}

function readRunState(run) {
  const state = readJson(statePath(run.runDir));
  if (!state || state.version !== 4 || state.runId !== run.runId || !RUN_STATUSES.has(state.status)) {
    throw new Error(`invalid run state for ${run.runId}`);
  }
  if (state.approval !== "propose" && state.approval !== "auto") throw new Error(`invalid approval mode for ${run.runId}`);
  return state;
}

function writeRunState(root, run, state) {
  const next = { ...state, updatedAt: new Date().toISOString() };
  writeJson(statePath(run.runDir), next);
  const current = setActiveRun(root, {
    runId: run.runId,
    runDir: run.runDir,
    status: next.status,
    planDigest: next.planDigest,
    bundleDigest: next.bundle?.digest ?? null,
  });
  return { state: next, current };
}

function planDigest(run) {
  const file = planPath(run.runDir);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !fs.readFileSync(file, "utf8").trim()) {
    throw new Error("analysis/plan.md must exist and be non-empty before planning can complete");
  }
  return `sha256:${sha256File(file)}`;
}

function assertSnapshot(run) {
  const snapshot = verifyFrozenSnapshot(run.runDir);
  if (!snapshot.ok) throw new Error(`frozen snapshot integrity failed: ${snapshot.errors.join("; ")}`);
  return snapshot;
}

function normalizeSessionPath(run, value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) {
    throw new Error("sessionPath must be a non-empty path under analysis/session");
  }
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(run.runDir, value);
  const allowed = sessionDir(run.runDir);
  const relative = path.relative(allowed, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("sessionPath must be under analysis/session");
  return path.relative(run.runDir, resolved).replace(/\\/g, "/");
}

function runPaths(root, run) {
  return {
    root: path.resolve(root),
    runId: run.runId,
    runDir: run.runDir,
    inputsDir: inputsDir(run.runDir),
    sourcesDir: frozenSourcesDir(run.runDir),
    analysisDir: analysisDir(run.runDir),
    planPath: planPath(run.runDir),
    discoveryDir: discoveryDir(run.runDir),
    coverageReviewPath: coverageReviewPath(run.runDir),
    reviewPath: reviewPath(run.runDir),
    sessionDir: sessionDir(run.runDir),
    bundleDir: bundleDir(run.runDir),
  };
}

function piSource(source) {
  const origin = source.origin || {};
  return {
    ...source,
    kind: origin.type === "clone" ? "clone" : "linked",
    ...(origin.type === "clone" ? { url: origin.remoteUrl } : { root: origin.linkedPath || path.resolve(source.path || ".") }),
  };
}

function summaryForRun(root, meta) {
  if (!meta || meta.status === "corrupt") return meta || { status: "missing" };
  try {
    const runDir = path.resolve(root, meta.runDir);
    const state = readJson(statePath(runDir));
    const seal = bundleSealStatus(runDir);
    return {
      ...meta,
      status: seal.sealed ? (seal.valid ? "complete" : "tampered") : state?.status ?? "invalid",
      planDigest: state?.planDigest ?? null,
    };
  } catch (error) {
    return { ...meta, status: "invalid", error: error.message };
  }
}

/** Create or reopen a workspace, bind it to Pi, and optionally add the first source. */
export function initializePiWorkspace(root, { name, wikiLanguage = "en", force = false, runtime, source } = {}) {
  const status = initWorkspace(root, { name, wikiLanguage, force, runtime });
  let sourceResult = null;
  if (source?.type === "path") sourceResult = addPathSource(root, { linkedPath: source.path, id: source.id, ignore: source.ignore });
  else if (source?.type === "clone") sourceResult = addCloneSource(root, { url: source.url, id: source.id, ref: source.ref, depth: source.depth });
  else if (source !== undefined) throw new Error("source.type must be path or clone");
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

export function initWorkspace(root, { name, wikiLanguage = "en", force = false, runtime, runtimeDefinition } = {}) {
  const definition = runtime || runtimeDefinition;
  if (!definition) throw new Error("Pi runtime descriptor is required to initialize a Wiki workspace");
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

export function ensureRuntime(root, { runtimeDefinition, runtime, ...definition } = {}) {
  return ensureRuntimeManifest(root, runtimeDefinition || runtime || definition);
}

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
    approval: workspace.workflow.approval,
    activeRunId: active?.runId,
    sources: (workspace.sources || []).map(piSource),
  };
}

export function getWorkspaceStatus(root) {
  const workspace = loadWorkspaceDocument(root);
  const active = resolveActiveRun(root);
  return {
    ...workspaceStatus(root, workspace),
    runtime: "pi",
    sources: listSources(root),
    current: readCurrent(root),
    active: active ? { ...runPaths(root, active), status: summaryForRun(root, active.meta).status } : null,
    runs: listRuns(root).slice(0, 10).map((meta) => summaryForRun(root, meta)),
  };
}

export function addClonedSource(root, { url, id, ref, depth } = {}) {
  return piSource(addCloneSource(root, { url, id, ref, depth }).source);
}

export function addLinkedSource(root, { path: linkedPath, id, ignore } = {}) {
  return piSource(addPathSource(root, { linkedPath, id, ignore }).source);
}

export function listSources(root) {
  return listSourceEntries(root).map(piSource);
}

/** Start a fresh run when focused/no active, otherwise expose the resumable active run. */
export function prepareRun(root, { focus } = {}) {
  const active = resolveActiveRun(root);
  if (active && !focus) {
    const state = readRunState(active);
    const seal = bundleSealStatus(active.runDir);
    if (state.status !== "complete" && !seal.sealed) {
      const resumed = resumeRun(root, { runId: active.runId });
      return { ...resumed, status: "ok", state: readRunState(active) };
    }
  }
  const created = freezeRun(root, { focus });
  const run = activeRun(root, created.runId);
  const startAt = created.policy.discovery.enabled ? "discover" : "plan";
  return { status: "ok", ok: true, ...runPaths(root, run), state: readRunState(run), startAt, adaptiveDiscovery: created.policy.discovery };
}

/** Record the one durable Markdown plan handoff and enter approval or writing. */
export function completeRunPlanning(root, { runId, sessionPath: persistedSession } = {}) {
  const run = activeRun(root, runId);
  const state = readRunState(run);
  if (!["planning", "proposed"].includes(state.status)) throw new Error(`run ${run.runId} is not planning`);
  assertSnapshot(run);
  const digest = planDigest(run);
  const sessionPath = normalizeSessionPath(run, persistedSession);
  const status = state.approval === "propose" ? "proposed" : "writing";
  const persisted = writeRunState(root, run, {
    ...state,
    status,
    planDigest: digest,
    ...(sessionPath !== undefined ? { sessionPath } : {}),
  });
  return {
    ok: true,
    ...runPaths(root, run),
    planDigest: digest,
    requiresApproval: state.approval === "propose",
    status,
    state: persisted.state,
  };
}

/** Explicit approval only succeeds when the frozen input and proposed plan remain unchanged. */
export function approveRun(root, { runId, planDigest: expectedDigest } = {}) {
  const run = activeRun(root, runId);
  const state = readRunState(run);
  if (state.approval !== "propose" || state.status !== "proposed") {
    throw new Error(`run ${run.runId} does not have a proposed plan awaiting approval`);
  }
  assertSnapshot(run);
  const actual = planDigest(run);
  if (state.planDigest !== actual || (expectedDigest && expectedDigest !== actual)) {
    throw new Error("plan changed after proposal; complete planning again before approval");
  }
  const persisted = writeRunState(root, run, { ...state, status: "writing", approvedAt: new Date().toISOString() });
  return { ok: true, ...runPaths(root, run), planDigest: actual, requiresApproval: false, status: "writing", state: persisted.state };
}

/** Recover a non-terminal run without inventing a phase from file names. */
export function resumeRun(root, { runId } = {}) {
  const run = activeRun(root, runId);
  const state = readRunState(run);
  const seal = bundleSealStatus(run.runDir);
  if (seal.sealed && !seal.valid) throw new Error("sealed bundle was modified; create a new run");
  if (state.status === "complete" || seal.sealed) throw new Error("run is complete; create a new run");
  if (state.status === "stopped") throw new Error("run was stopped; create a new run");
  if (state.status === "proposed") throw new Error("run has a proposed plan; use /wiki approve before resuming");
  assertSnapshot(run);
  const status = state.status === "paused" ? state.resumeStatus || "planning" : state.status;
  const resumed = state.status === "paused"
    ? writeRunState(root, run, { ...state, status, resumeStatus: null }).state
    : state;
  return { ok: true, ...runPaths(root, run), ...resumed, startAt: status, adaptiveDiscovery: readJson(path.join(inputsDir(run.runDir), "run-policy.json"))?.discovery };
}

/** The agent runtime may report progress/pause/failure; durable completion belongs to validation. */
export function setRunStatus(root, { runId, status, sessionPath: persistedSession, error } = {}) {
  if (!RUN_STATUSES.has(status) || status === "complete" || status === "proposed") {
    throw new Error(`unsupported externally-set run status: ${status}`);
  }
  const run = activeRun(root, runId);
  const state = readRunState(run);
  if (state.status === "complete" || state.status === "stopped") throw new Error(`run ${run.runId} is terminal`);
  const sessionPath = normalizeSessionPath(run, persistedSession);
  const next = {
    ...state,
    status,
    ...(status === "paused" ? { resumeStatus: state.status } : {}),
    ...(sessionPath !== undefined ? { sessionPath } : {}),
    ...(error === undefined ? {} : { error: String(error) }),
  };
  const persisted = writeRunState(root, run, next);
  return { ok: true, ...runPaths(root, run), status, state: persisted.state };
}

/** Stamp host metadata, project navigation, verify the bundle, and atomically seal a valid result. */
export function validateRunBundle(root, { runId } = {}) {
  const run = activeRun(root, runId);
  const state = readRunState(run);
  const existing = bundleSealStatus(run.runDir);
  if (existing.sealed) {
    if (!existing.valid) throw new Error("sealed bundle was modified; create a new run");
    return { ok: true, alreadySealed: true, manifest: existing.manifest, ...runPaths(root, run), status: "complete", state };
  }
  if (!["writing", "validating"].includes(state.status)) {
    throw new Error(`run ${run.runId} is not ready to validate`);
  }
  writeRunState(root, run, { ...state, status: "validating" });
  const stamped = stampBundleMetadata(run.runDir);
  if (!stamped.ok) return { ok: false, errors: stamped.errors, ...runPaths(root, run), state: readRunState(run) };
  const indexes = regenerateIndexes(run.runDir);
  const validation = validateBundle(run.runDir);
  if (!validation.ok) return { ...validation, indexes, ...runPaths(root, run), state: readRunState(run) };
  const manifest = sealBundle(run.runDir, validation);
  const persisted = writeRunState(root, run, {
    ...readRunState(run),
    status: "complete",
    bundle: { digest: manifest.bundleDigest, sealedAt: manifest.sealedAt },
  });
  return { ...validation, indexes, manifest, ...runPaths(root, run), status: "complete", state: persisted.state };
}

export function getRunPaths(root, { runId } = {}) {
  const run = activeRun(root, runId);
  return runPaths(root, run);
}

/** Read-only state inspection for the adapter's status tool. */
export function getRunState(root, { runId } = {}) {
  const run = activeRun(root, runId);
  return readRunState(run);
}

/**
 * Atomically claim a run before opening its persisted main-agent session.
 * The lock intentionally has no automatic timeout: stealing a live session
 * risks corrupting its JSONL history, so recovery is an explicit operator act.
 */
export function claimRun(root, { runId, owner } = {}) {
  const run = activeRun(root, runId);
  const state = readRunState(run);
  if (["complete", "stopped"].includes(state.status)) throw new Error(`run ${run.runId} is terminal and cannot be claimed`);
  const normalizedOwner = normalizeOwner(owner);
  const file = runLockPath(run.runDir);
  const claim = { version: 1, runId: run.runId, owner: normalizedOwner, claimedAt: new Date().toISOString() };
  try {
    const descriptor = fs.openSync(file, "wx");
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(claim, null, 2)}\n`, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    return { ok: true, claimed: true, claim };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readJson(file);
    if (existing?.version === 1 && existing.runId === run.runId && existing.owner === normalizedOwner) {
      return { ok: true, claimed: false, claim: existing };
    }
    const holder = typeof existing?.owner === "string" ? existing.owner : "an unknown owner";
    throw new Error(`run ${run.runId} is already claimed by ${holder}`);
  }
}

/** Release only the lock owned by this orchestration session. */
export function releaseRun(root, { runId, owner } = {}) {
  const run = activeRun(root, runId);
  const normalizedOwner = normalizeOwner(owner);
  const file = runLockPath(run.runDir);
  if (!fs.existsSync(file)) return { ok: true, released: false };
  const claim = readJson(file);
  if (claim?.version !== 1 || claim.runId !== run.runId || claim.owner !== normalizedOwner) {
    throw new Error(`run ${run.runId} lock is not owned by ${normalizedOwner}`);
  }
  fs.rmSync(file, { force: false });
  return { ok: true, released: true };
}

export { freezeRun };
