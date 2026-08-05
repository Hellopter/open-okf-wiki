/** Authoritative, digest-bound handoff checkpoints for the workflow graph. */

import fs from "node:fs";
import path from "node:path";
import { hashTree, isInside, readJson, sha256File, sha256Json } from "./artifacts.mjs";
import { setActiveRun } from "./active-run.mjs";
import { checkpointPath, checkpointsDir } from "./paths.mjs";
import { candidateSealStatus, validateWorkdir } from "./validate.mjs";

const DIGEST_RE = /^(?:sha256:)?[a-f0-9]{64}$/;
const PHASE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

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

function withCheckpointLock(workdir, action) {
  const directory = checkpointsDir(workdir);
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, ".lock");
  let descriptor;
  try {
    descriptor = fs.openSync(lock, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("another checkpoint publish is in progress");
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
    return action();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(lock, { force: true });
  }
}

function phasePredecessor(phase) {
  if (phase === "discover") return null;
  if (phase === "plan") return "discover";
  if (phase === "write-sources") return "plan";
  if (phase === "write") return "write-sources";
  const review = phase.match(/^review-(\d+)$/);
  if (review) return Number(review[1]) === 1 ? "write" : `repair-${Number(review[1]) - 1}`;
  const repair = phase.match(/^repair-(\d+)$/);
  if (repair) return `review-${repair[1]}`;
  const blocked = phase.match(/^blocked-(\d+)$/);
  if (blocked) return `review-${blocked[1]}`;
  if (phase === "validate") return "review-*";
  throw new Error(`unsupported checkpoint phase: ${phase}`);
}

function validatePredecessor(phase, inputDigests, existing) {
  const predecessor = phasePredecessor(phase);
  if (predecessor === null) {
    if (inputDigests.length) throw new Error("discover checkpoint must not declare input checkpoints");
    return;
  }
  if (inputDigests.length !== 1) throw new Error(`${phase} checkpoint must declare exactly one input checkpoint digest`);
  const candidates = existing
    .map((entry) => entry.value)
    .filter((record) => predecessor === "review-*" ? /^review-\d+$/.test(record.phase) : record.phase === predecessor);
  if (!candidates.length) throw new Error(`${phase} checkpoint is missing predecessor ${predecessor}`);
  const matching = candidates.find((record) => record.checkpointDigest === inputDigests[0]);
  if (!matching) throw new Error(`${phase} checkpoint input does not match predecessor ${predecessor}`);
}

/** A validate edge may start only from the current clean review leaf. */
export function verifyReviewLeaf(workdir, current) {
  const match = current?.phase?.match(/^review-(\d+)$/);
  if (!match || current?.status !== "active") {
    return { ok: false, errors: ["current run is not an active review checkpoint"] };
  }
  const round = Number(match[1]);
  const review = verifyCheckpoint(workdir, current.phase);
  if (!review.ok || review.checkpoint.status !== "complete") {
    return { ok: false, errors: ["current review checkpoint is invalid", ...(review.errors || [])] };
  }
  if (current.checkpointDigest !== review.checkpoint.checkpointDigest) {
    return { ok: false, errors: ["current run pointer does not match the review checkpoint"] };
  }
  try {
    const descendants = readExistingCheckpoints(workdir)
      .map((entry) => entry.value?.phase)
      .filter((phase) => typeof phase === "string")
      .filter((phase) => {
        const reviewRound = phase.match(/^review-(\d+)$/);
        const repairRound = phase.match(/^(?:repair|blocked)-(\d+)$/);
        return (reviewRound && Number(reviewRound[1]) > round) || (repairRound && Number(repairRound[1]) >= round) || phase === "validate";
      });
    if (descendants.length) return { ok: false, errors: [`review checkpoint has descendants: ${descendants.join(", ")}`] };
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
  return { ok: true, checkpoint: review.checkpoint, errors: [] };
}

function validateCheckpointRecord(record, source) {
  if (record.version !== 2 || !record.runId || !PHASE_RE.test(record.phase || "")) {
    throw new Error(`invalid checkpoint record: ${source}`);
  }
  if (!DIGEST_RE.test(record.checkpointDigest || "") || checkpointDigest(record) !== record.checkpointDigest) {
    throw new Error(`checkpoint digest mismatch: ${source}`);
  }
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

function proposedArtifacts(workdir, proposal, existing) {
  if (!Array.isArray(proposal.artifacts) || proposal.artifacts.length === 0) {
    throw new Error("handoff proposal requires at least one artifact");
  }
  const seenIds = new Set();
  const pageOwners = new Map();
  const knownArtifactIds = new Set(
    existing.flatMap((entry) => (Array.isArray(entry.value.artifacts) ? entry.value.artifacts.map((artifact) => artifact.id) : [])),
  );
  const knownCheckpointDigests = new Set(existing.map((entry) => entry.value.checkpointDigest));
  for (const entry of existing) {
    for (const artifact of entry.value.artifacts ?? []) {
      for (const pagePath of artifact.pagePaths ?? []) {
        pageOwners.set(pagePath, artifact.owner);
      }
    }
  }
  const artifacts = proposal.artifacts.map((artifact, index) => {
    if (!artifact || typeof artifact !== "object") throw new Error(`artifact ${index} must be an object`);
    const id = typeof artifact.id === "string" && artifact.id.trim();
    const type = typeof artifact.type === "string" && artifact.type.trim();
    const owner = typeof artifact.owner === "string" && artifact.owner.trim();
    if (!id || !type || !owner || !OWNER_RE.test(owner)) {
      throw new Error(`artifact ${index} requires id, type, and a valid owner`);
    }
    if (seenIds.has(id) || knownArtifactIds.has(id)) throw new Error(`artifact id is not unique: ${id}`);
    seenIds.add(id);
    const relative = asRelativePath(artifact.path, `artifact ${id}.path`);
    const resolved = ensureArtifactPath(workdir, relative);
    const dependsOn = Array.isArray(artifact.dependsOn) ? artifact.dependsOn : null;
    if (!dependsOn || dependsOn.some((dependency) => typeof dependency !== "string" || !dependency)) {
      throw new Error(`artifact ${id}.dependsOn must be an array of artifact ids`);
    }
    const pagePaths = Array.isArray(artifact.pagePaths) ? artifact.pagePaths.map((page) => asRelativePath(page, `artifact ${id}.pagePaths`)) : [];
    for (const pagePath of pagePaths) {
      const previousOwner = pageOwners.get(pagePath);
      if (previousOwner && previousOwner !== owner) throw new Error(`page has multiple owners: ${pagePath}`);
      pageOwners.set(pagePath, owner);
    }
    const coverageUnitIds = Array.isArray(artifact.coverageUnitIds) ? artifact.coverageUnitIds : [];
    if (coverageUnitIds.some((unit) => typeof unit !== "string" || !unit)) {
      throw new Error(`artifact ${id}.coverageUnitIds must contain non-empty strings`);
    }
    return {
      id,
      type,
      owner,
      path: relative,
      dependsOn: [...dependsOn],
      ...(coverageUnitIds.length ? { coverageUnitIds: [...coverageUnitIds] } : {}),
      ...(pagePaths.length ? { pagePaths } : {}),
      ...(typeof artifact.summary === "string" ? { summary: artifact.summary } : {}),
      ...(Array.isArray(artifact.openQuestions) ? { openQuestions: artifact.openQuestions } : {}),
      digest: `sha256:${resolved.digest}`,
    };
  });
  const allDependencies = new Set([...knownArtifactIds, ...seenIds, ...knownCheckpointDigests]);
  for (const artifact of artifacts) {
    for (const dependency of artifact.dependsOn) {
      if (!allDependencies.has(dependency)) {
        throw new Error(`artifact ${artifact.id} depends on unknown artifact or checkpoint: ${dependency}`);
      }
    }
  }
  return artifacts;
}

/**
 * Validate a proposal and atomically publish the next graph edge.
 * @param {string} root workspace root
 * @param {{runId:string, workdir:string}} run
 * @param {{phase:string, proposalPath:string}} input
 */
export function checkpointRun(root, run, input) {
  if (!PHASE_RE.test(input.phase || "")) throw new Error(`invalid checkpoint phase: ${input.phase}`);
  phasePredecessor(input.phase);
  return withCheckpointLock(run.workdir, () => {
    const proposalRelative = asRelativePath(input.proposalPath, "proposal path");
    const proposalAbsolute = path.resolve(run.workdir, proposalRelative);
    if (!isInside(run.workdir, proposalAbsolute) || !fs.existsSync(proposalAbsolute)) {
      throw new Error(`handoff proposal does not exist in run workdir: ${proposalRelative}`);
    }
    const proposalStat = fs.lstatSync(proposalAbsolute);
    if (!proposalStat.isFile() || proposalStat.isSymbolicLink()) {
      throw new Error(`handoff proposal must be a regular non-symlink file: ${proposalRelative}`);
    }
    const realWorkdir = fs.realpathSync(run.workdir);
    const realProposal = fs.realpathSync(proposalAbsolute);
    if (!isInside(realWorkdir, realProposal)) throw new Error(`handoff proposal real path escapes run workdir: ${proposalRelative}`);
    const proposal = readJson(proposalAbsolute);
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) throw new Error("handoff proposal must be a JSON object");
    if (proposal.version !== 2 || proposal.phase !== input.phase || !OWNER_RE.test(proposal.producer || "")) {
      throw new Error("handoff proposal has an invalid version, phase, or producer");
    }
    const status = proposal.status || "complete";
    if (status !== "complete" && status !== "blocked") throw new Error(`invalid handoff proposal status: ${status}`);
    const inputCheckpointDigests = Array.isArray(proposal.inputCheckpointDigests) ? proposal.inputCheckpointDigests : null;
    if (!inputCheckpointDigests || inputCheckpointDigests.some((digest) => typeof digest !== "string" || !DIGEST_RE.test(digest))) {
      throw new Error("handoff proposal inputCheckpointDigests must be valid digests");
    }

    const existing = readExistingCheckpoints(run.workdir);
    for (const entry of existing) validateCheckpointRecord(entry.value, entry.path);
    if (existing.some((entry) => entry.value.phase === input.phase)) {
      throw new Error(`checkpoint phase is immutable and already published: ${input.phase}`);
    }
    const knownDigests = new Set(existing.map((entry) => entry.value.checkpointDigest));
    for (const digest of inputCheckpointDigests) {
      if (!knownDigests.has(digest)) throw new Error(`handoff proposal references an unknown checkpoint digest: ${digest}`);
    }
    validatePredecessor(input.phase, inputCheckpointDigests, existing);
    if (input.phase === "validate") {
      const reviewLeaf = verifyReviewLeaf(run.workdir, run.current);
      if (!reviewLeaf.ok) throw new Error(`validate checkpoint requires current review leaf: ${reviewLeaf.errors.join("; ")}`);
      if (inputCheckpointDigests[0] !== reviewLeaf.checkpoint.checkpointDigest) {
        throw new Error("validate checkpoint input does not match the current review leaf");
      }
      assertSealableCandidate(run.workdir);
    }
    const artifacts = proposedArtifacts(run.workdir, proposal, existing);
    if (input.phase === "validate") {
      const paths = new Set(artifacts.map((artifact) => artifact.path));
      for (const required of ["analysis/validation.json", "analysis/candidate.manifest.json"]) {
        if (!paths.has(required)) throw new Error(`validate checkpoint must declare artifact: ${required}`);
      }
    }
    const record = {
      version: 2,
      runId: run.runId,
      phase: input.phase,
      status,
      createdAt: new Date().toISOString(),
      inputCheckpointDigests: [...inputCheckpointDigests],
      artifacts,
      ...(typeof proposal.summary === "string" ? { summary: proposal.summary } : {}),
      ...(Array.isArray(proposal.openQuestions) ? { openQuestions: proposal.openQuestions } : {}),
      ...(typeof proposal.reason === "string" ? { reason: proposal.reason } : {}),
    };
    record.checkpointDigest = checkpointDigest(record);
    const outputPath = checkpointPath(run.workdir, input.phase);
    atomicWriteJson(outputPath, record);
    const current = setActiveRun(root, {
      runId: run.runId,
      workdir: run.workdir,
      phase: input.phase === "validate" && status === "complete" ? "sealed" : input.phase,
      status: input.phase === "validate" && status === "complete" ? "sealed" : status === "blocked" ? "blocked" : "active",
      checkpointDigest: record.checkpointDigest,
    });
    return {
      checkpoint: record,
      current,
      checkpointPath: path.relative(run.workdir, outputPath).replace(/\\/g, "/"),
      checkpointDigest: record.checkpointDigest,
      summary: record.summary || `${input.phase} checkpoint published`,
    };
  });
}

export function verifyCheckpoint(workdir, phase) {
  const file = checkpointPath(workdir, phase);
  const record = readJson(file);
  if (!record) return { ok: false, errors: [`missing checkpoint: ${phase}`] };
  try {
    validateCheckpointRecord(record, file);
    for (const artifact of record.artifacts ?? []) {
      const relative = asRelativePath(artifact.path, `artifact ${artifact.id}.path`);
      const actual = ensureArtifactPath(workdir, relative).digest;
      if (`sha256:${actual}` !== artifact.digest) throw new Error(`artifact digest changed: ${artifact.id}`);
    }
    return { ok: true, checkpoint: record, errors: [] };
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
}
