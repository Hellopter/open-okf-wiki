/**
 * Durable Run Graph under the Run Boundary.
 * Live projection rides wiki_produce tool details; this is the on-disk truth.
 *
 * Path: `{root}/.okf-wiki/runs/{runId}/analysis/run-graph.json`
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type RunGraphSnapshot,
  RunGraphSnapshotSchema,
} from "@okf-wiki/contract";
import { atomicWriteJson } from "./atomic-write.js";
import { isPathInside } from "./paths.js";
import { analysisDir as layoutAnalysisDir } from "./run-layout.js";

export const RUN_GRAPH_FILE_NAME = "run-graph.json";

/** Relative path under run analysis/ (for Run Record / receipts pointers). */
export const RUN_GRAPH_REL_PATH = RUN_GRAPH_FILE_NAME;

export function runGraphPath(workspaceRoot: string, runId: string): string {
  const safe = runId.replace(/[/\\]/g, "_");
  return path.join(layoutAnalysisDir(workspaceRoot, safe), RUN_GRAPH_FILE_NAME);
}

/**
 * Atomically write a validated RunGraphSnapshot under analysis/run-graph.json.
 * Returns the absolute path written.
 */
export async function writeRunGraph(
  workspaceRoot: string,
  runId: string,
  snapshot: RunGraphSnapshot,
): Promise<string> {
  const parsed = RunGraphSnapshotSchema.parse(snapshot);
  const filePath = runGraphPath(workspaceRoot, runId);
  const root = path.resolve(workspaceRoot);
  const analysis = path.dirname(filePath);
  if (!isPathInside(root, analysis) || !isPathInside(root, filePath)) {
    throw new Error("run-graph path escapes workspace root");
  }
  await atomicWriteJson(filePath, parsed);
  return filePath;
}

/**
 * Load durable Run Graph for a run, or null if missing/invalid.
 */
export async function loadRunGraph(
  workspaceRoot: string,
  runId: string,
): Promise<RunGraphSnapshot | null> {
  const filePath = runGraphPath(workspaceRoot, runId);
  const root = path.resolve(workspaceRoot);
  if (!isPathInside(root, filePath)) return null;
  try {
    const raw = await readFile(filePath, "utf8");
    return RunGraphSnapshotSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
