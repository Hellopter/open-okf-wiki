/**
 * Post-restore durable integrity checks for Wiki run handoffs.
 *
 * Pure helper: no engine state. Extension/engine call this after accepting a
 * valid snapshot so resume cannot dispatch into a graph with missing blobs.
 */

import type { WikiArtifactStore } from "./artifact-store.js";
import { errorMessage } from "./failures.js";
import type { WikiNode, WikiRunSnapshot } from "./workflow-types.js";

/** Node kinds whose succeeded handoffs are required for later agents. */
const DURABLE_HANDOFF_KINDS = new Set<WikiNode["kind"]>(["research", "synthesis", "review"]);

/**
 * Validate that every succeeded research/synthesis/review handoff is still
 * readable from the artifact store. Returns human-readable problem strings
 * (empty when healthy). Does not mutate the snapshot.
 */
export async function checkRunArtifactHealth(
  _cwd: string,
  snapshot: WikiRunSnapshot,
  store: WikiArtifactStore,
): Promise<string[]> {
  const problems: string[] = [];
  for (const node of snapshot.nodes) {
    if (node.status !== "succeeded") continue;
    if (!DURABLE_HANDOFF_KINDS.has(node.kind)) continue;
    if (!node.handoff) continue;

    const ref = node.handoff;
    try {
      // Prefer full integrity (size + sha256) over a mere path existence check.
      await store.read(ref);
    } catch (error) {
      problems.push(
        `${node.kind} node ${node.id} (attempt ${ref.attempt}, ${ref.relativePath}): ${errorMessage(error)}`,
      );
    }
  }
  return problems;
}
