import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { PLAN_DRAFT_REL_PATH, planDraftPathFromRunWorkDir } from "../ports/core-spec-store.js";
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

  it("rejects Specs over maxDomainFanOut before writing draft", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-submit-domain-cap-"));
    temps.push(dir);
    let wrote = false;
    const tool = createSubmitWikiRunSpecTool({
      runWorkDir: dir,
      caps: { maxDomainFanOut: 2, maxLeafFanOut: 6 },
      writeDraft: async () => {
        wrote = true;
        return path.join(dir, "analysis", "plan-draft.json");
      },
    });
    const domains = Array.from({ length: 3 }, (_, i) => ({
      id: `d${i}`,
      title: `D${i}`,
      scope: `scope ${i}`,
      critical: true,
      questions: ["q"],
    }));
    const pages = domains.map((d) => ({
      path: `${d.id}.md`,
      purpose: `cover ${d.id}`,
      domainIds: [d.id],
      critical: true,
    }));
    await assert.rejects(
      () =>
        tool.execute(
          "call-domain-cap",
          {
            version: 1,
            summary: "too many domains",
            domains,
            pages,
          },
          undefined,
          undefined,
          {} as never,
        ),
      /submit_wiki_run_spec rejected:.*maxDomainFanOut is 2/,
    );
    assert.equal(wrote, false);
  });

  it("rejects Specs over maxLeafFanOut before writing draft", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-submit-leaf-cap-"));
    temps.push(dir);
    let wrote = false;
    const tool = createSubmitWikiRunSpecTool({
      runWorkDir: dir,
      caps: { maxDomainFanOut: 4, maxLeafFanOut: 2 },
      writeDraft: async () => {
        wrote = true;
        return path.join(dir, "analysis", "plan-draft.json");
      },
    });
    await assert.rejects(
      () =>
        tool.execute(
          "call-leaf-cap",
          {
            version: 1,
            summary: "too many questions",
            domains: [
              {
                id: "core",
                title: "Core",
                scope: "s",
                critical: true,
                questions: ["a", "b", "c"],
              },
            ],
            pages: [
              {
                path: "overview.md",
                purpose: "overview",
                domainIds: ["core"],
                critical: true,
              },
            ],
          },
          undefined,
          undefined,
          {} as never,
        ),
      /submit_wiki_run_spec rejected:.*maxLeafFanOut is 2/,
    );
    assert.equal(wrote, false);
  });

  it("writes draft when Spec is within fan-out caps", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-submit-under-cap-"));
    temps.push(dir);
    const tool = createSubmitWikiRunSpecTool({
      runWorkDir: dir,
      caps: { maxDomainFanOut: 4, maxLeafFanOut: 6 },
    });
    const result = await tool.execute(
      "call-under-cap",
      {
        version: 1,
        summary: "within caps",
        domains: [
          {
            id: "core",
            title: "Core",
            scope: "main",
            critical: true,
            questions: ["q1", "q2"],
          },
        ],
        pages: [
          {
            path: "overview.md",
            purpose: "overview of core",
            domainIds: ["core"],
            critical: true,
          },
        ],
      },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(result.details?.domainCount, 1);
    assert.equal(result.details?.pageCount, 1);
    const raw = await readFile(planDraftPathFromRunWorkDir(dir), "utf8");
    assert.match(raw, /overview\.md/);
  });
});
