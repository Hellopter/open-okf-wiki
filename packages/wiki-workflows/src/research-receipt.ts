import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { WikiArtifactRef } from "./artifact-store.js";
import type {
  WikiResearchArtifact,
  WikiResearchFinding,
  WikiResearchFindingDraft,
  WikiResearchReceipt,
  WikiResearchScope,
  WikiRunSnapshot,
} from "./workflow-types.js";

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

function routingFields(artifact: WikiResearchArtifact, scope: WikiResearchScope): Pick<WikiResearchReceipt, "findings" | "criticalGapSignatures" | "criticalGapQuestions"> {
  return {
    findings: researchFindings(scope.id, artifact).map((finding) => ({
      id: finding.id,
      priority: finding.priority,
      contentFingerprint: findingContentFingerprint(finding),
    })),
    criticalGapSignatures: artifact.gaps
      .filter((gap) => gap.priority === "critical")
      .map(criticalGapSignature),
    criticalGapQuestions: artifact.gaps
      .filter((gap) => gap.priority === "critical")
      .map((gap) => gap.question),
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

/**
 * Content fingerprint for dry-audit matching.
 * Normalizes evidence to paths only (strip #L ranges) and includes kind + title
 * so line-number jitter does not keep audits "wet" forever.
 */
export function findingContentFingerprint(
  finding: Pick<WikiResearchFindingDraft | WikiResearchFinding, "kind" | "evidence" | "title">,
): string {
  return createHash("sha256").update(stableStringify({
    kind: finding.kind,
    title: normalizeIssueText(finding.title ?? "").toLowerCase(),
    paths: [...finding.evidence].map(normalizeEvidencePath).filter(Boolean).sort(),
  })).digest("hex").slice(0, 16);
}

/** Strip line anchors (`path#L10-L20` → `path`) for stable matching. */
export function normalizeEvidencePath(evidence: string): string {
  return evidence.trim().replace(/#L\d+(?:-L\d+)?$/i, "");
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
