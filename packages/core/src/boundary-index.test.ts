import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildBoundaryIndex, classifyBoundaryPath } from "./boundary-index.js";
import { DEFAULT_SOURCE_IGNORES } from "./source-ignores.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, "utf8");
  }
}

test("classifyBoundaryPath recognizes openapi/proto/asyncapi/readme/manifest", () => {
  assert.equal(classifyBoundaryPath("openapi.yaml"), "openapi");
  assert.equal(classifyBoundaryPath("api/openapi-v1.json"), "openapi");
  assert.equal(classifyBoundaryPath("swagger.yml"), "openapi");
  assert.equal(classifyBoundaryPath("svc/user.proto"), "proto");
  assert.equal(classifyBoundaryPath("asyncapi.yaml"), "asyncapi");
  assert.equal(classifyBoundaryPath("events/asyncapi-orders.json"), "asyncapi");
  assert.equal(classifyBoundaryPath("README.md"), "readme");
  assert.equal(classifyBoundaryPath("docs/readme.txt"), "readme");
  assert.equal(classifyBoundaryPath("package.json"), "manifest");
  assert.equal(classifyBoundaryPath("go.mod"), "manifest");
  assert.equal(classifyBoundaryPath("Cargo.toml"), "manifest");
  assert.equal(classifyBoundaryPath("pyproject.toml"), "manifest");
  assert.equal(classifyBoundaryPath("src/main.ts"), undefined);
});

test("buildBoundaryIndex lists paths only (no edges) and is deterministic", async () => {
  const root = await tempDir("okf-bnd-");
  await writeTree(root, {
    "README.md": "# r\n",
    "openapi.yaml": "openapi: 3.0.0\n",
    "api/v1/user.proto": "syntax = \"proto3\";\n",
    "events/asyncapi.yaml": "asyncapi: 2.0.0\n",
    "package.json": "{}\n",
    "src/index.ts": "export {};\n",
    "node_modules/pkg/package.json": "{}\n",
  });

  const a = await buildBoundaryIndex([
    { id: "svc", path: root, effectiveIgnores: DEFAULT_SOURCE_IGNORES },
  ]);
  const b = await buildBoundaryIndex([
    { id: "svc", path: root, effectiveIgnores: DEFAULT_SOURCE_IGNORES },
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.version, 1);

  const paths = a.entries.map((e) => e.path);
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("openapi.yaml"));
  assert.ok(paths.includes("api/v1/user.proto"));
  assert.ok(paths.includes("events/asyncapi.yaml"));
  assert.ok(paths.includes("package.json"));
  assert.ok(!paths.includes("src/index.ts"));
  // node_modules ignored
  assert.ok(!paths.some((p) => p.startsWith("node_modules/")));

  // Deterministic path order within source
  assert.deepEqual(
    paths,
    [...paths].sort((x, y) => x.localeCompare(y)),
  );
  // Every entry is path-only (sourceId + path + kind)
  for (const entry of a.entries) {
    assert.equal(entry.sourceId, "svc");
    assert.equal(typeof entry.path, "string");
    assert.ok(
      ["openapi", "proto", "asyncapi", "readme", "manifest"].includes(entry.kind),
    );
  }
});

test("buildBoundaryIndex multi-source preserves source order", async () => {
  const aRoot = await tempDir("okf-bnd-a-");
  const bRoot = await tempDir("okf-bnd-b-");
  await writeTree(aRoot, { "README.md": "a\n" });
  await writeTree(bRoot, { "openapi.yaml": "openapi: 3.0.0\n" });

  const index = await buildBoundaryIndex([
    { id: "backend", path: aRoot, effectiveIgnores: [] },
    { id: "frontend", path: bRoot, effectiveIgnores: [] },
  ]);

  assert.equal(index.entries[0]!.sourceId, "backend");
  assert.equal(index.entries[0]!.kind, "readme");
  assert.equal(index.entries[1]!.sourceId, "frontend");
  assert.equal(index.entries[1]!.kind, "openapi");
});
