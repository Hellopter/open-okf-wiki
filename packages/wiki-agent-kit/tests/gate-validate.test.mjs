import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertCoverage,
  assertPageAssignments,
  assertSemanticSufficiency,
  assertSurveyOutcomeCoverage,
  gatePlan,
  verifyPlanGate,
  writePlanGateReceipt,
} from "../scripts/lib/gate.mjs";
import { publishArtifacts } from "../scripts/lib/publish.mjs";
import { mergeSurveyReceipts } from "../scripts/lib/survey.mjs";
import { candidateSealStatus, regenerateIndexes, sealCandidate, validateWorkdir } from "../scripts/lib/validate.mjs";
import { writeSurveyReceipts } from "./survey-fixtures.mjs";

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function publish(root, workdir, phase, artifacts) {
  const artifactsPath = `analysis/receipts/${phase}-artifacts.json`;
  writeJson(path.join(workdir, artifactsPath), artifacts);
  return publishArtifacts(root, { runId: "run-1", workdir }, { phase, artifactsJsonPath: artifactsPath });
}

function setupPlanningRun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gate-v3-"));
  const workdir = path.join(root, "run", "workdir");
  fs.mkdirSync(path.join(workdir, "inputs"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "analysis", "receipts"), { recursive: true });
  const inventory = {
    tier: "L1",
    sourceCount: 1,
    sources: [{ sourceId: "api" }],
    coverageUnits: [
      { id: "api", kind: "source", sourceId: "api", path: ".", label: "api", required: true },
      { id: "api::web", kind: "surface", sourceId: "api", path: "web", label: "api::web", required: true },
    ],
  };
  writeJson(path.join(root, ".wiki-agent", "current.json"), {
    version: 3,
    runId: "run-1",
    workdir,
    phase: "frozen",
    status: "active",
    checkpointDigest: null,
  });
  writeJson(path.join(workdir, "inputs", "inventory.json"), inventory);
  writeJson(path.join(workdir, "inputs", "snapshot-manifest.json"), { version: 1, sources: [] });
  writeSurveyReceipts(workdir, inventory);
  const surveyMerge = mergeSurveyReceipts(workdir, { pass: 1 });
  const surveyArtifacts = JSON.parse(fs.readFileSync(path.join(workdir, surveyMerge.artifactsPath), "utf8"));
  const discover = publish(root, workdir, "discover", surveyArtifacts);
  const pages = [{ path: "overview.md", type: "Overview", critical: true, coverageUnitIds: ["api", "api::web"], owner: "integration" }];
  const assignments = [{ pagePath: "overview.md", owner: "integration", role: "integration", coverageUnitIds: ["api", "api::web"], dependsOn: ["survey:api"], sourceIds: ["api"] }];
  writeJson(path.join(workdir, "analysis", "spec.json"), { version: 2, pages, pageAssignments: assignments });
  writeJson(path.join(workdir, "analysis", "page-assignments.json"), assignments);
  writeJson(path.join(workdir, "analysis", "receipts", "plan.json"), { planned: true });
  const plan = publish(root, workdir, "plan", [
    { id: "plan-receipt", type: "receipt", path: "analysis/receipts/plan.json" },
    { id: "spec", type: "spec", path: "analysis/spec.json" },
    { id: "page-assignments", type: "assignment-map", path: "analysis/page-assignments.json" },
  ]);
  return { root, workdir, discover, plan, inventory, pages, assignments };
}

describe("v3 checkpoint plan gate", () => {
  it("requires coverage, semantic sufficiency, and a complete unique ownership graph", () => {
    const inventory = { coverageUnits: [{ id: "api", required: true }] };
    assert.equal(assertCoverage({ inventory, spec: { pages: [] } }).ok, false);
    assert.equal(
      assertCoverage({ inventory, spec: { pages: [], coverageCancellations: [{ coverageUnitId: "api", cancelled: true, reason: "excluded" }] } }).ok,
      true,
    );

    const semantic = assertSemanticSufficiency({
      inventory: { tier: "L3", sourceCount: 2 },
      discoveryMap: { domains: [], flows: [] },
      spec: { pages: [{ path: "overview.md" }] },
    });
    assert.equal(semantic.ok, false);
    assert.ok(semantic.errors.some((error) => /cross-source/i.test(error)));

    const ownership = assertPageAssignments({
      inventory: { coverageUnits: [{ id: "api" }] },
      spec: { pages: [{ path: "overview.md", coverageUnitIds: ["api"] }] },
      assignments: [
        { pagePath: "overview.md", owner: "one", role: "integration", coverageUnitIds: ["api"] },
        { pagePath: "overview.md", owner: "two", role: "integration", coverageUnitIds: ["api"] },
      ],
    });
    assert.equal(ownership.ok, false);
    assert.ok(ownership.errors.some((error) => /duplicates path/i.test(error)));

    const surveyQuality = {
      ok: true,
      receipts: [{ receipt: { coverageUnit: { id: "api" }, status: "skipped" } }],
    };
    const insufficientBound = assertSurveyOutcomeCoverage({
      inventory: { coverageUnits: [{ id: "api", required: true }] },
      surveyQuality,
      spec: { pages: [{ coverageUnitIds: ["api"] }], domains: [], coverageCancellations: [] },
    });
    assert.equal(insufficientBound.ok, false);
    assert.ok(insufficientBound.errors.some((error) => /requires explicit cancellation/i.test(error)));
    assert.ok(insufficientBound.errors.some((error) => /must not be bound/i.test(error)));

    const insufficientCancelled = assertSurveyOutcomeCoverage({
      inventory: { coverageUnits: [{ id: "api", required: true }] },
      surveyQuality,
      spec: { pages: [], domains: [], coverageCancellations: [{ coverageUnitId: "api", cancelled: true, reason: "source unavailable" }] },
    });
    assert.equal(insufficientCancelled.ok, true);
  });

  it("binds write authority to snapshot, discovery checkpoint, Spec, and assignments", () => {
    const { workdir } = setupPlanningRun();
    const initial = gatePlan(workdir);
    assert.equal(initial.ok, true, JSON.stringify(initial.errors));
    const { receipt } = writePlanGateReceipt(workdir, "run-1", "method-digest");
    assert.ok(receipt);
    assert.equal(verifyPlanGate(workdir, "run-1", "method-digest").ok, true);

    fs.appendFileSync(path.join(workdir, "analysis", "page-assignments.json"), "\n");
    const staleAssignments = verifyPlanGate(workdir, "run-1", "method-digest");
    assert.equal(staleAssignments.ok, false);
    assert.ok(staleAssignments.errors.some((error) => /assignments.*digest changed|artifact digest changed/i.test(error)));

    const snapshotRun = setupPlanningRun();
    writePlanGateReceipt(snapshotRun.workdir, "run-1", "method-digest");
    fs.appendFileSync(path.join(snapshotRun.workdir, "inputs", "snapshot-manifest.json"), "\n");
    const staleSnapshot = verifyPlanGate(snapshotRun.workdir, "run-1", "method-digest");
    assert.equal(staleSnapshot.ok, false);
    assert.ok(staleSnapshot.errors.some((error) => /snapshotManifest.*digest changed/i.test(error)));
  });
});

describe("v2 candidate validation", () => {
  it("requires every Spec page to have exactly one assignment and seals valid local citations", () => {
    const { workdir } = setupPlanningRun();
    const source = path.join(workdir, "sources", "api", "src", "A.js");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.join(workdir, "candidate"), { recursive: true });
    fs.writeFileSync(source, "export const answer = 42;\n");
    fs.writeFileSync(
      path.join(workdir, "candidate", "overview.md"),
      ["---", "type: Overview", "title: Demo", "description: A demo.", "---", "", "[Source: src/A.js L1](../sources/api/src/A.js#L1)", ""].join("\n"),
    );
    const result = validateWorkdir(workdir);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(regenerateIndexes(path.join(workdir, "candidate")).written >= 1);
    const manifest = sealCandidate(workdir, result);
    assert.match(manifest.candidateDigest, /^[a-f0-9]{64}$/);
    assert.equal(candidateSealStatus(workdir).valid, true);

    fs.appendFileSync(path.join(workdir, "candidate", "overview.md"), "tampered\n");
    assert.equal(candidateSealStatus(workdir).valid, false);
  });

  it("rejects unassigned and multiply-owned candidate paths", () => {
    const { workdir } = setupPlanningRun();
    fs.mkdirSync(path.join(workdir, "candidate"), { recursive: true });
    fs.mkdirSync(path.join(workdir, "sources", "api", "src"), { recursive: true });
    fs.writeFileSync(path.join(workdir, "sources", "api", "src", "A.js"), "line\n");
    fs.writeFileSync(
      path.join(workdir, "candidate", "extra.md"),
      ["---", "type: Concept", "title: Extra", "description: Extra.", "---", "", "[Source](../sources/api/src/A.js#L1)"].join("\n"),
    );
    let result = validateWorkdir(workdir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /absent from the Spec/i.test(error)));

    const assignmentsPath = path.join(workdir, "analysis", "page-assignments.json");
    const assignments = JSON.parse(fs.readFileSync(assignmentsPath, "utf8"));
    assignments.push({ ...assignments[0], owner: "other" });
    writeJson(assignmentsPath, assignments);
    result = validateWorkdir(workdir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /multiple owners/i.test(error)));
  });
});
