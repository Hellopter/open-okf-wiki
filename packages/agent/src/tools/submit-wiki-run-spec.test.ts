import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { PLAN_DRAFT_REL_PATH, planDraftPathFromRunWorkDir } from "../produce/living-spec.js";
import {
  createSubmitWikiRunSpecTool,
  SUBMIT_WIKI_RUN_SPEC_TOOL_NAME,
} from "./submit-wiki-run-spec.js";

const temps: string[] = [];
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

describe("submit_wiki_run_spec tool", () => {
  it("validates and writes analysis/plan-draft.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-submit-spec-"));
    temps.push(dir);
    const tool = createSubmitWikiRunSpecTool({ runWorkDir: dir });
    assert.equal(tool.name, SUBMIT_WIKI_RUN_SPEC_TOOL_NAME);

    const spec = defaultWikiRunSpec("Submit");
    const result = await tool.execute(
      "call-1",
      {
        version: 1,
        summary: spec.summary,
        audience: spec.audience,
        domains: spec.domains,
        pages: spec.pages,
        openQuestions: spec.openQuestions,
        acceptance: spec.acceptance,
        changelog: spec.changelog,
      },
      undefined,
      undefined,
      {} as never,
    );

    const first = result.content[0];
    assert.ok(first && first.type === "text");
    assert.match(first.text, /plan-draft\.json/);
    assert.equal(result.details?.specPath, PLAN_DRAFT_REL_PATH);
    assert.equal(result.details?.pageCount, 1);
    const raw = await readFile(planDraftPathFromRunWorkDir(dir), "utf8");
    assert.match(raw, /overview\.md/);
  });

  it("rejects incomplete Spec at the Run Boundary", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-submit-bad-"));
    temps.push(dir);
    const tool = createSubmitWikiRunSpecTool({ runWorkDir: dir });
    await assert.rejects(
      () =>
        tool.execute(
          "call-2",
          {
            summary: "",
            domains: [],
            pages: [],
          } as never,
          undefined,
          undefined,
          {} as never,
        ),
      /submit_wiki_run_spec rejected|required|Invalid|too_small|min/i,
    );
  });
});