/**
 * Unit tests for RepairRequest construction and page extraction (ADR 0038).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PiAttemptNodeDetailSchema } from "@okf-wiki/contract/pi-attempt";
import { MechanicalReportSchema, RepairRequestSchema } from "@okf-wiki/contract/wiki-runs";
import {
  buildMechanicalRepairRequest,
  buildSemanticRepairRequest,
  isRepairNodeKey,
  REPAIR_NODE_PREFIX,
  repairNodeKey,
} from "./repair-schedule.js";

test("repairNodeKey / isRepairNodeKey product keys", () => {
  assert.equal(REPAIR_NODE_PREFIX, "repair.");
  assert.equal(repairNodeKey(1), "repair.1");
  assert.equal(repairNodeKey(12), "repair.12");
  assert.equal(isRepairNodeKey("repair.1"), true);
  assert.equal(isRepairNodeKey("repair.hv.1"), false);
  assert.equal(isRepairNodeKey("repair.review.1"), false);
  assert.equal(isRepairNodeKey("write.root"), false);
});

test("buildMechanicalRepairRequest extracts pages from validation message", () => {
  const req = buildMechanicalRepairRequest({
    runId: "run-1",
    round: 1,
    validationMessage:
      "validation failed: overview.md: missing Source Citation; architecture.md: missing YAML frontmatter with non-empty type; overview.md: again",
  });
  const parsed = RepairRequestSchema.parse(req);
  assert.equal(parsed.requestId, "repair:mechanical:run-1:1");
  assert.equal(parsed.round, 1);
  assert.deepEqual(parsed.sources, ["mechanical"]);
  assert.equal(parsed.scope.mode, "patch");
  assert.deepEqual(parsed.scope.pages, ["overview.md", "architecture.md"]);
  assert.equal(parsed.baselineCandidateId, "pending");
  assert.equal(parsed.issues.length, 1);
  assert.equal(parsed.issues[0]!.kind, "mechanical");
});

test("buildMechanicalRepairRequest does not cap fallback mechanical pages", () => {
  const segments = Array.from({ length: 12 }, (_, i) => `page${i}.md: err ${i}`);
  const req = buildMechanicalRepairRequest({
    runId: "run-x",
    round: 2,
    validationMessage: `validation failed: ${segments.join("; ")}`,
    baselineCandidateId: "cand-write-1",
  });
  assert.equal(req.scope.pages.length, 12);
  assert.equal(req.scope.pages[0], "page0.md");
  assert.equal(req.scope.pages[11], "page11.md");
  assert.equal(req.baselineCandidateId, "cand-write-1");
});

test("buildMechanicalRepairRequest preserves every issue and path from a sealed report", () => {
  const issues = Array.from({ length: 12 }, (_, i) => ({
    code: "missing_frontmatter" as const,
    message: `page${i}.md: missing YAML frontmatter`,
    raw: `page${i}.md: missing YAML frontmatter`,
    path: `page${i}.md`,
    autoFixable: false,
  }));
  const report = MechanicalReportSchema.parse({
    ok: false,
    issues,
    warnings: [],
    errors: issues.map((issue) => issue.raw),
  });
  const request = buildMechanicalRepairRequest({
    runId: "run-full-report",
    round: 1,
    validationMessage: "validation failed: 12 issue(s); see sealed validate_report",
    baselineCandidateId: "candidate-write-1",
    mechanicalReport: report,
    mechanicalReportArtifactId: "artifact-validate-report",
  });

  assert.equal(request.issues.length, 12);
  assert.deepEqual(
    request.scope.pages,
    issues.map((issue) => issue.path),
  );
  assert.equal(request.mechanicalReportArtifactId, "artifact-validate-report");
});

test("buildMechanicalRepairRequest allows empty pages when no path prefixes", () => {
  const req = buildMechanicalRepairRequest({
    runId: "run-2",
    round: 1,
    validationMessage: "validation failed: critical page missing: architecture.md",
  });
  assert.deepEqual(req.scope.pages, []);
  assert.equal(req.sources[0], "mechanical");
});

test("buildSemanticRepairRequest defaults to semantic source and empty pages", () => {
  const req = buildSemanticRepairRequest({
    runId: "run-3",
    round: 1,
    feedback: "Fix nav defects",
  });
  assert.deepEqual(req.sources, ["semantic"]);
  assert.deepEqual(req.scope.pages, []);
  assert.equal(req.scope.mode, "patch");
  assert.equal(req.issues[0]!.kind, "semantic");
  assert.match(String((req.issues[0] as { message?: string }).message), /Fix nav defects/);
});

test("PiAttemptNodeDetailSchema accepts repairRequest passthrough", () => {
  const repairRequest = buildMechanicalRepairRequest({
    runId: "run-detail",
    round: 1,
    validationMessage: "overview.md: citation line range out of bounds (x)",
  });
  const detail = PiAttemptNodeDetailSchema.parse({
    feedback: "Mechanical repair (round 1/1):\noverview.md: citation line range out of bounds (x)",
    repairRequest,
  });
  assert.ok(detail.repairRequest);
  assert.equal(detail.repairRequest.requestId, "repair:mechanical:run-detail:1");
  assert.deepEqual(detail.repairRequest.scope.pages, ["overview.md"]);
});
