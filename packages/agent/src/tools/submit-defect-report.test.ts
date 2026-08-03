import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  createSubmitDefectReportTool,
  DEFECT_REPORT_REL_PATH,
  defectReportPathFromRunWorkDir,
  readDefectReport,
  SUBMIT_DEFECT_REPORT_TOOL_NAME,
} from "./submit-defect-report.js";

const temps: string[] = [];
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

describe("submit_defect_report tool", () => {
  it("validates and writes analysis/defect-report.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-submit-defect-"));
    temps.push(dir);
    const tool = createSubmitDefectReportTool({ runWorkDir: dir, reviewerId: "grounding" });
    assert.equal(tool.name, SUBMIT_DEFECT_REPORT_TOOL_NAME);

    const result = await tool.execute(
      "call-1",
      {
        version: 1,
        reviewerId: "grounding",
        clean: false,
        defects: [
          {
            severity: "blocking",
            code: "missing_citation",
            path: "overview.md",
            issue: "overview lacks grounding citations",
          },
        ],
        summary: "blocking citation gap",
      },
      undefined,
      undefined,
      {} as never,
    );

    const first = result.content[0];
    assert.ok(first && first.type === "text");
    assert.match(first.text, /defect-report\.json/);
    assert.equal(result.details?.reportPath, DEFECT_REPORT_REL_PATH);
    assert.equal(result.details?.defectCount, 1);
    assert.equal(result.details?.clean, false);
    const raw = await readFile(defectReportPathFromRunWorkDir(dir), "utf8");
    assert.match(raw, /missing_citation/);
    const draft = await readDefectReport(dir);
    assert.equal(draft?.clean, false);
    assert.equal(draft?.defects[0]?.reviewerId, "grounding");
  });

  it("rejects clean with non-empty defects", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-submit-defect-bad-"));
    temps.push(dir);
    const tool = createSubmitDefectReportTool({ runWorkDir: dir, reviewerId: "coverage" });
    await assert.rejects(
      () =>
        tool.execute(
          "call-2",
          {
            reviewerId: "coverage",
            clean: true,
            defects: [{ severity: "major", code: "x", issue: "should not mix" }],
          } as never,
          undefined,
          undefined,
          {} as never,
        ),
      /submit_defect_report rejected|clean/i,
    );
  });

  it("stamps reviewerId from seat when omitted on defects", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-submit-defect-stamp-"));
    temps.push(dir);
    const tool = createSubmitDefectReportTool({ runWorkDir: dir, reviewerId: "consistency" });
    await tool.execute(
      "call-3",
      {
        reviewerId: "consistency",
        clean: true,
        defects: [],
        summary: "NO_DEFECTS",
      },
      undefined,
      undefined,
      {} as never,
    );
    const draft = await readDefectReport(dir);
    assert.equal(draft?.reviewerId, "consistency");
    assert.equal(draft?.clean, true);
  });
});
