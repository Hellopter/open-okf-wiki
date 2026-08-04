import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { CoveragePlanSchema, sourceCoverageUnit, surfaceCoverageUnit } from "@okf-wiki/contract/coverage";
import { resolveOrchestration, type WorkspaceOrchestration } from "@okf-wiki/contract/workspace";
import { type AgentRunRequest, createFixtureProduceRuntime } from "../../runtime/fixture-runner.js";
import { runWorkdirLayout } from "../../runtime/workdir.js";
import {
  formatScoutPlannerContext,
  formatScoutPlannerContextFromJson,
  runPlanScouts,
  selectPlanScoutTasks,
} from "./plan-scouts.js";

const temps: string[] = [];

after(async () => {
  for (const t of temps) {
    await rm(t, { recursive: true, force: true });
  }
});

async function makeLayout(root: string, sourceIds: string[] = ["main"]) {
  const runWorkDir = path.join(root, "run");
  const mounts = new Map<string, string>();
  for (const id of sourceIds) {
    const source = path.join(runWorkDir, "sources", id);
    await mkdir(source, { recursive: true });
    mounts.set(id, source);
  }
  await mkdir(path.join(runWorkDir, "analysis"), { recursive: true });
  return runWorkdirLayout(runWorkDir, mounts);
}

const orch = (partial: Partial<WorkspaceOrchestration> = {}): WorkspaceOrchestration =>
  resolveOrchestration({
    maxDomainFanOut: 4,
    maxLeafFanOut: 6,
    reviewCouncilSize: 3,
    planScoutCount: 2,
    domainConcurrency: 2,
    leafConcurrency: 2,
    maxActiveRuns: 2,
    maxConcurrentAttempts: 4,
    ...partial,
  });

describe("selectPlanScoutTasks", () => {
  it("selects thematic kinds by planScoutCount in thematic mode", () => {
    const tasks = selectPlanScoutTasks({
      orch: orch({ planScoutCount: 2, planScoutMode: "thematic" }),
    });
    assert.deepEqual(
      tasks.map((t) => (t.kind === "thematic" ? t.thematic : t.id)),
      ["entry", "layout"],
    );
    assert.ok(tasks.every((t) => t.required === false));
  });

  it("schedules per-source surveys under planSurveyTaskBudget (not thematic cap alone)", () => {
    const plan = CoveragePlanSchema.parse({
      requiredUnits: [sourceCoverageUnit("api"), sourceCoverageUnit("web")],
    });
    const tasks = selectPlanScoutTasks({
      orch: orch({
        planScoutCount: 1,
        planScoutMode: "hybrid",
        planSurveyTaskBudget: 2,
      }),
      coveragePlan: plan,
      coverageInventory: {
        version: 1,
        sources: [
          { sourceId: "api", surfaces: [] },
          { sourceId: "web", surfaces: [] },
        ],
      },
    });
    const sources = tasks.filter((t) => t.kind === "source");
    const thematic = tasks.filter((t) => t.kind === "thematic");
    assert.equal(sources.length, 2);
    assert.ok(sources.every((t) => t.required));
    assert.equal(thematic.length, 1);
    assert.equal(thematic[0]!.kind === "thematic" && thematic[0]!.thematic, "entry");
  });

  it("fail-closes when source surveys exceed planSurveyTaskBudget", () => {
    const plan = CoveragePlanSchema.parse({
      requiredUnits: [
        sourceCoverageUnit("a"),
        sourceCoverageUnit("b"),
        sourceCoverageUnit("c"),
      ],
    });
    assert.throws(
      () =>
        selectPlanScoutTasks({
          orch: orch({
            planScoutMode: "source",
            planScoutCount: 0,
            planSurveyTaskBudget: 2,
          }),
          coveragePlan: plan,
        }),
      /planSurveyTaskBudget/,
    );
  });

  it("schedules required surface surveys for large single-repo plan", () => {
    const plan = CoveragePlanSchema.parse({
      requiredUnits: [
        surfaceCoverageUnit("mono", "packages/core"),
        surfaceCoverageUnit("mono", "packages/web"),
      ],
    });
    const tasks = selectPlanScoutTasks({
      orch: orch({
        planScoutCount: 1,
        planScoutMode: "hybrid",
        planSurveyTaskBudget: 4,
        requireSurfaceCoverage: true,
      }),
      coveragePlan: plan,
      coverageInventory: {
        version: 1,
        sources: [
          {
            sourceId: "mono",
            surfaces: [
              { id: "mono::packages/core", path: "packages/core" },
              { id: "mono::packages/web", path: "packages/web" },
            ],
          },
        ],
      },
    });
    const surfaces = tasks.filter((t) => t.kind === "surface");
    assert.equal(surfaces.length, 2);
    assert.ok(surfaces.every((t) => t.required));
  });

  it("re-scout gapUnitIds only schedules missing units", () => {
    const tasks = selectPlanScoutTasks({
      orch: orch({ planScoutCount: 2, planScoutMode: "hybrid", planSurveyTaskBudget: 4 }),
      gapUnitIds: ["backend", "mono::packages/api"],
    });
    assert.ok(tasks.some((t) => t.kind === "source" && t.sourceId === "backend"));
    assert.ok(tasks.some((t) => t.kind === "surface" && t.unitId === "mono::packages/api"));
  });
});

describe("formatScoutPlannerContext", () => {
  it("emits index cards (ids/status/paths) without multi-kB body paste", () => {
    const longBody = "API findings ".repeat(300); // multi-kB-ish body must not appear in full
    const text = formatScoutPlannerContext(
      [
        {
          task: {
            kind: "source",
            sourceId: "api",
            id: "source:api",
            required: true,
          },
          relPath: "analysis/plan-scouts/source-api.md",
          receiptRelPath: "analysis/plan-scouts/source-api.json",
          summary: longBody,
          ok: true,
          required: true,
        },
        {
          task: {
            kind: "thematic",
            thematic: "entry",
            id: "entry",
            required: false,
          },
          relPath: "analysis/plan-scouts/entry.md",
          summary: "Entry findings with a short note",
          ok: true,
          required: false,
        },
      ],
      { discoveryMapPath: "inputs/discovery-map.json" },
    );
    assert.match(text, /Plan scout index|file handoff/i);
    assert.match(text, /### Source surveys/);
    assert.match(text, /\*\*api\*\*/);
    assert.match(text, /### Thematic scouts/);
    assert.match(text, /discovery-map/);
    assert.match(text, /inputs\/discovery-map\.json/);
    // Must instruct planner to read files
    assert.match(text, /`read`|read tool/i);
    // Must NOT paste the multi-kB body
    assert.ok(!text.includes(longBody), "must not paste multi-kB scout body");
    assert.ok(text.length < 4_000, "index card must stay compact");
    // Preview is truncated
    assert.ok(!/API findings API findings API findings API findings API findings/.test(text.slice(0, 500)) || text.length < longBody.length);
  });

  it("includes failed required scouts on the index (not only ok)", () => {
    const text = formatScoutPlannerContext([
      {
        task: {
          kind: "source",
          sourceId: "web",
          id: "source:web",
          required: true,
        },
        relPath: "analysis/plan-scouts/source-web.md",
        summary: "boom",
        ok: false,
        required: true,
      },
    ]);
    assert.match(text, /failed\(required\)|failed/);
    assert.match(text, /\*\*web\*\*/);
  });
});

describe("formatScoutPlannerContextFromJson", () => {
  it("is index-only and never pastes full summary bodies", () => {
    const fat = "x".repeat(2_500);
    const text = formatScoutPlannerContextFromJson(
      [
        {
          version: 1,
          kind: "source:api",
          sourceId: "api",
          summary: fat,
          ok: true,
          critical: true,
          relPath: "analysis/plan-scouts/source-api.md",
        },
        {
          version: 1,
          kind: "entry",
          summary: "entry ok",
          ok: true,
          critical: false,
        },
      ],
      { discoveryMapPath: "inputs/discovery-map.json" },
    );
    assert.match(text, /Plan scout index|file handoff/i);
    assert.match(text, /inputs\/plan-scouts\//);
    assert.match(text, /discovery-map/);
    assert.ok(!text.includes(fat), "must not paste full summary body");
    assert.ok(text.length < fat.length, "context shorter than one fat body");
  });
});

describe("runPlanScouts", () => {
  it("skips when no tasks (planScoutCount 0, single source thematic)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-scout-0-"));
    temps.push(root);
    const layout = await makeLayout(root);
    const result = await runPlanScouts({
      layout,
      workspaceName: "Demo",
      runtime: createFixtureProduceRuntime(),
      orch: orch({ planScoutCount: 0, planScoutMode: "thematic" }),
    });
    assert.equal(result.receipts.length, 0);
    assert.equal(result.plannerContext, "");
  });

  it("skips on fixture runtime even when count > 0", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-scout-fix-"));
    temps.push(root);
    const layout = await makeLayout(root);
    const result = await runPlanScouts({
      layout,
      workspaceName: "Demo",
      runtime: createFixtureProduceRuntime(),
      orch: orch({ planScoutCount: 2 }),
    });
    assert.equal(result.receipts.length, 0);
  });

  it("writes scout receipts and planner context on live-shaped runner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-scout-live-"));
    temps.push(root);
    const layout = await makeLayout(root);
    const roles: string[] = [];
    const base = createFixtureProduceRuntime({
      onAgent: async (req: AgentRunRequest) => {
        roles.push(req.role);
        return {
          role: req.role,
          summary: `scout body for ${req.spanId}`,
          mode: "fixture",
        };
      },
    });
    const runtime = {
      ...base,
      kind: "live" as const,
    };

    const result = await runPlanScouts({
      layout,
      workspaceName: "Demo",
      runtime,
      orch: orch({ planScoutCount: 2, planScoutConcurrency: 2, planScoutMode: "thematic" }),
    });

    assert.equal(result.receipts.length, 2);
    assert.ok(result.receipts.every((r) => r.ok));
    assert.match(result.plannerContext, /Plan scout index|file handoff|Thematic/i);
    assert.match(result.plannerContext, /entry|layout/);
    // Index only — scout agent bodies must not be fully pasted into planner context
    for (const r of result.receipts) {
      if (r.summary.length > 200) {
        assert.ok(!result.plannerContext.includes(r.summary));
      }
    }
    assert.ok(roles.every((r) => r === "root_research"));

    const entryPath = path.join(layout.runWorkDir, "analysis/plan-scouts/entry.md");
    const body = await readFile(entryPath, "utf8");
    assert.match(body, /Plan scout: thematic:entry|Plan scout: entry/);
  });

  it("marks required source scout failure as requiredScoutGaps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-scout-gap-"));
    temps.push(root);
    const layout = await makeLayout(root, ["api", "web"]);
    const base = createFixtureProduceRuntime({
      onAgent: async (req: AgentRunRequest) => {
        if (req.spanId?.includes("source-api")) {
          throw new Error("boom api scout");
        }
        return {
          role: req.role,
          summary: `ok ${req.spanId}`,
          mode: "fixture",
        };
      },
    });
    const runtime = { ...base, kind: "live" as const };
    const plan = CoveragePlanSchema.parse({
      requiredUnits: [sourceCoverageUnit("api"), sourceCoverageUnit("web")],
    });
    const result = await runPlanScouts({
      layout,
      workspaceName: "Demo",
      runtime,
      orch: orch({
        planScoutCount: 0,
        planScoutMode: "source",
        planSurveyTaskBudget: 2,
      }),
      coveragePlan: plan,
    });
    assert.ok(result.requiredScoutGaps.includes("api"));
    assert.ok(!result.requiredScoutGaps.includes("web"));
  });
});
