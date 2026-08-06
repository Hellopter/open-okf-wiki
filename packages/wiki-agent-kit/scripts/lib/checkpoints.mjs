/** Durable, host-verified checkpoints for one local workflow run. */

import fs from "node:fs";
import path from "node:path";
import { hashTree, isInside, readJson, sha256File, sha256Json } from "./artifacts.mjs";
import { readCurrent, setActiveRun } from "./active-run.mjs";
import { checkpointPath, checkpointsDir } from "./paths.mjs";
import { assertDiscoverSurveyQuality } from "./survey.mjs";
import { candidateSealStatus, validateWorkdir } from "./validate.mjs";

const CHECKPOINT_VERSION = 3;
const DIGEST_RE = /^(?:sha256:)?[a-f0-9]{64}$/;
const PHASE_RE = /^[a-z][a-z0-9-]{0,63}$/;

function atomicWriteJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}

function asRelativePath(value, label) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\")) {
    throw new Error(`${label} must be a non-empty slash-separated relative path`);
  }
  const normalized = value.replace(/^\.\//, "");
  if (normalized.split("/").includes("..")) throw new Error(`${label} escapes the run workdir: ${value}`);
  return normalized;
}

function ensureArtifactPath(workdir, relative) {
  const absolute = path.resolve(workdir, relative);
  if (!isInside(workdir, absolute)) throw new Error(`artifact path escapes run workdir: ${relative}`);
  if (!fs.existsSync(absolute)) throw new Error(`artifact path does not exist: ${relative}`);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`artifact path must be a regular file or directory: ${relative}`);
  }
  const realWorkdir = fs.realpathSync(workdir);
  const realArtifact = fs.realpathSync(absolute);
  if (!isInside(realWorkdir, realArtifact)) throw new Error(`artifact real path escapes run workdir: ${relative}`);
  return { absolute, digest: stat.isDirectory() ? hashTree(absolute).digest : sha256File(absolute) };
}

function checkpointDigest(record) {
  const { checkpointDigest: _ignored, ...withoutDigest } = record;
  return `sha256:${sha256Json(withoutDigest)}`;
}

function readExistingCheckpoints(workdir) {
  const directory = checkpointsDir(workdir);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ path: path.join(directory, name), value: readJson(path.join(directory, name)) }))
    .filter((entry) => entry.value && typeof entry.value === "object");
}

function predecessorPhase(phase) {
  if (phase === "discover") return null;
  if (phase === "plan") return "discover";
  if (phase === "write-sources") return "plan";
  if (phase === "write") return "write-sources";
  const review = phase.match(/^review-(\d+)$/);
  if (review) return Number(review[1]) === 1 ? "write" : `repair-${Number(review[1]) - 1}`;
  const repair = phase.match(/^repair-(\d+)$/);
  if (repair) return `review-${repair[1]}`;
  if (phase === "validate") return "review-*";
  throw new Error(`unsupported checkpoint phase: ${phase}`);
}

function phaseMatches(expected, actual) {
  return expected === "review-*" ? /^review-\d+$/.test(actual) : expected === actual;
}

function validateCheckpointRecord(record, source, existing = []) {
  if (record.version !== CHECKPOINT_VERSION || typeof record.runId !== "string" || !record.runId || !PHASE_RE.test(record.phase || "")) {
    throw new Error(`invalid checkpoint record: ${source}`);
  }
  if (record.status !== "complete") throw new Error(`invalid checkpoint status: ${source}`);
  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) {
    throw new Error(`checkpoint artifacts are missing: ${source}`);
  }
  if (!DIGEST_RE.test(record.checkpointDigest || "") || checkpointDigest(record) !== record.checkpointDigest) {
    throw new Error(`checkpoint digest mismatch: ${source}`);
  }
  const expected = predecessorPhase(record.phase);
  if (expected === null) {
    if (Object.hasOwn(record, "predecessorDigest")) throw new Error(`discover checkpoint must not have a predecessor: ${source}`);
    return record;
  }
  if (!DIGEST_RE.test(record.predecessorDigest || "")) {
    throw new Error(`checkpoint predecessor digest is invalid: ${source}`);
  }
  const predecessor = existing
    .map((entry) => entry.value)
    .find((candidate) => phaseMatches(expected, candidate?.phase) && candidate.checkpointDigest === record.predecessorDigest);
  if (!predecessor) throw new Error(`checkpoint predecessor is missing or mismatched: ${source}`);
  return record;
}

function assertSealableCandidate(workdir) {
  const defects = readJson(path.join(workdir, "analysis", "defects.json"));
  if (defects?.version !== 2 || defects?.clean !== true || !Array.isArray(defects.defects) || defects.defects.length !== 0) {
    throw new Error("validate checkpoint requires a clean v2 defects.json");
  }
  const seal = candidateSealStatus(workdir);
  if (!seal.sealed || !seal.valid) throw new Error("validate checkpoint requires a valid sealed candidate manifest");
  const validation = validateWorkdir(workdir);
  if (!validation.ok) throw new Error(`validate checkpoint candidate verification failed: ${validation.errors.join("; ")}`);
}

function normalizeArtifacts(workdir, phase, proposed) {
  if (!Array.isArray(proposed) || proposed.length === 0) {
    throw new Error("artifacts json requires at least one artifact");
  }
  const allowed = new Set(["id", "type", "path", "coverageUnitIds"]);
  const ids = new Set();
  const artifacts = proposed.map((artifact, index) => {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error(`artifact ${index} must be an object`);
    }
    for (const key of Object.keys(artifact)) {
      if (!allowed.has(key)) throw new Error(`artifact ${index} has unsupported field: ${key}`);
    }
    const id = typeof artifact.id === "string" ? artifact.id.trim() : "";
    const type = typeof artifact.type === "string" ? artifact.type.trim() : "";
    if (!id || !type) throw new Error(`artifact ${index} requires id and type`);
    if (ids.has(id)) throw new Error(`artifact id is not unique: ${id}`);
    ids.add(id);
    const relative = asRelativePath(artifact.path, `artifact ${id}.path`);
    const resolved = ensureArtifactPath(workdir, relative);
    const hasCoverage = Object.hasOwn(artifact, "coverageUnitIds");
    if (phase !== "discover" && hasCoverage) {
      throw new Error(`artifact ${id}.coverageUnitIds is only allowed for discover`);
    }
    const coverageUnitIds = hasCoverage ? artifact.coverageUnitIds : [];
    if (!Array.isArray(coverageUnitIds) || coverageUnitIds.some((unit) => typeof unit !== "string" || !unit.trim())) {
      throw new Error(`artifact ${id}.coverageUnitIds must contain non-empty strings`);
    }
    const coverage = coverageUnitIds.map((unit) => unit.trim());
    if (new Set(coverage).size !== coverage.length) throw new Error(`artifact ${id}.coverageUnitIds contains duplicates`);
    return {
      id,
      type,
      path: relative,
      ...(coverage.length ? { coverageUnitIds: coverage } : {}),
      digest: `sha256:${resolved.digest}`,
    };
  });
  return artifacts;
}

function assertDiscoverCoverage(workdir, artifacts) {
  const inventory = readJson(path.join(workdir, "inputs", "inventory.json"));
  if (!Array.isArray(inventory?.coverageUnits)) {
    throw new Error("discover checkpoint requires inputs/inventory.json coverageUnits");
  }
  const required = new Set(
    inventory.coverageUnits.filter((unit) => unit?.required === true).map((unit) => unit?.id).filter(Boolean),
  );
  const known = new Set(inventory.coverageUnits.map((unit) => unit?.id).filter(Boolean));
  const declared = new Set(artifacts.flatMap((artifact) => artifact.coverageUnitIds ?? []));
  const unknown = [...declared].filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`discover artifacts reference unknown coverage units: ${unknown.join(", ")}`);
  const missing = [...required].filter((id) => !declared.has(id));
  if (missing.length) throw new Error(`discover artifacts do not cover required units: ${missing.join(", ")}`);
}

function currentForRun(root, run) {
  const current = readCurrent(root);
  if (current?.version !== CHECKPOINT_VERSION || current.runId !== run.runId || typeof current.workdir !== "string") {
    throw new Error("publish requires the selected active run");
  }
  if (path.resolve(current.workdir) !== path.resolve(run.workdir)) {
    throw new Error("active run workdir does not match publish target");
  }
  return current;
}

function previousCheckpoint(workdir, current, phase) {
  const expected = predecessorPhase(phase);
  if (expected === null) {
    if (current.phase !== "frozen" || current.status !== "active" || current.checkpointDigest !== null) {
      throw new Error("discover checkpoint requires a frozen active run");
    }
    return null;
  }
  if (current.status !== "active" || !phaseMatches(expected, current.phase)) {
    throw new Error(`${phase} checkpoint requires active predecessor ${expected}`);
  }
  const verified = verifyCheckpoint(workdir, current.phase);
  if (!verified.ok) throw new Error(`${phase} checkpoint predecessor is invalid: ${verified.errors.join("; ")}`);
  if (current.checkpointDigest !== verified.checkpoint.checkpointDigest) {
    throw new Error(`${phase} checkpoint active pointer does not match predecessor`);
  }
  return verified.checkpoint;
}

/** A validate edge may start only from the current clean review leaf. */
export function verifyReviewLeaf(workdir, current) {
  const match = current?.phase?.match(/^review-(\d+)$/);
  if (!match || current?.status !== "active") {
    return { ok: false, errors: ["current run is not an active review checkpoint"] };
  }
  const review = verifyCheckpoint(workdir, current.phase);
  if (!review.ok || review.checkpoint.status !== "complete") {
    return { ok: false, errors: ["current review checkpoint is invalid", ...(review.errors || [])] };
  }
  if (current.checkpointDigest !== review.checkpoint.checkpointDigest) {
    return { ok: false, errors: ["current run pointer does not match the review checkpoint"] };
  }
  return { ok: true, checkpoint: review.checkpoint, errors: [] };
}

/**
 * Validate artifacts and atomically publish the unique next graph edge.
 * @param {string} root workspace root
 * @param {{runId:string, workdir:string}} run
 * @param {{phase:string, artifacts:object[]}} input
 */
export function publishCheckpoint(root, run, input) {
  if (!PHASE_RE.test(input?.phase || "")) throw new Error(`invalid checkpoint phase: ${input?.phase}`);
  predecessorPhase(input.phase);
  const current = currentForRun(root, run);
  const existing = readExistingCheckpoints(run.workdir);
  for (const entry of existing) validateCheckpointRecord(entry.value, entry.path, existing);
  if (existing.some((entry) => entry.value.phase === input.phase)) {
    throw new Error(`checkpoint phase is immutable and already published: ${input.phase}`);
  }
  const predecessor = previousCheckpoint(run.workdir, current, input.phase);
  if (input.phase === "validate") {
    const reviewLeaf = verifyReviewLeaf(run.workdir, current);
    if (!reviewLeaf.ok) throw new Error(`validate checkpoint requires current review leaf: ${reviewLeaf.errors.join("; ")}`);
    assertSealableCandidate(run.workdir);
  }
  const artifacts = normalizeArtifacts(run.workdir, input.phase, input.artifacts);
  if (input.phase === "discover") {
    assertDiscoverCoverage(run.workdir, artifacts);
    const surveyQuality = assertDiscoverSurveyQuality(run.workdir, artifacts);
    if (!surveyQuality.ok) throw new Error(`discover survey quality failed: ${surveyQuality.errors.join("; ")}`);
  }
  if (input.phase === "validate") {
    const paths = new Set(artifacts.map((artifact) => artifact.path));
    for (const required of ["analysis/validation.json", "analysis/candidate.manifest.json"]) {
      if (!paths.has(required)) throw new Error(`validate checkpoint must declare artifact: ${required}`);
    }
  }
  const record = {
    version: CHECKPOINT_VERSION,
    runId: run.runId,
    phase: input.phase,
    status: "complete",
    createdAt: new Date().toISOString(),
    ...(predecessor ? { predecessorDigest: predecessor.checkpointDigest } : {}),
    artifacts,
  };
  record.checkpointDigest = checkpointDigest(record);
  const outputPath = checkpointPath(run.workdir, input.phase);
  atomicWriteJson(outputPath, record);
  const nextCurrent = setActiveRun(root, {
    runId: run.runId,
    workdir: run.workdir,
    phase: input.phase === "validate" ? "sealed" : input.phase,
    status: input.phase === "validate" ? "sealed" : "active",
    checkpointDigest: record.checkpointDigest,
  });
  return {
    checkpoint: record,
    current: nextCurrent,
    checkpointPath: path.relative(run.workdir, outputPath).replace(/\\/g, "/"),
    checkpointDigest: record.checkpointDigest,
    artifacts,
  };
}

export function verifyCheckpoint(workdir, phase) {
  const file = checkpointPath(workdir, phase);
  const record = readJson(file);
  if (!record) return { ok: false, errors: [`missing checkpoint: ${phase}`] };
  try {
    const existing = readExistingCheckpoints(workdir);
    validateCheckpointRecord(record, file, existing);
    for (const artifact of record.artifacts) {
      const relative = asRelativePath(artifact.path, `artifact ${artifact.id}.path`);
      const actual = ensureArtifactPath(workdir, relative).digest;
      if (`sha256:${actual}` !== artifact.digest) throw new Error(`artifact digest changed: ${artifact.id}`);
    }
    if (phase === "discover") {
      const surveyQuality = assertDiscoverSurveyQuality(workdir, record.artifacts);
      if (!surveyQuality.ok) throw new Error(`discover survey quality failed: ${surveyQuality.errors.join("; ")}`);
    }
    return { ok: true, checkpoint: record, errors: [] };
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
}
