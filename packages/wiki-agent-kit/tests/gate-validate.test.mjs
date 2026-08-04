import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertCoverage,
  assertSemanticSufficiency,
  gatePlan,
  loadDiscoveryMap,
} from "../scripts/lib/gate.mjs";
import { regenerateIndexes, validateWorkdir } from "../scripts/lib/validate.mjs";

describe("gates", () => {
  it("assertCoverage fails when unit unbound", () => {
    const r = assertCoverage({
      inventory: {
        coverageUnits: [{ id: "api", kind: "source", sourceId: "api", required: true }],
      },
      spec: { pages: [{ path: "overview.md", purpose: "x", critical: true }] },
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("api")));
  });

  it("assertCoverage passes when bound", () => {
    const r = assertCoverage({
      inventory: {
        coverageUnits: [{ id: "api", kind: "source", sourceId: "api", required: true }],
      },
      spec: {
        pages: [{ path: "overview.md", purpose: "x", critical: true, coverageUnitIds: ["api"] }],
      },
    });
    assert.equal(r.ok, true);
  });

  it("assertCoverage fails cancel without notes", () => {
    const r = assertCoverage({
      inventory: {
        coverageUnits: [{ id: "api", kind: "source", sourceId: "api", required: true }],
      },
      spec: {
        pages: [],
        sourceCoverage: [{ sourceId: "api", cancelled: true }],
      },
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("notes")));
  });

  it("assertCoverage accepts cancel with non-empty notes", () => {
    const r = assertCoverage({
      inventory: {
        coverageUnits: [{ id: "api", kind: "source", sourceId: "api", required: true }],
      },
      spec: {
        pages: [],
        sourceCoverage: [{ sourceId: "api", cancelled: true, notes: "out of scope" }],
      },
    });
    assert.equal(r.ok, true);
  });

  it("semantic sufficiency fails L2 with empty domains", () => {
    const r = assertSemanticSufficiency({
      inventory: { tier: "L2", sourceCount: 1 },
      discoveryMap: { domains: [], flows: [] },
      spec: { pages: [{ path: "overview.md" }] },
    });
    assert.equal(r.ok, false);
  });

  it("gatePlan prefers analysis discovery-map with domains over inputs shell", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gate-map-"));
    fs.mkdirSync(path.join(tmp, "inputs"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "inputs", "inventory.json"),
      JSON.stringify({
        tier: "L1",
        sourceCount: 1,
        coverageUnits: [{ id: "api", kind: "source", sourceId: "api", required: true }],
      }),
    );
    fs.writeFileSync(
      path.join(tmp, "inputs", "discovery-map.json"),
      JSON.stringify({ domains: [], flows: [], coverageUnits: [] }),
    );
    fs.writeFileSync(
      path.join(tmp, "analysis", "discovery-map.json"),
      JSON.stringify({
        domains: [{ id: "domain:auth", title: "Auth", coverageUnitIds: ["api"] }],
        flows: [],
      }),
    );
    fs.writeFileSync(
      path.join(tmp, "analysis", "spec.json"),
      JSON.stringify({
        pages: [
          {
            path: "overview.md",
            purpose: "x",
            critical: true,
            coverageUnitIds: ["api"],
          },
        ],
      }),
    );

    const map = loadDiscoveryMap(tmp);
    assert.equal(map.domains.length, 1);
    assert.equal(map.domains[0].id, "domain:auth");

    const result = gatePlan(tmp);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });
});

describe("validate", () => {
  it("requires frontmatter and resolves citations", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-val-"));
    const wiki = path.join(tmp, "wiki");
    const sources = path.join(tmp, "sources", "api");
    fs.mkdirSync(path.join(sources, "src"), { recursive: true });
    fs.writeFileSync(path.join(sources, "src", "A.java"), "line1\nline2\nline3\n");
    fs.mkdirSync(wiki, { recursive: true });
    fs.writeFileSync(
      path.join(wiki, "overview.md"),
      `---
type: Overview
title: Demo
description: A demo page.
---

Hello [Source](repo:api/src/A.java#L1-L2).
`,
    );
    const ok = validateWorkdir(tmp);
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));

    fs.writeFileSync(path.join(wiki, "bad.md"), "# no fm\n");
    const bad = validateWorkdir(tmp);
    assert.equal(bad.ok, false);

    const { written } = regenerateIndexes(wiki);
    assert.ok(written >= 1);
    assert.ok(fs.existsSync(path.join(wiki, "index.md")));
  });
});
