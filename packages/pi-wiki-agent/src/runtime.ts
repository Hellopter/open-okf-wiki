import { createHash } from "node:crypto";
import type { WikiRuntimeDefinition } from "./core-adapter.js";

/** Stable topology id for session-orchestrated repository wiki production. */
export const WIKI_WORKFLOW_ID = "okf-repository-wiki-session-v4";

/**
 * Digest of the session orchestration topology (not a DW script).
 * Bump the payload string when the phase graph semantics change.
 */
const TOPOLOGY_PAYLOAD = [
  WIKI_WORKFLOW_ID,
  "Prepare",
  "Discover:adaptive-independent-breadth",
  "Plan:markdown",
  "CoverageReview",
  "Approval:propose|auto",
  "Write:persistent-main-session",
  "Review:independent",
  "Validate:deterministic-okf-bundle",
].join("|");

export const WIKI_WORKFLOW_DIGEST = `sha256:${createHash("sha256").update(TOPOLOGY_PAYLOAD, "utf8").digest("hex")}` as const;

/** The core records this descriptor in `.wiki-agent/runtime.json`. */
export const WIKI_RUNTIME_DEFINITION: WikiRuntimeDefinition = {
  kind: "pi",
  extension: "@okf-wiki/pi-wiki-agent",
  workflow: { id: WIKI_WORKFLOW_ID, digest: WIKI_WORKFLOW_DIGEST },
};
