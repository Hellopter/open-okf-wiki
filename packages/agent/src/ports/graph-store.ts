/**
 * Durable Run Graph persistence port (Run Boundary implementation in core).
 */

import type { RunGraphSnapshot } from "@okf-wiki/contract";

export interface GraphStore {
  save(runId: string, snapshot: RunGraphSnapshot): Promise<void>;
  load(runId: string): Promise<RunGraphSnapshot | null>;
}
