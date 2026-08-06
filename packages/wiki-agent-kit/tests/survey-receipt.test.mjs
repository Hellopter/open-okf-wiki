import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertDiscoverSurveyQuality,
  assertSurveyReceipt,
  mergeSurveyReceipts,
} from "../scripts/lib/survey.mjs";

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function setup() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-survey-"));
  const inventory = {
    version: 1,
    tier: "L1",
    coverageUnits: [
      { id: "api", kind: "source", sourceId: "api", path: ".", label: "api", required: true },
      { id: "api::packages/web", kind: "surface", sourceId: "api", path: "packages/web", label: "api::packages/web", required: true },
    ],
  };
  writeJson(path.join(workdir, "inputs", "inventory.json"), inventory);
  fs.mkdirSync(path.join(workdir, "analysis", "receipts", "survey"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "sources", "api", "src"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "sources", "api", "packages", "web", "src"), { recursive: true });
  fs.writeFileSync(path.join(workdir, "sources", "api", "src", "index.js"), "export const api = true;\nexport default api;\n", "utf8");
  fs.writeFileSync(path.join(workdir, "sources", "api", "packages", "web", "src", "index.js"), "export const web = true;\n", "utf8");
  return { workdir, inventory };
}

function finding(id) {
  return { id, summary: `${id} summary` };
}

function receipt(unit, { status = "ok", retryable = false, domains = [{ id: "domain:api", summary: "API domain" }], pass } = {}) {
  const source = unit.kind === "surface"
    ? "sources/api/packages/web/src/index.js"
    : "sources/api/src/index.js";
  return {
    coverageUnit: {
      id: unit.id,
      kind: unit.kind,
      sourceId: unit.sourceId,
      path: unit.path,
      label: unit.label,
    },
    status,
    purpose: `${unit.id} purpose`,
    summary: `${unit.id} summary${pass ? ` pass ${pass}` : ""}`,
    entryPoints: [finding("entry")],
    modules: [finding("module")],
    runtimeFlows: [],
    contracts: [],
    evidence: status === "ok" ? [{ id: "e1", path: source, startLine: 1, endLine: 1, summary: "declaration" }] : [],
    plannerHints: { domains, flows: [] },
    openQuestions: [],
    ...(unit.kind === "source" ? { relatedCoverageUnitIds: ["api::packages/web"] } : {}),
    ...(status === "ok" ? {} : { insufficiency: { code: retryable ? "timeout" : "snapshot_missing", retryable, reason: "bounded failure" } }),
  };
}

function hostReceipt(unit, options) {
  return { version: 1, kind: "survey-receipt", ...receipt(unit, options) };
}

function writeReceipt(workdir, unit, pass, opts) {
  const safe = unit.id.replace(/[^A-Za-z0-9._:-]+/g, "-");
  const relative = `analysis/receipts/survey/${safe}-pass-${pass}.json`;
  writeJson(path.join(workdir, relative), receipt(unit, { ...opts, pass }));
  return relative;
}

describe("survey receipt contract", () => {
  it("accepts bounded source and surface receipts rooted in frozen evidence", () => {
    const { workdir, inventory } = setup();
    for (const unit of inventory.coverageUnits) {
      const result = assertSurveyReceipt({ workdir, inventory, receipt: hostReceipt(unit) });
      assert.equal(result.ok, true, result.errors.join("; "));
    }
  });

  it("rejects ungrounded, out-of-scope, and underspecified receipts", () => {
    const { workdir, inventory } = setup();
    const surface = inventory.coverageUnits[1];
    const invalid = hostReceipt(surface);
    invalid.evidence[0].path = "sources/api/src/index.js";
    invalid.evidence[0].endLine = 99;
    invalid.relatedCoverageUnitIds = [];
    invalid.modules = Array.from({ length: 25 }, (_, index) => finding(`module-${index}`));
    const result = assertSurveyReceipt({ workdir, inventory, receipt: invalid });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /escapes coverage unit/i.test(error)));
    assert.ok(result.errors.some((error) => /surface receipt must not/i.test(error)));
    assert.ok(result.errors.some((error) => /modules exceeds/i.test(error)));

    const failed = hostReceipt(surface, { status: "failed" });
    delete failed.insufficiency;
    const failedResult = assertSurveyReceipt({ workdir, inventory, receipt: failed });
    assert.equal(failedResult.ok, false);
    assert.ok(failedResult.errors.some((error) => /requires insufficiency/i.test(error)));
  });

  it("merges the latest valid receipt per unit and preserves permanent insufficiency", () => {
    const { workdir } = setup();
    const inventory = JSON.parse(fs.readFileSync(path.join(workdir, "inputs", "inventory.json"), "utf8"));
    const [source, surface] = inventory.coverageUnits;
    writeReceipt(workdir, source, 1, { status: "failed", retryable: true });
    writeReceipt(workdir, source, 2, { status: "ok", domains: [{ id: "domain:api", summary: "API" }] });
    writeReceipt(workdir, surface, 1, { status: "skipped", retryable: false, domains: [{ id: "domain:web", summary: "Web" }] });

    const merged = mergeSurveyReceipts(workdir, { pass: 2 });
    assert.deepEqual(merged.missingUnitIds, []);
    assert.deepEqual(merged.retryUnitIds, []);
    assert.deepEqual(merged.selectedUnitIds, ["api", "api::packages/web"]);
    const map = JSON.parse(fs.readFileSync(path.join(workdir, "analysis", "discovery-map.json"), "utf8"));
    assert.deepEqual(map.domains.map((domain) => domain.id), ["domain:api", "domain:web"]);
    assert.equal(map.ledger.find((entry) => entry.coverageUnitId === "api::packages/web").status, "skipped");
    const artifacts = JSON.parse(fs.readFileSync(path.join(workdir, merged.artifactsPath), "utf8"));
    assert.ok(artifacts.filter((artifact) => artifact.type === "survey-receipt").every((artifact) => artifact.path.startsWith("analysis/receipts/survey-host/")));
    const canonical = JSON.parse(fs.readFileSync(path.join(workdir, artifacts.find((artifact) => artifact.id === "survey:api").path), "utf8"));
    assert.equal(canonical.version, 1);
    assert.equal(canonical.kind, "survey-receipt");
    assert.ok(artifacts.some((artifact) => artifact.type === "survey-merge"));
    const quality = assertDiscoverSurveyQuality(workdir, artifacts);
    assert.equal(quality.ok, true, quality.errors.join("; "));

    canonical.summary = "tampered host receipt";
    writeJson(path.join(workdir, artifacts.find((artifact) => artifact.id === "survey:api").path), canonical);
    const tampered = assertDiscoverSurveyQuality(workdir, artifacts);
    assert.equal(tampered.ok, false);
    assert.ok(tampered.errors.some((error) => /host materialization/i.test(error)));
  });

  it("rejects worker-authored control envelopes and direct worker receipt publishing", () => {
    const { workdir, inventory } = setup();
    const [source, surface] = inventory.coverageUnits;
    writeJson(path.join(workdir, "analysis", "receipts", "survey", "source-pass-1.json"), hostReceipt(source));
    writeReceipt(workdir, surface, 1, {});
    const merged = mergeSurveyReceipts(workdir, { pass: 1 });
    assert.deepEqual(merged.selectedUnitIds, ["api::packages/web"]);
    assert.ok(merged.invalidReceiptPaths.includes("analysis/receipts/survey/source-pass-1.json"));

    const directArtifacts = [
      { id: "discovery-map", type: "discovery-map", path: "analysis/discovery-map.json" },
      { id: "survey:api", type: "survey-receipt", path: "analysis/receipts/survey/source-pass-1.json", coverageUnitIds: ["api"] },
    ];
    const quality = assertDiscoverSurveyQuality(workdir, directArtifacts);
    assert.equal(quality.ok, false);
    assert.ok(quality.errors.some((error) => /unsafe path/i.test(error)));
  });

  it("requests retries for absent and retryable receipts, then accepts a bounded labels fallback", () => {
    const { workdir } = setup();
    const inventory = JSON.parse(fs.readFileSync(path.join(workdir, "inputs", "inventory.json"), "utf8"));
    const [source, surface] = inventory.coverageUnits;
    writeReceipt(workdir, source, 1, { status: "failed", retryable: true, domains: [] });
    const first = mergeSurveyReceipts(workdir, { pass: 1 });
    assert.deepEqual(first.retryUnitIds, ["api", "api::packages/web"]);
    assert.equal(first.needsDomainLabels, true);

    writeReceipt(workdir, source, 2, { domains: [] });
    writeReceipt(workdir, surface, 2, { domains: [] });
    const labelsPath = "analysis/receipts/discovery-labels-pass-2.json";
    writeJson(path.join(workdir, labelsPath), {
      domains: [{ id: "domain:application", summary: "Application", coverageUnitIds: ["api", "api::packages/web"] }],
      flows: [],
    });
    const merged = mergeSurveyReceipts(workdir, { pass: 2, labelsPath });
    assert.equal(merged.needsDomainLabels, false);
    const artifacts = JSON.parse(fs.readFileSync(path.join(workdir, merged.artifactsPath), "utf8"));
    assert.ok(artifacts.some((artifact) => artifact.type === "discovery-labels"));
  });

  it("rejects a merge list that predates a newer valid worker receipt", () => {
    const { workdir, inventory } = setup();
    const [source, surface] = inventory.coverageUnits;
    writeReceipt(workdir, source, 1, {});
    writeReceipt(workdir, surface, 1, {});
    const first = mergeSurveyReceipts(workdir, { pass: 1 });
    const artifacts = JSON.parse(fs.readFileSync(path.join(workdir, first.artifactsPath), "utf8"));
    writeReceipt(workdir, source, 2, { domains: [{ id: "domain:api-v2", summary: "API v2" }] });
    const quality = assertDiscoverSurveyQuality(workdir, artifacts);
    assert.equal(quality.ok, false);
    assert.ok(quality.errors.some((error) => /artifact is stale/i.test(error)));
  });
});
