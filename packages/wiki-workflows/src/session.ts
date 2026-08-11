import type { WikiRunSession, WikiRunSnapshot, WikiRunStatus } from "./workflow-types.js";

export const WIKI_RUN_CUSTOM_TYPE = "okf-wiki-run" as const;
export const WIKI_RUN_POINTER_VERSION = 1 as const;

const WIKI_RUN_STATUSES = new Set<WikiRunStatus>([
  "running",
  "paused",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
]);

/**
 * Build the pointer-only value that the extension stores through Pi's appendEntry API.
 * Full snapshot bodies are written to the project history store, not the session entry.
 */
export function createWikiRunSession(snapshot: WikiRunSnapshot): WikiRunSession {
  return {
    customType: WIKI_RUN_CUSTOM_TYPE,
    workspace: snapshot.cwd,
    pointerVersion: WIKI_RUN_POINTER_VERSION,
    runId: snapshot.id,
    revision: snapshot.revision ?? 0,
    status: snapshot.status,
    updatedAt: snapshot.updatedAt,
  };
}

/**
 * Parse a custom-entry payload defensively. Accepts pointer-only sessions.
 * Legacy full-snapshot session entries and malformed payloads return undefined
 * (fail closed — no dual-read / migration).
 */
export function parseWikiRunSession(value: unknown): WikiRunSession | undefined {
  if (!isRecord(value) || value.customType !== WIKI_RUN_CUSTOM_TYPE) return undefined;
  if (typeof value.workspace !== "string" || value.workspace.length === 0) return undefined;
  if (value.pointerVersion !== WIKI_RUN_POINTER_VERSION) return undefined;
  if (typeof value.runId !== "string" || value.runId.length === 0) return undefined;
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) return undefined;
  if (typeof value.status !== "string" || !WIKI_RUN_STATUSES.has(value.status as WikiRunStatus)) return undefined;
  if (typeof value.updatedAt !== "string" || value.updatedAt.length === 0) return undefined;
  // Fail closed: reject legacy full-snapshot session entries.
  if ("snapshot" in value) return undefined;

  return {
    customType: WIKI_RUN_CUSTOM_TYPE,
    workspace: value.workspace,
    pointerVersion: WIKI_RUN_POINTER_VERSION,
    runId: value.runId,
    revision: value.revision as number,
    status: value.status as WikiRunStatus,
    updatedAt: value.updatedAt,
  };
}

export function isWikiRunSession(value: unknown): value is WikiRunSession {
  return parseWikiRunSession(value) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
