/**
 * GraphStore adapter over Run Boundary core persistence.
 */

import type { RunGraphSnapshot } from "@okf-wiki/contract";
import { loadRunGraph, writeRunGraph } from "@okf-wiki/core";
import type { GraphStore } from "./graph-store.js";

export function createCoreGraphStore(workspaceRoot: string): GraphStore {
  return {
    async save(runId: string, snapshot: RunGraphSnapshot): Promise<void> {
      await writeRunGraph(workspaceRoot, runId, snapshot);
    },
    async load(runId: string): Promise<RunGraphSnapshot | null> {
      return loadRunGraph(workspaceRoot, runId);
    },
  };
}
