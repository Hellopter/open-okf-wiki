/**
 * Unit tests for pure discovery-map merge (plan.discover.reduce).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  mergeDiscoveryMapFromRoots,
  mergeScoutReceiptsToDiscoveryMap,
} from "./discovery-map-merge.js";

test("absorbScoutReceipt lifts lightweight source receipt into DiscoveryMap.sources", () => {
  const { map, errors } = mergeScoutReceiptsToDiscoveryMap([
    {
      raw: {
        version: 1,
        kind: "source",
        sourceId: "api",
        summary: "API surface looks REST-ish",
        ok: true,
        critical: true,
        openQuestions: ["auth?"],
        paths: ["src/api/index.ts"],
        taskLabel: "source:api",
      },
      nodeKey: "plan.scout.source-api",
    },
  ]);
  assert.equal(errors.length, 0);
  assert.equal(map.version, 1);
  assert.equal(map.sources.length, 1);
  assert.equal(map.sources[0]?.sourceId, "api");
  assert.ok(map.sources[0]?.evidencePaths.includes("src/api/index.ts"));
  assert.deepEqual(map.openQuestions, ["auth?"]);
  assert.ok(map.scoutKinds.includes("source"));
});

test("mergeScoutReceiptsToDiscoveryMap merges DiscoveryMap fragments + receipts", () => {
  const { map } = mergeScoutReceiptsToDiscoveryMap([
    {
      raw: {
        version: 1,
        sources: [
          {
            sourceId: "api",
            entryPoints: ["src/main.ts"],
            surfaces: [],
            purpose: "backend",
            evidencePaths: ["src/main.ts"],
          },
        ],
        domains: [
          {
            id: "auth",
            title: "Auth",
            scope: "login",
            coverageUnitIds: ["api"],
            evidencePaths: ["src/auth.ts"],
            readerQuestion: "How does auth work?",
          },
        ],
        flows: [],
        concepts: [],
        openQuestions: [],
        boundaryPaths: [],
        scoutKinds: ["domain"],
      },
      nodeKey: "plan.scout.domain",
    },
    {
      raw: {
        version: 1,
        kind: "source",
        sourceId: "web",
        summary: "SPA",
        ok: true,
        critical: true,
        paths: ["apps/web"],
      },
      nodeKey: "plan.scout.source-web",
    },
  ]);
  assert.equal(map.sources.length, 2);
  assert.equal(map.domains.length, 1);
  assert.ok(map.scoutKinds.includes("domain"));
  assert.ok(map.scoutKinds.includes("source"));
});

test("mergeDiscoveryMapFromRoots reads analysis/plan-scouts and writes discovery-map.json", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "okf-discovery-"));
  try {
    const scoutsDir = path.join(root, "analysis", "plan-scouts");
    mkdirSync(scoutsDir, { recursive: true });
    writeFileSync(
      path.join(scoutsDir, "entry.json"),
      `${JSON.stringify({
        version: 1,
        kind: "entry",
        summary: "entry scout",
        ok: true,
        critical: false,
        openQuestions: ["where is the main?"],
        paths: ["README.md"],
      })}\n`,
    );
    writeFileSync(
      path.join(scoutsDir, "source-api.json"),
      `${JSON.stringify({
        version: 1,
        kind: "source",
        sourceId: "api",
        summary: "source scout",
        ok: true,
        critical: true,
        paths: ["pkg/api"],
      })}\n`,
    );
    const outDir = path.join(root, "out");
    const { map, errors, outPath } = mergeDiscoveryMapFromRoots({ roots: [root], outDir });
    assert.equal(errors.length, 0);
    assert.equal(map.sources.length, 1);
    assert.equal(map.sources[0]?.sourceId, "api");
    assert.ok(map.openQuestions.includes("where is the main?"));
    assert.ok(outPath?.endsWith("discovery-map.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finalizeDiscoveryMap yields empty sealed map for zero receipts", () => {
  // Use public absorb path with empty merge.
  const { map } = mergeScoutReceiptsToDiscoveryMap([]);
  assert.equal(map.version, 1);
  assert.deepEqual(map.sources, []);
  assert.deepEqual(map.domains, []);
  assert.deepEqual(map.flows, []);
});
