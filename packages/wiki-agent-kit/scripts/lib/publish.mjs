/** Publish run-local artifacts as the next verified workflow checkpoint. */

import fs from "node:fs";
import path from "node:path";
import { isInside, readJson } from "./artifacts.mjs";
import { publishCheckpoint } from "./checkpoints.mjs";
import { verifyPlanGate } from "./gate.mjs";

function artifactListFile(workdir, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("artifactsJsonPath must be a non-empty path");
  }
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(workdir, value);
  if (!isInside(workdir, candidate) || !fs.existsSync(candidate)) {
    throw new Error(`artifacts json does not exist in run workdir: ${value}`);
  }
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`artifacts json must be a regular non-symlink file: ${value}`);
  }
  const realWorkdir = fs.realpathSync(workdir);
  if (!isInside(realWorkdir, fs.realpathSync(candidate))) {
    throw new Error(`artifacts json real path escapes run workdir: ${value}`);
  }
  return candidate;
}

function assertWriteSourcesAuthorized(run, phase) {
  if (phase !== "write-sources") return;
  const methodDigest = run?.meta?.methodDigest;
  if (typeof methodDigest !== "string" || !methodDigest) {
    throw new Error("write-sources publish requires the active run method digest");
  }
  const gate = verifyPlanGate(run.workdir, run.runId, methodDigest);
  if (!gate.ok) {
    throw new Error(`write-sources publish requires a valid plan gate: ${(gate.errors || []).join("; ")}`);
  }
}

/**
 * Publish artifacts for the next workflow phase.
 *
 * The JSON file must be an array of `{ id, type, path }` values. Discover
 * artifacts may additionally contain `coverageUnitIds`; no agent-authored
 * phase, producer, dependency, or checkpoint metadata is accepted.
 *
 * @param {string} root workspace root
 * @param {{runId:string, workdir:string}} run active run
 * @param {{phase:string, artifactsJsonPath:string}} input
 */
export function publishArtifacts(root, run, input) {
  const file = artifactListFile(run.workdir, input?.artifactsJsonPath);
  const artifacts = readJson(file);
  if (!Array.isArray(artifacts)) {
    throw new Error(`artifacts json must contain an array: ${input.artifactsJsonPath}`);
  }
  assertWriteSourcesAuthorized(run, input?.phase);
  return publishCheckpoint(root, run, { phase: input?.phase, artifacts });
}
