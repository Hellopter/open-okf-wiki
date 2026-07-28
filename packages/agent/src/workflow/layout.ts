/**
 * Workflow projection of freeze output into Run workdir layout.
 *
 * layoutFromFrozen is pure projection from a freeze boundary.
 * layoutForExistingRun discovers mounts on disk for operator repair.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { type FrozenRunBoundary, runWorkDir } from "@okf-wiki/core";
import { type RunWorkdirLayout, runWorkdirLayout } from "../runtime/workdir.js";

export type { RunWorkdirLayout };

/** Project freeze output into the layout Produce/plan use. */
export function layoutFromFrozen(frozen: FrozenRunBoundary): RunWorkdirLayout {
  return runWorkdirLayout(frozen.runWorkDir, frozen.sourcePathMap);
}

/**
 * Reconstruct RunWorkdirLayout from an existing frozen run on disk.
 * Performs I/O (mount discovery); pure path projection stays in runWorkdirLayout.
 */
export async function layoutForExistingRun(
  workspaceRoot: string,
  runId: string,
): Promise<RunWorkdirLayout> {
  const work = runWorkDir(workspaceRoot, runId);
  const sourcesDir = path.join(work, "sources");
  const mounts = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(sourcesDir);
  } catch {
    throw new Error(`Run workdir sources missing for run ${runId}`);
  }
  for (const name of names) {
    const abs = path.join(sourcesDir, name);
    try {
      if ((await stat(abs)).isDirectory()) mounts.set(name, abs);
    } catch {
      // ignore unreadable entries
    }
  }
  if (mounts.size === 0) {
    throw new Error(`Run ${runId} has no source mounts under sources/`);
  }
  return runWorkdirLayout(work, mounts);
}
