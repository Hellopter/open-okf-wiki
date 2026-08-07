import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildInventory } from "../scripts/lib/inventory.mjs";

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

describe("inventory coverage units", () => {
  it("emits required source and package surface units with labels", () => {
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
    assert.equal(sourceUnit.id, "app");
    assert.equal(sourceUnit.label, "app");
    assert.equal(sourceUnit.required, true);
    assert.equal(sourceUnit.survey, undefined);
    assert.ok(surfaces.length >= 2);
    for (const surface of surfaces) {
      assert.equal(surface.required, true);
      assert.equal(surface.label, surface.id);
      assert.equal(surface.survey, undefined);
    }
  });
});
