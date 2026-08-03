/**
 * CoverageUnit plan coverage (Phase A) — fail-closed unit tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCoverage,
  cancelledUnitsFromSpec,
  CoverageAssertError,
  CoverageInventorySchema,
  CoveragePlanSchema,
  CoverageUnitSchema,
  effectiveCoveragePlan,
  isSurfaceUnitId,
  normalizeSpecUnitIds,
  parseSealedCoverageInventory,
  parseSealedCoveragePlan,
  parseSurfaceUnitId,
  requiredSourceUnitsFromInventory,
  requiredSurfaceUnitsFromInventory,
  sourceCoverageUnit,
  surfaceCoverageUnit,
  unitIdForSource,
  unitIdForSurface,
} from "./coverage.js";
import { WikiRunSpecSchema } from "./run.js";

test("unitIdForSource / unitIdForSurface conventions", () => {
  assert.equal(unitIdForSource(" backend "), "backend");
  assert.equal(unitIdForSurface("backend", " src/main/java "), "backend::src/main/java");
  assert.equal(unitIdForSurface("frontend", "./packages/app"), "frontend::packages/app");
  assert.equal(isSurfaceUnitId("backend"), false);
  assert.equal(isSurfaceUnitId("backend::src"), true);
  assert.deepEqual(parseSurfaceUnitId("backend::src/main"), {
    sourceId: "backend",
    path: "src/main",
  });
  assert.equal(parseSurfaceUnitId("backend"), null);
});

test("CoverageUnitSchema enforces id conventions", () => {
  assert.equal(
    CoverageUnitSchema.safeParse({
      id: "app",
      kind: "source",
      sourceId: "app",
    }).success,
    true,
  );
  assert.equal(
    CoverageUnitSchema.safeParse({
      id: "wrong",
      kind: "source",
      sourceId: "app",
    }).success,
    false,
  );
  assert.equal(
    CoverageUnitSchema.safeParse({
      id: "app::src",
      kind: "surface",
      sourceId: "app",
      path: "src",
    }).success,
    true,
  );
  assert.equal(
    CoverageUnitSchema.safeParse({
      id: "app",
      kind: "surface",
      sourceId: "app",
      path: "src",
    }).success,
    false,
  );
});

test("normalizeSpecUnitIds prefers coverageUnitIds and projects source/surface", () => {
  const onlyCanonical = normalizeSpecUnitIds({
    coverageUnitIds: ["backend", "frontend::src/app", "backend"],
  });
  assert.deepEqual(onlyCanonical.coverageUnitIds, ["backend", "frontend::src/app"]);
  assert.deepEqual(onlyCanonical.sourceIds, ["backend"]);
  assert.deepEqual(onlyCanonical.surfaceIds, ["frontend::src/app"]);

  const fromProjections = normalizeSpecUnitIds({
    sourceIds: ["api"],
    surfaceIds: ["api::pkg/core"],
  });
  assert.ok(fromProjections.coverageUnitIds.includes("api"));
  assert.ok(fromProjections.coverageUnitIds.includes("api::pkg/core"));
});

test("assertCoverage rejects missing source unit (multi-source)", () => {
  const plan = CoveragePlanSchema.parse({
    requiredUnits: [sourceCoverageUnit("frontend"), sourceCoverageUnit("backend")],
    cancelled: [],
  });
  const spec = {
    pages: [
      {
        path: "overview.md",
        critical: true,
        sourceIds: ["frontend"],
      },
    ],
  };

  assert.throws(() => assertCoverage(spec, plan), CoverageAssertError);
  assert.throws(() => assertCoverage(spec, plan), /gap/);

  const soft = assertCoverage(spec, plan, { throwOnGap: false });
  assert.equal(soft.ok, false);
  assert.equal(soft.stop_reason, "coverage_gap");
  assert.deepEqual(soft.gaps, ["backend"]);
  assert.equal(soft.rows.find((r) => r.unitId === "frontend")?.status, "covered");
  assert.equal(soft.rows.find((r) => r.unitId === "backend")?.status, "gap");
});

test("assertCoverage accepts multi-source when every source is bound or cancelled", () => {
  const plan = CoveragePlanSchema.parse({
    requiredUnits: [
      sourceCoverageUnit("frontend"),
      sourceCoverageUnit("backend"),
      sourceCoverageUnit("docs"),
    ],
    cancelled: [{ unitId: "docs", reason: "docs repo out of scope for this run" }],
  });
  const spec = {
    pages: [
      {
        path: "overview.md",
        critical: true,
        coverageUnitIds: ["frontend", "backend"],
      },
      {
        path: "modules/ui.md",
        critical: true,
        sourceIds: ["frontend"],
      },
    ],
  };
  const result = assertCoverage(spec, plan);
  assert.equal(result.ok, true);
  assert.equal(result.stop_reason, "complete");
  assert.equal(result.gaps.length, 0);
  assert.equal(result.rows.find((r) => r.unitId === "docs")?.status, "cancelled");
});

test("assertCoverage merges Spec sourceCoverage/surfaceCoverage cancelled into plan", () => {
  const plan = CoveragePlanSchema.parse({
    requiredUnits: [
      sourceCoverageUnit("frontend"),
      sourceCoverageUnit("backend"),
      sourceCoverageUnit("docs"),
      surfaceCoverageUnit("frontend", "packages/legacy"),
    ],
    cancelled: [], // freeze plans always start empty
  });
  const spec = {
    pages: [
      {
        path: "overview.md",
        critical: true,
        coverageUnitIds: ["frontend", "backend"],
      },
    ],
    sourceCoverage: [
      {
        sourceId: "docs",
        cancelled: true,
        notes: "docs repo out of scope for this run",
      },
    ],
    surfaceCoverage: [
      {
        surfaceId: "frontend::packages/legacy",
        cancelled: true,
        notes: "legacy package not in product surface",
      },
    ],
  };
  const result = assertCoverage(spec, plan);
  assert.equal(result.ok, true);
  assert.equal(result.stop_reason, "complete");
  assert.equal(result.rows.find((r) => r.unitId === "docs")?.status, "cancelled");
  assert.equal(
    result.rows.find((r) => r.unitId === "frontend::packages/legacy")?.status,
    "cancelled",
  );
  assert.match(
    result.rows.find((r) => r.unitId === "docs")?.reason ?? "",
    /out of scope/,
  );
});

test("effectiveCoveragePlan / cancelledUnitsFromSpec extract Spec cancel rows", () => {
  const plan = CoveragePlanSchema.parse({
    requiredUnits: [sourceCoverageUnit("a"), sourceCoverageUnit("b")],
    cancelled: [{ unitId: "a", reason: "plan-level cancel" }],
  });
  const effective = effectiveCoveragePlan(plan, {
    sourceCoverage: [
      { sourceId: "a", cancelled: true, notes: "spec override ignored" },
      { sourceId: "b", cancelled: true, notes: "spec cancels b" },
    ],
  });
  // plan-level reason for a wins; b added from Spec
  assert.equal(effective.cancelled.find((c) => c.unitId === "a")?.reason, "plan-level cancel");
  assert.equal(effective.cancelled.find((c) => c.unitId === "b")?.reason, "spec cancels b");
  assert.deepEqual(
    cancelledUnitsFromSpec({
      surfaceCoverage: [
        { surfaceId: "app::pkg", cancelled: true, notes: "skip" },
        { surfaceId: "app::other", cancelled: false, notes: "still required" },
      ],
    }).map((c) => c.unitId),
    ["app::pkg"],
  );
});

test("assertCoverage rejects missing surface unit (large single-repo)", () => {
  const plan = CoveragePlanSchema.parse({
    requiredUnits: [
      surfaceCoverageUnit("app", "packages/core"),
      surfaceCoverageUnit("app", "packages/web"),
    ],
  });
  const spec = {
    pages: [
      {
        path: "modules/core.md",
        critical: true,
        surfaceIds: ["app::packages/core"],
      },
    ],
  };
  assert.throws(() => assertCoverage(spec, plan), CoverageAssertError);
  const soft = assertCoverage(spec, plan, { throwOnGap: false });
  assert.deepEqual(soft.gaps, ["app::packages/web"]);
});

test("assertCoverage accepts surfaces covered via coverageUnitIds; one page covers many", () => {
  const plan = CoveragePlanSchema.parse({
    requiredUnits: [
      surfaceCoverageUnit("app", "packages/core"),
      surfaceCoverageUnit("app", "packages/web"),
    ],
  });
  const result = assertCoverage(
    {
      pages: [
        {
          path: "architecture.md",
          critical: true,
          coverageUnitIds: ["app::packages/core", "app::packages/web"],
        },
      ],
    },
    plan,
  );
  assert.equal(result.ok, true);
  assert.equal(result.rows.every((r) => r.coveredBy.includes("architecture.md")), true);
});

test("non-critical pages do not satisfy the coverage gate", () => {
  const plan = CoveragePlanSchema.parse({
    requiredUnits: [sourceCoverageUnit("backend")],
  });
  assert.throws(
    () =>
      assertCoverage(
        {
          pages: [
            {
              path: "notes.md",
              critical: false,
              sourceIds: ["backend"],
            },
          ],
        },
        plan,
      ),
    CoverageAssertError,
  );
});

test("empty requiredUnits is not_required (small single-repo light path)", () => {
  const plan = CoveragePlanSchema.parse({ requiredUnits: [] });
  const result = assertCoverage(
    { pages: [{ path: "overview.md", critical: true }] },
    plan,
  );
  assert.equal(result.ok, true);
  assert.equal(result.stop_reason, "not_required");
});

test("parseSealedCoveragePlan strips host extras (lightPath/reasons/maxSurfacesRequired)", () => {
  const freezeShaped = {
    version: 1 as const,
    requiredUnits: [sourceCoverageUnit("api"), sourceCoverageUnit("web")],
    cancelled: [],
    lightPath: false,
    reasons: ["multi-source: each source unit required"],
    maxSurfacesRequired: 12,
  };
  // Strict schema rejects host extras.
  assert.equal(CoveragePlanSchema.safeParse(freezeShaped).success, false);

  const plan = parseSealedCoveragePlan(freezeShaped);
  assert.ok(plan);
  assert.deepEqual(
    plan.requiredUnits.map((u) => u.id),
    ["api", "web"],
  );
  assert.equal(plan.cancelled.length, 0);
  assert.equal("lightPath" in plan, false);
  assert.equal("reasons" in plan, false);
  assert.equal("maxSurfacesRequired" in plan, false);
});

test("parseSealedCoveragePlan maps legacy core { required } shape", () => {
  const plan = parseSealedCoveragePlan({
    version: 1,
    required: [
      { id: "source:api", kind: "source", sourceId: "api" },
      { id: "source:web", kind: "source", sourceId: "web" },
    ],
    lightPath: false,
    reasons: ["multi-source"],
    maxSurfacesRequired: 12,
  });
  assert.ok(plan);
  assert.deepEqual(
    plan.requiredUnits.map((u) => u.id).sort(),
    ["api", "web"],
  );
});

test("parseSealedCoverageInventory strips host walk metadata", () => {
  const freezeShaped = {
    version: 1 as const,
    sources: [
      {
        sourceId: "mono",
        fileCount: 10,
        languages: ["ts"],
        multiEntry: true,
        truncated: false,
        surfaces: [
          { id: "mono::.", path: ".", origin: "root" },
          { id: "mono::packages/a", path: "packages/a", origin: "manifest", label: "a" },
        ],
      },
    ],
    units: [],
    sourceCount: 1,
    fileCount: 10,
    languages: ["ts"],
    multiEntry: true,
    large: false,
  };
  assert.equal(CoverageInventorySchema.safeParse(freezeShaped).success, false);

  const inv = parseSealedCoverageInventory(freezeShaped);
  assert.ok(inv);
  assert.equal(inv.sources.length, 1);
  assert.equal(inv.sources[0]!.sourceId, "mono");
  assert.equal(inv.sources[0]!.surfaces.length, 2);
  assert.equal(inv.sources[0]!.surfaces[0]!.id, "mono::.");
  assert.equal("origin" in (inv.sources[0]!.surfaces[0] as object), false);
  assert.equal("multiEntry" in inv, false);
  assert.equal("sourceCount" in inv, false);
});

test("requiredSurfaceUnitsFromInventory fails closed on over-cap (no silent truncate)", () => {
  const inventory = CoverageInventorySchema.parse({
    sources: [
      {
        sourceId: "app",
        surfaces: Array.from({ length: 3 }, (_, i) => ({
          id: `app::pkg-${i}`,
          path: `pkg-${i}`,
        })),
      },
    ],
  });
  assert.throws(
    () => requiredSurfaceUnitsFromInventory(inventory, { maxSurfacesRequired: 2 }),
    /maxSurfacesRequired is 2/,
  );
  assert.equal(requiredSurfaceUnitsFromInventory(inventory, { maxSurfacesRequired: 12 }).length, 3);
});

test("requiredSourceUnitsFromInventory maps every source", () => {
  const inventory = CoverageInventorySchema.parse({
    sources: [
      { sourceId: "a", surfaces: [] },
      { sourceId: "b", surfaces: [] },
    ],
  });
  const units = requiredSourceUnitsFromInventory(inventory);
  assert.deepEqual(
    units.map((u) => u.id),
    ["a", "b"],
  );
});

test("WikiRunSpec accepts additive coverage fields (version 1)", () => {
  const parsed = WikiRunSpecSchema.parse({
    summary: "multi-source wiki",
    domains: [
      {
        id: "core",
        title: "Core",
        scope: "both repos",
        sourceIds: ["frontend", "backend"],
      },
    ],
    pages: [
      {
        path: "overview.md",
        purpose: "system overview",
        domainIds: ["core"],
        coverageUnitIds: ["frontend", "backend"],
        critical: true,
      },
    ],
    repositoryMap: {
      summary: "fe + be",
      sources: [
        { sourceId: "frontend", role: "UI" },
        { sourceId: "backend", role: "API" },
      ],
    },
    sourceCoverage: [
      { sourceId: "frontend", pagePaths: ["overview.md"] },
      { sourceId: "backend", pagePaths: ["overview.md"] },
    ],
  });
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.pages[0]?.coverageUnitIds, ["frontend", "backend"]);
});

test("WikiRunSpec rejects non-qualified surfaceIds and inconsistent sourceCoverage", () => {
  assert.equal(
    WikiRunSpecSchema.safeParse({
      summary: "s",
      pages: [
        {
          path: "a.md",
          purpose: "p",
          surfaceIds: ["not-qualified"],
        },
      ],
    }).success,
    false,
  );

  assert.equal(
    WikiRunSpecSchema.safeParse({
      summary: "s",
      pages: [
        {
          path: "a.md",
          purpose: "p",
          sourceIds: ["frontend", "backend"],
          critical: true,
        },
      ],
      sourceCoverage: [{ sourceId: "orphan" }],
    }).success,
    false,
  );
});

test("WikiRunSpec rejects surfaceIds not present in coverageUnitIds when both set", () => {
  assert.equal(
    WikiRunSpecSchema.safeParse({
      summary: "s",
      pages: [
        {
          path: "a.md",
          purpose: "p",
          coverageUnitIds: ["app::core"],
          surfaceIds: ["app::other"],
        },
      ],
    }).success,
    false,
  );
});

test("WikiRunSpec accepts cancelled sourceCoverage with notes; rejects cancelled without notes", () => {
  const ok = WikiRunSpecSchema.safeParse({
    summary: "cancel docs",
    pages: [
      {
        path: "overview.md",
        purpose: "map fe+be",
        critical: true,
        coverageUnitIds: ["frontend", "backend"],
      },
    ],
    sourceCoverage: [
      { sourceId: "docs", cancelled: true, notes: "out of scope" },
    ],
  });
  assert.equal(ok.success, true);

  const missingNotes = WikiRunSpecSchema.safeParse({
    summary: "bad cancel",
    pages: [
      {
        path: "overview.md",
        purpose: "p",
        critical: true,
        sourceIds: ["frontend"],
      },
    ],
    sourceCoverage: [{ sourceId: "docs", cancelled: true }],
  });
  assert.equal(missingNotes.success, false);
});
