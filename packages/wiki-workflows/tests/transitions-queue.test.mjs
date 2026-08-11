import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  findingContentFingerprint,
  researchFindings,
} from "../dist/research-receipt.js";
import {
  previousReviewSignature,
  previousValidationSignature,
} from "../dist/transitions-queue.js";
import { defectsFingerprint, validationIssuesFingerprint } from "../dist/run-nodes.js";

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function draftFinding(overrides = {}) {
  return {
    kind: "domain",
    title: "Core domain",
    readerQuestion: "What is the core?",
    priority: "critical",
    evidence: ["src-core/index.ts#L1"],
    ...overrides,
  };
}

function hostWithNodes(nodes) {
  return {
    requireRun: () => ({ nodes }),
  };
}

function verifyNode(kind, id, synthesisNodeId, result, status = "succeeded") {
  return {
    id,
    kind,
    status,
    input: { synthesisNodeId, sourceNodeIds: [], verificationGroupId: "verify:g" },
    result,
  };
}

test("researchFindings ids include scopeId so cross-scope kind+evidence do not collide", () => {
  const artifact = { summary: "s", findings: [draftFinding()], gaps: [] };
  const left = researchFindings("source-survey:src-a", artifact);
  const right = researchFindings("source-survey:src-b", artifact);
  assert.equal(left.length, 1);
  assert.equal(right.length, 1);
  assert.notEqual(left[0].id, right[0].id);
  assert.equal(left[0].scopeId, "source-survey:src-a");
  assert.equal(right[0].scopeId, "source-survey:src-b");

  const expectedLeft = `finding-${createHash("sha256").update(stableStringify({
    scopeId: "source-survey:src-a",
    kind: "domain",
    evidence: ["src-core/index.ts#L1"],
  })).digest("hex").slice(0, 16)}`;
  assert.equal(left[0].id, expectedLeft);

  // Content fingerprint stays scope-agnostic for dry-audit matching.
  assert.equal(
    findingContentFingerprint(left[0]),
    findingContentFingerprint(right[0]),
  );
  assert.equal(
    findingContentFingerprint(left[0]),
    createHash("sha256").update(stableStringify({
      kind: "domain",
      evidence: ["src-core/index.ts#L1"],
    })).digest("hex").slice(0, 16),
  );
});

test("researchFindings is stable for the same scopeId + kind + sorted evidence", () => {
  const artifact = {
    summary: "s",
    findings: [draftFinding({ evidence: ["b.ts#L2", "a.ts#L1"] })],
    gaps: [],
  };
  const once = researchFindings("scope-x", artifact);
  const twice = researchFindings("scope-x", {
    summary: "s",
    findings: [draftFinding({ evidence: ["a.ts#L1", "b.ts#L2"] })],
    gaps: [],
  });
  assert.equal(once[0].id, twice[0].id);
});

test("previousReviewSignature only matches prior reviews for the same synthesisNodeId", () => {
  const defects = [{ kind: "depth", page: "core/page.md", detail: "Too shallow" }];
  const fingerprint = defectsFingerprint(defects);
  const nodes = [
    verifyNode("review", "review-old-plan", "synthesis-old", { defects, summary: "old" }),
    verifyNode("review", "review-current", "synthesis-new", { defects, summary: "new" }),
  ];
  const host = hostWithNodes(nodes);

  // Different synthesis lineage: ignore old plan defects.
  assert.equal(
    previousReviewSignature(host, "review-current", "synthesis-new"),
    undefined,
  );

  // Same synthesis lineage: surface prior fingerprint.
  nodes.push(verifyNode("review", "review-prior-same", "synthesis-new", { defects, summary: "prior" }));
  // Insert prior before current in list order by rebuilding with prior earlier.
  const sameLineage = hostWithNodes([
    verifyNode("review", "review-prior-same", "synthesis-new", { defects, summary: "prior" }),
    verifyNode("review", "review-current", "synthesis-new", { defects, summary: "new" }),
    verifyNode("review", "review-old-plan", "synthesis-old", { defects, summary: "old" }),
  ]);
  assert.equal(
    previousReviewSignature(sameLineage, "review-current", "synthesis-new"),
    fingerprint,
  );
});

function validationResult(issues) {
  return { ok: false, issues, pages: [], obsoletePages: [] };
}

test("previousValidationSignature only matches prior validates for the same synthesisNodeId", () => {
  const issues = [{ code: "link", page: "api/flow.md", message: "Broken link" }];
  const fingerprint = validationIssuesFingerprint(issues);
  const hostCrossPlan = hostWithNodes([
    verifyNode("validate", "validate-old", "synthesis-old", validationResult(issues)),
    verifyNode("validate", "validate-current", "synthesis-new", validationResult(issues)),
  ]);
  assert.equal(
    previousValidationSignature(hostCrossPlan, "validate-current", "synthesis-new"),
    undefined,
  );

  const hostSamePlan = hostWithNodes([
    verifyNode("validate", "validate-prior", "synthesis-new", validationResult(issues)),
    verifyNode("validate", "validate-current", "synthesis-new", validationResult(issues)),
    verifyNode("validate", "validate-old", "synthesis-old", validationResult(issues)),
  ]);
  assert.equal(
    previousValidationSignature(hostSamePlan, "validate-current", "synthesis-new"),
    fingerprint,
  );
});
