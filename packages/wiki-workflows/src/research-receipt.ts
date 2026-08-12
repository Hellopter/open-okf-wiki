import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { WikiArtifactRef } from "./artifact-store.js";
import type {
  WikiResearchArtifact,
  WikiResearchFinding,
  WikiCriticalGap,
  WikiResearchReceipt,
  WikiResearchScope,
  WikiRunSnapshot,
} from "./workflow-types.js";
import { stableStringify } from "./util.js";

/** Receipts are routing state, not a second copy of the full research artifact. */
export const MAX_RESEARCH_RECEIPT_BYTES = 64 * 1024;
export const MAX_RESEARCH_RECEIPT_ROUTING_BYTES = 60 * 1024;

/** Preflight the model-authored routing fields before accepting its submission. */
export function validateResearchReceiptRouting(artifact: WikiResearchArtifact, scope: WikiResearchScope): void {
  const routing = routingFields(artifact, scope);
  const sizeBytes = Buffer.byteLength(JSON.stringify(routing), "utf8");
  if (sizeBytes > MAX_RESEARCH_RECEIPT_ROUTING_BYTES) {
    throw new Error(`Research receipt routing exceeds ${MAX_RESEARCH_RECEIPT_ROUTING_BYTES} UTF-8 bytes (${sizeBytes}); reduce findings or critical gap detail`);
  }
}

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
  const receipt: WikiResearchReceipt = {
    scopeId: scope.id,
    task: scope.task,
    sourceFingerprint: run.inspection?.sourceFingerprint ?? "unknown",
    artifact: artifactRef,
    ...routingFields(artifact, scope),
  };
  const sizeBytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");
  if (sizeBytes > MAX_RESEARCH_RECEIPT_BYTES) {
    throw new Error(`Research receipt exceeds ${MAX_RESEARCH_RECEIPT_BYTES} UTF-8 bytes (${sizeBytes}); reduce findings or critical gap detail`);
  }
  return receipt;
}

function routingFields(artifact: WikiResearchArtifact, scope: WikiResearchScope): Pick<WikiResearchReceipt, "findings" | "criticalGaps"> {
  return {
    findings: researchFindings(scope.id, artifact).map((finding) => ({
      id: finding.id,
      priority: finding.priority,
    })),
    criticalGaps: artifact.gaps
      .filter((gap) => gap.priority === "critical")
      .map(projectCriticalGap),
  };
}

/**
 * Stable identity for a finding within a research scope.
 * Includes scopeId so identical kind+evidence from different scopes never collide
 * when receipts are merged by id.
 */
export function researchFindings(scopeId: string, artifact: WikiResearchArtifact): WikiResearchFinding[] {
  return artifact.findings.map((finding) => ({
    ...finding,
    id: `finding-${createHash("sha256").update(stableStringify({
      scopeId,
      kind: finding.kind,
      evidence: [...finding.evidence].sort(),
    })).digest("hex").slice(0, 16)}`,
    scopeId,
  }));
}

function projectCriticalGap(gap: WikiResearchArtifact["gaps"][number]): WikiCriticalGap {
  const question = normalizeIssueText(gap.question);
  const sourcePaths = [...new Set(gap.sourcePaths)].sort();
  const id = createHash("sha256").update(stableStringify({
    question: question.toLowerCase(),
    sourcePaths,
  })).digest("hex").slice(0, 16);
  return { id, question, sourcePaths };
}

function normalizeIssueText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
