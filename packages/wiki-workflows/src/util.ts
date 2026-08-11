/**
 * Shared pure helpers for wiki-workflows.
 *
 * Pure module: no @earendil-works/* imports.
 */

import path from "node:path";
import { errorMessage } from "./failures.js";

export { errorMessage };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** True when `target` is a path strictly inside `root` (not equal, not outside). */
export function pathIsInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** Deterministic JSON-like stringify with sorted object keys (for fingerprints). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
