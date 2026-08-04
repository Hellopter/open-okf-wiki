import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CoveragePlanSchema, sourceCoverageUnit, surfaceCoverageUnit } from "./coverage.js";
import {
  planScoutNodeKey,
  scoutTaskFileSlug,
  selectPlanScoutTasks,
} from "./plan-scouts.js";
import { resolveOrchestration, type WorkspaceOrchestration } from "./workspace.js";

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
  it("light path: no scouts when planScoutCount=0 and single-source thematic", () => {
    const tasks = selectPlanScoutTasks({
      orch: orch({ planScoutCount: 0, planScoutMode: "thematic" }),
    });
    assert.equal(tasks.length, 0);
  });

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

  it("schedules per-source surveys under planSurveyTaskBudget", () => {
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

  it("schedules required surface surveys", () => {
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

  it("builds durable plan.scout node keys from task slugs", () => {
    assert.equal(
      planScoutNodeKey({
        kind: "thematic",
        thematic: "entry",
        id: "entry",
        required: false,
      }),
      "plan.scout.entry",
    );
    assert.equal(
      scoutTaskFileSlug({
        kind: "source",
        sourceId: "api",
        id: "source:api",
        required: true,
      }),
      "source-api",
    );
  });
});
