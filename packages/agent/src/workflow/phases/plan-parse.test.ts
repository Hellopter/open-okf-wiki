import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract/wiki-runs";
import {
  clearPlanDraft,
  commitPlanDraft,
  planDraftPathFromRunWorkDir,
  readPlanDraft,
} from "../../plan/commit-plan-draft.js";
import { resolvePlanSpecFromAgentResult } from "./plan-phase.js";

const temps: string[] = [];
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

function largeSpec(name: string) {
  const base = defaultWikiRunSpec(name);
  return {
    ...base,
    summary: `Source-grounded wiki for ${name} — ${"detail ".repeat(40)}`.slice(0, 500),
    domains: Array.from({ length: 6 }, (_, i) => ({
      id: `d${i}`,
      title: `Domain ${i}`,
      scope: `scope area ${i} ${"x".repeat(80)}`,
      critical: true,
      questions: Array.from({ length: 4 }, (_, q) => `Question ${q} for domain ${i}`),
    })),
    pages: Array.from({ length: 10 }, (_, i) => ({
      path: i === 0 ? "overview.md" : `page-${i}.md`,
      purpose: `purpose ${i} ${"y".repeat(40)}`,
      domainIds: [`d${i % 6}`],
      questions: ["What is covered?", "Where is the entry point?"],
      template: i === 0 ? ("overview" as const) : ("module" as const),
      critical: i === 0,
    })),
    openQuestions: ["o1", "o2", "o3"],
    acceptance: {
      reviewRequired: true,
      maxRepairRounds: 2,
      blockingSeverities: ["blocking" as const],
    },
    changelog: ["planned"],
  };
}

test("resolvePlanSpecFromAgentResult reads only on-disk plan-draft (not summary text)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "okf-plan-draft-"));
  temps.push(dir);
  const expected = defaultWikiRunSpec("FromDisk");
  await commitPlanDraft(dir, expected);
  const resolved = await resolvePlanSpecFromAgentResult({
    runWorkDir: dir,
    summary: "Plan submitted → analysis/plan-draft.json",
  });
  assert.equal(resolved.source, "draft");
  assert.equal(resolved.spec.summary, expected.summary);
  assert.equal(resolved.draftPath, planDraftPathFromRunWorkDir(dir));
});

test("resolvePlanSpecFromAgentResult fails closed when draft is missing (no text spill)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "okf-plan-nodraft-"));
  temps.push(dir);
  const expected = largeSpec("NoSpill");
  const text = JSON.stringify(expected);
  assert.ok(text.length > 4000);
  await assert.rejects(
    () =>
      resolvePlanSpecFromAgentResult({
        runWorkDir: dir,
        summary: text,
      }),
    /submit_wiki_run_spec|plan-draft\.json/,
  );
});

test("clearPlanDraft removes a stale draft so a failed replan cannot re-resolve it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "okf-plan-stale-"));
  temps.push(dir);
  await commitPlanDraft(dir, defaultWikiRunSpec("Round1"));
  assert.ok(await readPlanDraft(dir), "draft exists after round 1");

  // Round 2 starts: the previous round's draft must not survive into resolve.
  await clearPlanDraft(dir);
  assert.equal(await readPlanDraft(dir), null);
  await assert.rejects(
    () => resolvePlanSpecFromAgentResult({ runWorkDir: dir, summary: "revise failed" }),
    /submit_wiki_run_spec|plan-draft\.json/,
  );

  // Clearing a non-existent draft is a no-op.
  await clearPlanDraft(dir);
});
