/**
 * Workspace path helpers for the ow CLI.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Kit package root (packages/wiki-agent-kit). */
export const KIT_ROOT = path.resolve(__dirname, "../..");

export const META_DIR = ".wiki-agent";
export const WORKSPACE_FILE = "workspace.json";

export function resolveWorkspaceRoot(cwd = process.cwd(), explicit) {
  if (explicit) return path.resolve(explicit);
  return path.resolve(cwd);
}

export function workspaceJsonPath(root) {
  return path.join(root, WORKSPACE_FILE);
}

export function metaDir(root) {
  return path.join(root, META_DIR);
}

export function runsDir(root) {
  return path.join(metaDir(root), "runs");
}

export function runDir(root, runId) {
  return path.join(runsDir(root), runId);
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

export function agentsSkillsDir(root) {
  return path.join(root, ".agents", "skills", "repository-wiki-producer");
}

export function kitWorkflowsDir() {
  return path.join(KIT_ROOT, "workflows");
}

export function kitSkillDir() {
  return path.join(KIT_ROOT, "skill", "repository-wiki-producer");
}

export function kitDefaultsDir() {
  return path.join(KIT_ROOT, "defaults");
}

/** Contain a candidate path under workspace root (no escape). */
export function assertInsideRoot(root, candidate) {
  const absRoot = path.resolve(root);
  const abs = path.resolve(candidate);
  const rel = path.relative(absRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace root: ${candidate}`);
  }
  return abs;
}
