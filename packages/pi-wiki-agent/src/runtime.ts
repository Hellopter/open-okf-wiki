import { createHash } from "node:crypto";
import type { WikiRuntimeDefinition } from "./core.js";

/** Stable topology id for session-orchestrated repository wiki production. */
export const WIKI_WORKFLOW_ID = "okf-repository-wiki-session-v5";

/**
 * Digest of the session orchestration topology (not a DW script).
 * Bump the payload string when the phase graph semantics change.
 */
/** The execution graph and runtime digest derive from this single inventory. */
export const WIKI_WORKFLOW_PHASE = {
  survey: "Survey",
  plan: "Plan",
  evidence: "Evidence",
  evidenceSynthesis: "Evidence synthesis",
  coverageInitial: "Coverage initial",
  coverageRevision: "Coverage revision",
  coverageVerification: "Coverage verification",
  write: "Write",
  review: "Review",
  repair: "Repair",
  verification: "Verification",
  validate: "Validate",
} as const;

export const WIKI_WORKFLOW_PHASES = Object.freeze(Object.values(WIKI_WORKFLOW_PHASE));
export type WikiWorkflowPhase = (typeof WIKI_WORKFLOW_PHASE)[keyof typeof WIKI_WORKFLOW_PHASE];

const TOPOLOGY_PAYLOAD = [
  WIKI_WORKFLOW_ID,
  ...WIKI_WORKFLOW_PHASES,
].join("|");

export const WIKI_WORKFLOW_DIGEST = `sha256:${createHash("sha256").update(TOPOLOGY_PAYLOAD, "utf8").digest("hex")}` as const;

/** The core records this descriptor in `.wiki-agent/runtime.json`. */
export const WIKI_RUNTIME_DEFINITION: WikiRuntimeDefinition = {
  kind: "pi",
  extension: "@okf-wiki/pi-wiki-agent",
  workflow: { id: WIKI_WORKFLOW_ID, digest: WIKI_WORKFLOW_DIGEST },
};
