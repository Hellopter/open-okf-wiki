/** Workspace and kit path helpers for the framework-neutral Wiki core. */

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

/** A run directory is its own work root. */
export function runRoot(root, runId) {
  return runDir(root, runId);
}

export function inputsDir(runRootPath) {
  return path.join(runRootPath, "inputs");
}

export function frozenSourcesDir(runRootPath) {
  return path.join(inputsDir(runRootPath), "sources");
}

export function analysisDir(runRootPath) {
  return path.join(runRootPath, "analysis");
}

export function bundleDir(runRootPath) {
  return path.join(runRootPath, "bundle");
}

/** The canonical workflow guidance frozen with this run. */
export function runMethodDir(runRootPath) {
  return path.join(runRootPath, "method");
}

export function statePath(runRootPath) {
  return path.join(analysisDir(runRootPath), "state.json");
}

export function planPath(runRootPath) {
  return path.join(analysisDir(runRootPath), "plan.md");
}

export function discoveryDir(runRootPath) {
  return path.join(analysisDir(runRootPath), "discovery");
}

/** Source-grounded research briefs selected by the planner before writing begins. */
export function evidenceDir(runRootPath) {
  return path.join(analysisDir(runRootPath), "evidence");
}

export function coverageReviewPath(runRootPath) {
  return path.join(analysisDir(runRootPath), "coverage-review.md");
}

export function reviewPath(runRootPath) {
  return path.join(analysisDir(runRootPath), "review.md");
}

/** Independent quality reports produced after the main bundle draft. */
export function qualityReportsDir(runRootPath) {
  return path.join(analysisDir(runRootPath), "reviews");
}

export const QUALITY_REPORT_IDS = Object.freeze([
  "coverage-rereview",
  "evidence",
  "workflow",
  "navigation",
  "reader-qa",
]);

/** Resolve one canonical post-write quality report. */
export function qualityReportPath(runRootPath, reportId) {
  if (!QUALITY_REPORT_IDS.includes(reportId)) throw new Error(`unknown quality report: ${reportId}`);
  return path.join(qualityReportsDir(runRootPath), `${reportId}.md`);
}

export function sessionDir(runRootPath) {
  return path.join(analysisDir(runRootPath), "session");
}

export function runLockPath(runRootPath) {
  return path.join(analysisDir(runRootPath), "run.lock.json");
}

/** Workspace-managed linked or cloned sources, distinct from frozen inputs. */
export function sourcesDir(root) {
  return path.join(root, "sources");
}

export function sourcePath(root, sourceId) {
  return path.join(sourcesDir(root), sourceId);
}

export function bundleManifestPath(runRootPath) {
  return path.join(analysisDir(runRootPath), "bundle.manifest.json");
}

/** Private method material, frozen into run directories but never installed. */
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
