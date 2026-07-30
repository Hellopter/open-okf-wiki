import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { writeDefectReportDraft } from "../../../tools/submit-defect-report.js";
import { resolveReviewSeatIndex } from "../shared.js";
import { resolveSeatDefectReport } from "./review.js";

const temps: string[] = [];
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

function fakeInput(key: string, detail?: Record<string, unknown>) {
  return {
    node: {
      key,
      kind: "review.seat" as const,
      generation: 0,
      runIndex: 1,
      ...(detail ? { detail } : {}),
    },
  } as Parameters<typeof resolveReviewSeatIndex>[0];
}

describe("review seat fail-closed", () => {
  it("resolveReviewSeatIndex requires sealed seatIndex", () => {
    assert.equal(resolveReviewSeatIndex(fakeInput("review.seat.grounding", { seatIndex: 2 })), 2);
    assert.throws(
      () => resolveReviewSeatIndex(fakeInput("review.seat.coverage")),
      /review\.seat\/review\.seat\.coverage requires sealed node detail/,
    );
    assert.throws(
      () => resolveReviewSeatIndex(fakeInput("review.seat.consistency", { lens: "consistency" })),
      /requires detail\.seatIndex/,
    );
  });

  it("resolveSeatDefectReport prefers tool draft", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-seat-tool-"));
    temps.push(dir);
    await mkdir(path.join(dir, "analysis"), { recursive: true });
    await writeDefectReportDraft(dir, {
      version: 1,
      reviewerId: "grounding",
      clean: true,
      defects: [],
      summary: "NO_DEFECTS",
    });
    const result = await resolveSeatDefectReport({
      workDir: dir,
      reviewerId: "grounding",
      summaryText: "ignore me",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.source, "tool");
    assert.equal(result.report.clean, true);
  });

  it("resolveSeatDefectReport parses free-text JSON once", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-seat-text-"));
    temps.push(dir);
    const result = await resolveSeatDefectReport({
      workDir: dir,
      reviewerId: "coverage",
      summaryText: JSON.stringify({
        clean: false,
        defects: [
          {
            severity: "blocking",
            code: "gap",
            issue: "missing page",
          },
        ],
        summary: "gap",
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.source, "free_text");
    assert.equal(result.report.reviewerId, "coverage");
    assert.equal(result.report.defects[0]?.reviewerId, "coverage");
  });

  it("resolveSeatDefectReport fails closed on malformed free text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-seat-bad-"));
    temps.push(dir);
    const result = await resolveSeatDefectReport({
      workDir: dir,
      reviewerId: "general",
      summaryText: "NO_DEFECTS looks fine",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /missing validated DefectReport|never treated as clean/i);
  });

  it("resolveSeatDefectReport fails on empty summary without draft", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-seat-empty-"));
    temps.push(dir);
    await writeFile(path.join(dir, "noise.txt"), "x", "utf8");
    const result = await resolveSeatDefectReport({
      workDir: dir,
      reviewerId: "general",
      summaryText: "",
    });
    assert.equal(result.ok, false);
  });
});
