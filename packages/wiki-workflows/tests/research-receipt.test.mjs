import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RESEARCH_RECEIPT_BYTES, projectResearchReceipt } from "../dist/research-receipt.js";

const ref = {
  version: 1, runId: "run-1", nodeId: "research-1", attempt: 1, kind: "research",
  relativePath: ".okf-wiki/blobs/a.json", sha256: "a".repeat(64), sizeBytes: 1,
  mediaType: "application/json",
};
const run = { inspection: { sourceFingerprint: "source-1" } };
const scope = { id: "scope-1", task: "Survey", sourcePaths: ["src"] };

test("research receipts enforce a total UTF-8 byte boundary without truncating routing state", () => {
  const receipt = projectResearchReceipt(run, {
    summary: "ok",
    findings: [{
      kind: "domain", title: "Core", readerQuestion: "How?", priority: "normal", evidence: ["src/a.ts#L1"],
    }],
    gaps: [],
  }, ref, scope);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt), "utf8") < MAX_RESEARCH_RECEIPT_BYTES);

  assert.throws(() => projectResearchReceipt(run, {
    summary: "too large",
    findings: [],
    gaps: [{ question: "x".repeat(MAX_RESEARCH_RECEIPT_BYTES), priority: "critical", sourcePaths: ["src"] }],
  }, ref, scope), /Research receipt exceeds 65536 UTF-8 bytes/);
});
