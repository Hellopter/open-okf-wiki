import { createHash } from "node:crypto";
import type { WikiArtifactRef } from "./artifact-store.js";
import type {
  WikiResearchArtifact,
  WikiResearchFinding,
  WikiResearchReceipt,
  WikiResearchScope,
  WikiRunSnapshot,
} from "./workflow-types.js";

/**
 * Project a durable research receipt from an already-validated artifact.
 * Call only after validateResearchArtifact + handoff persist.
 */
export function projectResearchReceipt(
  run: WikiRunSnapshot,
  artifact: WikiResearchArtifact,
  artifactRef: WikiArtifactRef,
  scope: WikiResearchScope,
): WikiResearchReceipt {
  return {
    scopeId: scope.id,
    task: scope.task,
    sourceFingerprint: run.inspection?.sourceFingerprint ?? "unknown",
    artifact: artifactRef,
    findings: researchFindings(scope.id, artifact).map((finding) => ({
      id: finding.id,
      priority: finding.priority,
    })),
    criticalGapSignatures: artifact.gaps
      .filter((gap) => gap.priority === "critical")
      .map(criticalGapSignature),
  };
}

export function researchFindings(scopeId: string, artifact: WikiResearchArtifact): WikiResearchFinding[] {
  return artifact.findings.map((finding) => ({
    ...finding,
    id: `finding-${createHash("sha256").update(stableStringify({
      kind: finding.kind,
      evidence: [...finding.evidence].sort(),
    })).digest("hex").slice(0, 16)}`,
    scopeId,
  }));
}

function criticalGapSignature(gap: WikiResearchArtifact["gaps"][number]): string {
  return createHash("sha256").update(stableStringify({
    priority: gap.priority,
    question: normalizeIssueText(gap.question).toLowerCase(),
    sourcePaths: [...gap.sourcePaths].sort(),
  })).digest("hex").slice(0, 16);
}

function normalizeIssueText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
