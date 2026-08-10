import type { WikiRunSession, WikiRunSnapshot } from "./workflow-types.js";
import { isWikiRunSnapshot } from "./snapshot-validation.js";

export const WIKI_RUN_CUSTOM_TYPE = "okf-wiki-run" as const;

/** Build the compact value that the extension stores through Pi's appendEntry API. */
export function createWikiRunSession(snapshot: WikiRunSnapshot): WikiRunSession {
  return {
    customType: WIKI_RUN_CUSTOM_TYPE,
    workspace: snapshot.cwd,
    snapshot: clone(snapshot),
  };
}

/**
 * Parse a custom-entry payload defensively. A malformed historical entry is
 * ignored by the extension instead of preventing Pi session recovery.
 */
export function parseWikiRunSession(value: unknown): WikiRunSession | undefined {
  if (!isRecord(value) || value.customType !== WIKI_RUN_CUSTOM_TYPE || typeof value.workspace !== "string") return undefined;
  const snapshot = value.snapshot;
  if (!isWikiRunSnapshot(snapshot) || snapshot.cwd !== value.workspace) return undefined;
  return createWikiRunSession(snapshot);
}

export function isWikiRunSession(value: unknown): value is WikiRunSession {
  return parseWikiRunSession(value) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
