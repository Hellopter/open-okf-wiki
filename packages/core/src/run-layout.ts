import path from "node:path";

/** Product meta directory under a workspace root (and default user home). */
export const WORKSPACE_DIR_NAME = ".okf-wiki";

/** Directory name for Wiki Run records and workdirs under product meta. */
export const RUNS_DIR_NAME = "runs";

/** Absolute path to `{root}/.okf-wiki/runs`. */
export function runsDir(root: string): string {
  return path.join(path.resolve(root), WORKSPACE_DIR_NAME, RUNS_DIR_NAME);
}

/** Absolute path to `{root}/.okf-wiki/runs/{runId}`. */
export function runWorkDir(root: string, runId: string): string {
  return path.join(runsDir(root), runId);
}

/** Absolute path to `{root}/.okf-wiki/runs/{runId}/skill`. */
export function runSkillDir(root: string, runId: string): string {
  return path.join(runWorkDir(root, runId), "skill");
}

/** Absolute path to `{root}/.okf-wiki/runs/{runId}/analysis`. */
export function analysisDir(root: string, runId: string): string {
  return path.join(runWorkDir(root, runId), "analysis");
}

/** Absolute path to `{root}/.okf-wiki/runs/{runId}/analysis/receipts`. */
export function analysisReceiptsDir(root: string, runId: string): string {
  return path.join(analysisDir(root, runId), "receipts");
}
