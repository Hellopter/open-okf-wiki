import { createHash } from "node:crypto";
import type { WikiRuntimeDefinition } from "./core-adapter.js";
import { WIKI_WORKFLOW_SCRIPT } from "./wiki-workflow.js";

export const WIKI_WORKFLOW_ID = "okf-repository-wiki-v1";
export const WIKI_WORKFLOW_DIGEST = `sha256:${createHash("sha256").update(WIKI_WORKFLOW_SCRIPT, "utf8").digest("hex")}` as const;

/** The core records this descriptor in `.wiki-agent/runtime.json`. */
export const WIKI_RUNTIME_DEFINITION: WikiRuntimeDefinition = {
  kind: "pi",
  extension: "@okf-wiki/pi-wiki-agent",
  workflow: { id: WIKI_WORKFLOW_ID, digest: WIKI_WORKFLOW_DIGEST },
};
