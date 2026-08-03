import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { unitIdForSurface } from "@okf-wiki/contract/coverage";
import { buildCoveragePlan } from "./coverage-plan.js";
import { makeSourceUnit, makeSurfaceUnit } from "./coverage-types.js";
import {
  buildCoverageInventory,
  PACKAGE_MANIFEST_NAMES,
  toAdaptiveRepositoryInventory,
} from "./repository-inventory.js";
import { DEFAULT_SOURCE_IGNORES } from "./source-ignores.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeTree(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, "utf8");
  }
}

test("buildCoverageInventory is deterministic on a 2-package monorepo", async () => {
  const root = await tempDir("okf-inv-mono-");
  await writeTree(root, {
    "package.json": '{"name":"root"}\n',
    "packages/core/package.json": '{"name":"@acme/core"}\n',
    "packages/core/src/index.ts": "export const x = 1;\n",
    "packages/web/package.json": '{"name":"@acme/web"}\n',
    "packages/web/src/app.tsx": "export const App = () => null;\n",
    "apps/api/main.go": "package main\n",
    "node_modules/left-pad/index.js": "module.exports = 1;\n",
    "README.md": "# mono\n",
  });

  const a = await buildCoverageInventory([
    { id: "mono", path: root, effectiveIgnores: DEFAULT_SOURCE_IGNORES },
  ]);
  const b = await buildCoverageInventory([
    { id: "mono", path: root, effectiveIgnores: DEFAULT_SOURCE_IGNORES },
  ]);

  assert.deepEqual(a, b, "two walks must produce identical inventory");
  assert.equal(a.sourceCount, 1);
  assert.equal(a.sources[0]!.sourceId, "mono");
  assert.equal(a.sources[0]!.multiEntry, true);
  assert.ok(a.sources[0]!.languages.includes("ts"));
  assert.ok(a.sources[0]!.languages.includes("go"));
  // node_modules ignored → not counted
  assert.ok(
    a.sources[0]!.fileCount < 10,
    `expected small file count without node_modules, got ${a.sources[0]!.fileCount}`,
  );

  const surfacePaths = a.sources[0]!.surfaces.map((s) => s.path);
  assert.ok(surfacePaths.includes("."), "root surface");
  assert.ok(surfacePaths.includes("packages/core"));
  assert.ok(surfacePaths.includes("packages/web"));
  assert.ok(surfacePaths.includes("apps/api"));
  // Surface ids are source-qualified (contract unitIdForSurface)
  assert.equal(
    a.sources[0]!.surfaces.find((s) => s.path === "packages/core")!.id,
    unitIdForSurface("mono", "packages/core"),
  );
  // Deterministic surface order: root first, then localeCompare
  assert.equal(surfacePaths[0], ".");
  assert.deepEqual(
    surfacePaths.slice(1),
    [...surfacePaths.slice(1)].sort((x, y) => x.localeCompare(y)),
  );
});

test("buildCoverageInventory multi-source aggregates two sealed trees", async () => {
  const api = await tempDir("okf-inv-api-");
  const web = await tempDir("okf-inv-web-");
  await writeTree(api, {
    "go.mod": "module example.com/api\n",
    "cmd/server/main.go": "package main\n",
    "openapi.yaml": "openapi: 3.0.0\n",
  });
  await writeTree(web, {
    "package.json": '{"name":"web"}\n',
    "src/index.ts": "export {};\n",
    "README.md": "# web\n",
  });

  const inventory = await buildCoverageInventory([
    { id: "api", path: api, effectiveIgnores: [] },
    { id: "web", path: web, effectiveIgnores: [] },
  ]);

  assert.equal(inventory.sourceCount, 2);
  assert.equal(inventory.large, true, "multi-source is large");
  assert.deepEqual(
    inventory.sources.map((s) => s.sourceId),
    ["api", "web"],
  );
  assert.ok(inventory.units.some((u) => u.id === makeSourceUnit("api").id));
  assert.ok(inventory.units.some((u) => u.id === makeSourceUnit("web").id));
  assert.ok(inventory.languages.includes("go"));
  assert.ok(inventory.languages.includes("ts"));

  const adaptive = toAdaptiveRepositoryInventory(inventory);
  assert.equal(adaptive.sourceCount, 2);
  assert.equal(adaptive.large, true);

  // Multi-source plan requires each source unit (not surfaces).
  const plan = buildCoveragePlan(inventory);
  assert.equal(plan.lightPath, false);
  assert.deepEqual(plan.cancelled, []);
  assert.deepEqual(
    plan.requiredUnits.map((u) => u.id),
    [makeSourceUnit("api").id, makeSourceUnit("web").id],
  );
  // Contract source unit id is bare sourceId
  assert.deepEqual(plan.requiredUnits.map((u) => u.id), ["api", "web"]);
  assert.ok(plan.reasons.some((r) => /multi-source/i.test(r)));
});

test("buildCoverageInventory light single-source yields empty coverage plan", async () => {
  const root = await tempDir("okf-inv-small-");
  await writeTree(root, {
    "README.md": "# tiny\n",
    "main.py": "print('hi')\n",
  });
  const inventory = await buildCoverageInventory([
    { id: "tiny", path: root, effectiveIgnores: [] },
  ]);
  assert.equal(inventory.sourceCount, 1);
  assert.equal(inventory.multiEntry, false);
  assert.equal(inventory.sources[0]!.surfaces.length, 1); // root only
  const plan = buildCoveragePlan(inventory);
  assert.equal(plan.lightPath, true);
  assert.deepEqual(plan.requiredUnits, []);
  assert.deepEqual(plan.cancelled, []);
});

test("buildCoveragePlan requires critical surfaces for multi-entry monorepo", async () => {
  const root = await tempDir("okf-inv-surfaces-");
  await writeTree(root, {
    "package.json": "{}\n",
    "packages/a/package.json": "{}\n",
    "packages/b/package.json": "{}\n",
    "packages/c/package.json": "{}\n",
    "packages/a/index.ts": "export {};\n",
  });
  const inventory = await buildCoverageInventory([
    { id: "mono", path: root, effectiveIgnores: [] },
  ]);
  const surfaceCount = inventory.sources[0]!.surfaces.length;
  assert.ok(surfaceCount >= 3);
  // Fail-closed: over maxSurfacesRequired throws (no silent slice).
  assert.throws(
    () => buildCoveragePlan(inventory, { maxSurfacesRequired: 2 }),
    /maxSurfacesRequired is 2/,
  );
  const plan = buildCoveragePlan(inventory, { maxSurfacesRequired: surfaceCount });
  assert.equal(plan.lightPath, false);
  assert.equal(plan.requiredUnits.length, surfaceCount);
  assert.ok(plan.requiredUnits.every((u) => u.kind === "surface"));
  assert.equal(plan.requiredUnits[0]!.id, makeSurfaceUnit("mono", ".").id);
});

test("buildCoveragePlan over-cap throws (no silent surface truncation)", async () => {
  const root = await tempDir("okf-inv-overcap-");
  await writeTree(root, {
    "package.json": "{}\n",
    "packages/a/package.json": "{}\n",
    "packages/b/package.json": "{}\n",
    "packages/c/package.json": "{}\n",
  });
  const inventory = await buildCoverageInventory([
    { id: "mono", path: root, effectiveIgnores: [] },
  ]);
  assert.ok(inventory.sources[0]!.surfaces.length > 1);
  assert.throws(
    () => buildCoveragePlan(inventory, { maxSurfacesRequired: 1 }),
    (err: unknown) =>
      err instanceof Error &&
      /silent truncation is not allowed/.test(err.message) &&
      err.name === "CoverageAssertError",
  );
});

test("buildCoveragePlan multi-source adds critical surfaces for multiEntry sources only", async () => {
  const mono = await tempDir("okf-inv-ms-mono-");
  const lib = await tempDir("okf-inv-ms-lib-");
  await writeTree(mono, {
    "package.json": "{}\n",
    "packages/a/package.json": "{}\n",
    "packages/b/package.json": "{}\n",
    "packages/a/index.ts": "export {};\n",
  });
  await writeTree(lib, {
    "README.md": "# small lib\n",
    "main.go": "package main\n",
  });
  const inventory = await buildCoverageInventory([
    { id: "mono", path: mono, effectiveIgnores: [] },
    { id: "lib", path: lib, effectiveIgnores: [] },
  ]);
  assert.equal(inventory.sourceCount, 2);
  assert.equal(inventory.sources.find((s) => s.sourceId === "mono")?.multiEntry, true);
  assert.equal(inventory.sources.find((s) => s.sourceId === "lib")?.multiEntry, false);

  const monoSurfaceCount = inventory.sources.find((s) => s.sourceId === "mono")!.surfaces.length;
  const plan = buildCoveragePlan(inventory, { maxSurfacesRequired: Math.max(monoSurfaceCount, 12) });
  assert.equal(plan.lightPath, false);
  const ids = plan.requiredUnits.map((u) => u.id);
  // Every source unit required.
  assert.ok(ids.includes("mono"));
  assert.ok(ids.includes("lib"));
  // Additive surfaces only for multiEntry mono.
  const monoSurfaces = plan.requiredUnits.filter(
    (u) => u.kind === "surface" && u.sourceId === "mono",
  );
  assert.equal(monoSurfaces.length, monoSurfaceCount);
  assert.ok(monoSurfaces.every((u) => u.id.startsWith("mono::")));
  // Non-multiEntry lib must not contribute surface obligations.
  assert.equal(
    plan.requiredUnits.filter((u) => u.kind === "surface" && u.sourceId === "lib").length,
    0,
  );
  assert.ok(plan.reasons.some((r) => /additive surfaces/i.test(r)));

  // Over-cap on multi-entry multi-source also fail-closes (no silent slice).
  assert.throws(
    () => buildCoveragePlan(inventory, { maxSurfacesRequired: 1 }),
    /silent truncation is not allowed|maxSurfacesRequired is 1/,
  );
});

test("PACKAGE_MANIFEST_NAMES covers js/py/go/rust", () => {
  assert.deepEqual([...PACKAGE_MANIFEST_NAMES].sort(), [
    "Cargo.toml",
    "go.mod",
    "package.json",
    "pyproject.toml",
  ]);
});
