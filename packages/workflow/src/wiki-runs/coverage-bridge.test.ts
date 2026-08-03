/**
 * Coverage bridge unit tests (Wave 2).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCoverage, CoveragePlanSchema, sourceCoverageUnit } from "@okf-wiki/contract/coverage";
import { defaultWikiRunSpec } from "@okf-wiki/contract/wiki-runs";
import {
  coverageObligationsFromSpec,
  pageSetDiffFromSpecs,
  parseSealedCoveragePlan,
  toContractCoveragePlan,
} from "./coverage-bridge.js";

test("toContractCoveragePlan preserves requiredUnits", () => {
  const plan = toContractCoveragePlan({
    version: 1,
    requiredUnits: [sourceCoverageUnit("frontend"), sourceCoverageUnit("backend")],
    cancelled: [],
  });
  assert.deepEqual(
    plan.requiredUnits.map((u) => u.id),
    ["frontend", "backend"],
  );
});

test("parseSealedCoveragePlan accepts host plan with lightPath/reasons", () => {
  const core = parseSealedCoveragePlan({
    version: 1,
    requiredUnits: [sourceCoverageUnit("a")],
    cancelled: [],
    lightPath: false,
    reasons: ["multi-source"],
    maxSurfacesRequired: 12,
  });
  assert.ok(core);
  assert.equal(core.requiredUnits.length, 1);
  assert.equal(core.requiredUnits[0]?.id, "a");
  assert.equal(core.lightPath, false);

  const contract = parseSealedCoveragePlan(
    CoveragePlanSchema.parse({
      requiredUnits: [sourceCoverageUnit("a"), sourceCoverageUnit("b")],
      cancelled: [],
    }),
  );
  assert.ok(contract);
  assert.equal(contract.requiredUnits.length, 2);
});

test("coverageObligationsFromSpec projects page bindings to unit ids", () => {
  const spec = defaultWikiRunSpec("X");
  spec.pages = [
    {
      path: "overview.md",
      purpose: "o",
      domainIds: ["core"],
      questions: [],
      critical: true,
      sourceIds: ["api", "web"],
    },
    {
      path: "modules/ui.md",
      purpose: "ui",
      domainIds: ["core"],
      questions: [],
      critical: true,
      coverageUnitIds: ["web::packages/web"],
    },
  ];
  const obligations = coverageObligationsFromSpec(spec);
  assert.ok(obligations.some((o) => o.unitId === "api" && o.pagePath === "overview.md"));
  assert.ok(obligations.some((o) => o.unitId === "web" && o.pagePath === "overview.md"));
  assert.ok(
    obligations.some(
      (o) => o.unitId === "web::packages/web" && o.pagePath === "modules/ui.md",
    ),
  );
});

test("pageSetDiffFromSpecs computes added/removed/retained", () => {
  const prior = defaultWikiRunSpec("P");
  prior.pages = [
    { path: "overview.md", purpose: "o", domainIds: ["core"], questions: [], critical: true },
    { path: "old.md", purpose: "old", domainIds: ["core"], questions: [], critical: true },
  ];
  const current = defaultWikiRunSpec("C");
  current.pages = [
    { path: "overview.md", purpose: "o", domainIds: ["core"], questions: [], critical: true },
    { path: "new.md", purpose: "n", domainIds: ["core"], questions: [], critical: true },
  ];
  const diff = pageSetDiffFromSpecs(prior, current);
  assert.deepEqual(diff?.added, ["new.md"]);
  assert.deepEqual(diff?.removed, ["old.md"]);
  assert.deepEqual(diff?.retained, ["overview.md"]);
});

test("assertCoverage soft result projects gaps for plan-review rows", () => {
  const plan = CoveragePlanSchema.parse({
    requiredUnits: [sourceCoverageUnit("frontend"), sourceCoverageUnit("backend")],
    cancelled: [],
  });
  const spec = defaultWikiRunSpec("R");
  spec.pages = [
    {
      path: "overview.md",
      purpose: "o",
      domainIds: ["core"],
      questions: [],
      critical: true,
      sourceIds: ["frontend"],
    },
  ];
  const result = assertCoverage(spec, plan, { throwOnGap: false });
  assert.equal(result.ok, false);
  assert.equal(result.stop_reason, "coverage_gap");
  assert.ok(result.rows.some((r) => r.unitId === "backend" && r.status === "gap"));
  assert.ok(result.rows.some((r) => r.unitId === "frontend" && r.status === "covered"));
});

test("assertCoverage honors Spec sourceCoverage.cancelled when plan.cancelled is empty", () => {
  const plan = CoveragePlanSchema.parse({
    requiredUnits: [sourceCoverageUnit("frontend"), sourceCoverageUnit("backend")],
    cancelled: [],
  });
  const spec = defaultWikiRunSpec("Cancel");
  spec.pages = [
    {
      path: "overview.md",
      purpose: "frontend only",
      domainIds: ["core"],
      questions: [],
      critical: true,
      sourceIds: ["frontend"],
    },
  ];
  spec.sourceCoverage = [
    {
      sourceId: "backend",
      cancelled: true,
      notes: "backend out of scope for this operator focus",
    },
  ];
  const result = assertCoverage(spec, plan);
  assert.equal(result.ok, true);
  assert.equal(result.rows.find((r) => r.unitId === "backend")?.status, "cancelled");
});

test("assertCoverageForSealedSpec fails multi-source when plan missing (no soft skip)", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const {
    assertCoverageForSealedSpec,
    COVERAGE_INVENTORY_FILE,
  } = await import("./coverage-bridge.js");
  const { CoverageAssertError } = await import("@okf-wiki/contract/coverage");

  const runDir = await mkdtemp(path.join(tmpdir(), "okf-cov-ms-miss-"));
  const analysisDir = path.join(runDir, "analysis");
  await mkdir(analysisDir, { recursive: true });
  // Multi-source inventory present, but no coverage plan.
  await writeFile(
    path.join(analysisDir, COVERAGE_INVENTORY_FILE),
    `${JSON.stringify({
      version: 1,
      sources: [
        { sourceId: "a", fileCount: 1, languages: ["ts"], multiEntry: false, surfaces: [], truncated: false },
        { sourceId: "b", fileCount: 1, languages: ["go"], multiEntry: false, surfaces: [], truncated: false },
      ],
      units: [],
      sourceCount: 2,
      fileCount: 2,
      languages: ["go", "ts"],
      multiEntry: false,
      large: true,
    })}\n`,
    "utf8",
  );

  const db = new DatabaseSync(":memory:");
  // Minimal schema stubs so sealed path queries return nothing (analysis fallback only).
  db.exec(`
    CREATE TABLE node_outputs (
      run_id TEXT, node_key TEXT, node_generation INTEGER, role TEXT, artifact_id TEXT
    );
    CREATE TABLE artifacts (artifact_id TEXT, relative_path TEXT);
    CREATE TABLE nodes (run_id TEXT, node_key TEXT, generation INTEGER);
  `);

  const spec = defaultWikiRunSpec("MS");
  spec.pages = [
    {
      path: "overview.md",
      purpose: "o",
      domainIds: ["core"],
      questions: [],
      critical: true,
      sourceIds: ["a", "b"],
    },
  ];

  assert.throws(
    () => assertCoverageForSealedSpec(db, "run-ms", runDir, spec, { requireSpec: true }),
    (err: unknown) =>
      err instanceof CoverageAssertError &&
      /multi-source|CoveragePlan/.test(err.message),
  );
});

test("readScoutsSummary returns per-receipt ok/preview rows", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { readScoutsSummary } = await import("./coverage-bridge.js");

  const analysisDir = await mkdtemp(path.join(tmpdir(), "okf-scouts-"));
  const scoutsDir = path.join(analysisDir, "plan-scouts");
  await mkdir(scoutsDir, { recursive: true });
  await writeFile(
    path.join(scoutsDir, "entry.md"),
    "# Plan scout: entry\n\nFound README and package.json.\n",
    "utf8",
  );
  await writeFile(
    path.join(scoutsDir, "layout.md"),
    "# Plan scout: layout\n\nScout failed: timeout\n",
    "utf8",
  );

  const summary = readScoutsSummary(analysisDir);
  assert.ok(summary);
  assert.deepEqual(summary.kinds, ["entry", "layout"]);
  assert.equal(summary.receiptCount, 2);
  assert.equal(summary.scouts.length, 2);
  const entry = summary.scouts.find((s) => s.kind === "entry");
  const layout = summary.scouts.find((s) => s.kind === "layout");
  assert.equal(entry?.ok, true);
  assert.equal(layout?.ok, false);
  assert.match(entry?.preview ?? "", /Found README/);
  assert.equal(entry?.relPath, "analysis/plan-scouts/entry.md");
});

test("readScoutsSummary returns undefined when plan-scouts missing", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { readScoutsSummary } = await import("./coverage-bridge.js");
  const analysisDir = await mkdtemp(path.join(tmpdir(), "okf-scouts-empty-"));
  assert.equal(readScoutsSummary(analysisDir), undefined);
});
