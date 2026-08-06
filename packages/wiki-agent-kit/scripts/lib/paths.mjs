/** Workspace and kit path helpers for the ow CLI. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Kit package root (packages/wiki-agent-kit). */
export const KIT_ROOT = path.resolve(__dirname, "../..");
export const META_DIR = ".wiki-agent";
export const WORKSPACE_FILE = "workspace.yaml";
export const LEGACY_WORKSPACE_FILES = ["workspace.yml", "workspace.json"];

export function resolveWorkspaceRoot(cwd = process.cwd(), explicit) {
  return path.resolve(explicit || cwd);
}

/** Workspaces use one configuration filename and one encoding. */
export function findWorkspaceConfig(root) {
  const configPath = path.join(root, WORKSPACE_FILE);
  if (!fs.existsSync(configPath)) return null;
  if (!fs.statSync(configPath).isFile()) {
    throw new Error(`workspace config is not a file: ${configPath}`);
  }
  return { path: configPath, name: WORKSPACE_FILE, format: "yaml" };
}

export function findLegacyWorkspaceConfigs(root) {
  return LEGACY_WORKSPACE_FILES.filter((name) => {
    const candidate = path.join(root, name);
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  });
}

export function defaultWorkspaceConfigPath(root) {
  return { path: path.join(root, WORKSPACE_FILE), name: WORKSPACE_FILE, format: "yaml" };
}

export function metaDir(root) {
  return path.join(root, META_DIR);
}

/** The only workspace-level run pointer. */
export function currentRunPath(root) {
  return path.join(metaDir(root), "current.json");
}

export function runtimeManifestPath(root) {
  return path.join(metaDir(root), "runtime.json");
}

export function runsDir(root) {
  return path.join(metaDir(root), "runs");
}

export function runDir(root, runId) {
  return path.join(runsDir(root), runId);
}

export function checkpointsDir(workdir) {
  return path.join(workdir, "analysis", "checkpoints");
}

export function checkpointPath(workdir, phase) {
  return path.join(checkpointsDir(workdir), `${phase}.json`);
}

export function sourcesDir(root) {
  return path.join(root, "sources");
}

export function sourcePath(root, sourceId) {
  return path.join(sourcesDir(root), sourceId);
}

export function claudeWorkflowsDir(root) {
  return path.join(root, ".claude", "workflows");
}

export const REQUIRED_WORKFLOWS = ["wiki.workflow.js"];
export const LEGACY_WORKFLOWS = [
  "wiki-plan.workflow.js",
  "wiki-write-review.workflow.js",
  "wiki-produce.workflow.js",
];

export function candidateDir(workdir) {
  return path.join(workdir, "candidate");
}

export function candidateManifestPath(workdir) {
  return path.join(workdir, "analysis", "candidate.manifest.json");
}

export function kitWorkflowsDir() {
  return path.join(KIT_ROOT, "workflows");
}

/** Private method material, frozen into run workdirs but never installed. */
export function kitMethodDir() {
  return path.join(KIT_ROOT, "method", "repository-wiki-producer");
}

export function kitDefaultsDir() {
  return path.join(KIT_ROOT, "defaults");
}

export function assertInsideRoot(root, candidate) {
  const absRoot = path.resolve(root);
  const abs = path.resolve(candidate);
  const rel = path.relative(absRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace root: ${candidate}`);
  }
  return abs;
}
