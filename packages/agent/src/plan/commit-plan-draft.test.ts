import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { CoveragePlanSchema, sourceCoverageUnit } from "@okf-wiki/contract/coverage";
import { defaultWikiRunSpec } from "@okf-wiki/contract/wiki-runs";
import {
  clearPlanDraft,
  commitPlanDraft,
  PLAN_DRAFT_REL_PATH,
  planDraftPathFromRunWorkDir,
  readPlanDraft,
} from "./commit-plan-draft.js";

const temps: string[] = [];
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

describe("commitPlanDraft", () => {
  it("validates Zod and atomically writes analysis/plan-draft.json", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-commit-plan-"));
    temps.push(root);
    const spec = defaultWikiRunSpec("Draft");
    const result = await commitPlanDraft(root, spec);
    assert.equal(result.absolutePath, planDraftPathFromRunWorkDir(root));
    assert.equal(result.specPath, PLAN_DRAFT_REL_PATH);
    assert.equal(result.pageCount, 1);
    assert.equal(result.spec.summary, spec.summary);
    const loaded = await readPlanDraft(root);
    assert.equal(loaded?.summary, spec.summary);
    const raw = await readFile(result.absolutePath, "utf8");
    assert.match(raw, /overview\.md/);
  });

  it("rejects invalid Spec before writing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-commit-plan-bad-"));
    temps.push(root);
    await assert.rejects(
      () => commitPlanDraft(root, { summary: "", domains: [], pages: [] }),
      /commitPlanDraft rejected/,
    );
    assert.equal(await readPlanDraft(root), null);
  });

  it("enforces fan-out caps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-commit-plan-cap-"));
    temps.push(root);
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
        commitPlanDraft(
          root,
          {
            version: 1,
            summary: "too many domains",
            domains,
            pages,
          },
          { caps: { maxDomainFanOut: 2, maxLeafFanOut: 6 } },
        ),
      /commitPlanDraft rejected:.*maxDomainFanOut is 2/,
    );
    assert.equal(await readPlanDraft(root), null);
  });

  it("enforces assertCoverage when plan has required units", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-commit-plan-cov-"));
    temps.push(root);
    const plan = CoveragePlanSchema.parse({
      requiredUnits: [sourceCoverageUnit("frontend"), sourceCoverageUnit("backend")],
    });
    await assert.rejects(
      () =>
        commitPlanDraft(
          root,
          {
            version: 1,
            summary: "only covers frontend",
            domains: [],
            pages: [
              {
                path: "overview.md",
                purpose: "frontend only",
                critical: true,
                sourceIds: ["frontend"],
              },
            ],
          },
          { coveragePlan: plan },
        ),
      /coverage gap|backend/,
    );
    assert.equal(await readPlanDraft(root), null);
  });

  it("clearPlanDraft removes a stale draft", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-commit-plan-clear-"));
    temps.push(root);
    await commitPlanDraft(root, defaultWikiRunSpec("Round1"));
    assert.ok(await readPlanDraft(root));
    await clearPlanDraft(root);
    assert.equal(await readPlanDraft(root), null);
    // Clearing a non-existent draft is a no-op.
    await clearPlanDraft(root);
  });
});
