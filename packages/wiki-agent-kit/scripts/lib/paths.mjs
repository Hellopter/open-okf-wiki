/**
 * Workspace path helpers for the ow CLI.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Kit package root (packages/wiki-agent-kit). */
export const KIT_ROOT = path.resolve(__dirname, "../..");

export const META_DIR = ".wiki-agent";
/** @deprecated Prefer resolveWorkspaceConfigPath / WORKSPACE_CONFIG_CANDIDATES. */
export const WORKSPACE_FILE = "workspace.json";

/** Preferred order when multiple names are considered for creation. */
export const WORKSPACE_CONFIG_CANDIDATES = ["workspace.yaml", "workspace.yml", "workspace.json"];

export function resolveWorkspaceRoot(cwd = process.cwd(), explicit) {
  if (explicit) return path.resolve(explicit);
  return path.resolve(cwd);
}

/**
 * Locate the on-disk workspace config.
 * @returns {{ path: string, format: "yaml" | "json", name: string } | null}
 */
export function findWorkspaceConfig(root) {
  const found = [];
  for (const name of WORKSPACE_CONFIG_CANDIDATES) {
    const abs = path.join(root, name);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      found.push({
        path: abs,
        name,
        format: name.endsWith(".json") ? "json" : "yaml",
      });
    }
  }
  if (found.length > 1) {
    throw new Error(
      `multiple workspace configs found (${found.map((f) => f.name).join(", ")}); keep exactly one of workspace.yaml|workspace.yml|workspace.json`,
    );
  }
  return found[0] ?? null;
}

/**
 * Path used when creating a new workspace config.
 * @param {"yaml"|"json"} [format]
 */
export function defaultWorkspaceConfigPath(root, format = "yaml") {
  const name = format === "json" ? "workspace.json" : "workspace.yaml";
  return {
    path: path.join(root, name),
    name,
    format: format === "json" ? "json" : "yaml",
  };
}

/** @deprecated Use findWorkspaceConfig / defaultWorkspaceConfigPath. */
export function workspaceJsonPath(root) {
  const existing = findWorkspaceConfig(root);
  if (existing) return existing.path;
  return path.join(root, WORKSPACE_FILE);
}

export function metaDir(root) {
  return path.join(root, META_DIR);
}

/** Active-run pointer for no-arg Claude workflows. */
export function currentRunPath(root) {
  return path.join(metaDir(root), "current.json");
}

/** Next operator/workflow action for the active run. */
export function nextActionPath(root) {
  return path.join(metaDir(root), "next-action.json");
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

export function claudeSkillsDir(root) {
  return path.join(root, ".claude", "skills", "repository-wiki-producer");
}

export function agentsSkillsDir(root) {
  return path.join(root, ".agents", "skills", "repository-wiki-producer");
}

export function candidateDir(workdir) {
  return path.join(workdir, "candidate");
}

export function candidateManifestPath(workdir) {
  return path.join(workdir, "analysis", "candidate.manifest.json");
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
