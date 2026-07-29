/**
 * Pure hashing / time helpers for WikiRuns.
 */

import { createHash } from "node:crypto";
import type { WikiRunArtifactKind } from "@okf-wiki/contract";

export function now(): string {
  return new Date().toISOString();
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function artifactId(
  runId: string,
  kind: WikiRunArtifactKind,
  manifestDigest: string,
): string {
  return `${runId}:${kind}:${manifestDigest}`;
}
