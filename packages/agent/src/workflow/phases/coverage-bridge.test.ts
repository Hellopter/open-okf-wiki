import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CoveragePlanSchema, sourceCoverageUnit } from "@okf-wiki/contract/coverage";
import { resolveOrchestration } from "@okf-wiki/contract/workspace";
import { runWorkdirLayout } from "../../runtime/workdir.js";
import {
  contractPlanFromCore,
  formatCoveragePlannerContext,
  loadCoveragePlanFromWorkdir,
  resolveCoverageArtifacts,
} from "./coverage-bridge.js";
import { buildCoverageInventory } from "@okf-wiki/core";

test("loadCoveragePlanFromWorkdir accepts contract requiredUnits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-cov-load-"));
  const runWorkDir = path.join(root, "run");
  await mkdir(path.join(runWorkDir, "analysis"), { recursive: true });
  const plan = CoveragePlanSchema.parse({
    requiredUnits: [sourceCoverageUnit("a"), sourceCoverageUnit("b")],
  });
  await writeFile(
    path.join(runWorkDir, "analysis", "coverage-plan.json"),
    `${JSON.stringify(plan)}\n`,
    "utf8",
  );
  const loaded = await loadCoveragePlanFromWorkdir(runWorkDir);
  assert.ok(loaded);
  assert.deepEqual(
    loaded.requiredUnits.map((u) => u.id),
    ["a", "b"],
  );
});

test("loadCoveragePlanFromWorkdir normalizes core { required } plan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-cov-core-"));
  const runWorkDir = path.join(root, "run");
  await mkdir(path.join(runWorkDir, "inputs"), { recursive: true });
  await writeFile(
    path.join(runWorkDir, "inputs", "coverage-plan.json"),
    `${JSON.stringify({
      version: 1,
      required: [
        { id: "source:api", kind: "source", sourceId: "api" },
        { id: "source:web", kind: "source", sourceId: "web" },
      ],
      lightPath: false,
      reasons: ["multi-source"],
      maxSurfacesRequired: 12,
    })}\n`,
    "utf8",
  );
  const loaded = await loadCoveragePlanFromWorkdir(runWorkDir);
  assert.ok(loaded);
  assert.deepEqual(
    loaded.requiredUnits.map((u) => u.id).sort(),
    ["api", "web"],
  );
});

test("loadCoveragePlanFromWorkdir accepts freeze host shape (requiredUnits + extras)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-cov-freeze-"));
  const runWorkDir = path.join(root, "run");
  await mkdir(path.join(runWorkDir, "inputs"), { recursive: true });
  // Strict CoveragePlanSchema rejects lightPath/reasons/maxSurfacesRequired.
  await writeFile(
    path.join(runWorkDir, "inputs", "coverage-plan.json"),
    `${JSON.stringify({
      version: 1,
      requiredUnits: [
        { id: "api", kind: "source", sourceId: "api" },
        { id: "web", kind: "source", sourceId: "web" },
      ],
      cancelled: [],
      lightPath: false,
      reasons: ["multi-source: each source unit required"],
      maxSurfacesRequired: 12,
    })}\n`,
    "utf8",
  );
  const loaded = await loadCoveragePlanFromWorkdir(runWorkDir);
  assert.ok(loaded, "sealed freeze plan must load without re-walk");
  assert.deepEqual(
    loaded.requiredUnits.map((u) => u.id),
    ["api", "web"],
  );
  assert.equal("lightPath" in loaded, false);
});

test("resolveCoverageArtifacts fail-closes when mounts exceed maxSourcesPerRun", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-cov-max-"));
  const runWorkDir = path.join(root, "run");
  const mounts = new Map<string, string>();
  for (const id of ["a", "b", "c"]) {
    const p = path.join(runWorkDir, "sources", id);
    await mkdir(p, { recursive: true });
    await writeFile(path.join(p, "README.md"), `# ${id}\n`, "utf8");
    mounts.set(id, p);
  }
  await mkdir(path.join(runWorkDir, "analysis"), { recursive: true });
  const layout = runWorkdirLayout(runWorkDir, mounts);
  await assert.rejects(
    () =>
      resolveCoverageArtifacts({
        layout,
        orch: resolveOrchestration({ maxSourcesPerRun: 2 }),
        sourceMounts: mounts,
      }),
    /maxSourcesPerRun/,
  );
});

test("contractPlanFromCore multi-source requires bare source units", async () => {
  const a = await mkdtemp(path.join(tmpdir(), "okf-cov-a-"));
  const b = await mkdtemp(path.join(tmpdir(), "okf-cov-b-"));
  await writeFile(path.join(a, "README.md"), "# a\n", "utf8");
  await writeFile(path.join(b, "README.md"), "# b\n", "utf8");
  const inv = await buildCoverageInventory([
    { id: "alpha", path: a, effectiveIgnores: [] },
    { id: "beta", path: b, effectiveIgnores: [] },
  ]);
  const plan = contractPlanFromCore(inv, resolveOrchestration({}));
  assert.deepEqual(
    plan.requiredUnits.map((u) => u.id).sort(),
    ["alpha", "beta"],
  );
  assert.ok(plan.requiredUnits.every((u) => u.kind === "source"));
});

test("formatCoveragePlannerContext lists required units", () => {
  const text = formatCoveragePlannerContext({
    contractInventory: {
      version: 1,
      sources: [
        { sourceId: "api", surfaces: [] },
        { sourceId: "web", surfaces: [] },
      ],
    },
    plan: CoveragePlanSchema.parse({
      requiredUnits: [sourceCoverageUnit("api"), sourceCoverageUnit("web")],
    }),
    adaptive: { sourceCount: 2 },
  });
  assert.match(text, /Required coverage units/);
  assert.match(text, /api/);
  assert.match(text, /web/);
});
