import assert from "node:assert/strict";
import test from "node:test";
import { mergeSeatFindings, parseSeatFinding } from "./review-reduce.js";

test("parseSeatFinding treats NO_DEFECTS as clean", () => {
  const f = parseSeatFinding("review.seat.grounding", "NO_DEFECTS");
  assert.equal(f.clean, true);
  assert.equal(f.defects.length, 0);
});

test("parseSeatFinding extracts blocking defects from JSON", () => {
  const f = parseSeatFinding(
    "review.seat.coverage",
    JSON.stringify({
      clean: false,
      defects: [
        {
          severity: "blocking",
          code: "missing_page",
          issue: "overview page missing citations",
        },
      ],
      summary: "blocking issues",
    }),
  );
  assert.equal(f.clean, false);
  assert.equal(f.defects.length, 1);
  assert.equal(f.defects[0]?.severity, "blocking");
});

test("mergeSeatFindings fail-closed on any blocking seat", () => {
  const merged = mergeSeatFindings([
    parseSeatFinding("review.seat.grounding", "NO_DEFECTS"),
    parseSeatFinding(
      "review.seat.coverage",
      JSON.stringify({
        clean: false,
        defects: [{ severity: "blocking", code: "x", issue: "broken claim" }],
      }),
    ),
  ]);
  assert.equal(merged.clean, false);
  assert.ok(merged.defects.some((d) => d.severity === "blocking"));
});

test("mergeSeatFindings is clean when all seats clean", () => {
  const merged = mergeSeatFindings([
    parseSeatFinding("review.seat.grounding", "NO_DEFECTS"),
    parseSeatFinding("review.seat.coverage", JSON.stringify({ clean: true, defects: [] })),
  ]);
  assert.equal(merged.clean, true);
  assert.equal(merged.defects.length, 0);
});
