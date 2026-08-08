import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WikiRunPaths } from "./types.js";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qualityReportIds = ["coverage-rereview", "evidence", "workflow", "navigation", "reader-qa"] as const;

export const kitRoot = packageDirectory;
export const methodSourceDirectory = path.join(kitRoot, "method", "repository-wiki-producer");
export const defaultsDirectory = path.join(kitRoot, "defaults");
export const workspaceFileName = "workspace.yaml";

export function workspacePaths(root: string) {
  const absoluteRoot = path.resolve(root);
  const metadataDirectory = path.join(absoluteRoot, ".wiki-agent");
  return {
    root: absoluteRoot,
    workspaceFile: path.join(absoluteRoot, workspaceFileName),
    metadataDirectory,
    sourcesDirectory: path.join(absoluteRoot, "sources"),
    runsDirectory: path.join(metadataDirectory, "runs"),
    currentRunFile: path.join(metadataDirectory, "current.json"),
    runtimeFile: path.join(metadataDirectory, "runtime.json"),
  };
}

export function runPaths(root: string, runId: string): WikiRunPaths & { lockPath: string; policyPath: string; inventoryPath: string; snapshotPath: string; manifestPath: string; metaPath: string } {
  const workspace = workspacePaths(root);
  const runDir = path.join(workspace.runsDirectory, runId);
  const inputsDir = path.join(runDir, "inputs");
  const analysisDir = path.join(runDir, "analysis");
  const qualityReportsDir = path.join(analysisDir, "reviews");
  return {
    root: workspace.root,
    runId,
    runDir,
    inputsDir,
    sourcesDir: path.join(inputsDir, "sources"),
    methodDir: path.join(runDir, "method"),
    analysisDir,
    statePath: path.join(analysisDir, "state.json"),
    planPath: path.join(analysisDir, "plan.md"),
    discoveryDir: path.join(analysisDir, "discovery"),
    evidenceDir: path.join(analysisDir, "evidence"),
    coverageReviewPath: path.join(analysisDir, "coverage-review.md"),
    reviewPath: path.join(analysisDir, "review.md"),
    qualityReportsDir,
    qualityReportPaths: Object.fromEntries(qualityReportIds.map((id) => [id, path.join(qualityReportsDir, `${id}.md`)])),
    mainSessionDir: path.join(analysisDir, "session"),
    bundleDir: path.join(runDir, "bundle"),
    lockPath: path.join(analysisDir, "run.lock.json"),
    policyPath: path.join(inputsDir, "run-policy.json"),
    inventoryPath: path.join(inputsDir, "inventory.json"),
    snapshotPath: path.join(inputsDir, "snapshot-manifest.json"),
    manifestPath: path.join(analysisDir, "bundle.manifest.json"),
    metaPath: path.join(runDir, "meta.json"),
  };
}

export function assertInside(root: string, candidate: string, label = "path"): string {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} escapes its allowed directory`);
  return absoluteCandidate;
}

export function relativePath(root: string, candidate: string): string {
  return path.relative(root, candidate).replaceAll(path.sep, "/");
}
