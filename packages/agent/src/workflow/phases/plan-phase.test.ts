/**
 * planWikiSpec interface tests (Epic D.4): policy lives in the deep module.
 * Fixture AgentRunner + live-shaped runner that commits plan-draft.json.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { CoveragePlanSchema, sourceCoverageUnit } from "@okf-wiki/contract/coverage";
import { defaultWikiRunSpec } from "@okf-wiki/contract/wiki-runs";
import { resolveOrchestration } from "@okf-wiki/contract/workspace";
import { commitPlanDraft, PLAN_DRAFT_REL_PATH, readPlanDraft } from "../../plan/commit-plan-draft.js";
import {
  type AgentRunRequest,
  createFixtureProduceRuntime,
} from "../../runtime/fixture-runner.js";
import { runWorkdirLayout } from "../../runtime/workdir.js";
import {
  inventoryFromWorkspace,
  planUncertaintyForPriorSpec,
  planWikiSpec,
  resolvePlanInventoryAndAdaptive,
  resolvePlanSpecFromAgentResult,
} from "./plan-phase.js";

const temps: string[] = [];
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

async function makeLayout(root: string, sourceIds: string[] = ["main"]) {
  const runWorkDir = path.join(root, "run");
  const mounts = new Map<string, string>();
  for (const id of sourceIds) {
    const source = path.join(runWorkDir, "sources", id);
    await mkdir(source, { recursive: true });
    await mkdir(path.join(source, "src"), { recursive: true });
    mounts.set(id, source);
  }
  await mkdir(path.join(runWorkDir, "analysis"), { recursive: true });
  return runWorkdirLayout(runWorkDir, mounts);
}

describe("inventoryFromWorkspace", () => {
  it("does not infer multiEntry from multi-source alone", () => {
    const inv = inventoryFromWorkspace({ sourceCount: 3 });
    assert.equal(inv.sourceCount, 3);
    assert.equal(inv.multiEntry, false);
    assert.equal(inv.large, false);
  });
});

describe("planUncertaintyForPriorSpec", () => {
  it("returns 0 without a prior Spec", () => {
    assert.equal(planUncertaintyForPriorSpec(undefined), 0);
  });

  it("rises with open questions", () => {
    const base = defaultWikiRunSpec("U");
    const low = planUncertaintyForPriorSpec(base);
    const high = planUncertaintyForPriorSpec({
      ...base,
      openQuestions: Array.from({ length: 8 }, (_, i) => `q${i}`),
      domains: Array.from({ length: 4 }, (_, i) => ({
        id: `d${i}`,
        title: `D${i}`,
        scope: "scope",
        critical: true,
        questions: [`q for d${i}`],
      })),
    });
    assert.ok(high >= low);
  });
});

describe("planWikiSpec fixture path", () => {
  it("commits default Spec via commitPlanDraft and skips scouts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-plan-fix-"));
    temps.push(root);
    const layout = await makeLayout(root);
    const result = await planWikiSpec({
      layout,
      workspaceName: "Fixture Wiki",
      runtime: createFixtureProduceRuntime(),
    });
    assert.equal(result.mode, "fixture");
    assert.equal(result.source, "fixture");
    assert.equal(result.scoutKinds?.length, 0);
    assert.match(result.spec.summary, /Fixture Wiki/);
    const draft = await readPlanDraft(layout.runWorkDir);
    assert.equal(draft?.summary, result.spec.summary);
    assert.ok(result.draftPath?.endsWith(PLAN_DRAFT_REL_PATH.replace("analysis/", "")));
  });
});

describe("resolvePlanInventoryAndAdaptive", () => {
  it("fail-closes when workspace sources exceed maxSourcesPerRun", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-plan-maxsrc-"));
    temps.push(root);
    const layout = await makeLayout(root, ["a", "b"]);
    await assert.rejects(
      () =>
        resolvePlanInventoryAndAdaptive({
          layout,
          workspaceSourceCount: 4,
          orchestration: resolveOrchestration({ maxSourcesPerRun: 2 }),
        }),
      /maxSourcesPerRun=2/,
    );
  });

  it("raises hybrid mode for multi-source inventory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-plan-adaptive-"));
    temps.push(root);
    const layout = await makeLayout(root, ["api", "web"]);
    const { adaptive, inventory } = await resolvePlanInventoryAndAdaptive({
      layout,
      workspaceSourceCount: 2,
      orchestration: resolveOrchestration({ planScoutMode: "auto", planScoutCount: 0 }),
    });
    assert.ok(inventory.sourceCount >= 2);
    assert.equal(adaptive.orchestration.planScoutMode, "hybrid");
    assert.ok(adaptive.reasons.some((r) => r.includes("multi-source")));
  });
});

describe("planWikiSpec live path (scripted AgentRunner)", () => {
  it("runs scouts then synthesizer; resolve path-first draft", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-plan-live-"));
    temps.push(root);
    const layout = await makeLayout(root);
    const roles: string[] = [];
    let toolCaps: { maxDomainFanOut?: number; maxLeafFanOut?: number } | undefined;

    const base = createFixtureProduceRuntime({
      onAgent: async (req: AgentRunRequest) => {
        roles.push(req.role);
        if (req.role === "plan") {
          const spec = defaultWikiRunSpec("Live Plan");
          await commitPlanDraft(layout.runWorkDir, spec);
          return {
            role: "plan",
            mode: "fixture",
            summary: "Plan submitted → analysis/plan-draft.json",
            items: [{ type: "text", text: "submitted" }],
          };
        }
        return {
          role: req.role,
          mode: "fixture",
          summary: `scout ${req.spanId}`,
        };
      },
    });
    const runtime = { ...base, kind: "live" as const };

    const result = await planWikiSpec({
      layout,
      workspaceName: "Live Plan",
      runtime,
      model: { id: "test-model", contextWindow: 32_000 },
      orchestration: resolveOrchestration({
        planScoutCount: 2,
        planScoutMode: "thematic",
        planScoutConcurrency: 2,
        planRescoutMaxRounds: 0,
      }),
      workspaceSourceCount: 1,
      createCustomTools: ({ orchestration, coveragePlan }) => {
        toolCaps = {
          maxDomainFanOut: orchestration.maxDomainFanOut,
          maxLeafFanOut: orchestration.maxLeafFanOut,
        };
        assert.ok(coveragePlan);
        return [{ name: "submit_wiki_run_spec" }];
      },
    });

    assert.equal(result.mode, "live");
    assert.equal(result.source, "draft");
    assert.match(result.spec.summary, /Live Plan/);
    assert.ok(roles.includes("plan"));
    assert.ok(roles.includes("root_research"), "thematic scouts should run");
    assert.equal(toolCaps?.maxDomainFanOut, result.orchestration?.maxDomainFanOut);
    assert.ok(Array.isArray(result.adaptiveReasons));
    assert.ok((result.scoutKinds?.length ?? 0) >= 1);

    const resolved = await resolvePlanSpecFromAgentResult({
      runWorkDir: layout.runWorkDir,
    });
    assert.equal(resolved.source, "draft");
  });

  it("fail-closes when synthesizer omits submit (no draft)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-plan-nodraft-live-"));
    temps.push(root);
    const layout = await makeLayout(root);
    const base = createFixtureProduceRuntime({
      onAgent: async (req: AgentRunRequest) => ({
        role: req.role,
        mode: "fixture",
        summary: req.role === "plan" ? "I forgot the tool" : "scout ok",
      }),
    });
    const runtime = { ...base, kind: "live" as const };

    await assert.rejects(
      () =>
        planWikiSpec({
          layout,
          workspaceName: "No Draft",
          runtime,
          model: { id: "m" },
          orchestration: resolveOrchestration({
            planScoutCount: 0,
            planScoutMode: "thematic",
            planRescoutMaxRounds: 0,
          }),
        }),
      /submit_wiki_run_spec|plan-draft\.json/,
    );
  });

  it("injects revision feedback and prior Spec into synthesizer task", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-plan-revise-"));
    temps.push(root);
    const layout = await makeLayout(root);
    let planTask = "";
    const prior = defaultWikiRunSpec("Prior");
    const base = createFixtureProduceRuntime({
      onAgent: async (req: AgentRunRequest) => {
        if (req.role === "plan") {
          planTask = req.task;
          await commitPlanDraft(layout.runWorkDir, {
            ...prior,
            summary: "Revised wiki for Prior",
            changelog: [...(prior.changelog ?? []), "revised for feedback"],
          });
          return {
            role: "plan",
            mode: "fixture",
            summary: "revised",
          };
        }
        return { role: req.role, mode: "fixture", summary: "scout" };
      },
    });
    const runtime = { ...base, kind: "live" as const };

    const result = await planWikiSpec({
      layout,
      workspaceName: "Prior",
      runtime,
      model: { id: "m" },
      priorSpec: prior,
      revisionFeedback: "Narrow to runtime only.",
      orchestration: resolveOrchestration({ planScoutCount: 0, planRescoutMaxRounds: 0 }),
    });

    assert.match(planTask, /Operator feedback: Narrow to runtime only/);
    assert.match(planTask, /Prior Spec/);
    assert.match(result.spec.summary, /Revised/);
  });

  it("rescouts when coverage gaps remain and budget allows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-plan-rescout-"));
    temps.push(root);
    const layout = await makeLayout(root, ["api", "web"]);
    let planRounds = 0;
    const plan = CoveragePlanSchema.parse({
      requiredUnits: [sourceCoverageUnit("api"), sourceCoverageUnit("web")],
    });
    const base = createFixtureProduceRuntime({
      onAgent: async (req: AgentRunRequest) => {
        if (req.role === "plan") {
          planRounds += 1;
          // Round 0: bind only api → gap on web. Round 1+: bind both.
          const units = planRounds === 1 ? ["api"] : ["api", "web"];
          const base = defaultWikiRunSpec("Multi");
          const domainId = base.domains[0]!.id;
          const spec = {
            ...base,
            pages: [
              {
                path: "overview.md",
                purpose: "cover sources",
                critical: true as const,
                domainIds: [domainId],
                coverageUnitIds: units,
                sourceIds: units,
              },
            ],
            sourceCoverage: units.map((sourceId) => ({
              sourceId,
              pagePaths: ["overview.md"],
            })),
          };
          await commitPlanDraft(layout.runWorkDir, spec);
          return {
            role: "plan",
            mode: "fixture",
            summary: `plan round ${planRounds}`,
          };
        }
        return { role: req.role, mode: "fixture", summary: `scout ${req.spanId}` };
      },
    });
    const runtime = { ...base, kind: "live" as const };

    const result = await planWikiSpec({
      layout,
      workspaceName: "Multi",
      runtime,
      model: { id: "m" },
      coveragePlan: plan,
      orchestration: resolveOrchestration({
        planScoutCount: 0,
        planScoutMode: "source",
        planSurveyTaskBudget: 2,
        planRescoutMaxRounds: 1,
        maxSourcesPerRun: 8,
      }),
      workspaceSourceCount: 2,
    });

    assert.equal(result.rescoutRounds, 1);
    assert.equal(planRounds, 2);
    assert.ok(result.coverage?.ok !== false || result.spec.pages[0]?.coverageUnitIds?.includes("web"));
  });
});

describe("resolvePlanSpecFromAgentResult", () => {
  it("reads only on-disk plan-draft", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-plan-resolve-"));
    temps.push(dir);
    await mkdir(path.join(dir, "analysis"), { recursive: true });
    const expected = defaultWikiRunSpec("Disk");
    await commitPlanDraft(dir, expected);
    const resolved = await resolvePlanSpecFromAgentResult({
      runWorkDir: dir,
      summary: "ignored full text",
    });
    assert.equal(resolved.spec.summary, expected.summary);
    const raw = await readFile(path.join(dir, PLAN_DRAFT_REL_PATH), "utf8");
    assert.match(raw, /overview\.md/);
  });
});
