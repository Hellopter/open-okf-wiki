import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildInventory } from "../scripts/lib/inventory.mjs";
import { defaultLimits, normalizeLimits } from "../scripts/lib/limits.mjs";

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

describe("inventory survey tags and limits defaults", () => {
  it("tags source units always and package surfaces on-demand", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-inv-"));
    const source = path.join(root, "repo");
    writeTree(source, {
      "package.json": '{"name":"root"}',
      "packages/core/package.json": '{"name":"core"}',
      "packages/api/package.json": '{"name":"api"}',
      "packages/core/src/index.js": "export {}",
      "packages/api/src/index.js": "export {}",
    });
    const workspace = {
      wikiLanguage: "en",
      sources: [{ id: "app", type: "path", path: source }],
    };
    const inventory = buildInventory(root, workspace, {
      sourceRoots: new Map([["app", source]]),
    });
    const sourceUnit = inventory.coverageUnits.find((u) => u.kind === "source");
    const surfaces = inventory.coverageUnits.filter((u) => u.kind === "surface");
    assert.equal(sourceUnit.survey, "always");
    assert.equal(sourceUnit.label, "app");
    assert.equal(sourceUnit.required, true);
    assert.ok(surfaces.length >= 2);
    for (const surface of surfaces) {
      assert.equal(surface.survey, "on-demand");
      assert.equal(surface.required, true);
      assert.equal(surface.label, surface.id);
    }
  });

  it("defaults batchConcurrency by source count", () => {
    assert.equal(defaultLimits({ sourceCount: 1 }).batchConcurrency, 4);
    assert.equal(defaultLimits({ sourceCount: 2 }).batchConcurrency, 3);
    assert.equal(defaultLimits({ sourceCount: 1 }).perSourceConcurrency, 2);
    const multi = normalizeLimits(undefined, { sourceCount: 3 });
    assert.deepEqual(multi, {
      batchConcurrency: 3,
      perSourceConcurrency: 2,
      maxCoveragePasses: 2,
      maxRepairRounds: 2,
    });
    const clamped = normalizeLimits(
      { batchConcurrency: 99, perSourceConcurrency: 50, maxCoveragePasses: 9, maxRepairRounds: 0 },
      { sourceCount: 1 },
    );
    assert.equal(clamped.batchConcurrency, 8);
    assert.equal(clamped.perSourceConcurrency, 8);
    assert.equal(clamped.maxCoveragePasses, 4);
    assert.equal(clamped.maxRepairRounds, 1);
  });
});
