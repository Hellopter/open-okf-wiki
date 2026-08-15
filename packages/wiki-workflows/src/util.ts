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
  const serialized = stableJsonValue(value);
  if (serialized === undefined) throw new TypeError("Cannot stringify a non-JSON top-level value");
  return serialized;
}

function stableJsonValue(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJsonValue(item) ?? "null").join(",")}]`;
  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const serialized = stableJsonValue(record[key]);
    if (serialized !== undefined) fields.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `{${fields.join(",")}}`;
}

/** Compare string collections by unique membership, independent of order. */
export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
