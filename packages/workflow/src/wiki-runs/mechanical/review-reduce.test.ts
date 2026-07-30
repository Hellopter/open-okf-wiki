import assert from "node:assert/strict";
import test from "node:test";
import {
  hasGateBlockingDefects,
  mergeSeatFindings,
  parseSeatDefectReport,
  parseSeatFinding,
} from "./review-reduce.js";

test("parseSeatDefectReport accepts valid DefectReport JSON", () => {
  const result = parseSeatDefectReport(
    "review.seat.coverage",
    JSON.stringify({
      version: 1,
      reviewerId: "coverage",
      clean: false,
      defects: [
        {
          severity: "blocking",
          code: "missing_page",
          issue: "overview page missing citations",
          reviewerId: "coverage",
        },
      ],
      summary: "blocking issues",
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.finding.clean, false);
  assert.equal(result.finding.defects.length, 1);
  assert.equal(result.finding.defects[0]?.severity, "blocking");
});

test("parseSeatDefectReport rejects empty artifact (never clean)", () => {
  const result = parseSeatDefectReport("review.seat.grounding", "");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /empty|never treated as clean/i);
});

test("parseSeatDefectReport rejects NO_DEFECTS keyword alone", () => {
  const result = parseSeatDefectReport("review.seat.grounding", "NO_DEFECTS");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /not valid JSON|DefectReport/i);
});

test("parseSeatDefectReport rejects unstructured text", () => {
  const result = parseSeatDefectReport("review.seat.general", "looks fine to me");
  assert.equal(result.ok, false);
});

test("parseSeatDefectReport rejects clean with defects", () => {
  const result = parseSeatDefectReport(
    "review.seat.grounding",
    JSON.stringify({
      reviewerId: "grounding",
      clean: true,
      defects: [{ severity: "major", code: "x", issue: "noise" }],
    }),
  );
  assert.equal(result.ok, false);
});

test("parseSeatFinding throws on malformed (fail-closed)", () => {
  assert.throws(
    () => parseSeatFinding("review.seat.grounding", "NO_DEFECTS"),
    /DefectReport|JSON/i,
  );
});

test("mergeSeatFindings fail-closed on any blocking seat", () => {
  const clean = parseSeatFinding(
    "review.seat.grounding",
    JSON.stringify({
      version: 1,
      reviewerId: "grounding",
      clean: true,
      defects: [],
      summary: "NO_DEFECTS",
    }),
  );
  const dirty = parseSeatFinding(
    "review.seat.coverage",
    JSON.stringify({
      version: 1,
      reviewerId: "coverage",
      clean: false,
      defects: [
        {
          severity: "blocking",
          code: "x",
          issue: "broken claim",
          reviewerId: "coverage",
        },
      ],
    }),
  );
  const merged = mergeSeatFindings([clean, dirty]);
  assert.equal(merged.clean, false);
  assert.ok(merged.defects.some((d) => d.severity === "blocking"));
  assert.ok(hasGateBlockingDefects(merged, ["blocking"]));
});

test("mergeSeatFindings is clean when all seats clean", () => {
  const merged = mergeSeatFindings([
    parseSeatFinding(
      "review.seat.grounding",
      JSON.stringify({ version: 1, reviewerId: "grounding", clean: true, defects: [] }),
    ),
    parseSeatFinding(
      "review.seat.coverage",
      JSON.stringify({ version: 1, reviewerId: "coverage", clean: true, defects: [] }),
    ),
  ]);
  assert.equal(merged.clean, true);
  assert.equal(merged.defects.length, 0);
});

test("hasGateBlockingDefects respects blockingSeverities major", () => {
  const merged = mergeSeatFindings([
    parseSeatFinding(
      "review.seat.grounding",
      JSON.stringify({
        version: 1,
        reviewerId: "grounding",
        clean: false,
        defects: [
          {
            severity: "major",
            code: "weak_grounding",
            issue: "weak citation",
            reviewerId: "grounding",
          },
        ],
      }),
    ),
  ]);
  assert.equal(hasGateBlockingDefects(merged, ["blocking"]), false);
  assert.equal(hasGateBlockingDefects(merged, ["blocking", "major"]), true);
});
