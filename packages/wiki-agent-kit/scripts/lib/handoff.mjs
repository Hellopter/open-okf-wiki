/**
 * Host-authored handoff proposals (control plane).
 * Always emits version 2; agents never invent protocol fields.
 */

import fs from "node:fs";
import path from "node:path";
import { isInside, readJson, writeJson } from "./artifacts.mjs";
import { checkpointRun } from "./checkpoints.mjs";

export const HANDOFF_VERSION = 2;
export const DIGEST_RE = /^(?:sha256:)?[a-f0-9]{64}$/;
export const PHASE_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * @param {string} value
 * @param {string} label
 */
export function asRelativePath(value, label = "path") {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\")) {
    throw new Error(`${label} must be a non-empty slash-separated relative path`);
  }
  const normalized = value.replace(/^\.\//, "");
  if (normalized.split("/").includes("..")) throw new Error(`${label} escapes the run workdir: ${value}`);
  return normalized;
}

/**
 * Parse `id:type:owner:path` or `id:type:owner:path:dep1,dep2`.
 * Path may contain colons only if we split with limit — use first 3 colons as separators.
 * @param {string} spec
 */
export function parseArtifactFlag(spec) {
  if (typeof spec !== "string" || !spec.trim()) {
    throw new Error('artifact flag requires "id:type:owner:path[:dep,dep]"');
  }
  const raw = spec.trim();
  const parts = raw.split(":");
  if (parts.length < 4) {
    throw new Error(
      `invalid artifact flag ${JSON.stringify(raw)}; expected id:type:owner:path[:dep,dep] (example: map:discovery-map:survey:analysis/discovery-map.json)`,
    );
  }
  const id = parts[0];
  const type = parts[1];
  const owner = parts[2];
  // path may include ":" rarely; join middle segments except last deps if more than 4 parts.
  // Convention: exactly 4 fields OR 5th field is dependsOn list.
  let artifactPath;
  let dependsOn = [];
  if (parts.length === 4) {
    artifactPath = parts[3];
  } else {
    // last segment is deps; path is parts[3..-2] joined by :
    dependsOn = parts[parts.length - 1]
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    artifactPath = parts.slice(3, -1).join(":");
  }
  if (!id || !type || !owner || !artifactPath) {
    throw new Error(`invalid artifact flag ${JSON.stringify(raw)}; id, type, owner, path are required`);
  }
  if (!OWNER_RE.test(owner)) throw new Error(`invalid artifact owner: ${owner}`);
  return {
    id,
    type,
    owner,
    path: asRelativePath(artifactPath, `artifact ${id}.path`),
    dependsOn,
  };
}

/**
 * @param {string} file
 * @returns {object[]}
 */
export function loadArtifactsJson(file) {
  if (!fs.existsSync(file)) throw new Error(`artifacts json not found: ${file}`);
  const value = readJson(file);
  if (!Array.isArray(value)) throw new Error(`artifacts json must be an array: ${file}`);
  return value.map((item, index) => normalizeArtifactInput(item, index));
}

function normalizeArtifactInput(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`artifact ${index} must be an object`);
  }
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const type = typeof item.type === "string" ? item.type.trim() : "";
  const owner = typeof item.owner === "string" ? item.owner.trim() : "";
  if (!id || !type || !owner) throw new Error(`artifact ${index} requires id, type, and owner`);
  if (!OWNER_RE.test(owner)) throw new Error(`artifact ${index} has invalid owner: ${owner}`);
  const relative = asRelativePath(item.path, `artifact ${id}.path`);
  const dependsOn = Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [];
  if (dependsOn.some((d) => !d)) throw new Error(`artifact ${id}.dependsOn must be non-empty strings`);
  const coverageUnitIds = Array.isArray(item.coverageUnitIds)
    ? item.coverageUnitIds.map(String).filter(Boolean)
    : [];
  const pagePaths = Array.isArray(item.pagePaths)
    ? item.pagePaths.map((p) => asRelativePath(String(p), `artifact ${id}.pagePaths`))
    : [];
  return {
    id,
    type,
    owner,
    path: relative,
    dependsOn,
    ...(coverageUnitIds.length ? { coverageUnitIds } : {}),
    ...(pagePaths.length ? { pagePaths } : {}),
    ...(typeof item.summary === "string" ? { summary: item.summary } : {}),
    ...(Array.isArray(item.openQuestions) ? { openQuestions: item.openQuestions.map(String) } : {}),
  };
}

/**
 * @param {object} input
 */
export function buildHandoffProposal(input) {
  const phase = typeof input.phase === "string" ? input.phase.trim() : "";
  if (!PHASE_RE.test(phase)) throw new Error(`invalid handoff phase: ${input.phase}`);
  const producer = typeof input.producer === "string" ? input.producer.trim() : "";
  if (!OWNER_RE.test(producer)) throw new Error(`invalid handoff producer: ${input.producer}`);
  const digests = Array.isArray(input.inputCheckpointDigests) ? input.inputCheckpointDigests : [];
  if (digests.some((d) => typeof d !== "string" || !DIGEST_RE.test(d))) {
    throw new Error("inputCheckpointDigests must be valid digests (sha256:… or 64 hex)");
  }
  const artifacts = (input.artifacts || []).map((item, index) => normalizeArtifactInput(item, index));
  if (!artifacts.length) throw new Error("handoff proposal requires at least one artifact");
  const status = input.status === "blocked" ? "blocked" : "complete";
  const proposal = {
    version: HANDOFF_VERSION,
    phase,
    inputCheckpointDigests: [...digests],
    producer,
    artifacts,
    status,
  };
  if (typeof input.summary === "string" && input.summary.trim()) proposal.summary = input.summary.trim();
  if (Array.isArray(input.openQuestions) && input.openQuestions.length) {
    proposal.openQuestions = input.openQuestions.map(String).filter(Boolean);
  }
  if (status === "blocked" && typeof input.reason === "string" && input.reason.trim()) {
    proposal.reason = input.reason.trim();
  }
  return proposal;
}

/**
 * Shape-only validation (files need not exist).
 * @param {object} proposal
 * @param {{ phase?: string }} [opts]
 */
export function validateHandoffProposalShape(proposal, opts = {}) {
  const errors = [];
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    return { ok: false, errors: ["handoff proposal must be a JSON object"] };
  }
  if (proposal.version !== HANDOFF_VERSION) {
    errors.push(`version must be number ${HANDOFF_VERSION} (got ${JSON.stringify(proposal.version)})`);
  }
  if (opts.phase && proposal.phase !== opts.phase) {
    errors.push(`phase mismatch (got ${JSON.stringify(proposal.phase)}, want ${JSON.stringify(opts.phase)})`);
  } else if (!PHASE_RE.test(proposal.phase || "")) {
    errors.push(`invalid phase: ${JSON.stringify(proposal.phase)}`);
  }
  if (!OWNER_RE.test(proposal.producer || "")) {
    errors.push(`invalid producer: ${JSON.stringify(proposal.producer)}`);
  }
  if (!Array.isArray(proposal.inputCheckpointDigests)) {
    errors.push("inputCheckpointDigests must be an array");
  } else if (proposal.inputCheckpointDigests.some((d) => typeof d !== "string" || !DIGEST_RE.test(d))) {
    errors.push("inputCheckpointDigests contains an invalid digest");
  }
  if (!Array.isArray(proposal.artifacts) || !proposal.artifacts.length) {
    errors.push("artifacts must be a non-empty array");
  }
  const status = proposal.status || "complete";
  if (status !== "complete" && status !== "blocked") {
    errors.push(`invalid status: ${status}`);
  }
  return { ok: !errors.length, errors };
}

/**
 * @param {string} workdir
 * @param {string} relativeOutPath
 * @param {object} proposalInput buildHandoffProposal input
 */
export function writeHandoffProposal(workdir, relativeOutPath, proposalInput) {
  const proposal = buildHandoffProposal(proposalInput);
  const relative = asRelativePath(relativeOutPath, "proposal out path");
  const absolute = path.resolve(workdir, relative);
  if (!isInside(workdir, absolute)) throw new Error(`proposal path escapes workdir: ${relative}`);
  writeJson(absolute, proposal);
  return { proposalPath: relative, proposal };
}

/**
 * @param {string} workdir
 * @param {object} opts
 */
export function handoffWrite(workdir, opts) {
  const artifacts = [];
  if (Array.isArray(opts.artifacts)) artifacts.push(...opts.artifacts);
  if (Array.isArray(opts.artifactFlags)) {
    for (const flag of opts.artifactFlags) artifacts.push(parseArtifactFlag(flag));
  }
  if (opts.artifactsJsonPath) {
    const abs = path.isAbsolute(opts.artifactsJsonPath)
      ? opts.artifactsJsonPath
      : path.resolve(workdir, opts.artifactsJsonPath);
    artifacts.push(...loadArtifactsJson(abs));
  }
  return writeHandoffProposal(workdir, opts.out, {
    phase: opts.phase,
    producer: opts.producer,
    inputCheckpointDigests: opts.inputCheckpointDigests || [],
    artifacts,
    summary: opts.summary,
    openQuestions: opts.openQuestions,
    status: opts.status,
    reason: opts.reason,
  });
}

/**
 * Write proposal then publish checkpoint.
 * @param {string} root
 * @param {{runId:string, workdir:string, current?: object}} run
 * @param {object} opts same as handoffWrite + phase/out
 */
export function handoffPublish(root, run, opts) {
  const written = handoffWrite(run.workdir, opts);
  const result = checkpointRun(root, run, { phase: opts.phase, proposalPath: written.proposalPath });
  return {
    status: "ok",
    proposalPath: written.proposalPath,
    checkpointPath: result.checkpointPath,
    checkpointDigest: result.checkpointDigest,
    summary: result.summary,
  };
}

/**
 * Default proposal path for a phase (overridable).
 * @param {string} phase
 * @param {{ pass?: number|string }} [opts]
 */
export function defaultHandoffOut(phase, opts = {}) {
  if (phase === "discover") {
    const pass = opts.pass ?? 1;
    return `analysis/handoffs/discovery-pass-${pass}.json`;
  }
  if (phase === "plan") return "analysis/handoffs/plan.json";
  if (phase === "write-sources") return "analysis/handoffs/write-sources.json";
  if (phase === "write") return "analysis/handoffs/write.json";
  if (phase === "validate") return "analysis/handoffs/validate.json";
  if (/^review-\d+$/.test(phase)) return `analysis/handoffs/${phase}.json`;
  if (/^repair-\d+$/.test(phase)) return `analysis/handoffs/${phase}.json`;
  if (/^blocked-\d+$/.test(phase)) return `analysis/handoffs/blocked-review-${phase.slice("blocked-".length)}.json`;
  return `analysis/handoffs/${phase}.json`;
}
