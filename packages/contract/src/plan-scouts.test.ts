import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CoveragePlanSchema, sourceCoverageUnit, surfaceCoverageUnit } from "./coverage.js";
import {
  FLOW_CROSS_ID,
  makeSemanticScoutTask,
  type PlanScoutTask,
  planScoutNodeKey,
  planScoutTaskFromDetail,
  scoutTaskFileSlug,
  scoutTaskLabel,
  selectPlanScoutTasks,
} from "./plan-scouts.js";

/** Semantic branch of PlanScoutTask (domain | flow | concept). */
type SemanticTask = PlanScoutTask & {
  kind: "domain" | "flow" | "concept";
  sourceId?: string;
  cross?: boolean;
};
function isSemanticTask(t: PlanScoutTask): t is SemanticTask {
  return t.kind === "domain" || t.kind === "flow" || t.kind === "concept";
}
function isDomainTask(t: PlanScoutTask): t is SemanticTask & { kind: "domain" } {
  return t.kind === "domain";
}
function isFlowTask(t: PlanScoutTask): t is SemanticTask & { kind: "flow" } {
  return t.kind === "flow";
}
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

const twoSourcePlan = () =>
  CoveragePlanSchema.parse({
    requiredUnits: [sourceCoverageUnit("api"), sourceCoverageUnit("web")],
  });

const twoSourceInventory = () => ({
  version: 1 as const,
  sources: [
    { sourceId: "api", surfaces: [] },
    { sourceId: "web", surfaces: [] },
  ],
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
    const tasks = selectPlanScoutTasks({
      orch: orch({
        planScoutCount: 1,
        planScoutMode: "hybrid",
        planSurveyTaskBudget: 2,
      }),
      coveragePlan: twoSourcePlan(),
      coverageInventory: twoSourceInventory(),
    });
    const sources = tasks.filter((t) => t.kind === "source");
    const thematic = tasks.filter((t) => t.kind === "thematic");
    const domains = tasks.filter(isDomainTask);
    const flows = tasks.filter(isFlowTask);
    assert.equal(sources.length, 2);
    assert.ok(sources.every((t) => t.required));
    assert.equal(thematic.length, 1);
    // domain×2 + flow×2 + flow:cross
    assert.equal(domains.length, 2);
    assert.equal(flows.length, 3);
    assert.ok(domains.every((t) => t.required && t.sourceId));
    assert.ok(flows.every((t) => t.required));
    assert.ok(flows.some((t) => t.cross && t.id === FLOW_CROSS_ID));
  });

  it("multi-source hybrid: source×2 + domain×2 + flow×2 + flow:cross; thematic default-off", () => {
    const tasks = selectPlanScoutTasks({
      orch: orch({
        planScoutCount: 0,
        planScoutMode: "hybrid",
        planSurveyTaskBudget: 2,
      }),
      coveragePlan: twoSourcePlan(),
      coverageInventory: twoSourceInventory(),
    });

    const sources = tasks.filter((t) => t.kind === "source");
    const domains = tasks.filter(isDomainTask);
    const flows = tasks.filter(isFlowTask);
    const cross = flows.filter((t) => t.cross);
    const bareGlobal = tasks.filter(
      (t): t is SemanticTask => isSemanticTask(t) && !t.sourceId && !t.cross,
    );

    assert.equal(sources.length, 2, "source×2");
    assert.equal(domains.length, 2, "domain×2");
    assert.equal(flows.length, 3, "flow×2 + flow:cross");
    assert.equal(cross.length, 1);
    assert.equal(cross[0]!.id, FLOW_CROSS_ID);
    assert.ok(
      domains.every((t) => t.sourceId === "api" || t.sourceId === "web"),
      "domains are source-qualified",
    );
    assert.ok(
      flows.filter((t) => !t.cross).every((t) => t.sourceId === "api" || t.sourceId === "web"),
      "per-source flows are source-qualified",
    );
    assert.ok(domains.every((t) => t.required));
    assert.ok(flows.every((t) => t.required));
    assert.equal(bareGlobal.length, 0, "no bare global domain/flow without sourceId");
    assert.equal(
      tasks.filter((t) => t.kind === "thematic").length,
      0,
      "thematic spine default-off for multi-source",
    );
    assert.equal(
      tasks.filter((t) => t.kind === "concept").length,
      0,
      "concept not auto-scheduled",
    );

    // Full expected set (order: sources → domain/flow per source → cross)
    assert.deepEqual(
      tasks.map((t) => t.id),
      [
        "source:api",
        "source:web",
        "domain:api",
        "flow:api",
        "domain:web",
        "flow:web",
        "flow:cross",
      ],
    );
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
    // hybrid single-source: per-source domain+flow, no flow:cross
    assert.ok(
      tasks.some((t) => t.kind === "domain" && t.sourceId === "mono"),
    );
    assert.ok(
      tasks.some((t) => t.kind === "flow" && t.sourceId === "mono" && !t.cross),
    );
    assert.ok(!tasks.some((t) => t.kind === "flow" && t.cross));
  });

  it("gap domain:api only reopens that semantic task", () => {
    const tasks = selectPlanScoutTasks({
      orch: orch({ planScoutCount: 0, planScoutMode: "hybrid", planSurveyTaskBudget: 4 }),
      gapUnitIds: ["domain:api"],
    });
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0], {
      kind: "domain",
      id: "domain:api",
      sourceId: "api",
      required: true,
    });
  });

  it("gap path supports unit ids and semantic ids including flow:cross", () => {
    const tasks = selectPlanScoutTasks({
      orch: orch({ planScoutCount: 0, planScoutMode: "hybrid", planSurveyTaskBudget: 4 }),
      gapUnitIds: ["backend", "mono::packages/api", "flow:web", "flow:cross"],
    });
    assert.ok(tasks.some((t) => t.kind === "source" && t.sourceId === "backend"));
    assert.ok(tasks.some((t) => t.kind === "surface" && t.unitId === "mono::packages/api"));
    assert.ok(tasks.some((t) => t.kind === "flow" && t.sourceId === "web" && !t.cross));
    assert.ok(tasks.some((t) => t.kind === "flow" && t.cross && t.id === FLOW_CROSS_ID));
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
    assert.equal(
      scoutTaskFileSlug(makeSemanticScoutTask("domain", { sourceId: "api" })),
      "domain-api",
    );
    assert.equal(
      planScoutNodeKey(makeSemanticScoutTask("flow", { sourceId: "web" })),
      "plan.scout.flow-web",
    );
    assert.equal(
      planScoutNodeKey(makeSemanticScoutTask("flow", { cross: true })),
      "plan.scout.flow-cross",
    );
    assert.equal(scoutTaskLabel(makeSemanticScoutTask("domain", { sourceId: "api" })), "domain:api");
    assert.equal(scoutTaskLabel(makeSemanticScoutTask("flow", { cross: true })), "flow:cross");
    // legacy bare
    assert.equal(scoutTaskFileSlug({ kind: "domain", id: "domain", required: true }), "domain");
    assert.equal(scoutTaskLabel({ kind: "domain", id: "domain", required: true }), "semantic:domain");
  });

  it("planScoutTaskFromDetail supports thematic, source, surface, semantic", () => {
    assert.deepEqual(planScoutTaskFromDetail({ scoutKind: "entry" }), {
      kind: "thematic",
      thematic: "entry",
      id: "entry",
      required: false,
    });
    // Legacy bare global domain/flow/concept (compat)
    assert.deepEqual(planScoutTaskFromDetail({ scoutKind: "domain" }), {
      kind: "domain",
      id: "domain",
      required: true,
    });
    assert.deepEqual(planScoutTaskFromDetail({ scoutKind: "concept" }), {
      kind: "concept",
      id: "concept",
      required: false,
    });
    // Source-qualified via detail.sourceId
    assert.deepEqual(
      planScoutTaskFromDetail({ scoutKind: "domain", sourceId: "api" }),
      {
        kind: "domain",
        id: "domain:api",
        sourceId: "api",
        required: true,
      },
    );
    // Qualified scoutKind form
    assert.deepEqual(planScoutTaskFromDetail({ scoutKind: "flow:web" }), {
      kind: "flow",
      id: "flow:web",
      sourceId: "web",
      required: true,
    });
    // flow:cross via sourceId "cross"
    assert.deepEqual(
      planScoutTaskFromDetail({ scoutKind: "flow", sourceId: "cross" }),
      {
        kind: "flow",
        id: "flow:cross",
        sourceId: "cross",
        cross: true,
        required: true,
      },
    );
    // flow-cross scoutKind alias
    assert.deepEqual(planScoutTaskFromDetail({ scoutKind: "flow-cross" }), {
      kind: "flow",
      id: "flow:cross",
      sourceId: "cross",
      cross: true,
      required: true,
    });
    assert.deepEqual(
      planScoutTaskFromDetail({ scoutKind: "source", sourceId: "api", critical: true }),
      {
        kind: "source",
        sourceId: "api",
        id: "source:api",
        required: true,
      },
    );
    assert.throws(() => planScoutTaskFromDetail({}), /scoutKind/);
    assert.throws(() => planScoutTaskFromDetail({ scoutKind: "nope" }), /scoutKind/);
  });
});
