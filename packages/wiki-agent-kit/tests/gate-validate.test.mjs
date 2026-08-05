import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertCoverage,
  assertPageAssignments,
  assertSemanticSufficiency,
  gatePlan,
  verifyPlanGate,
  writePlanGateReceipt,
} from "../scripts/lib/gate.mjs";
import { checkpointRun } from "../scripts/lib/checkpoints.mjs";
import { candidateSealStatus, regenerateIndexes, sealCandidate, validateWorkdir } from "../scripts/lib/validate.mjs";

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setupPlanningRun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gate-v2-"));
  const workdir = path.join(root, "run", "workdir");
  fs.mkdirSync(path.join(workdir, "inputs"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "analysis", "handoffs"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "analysis", "receipts"), { recursive: true });
  const inventory = {
    tier: "L1",
    sourceCount: 1,
    sources: [{ sourceId: "api" }],
    coverageUnits: [{ id: "api", kind: "source", sourceId: "api", required: true }],
  };
  writeJson(path.join(workdir, "inputs", "inventory.json"), inventory);
  writeJson(path.join(workdir, "inputs", "snapshot-manifest.json"), { version: 1, sources: [] });
  writeJson(path.join(workdir, "analysis", "discovery-map.json"), {
    version: 2,
    sources: [{ sourceId: "api" }],
    domains: [{ id: "domain:api", coverageUnitIds: ["api"] }],
    flows: [],
    coverageUnits: inventory.coverageUnits,
  });
  writeJson(path.join(workdir, "analysis", "receipts", "discover.json"), { discovered: true });
  const proposalPath = path.join(workdir, "analysis", "handoffs", "discover.json");
  writeJson(proposalPath, {
    version: 2,
    phase: "discover",
    producer: "survey",
    inputCheckpointDigests: [],
    artifacts: [
      { id: "discover-receipt", type: "receipt", owner: "survey", path: "analysis/receipts/discover.json", dependsOn: [], coverageUnitIds: ["api"] },
      { id: "discovery-map", type: "discovery-map", owner: "survey", path: "analysis/discovery-map.json", dependsOn: ["discover-receipt"], coverageUnitIds: ["api"] },
    ],
  });
  const discover = checkpointRun(root, { runId: "run-1", workdir }, { phase: "discover", proposalPath: "analysis/handoffs/discover.json" });
  const pages = [{ path: "overview.md", type: "Overview", critical: true, coverageUnitIds: ["api"], owner: "integration" }];
  const assignments = [{ pagePath: "overview.md", owner: "integration", role: "integration", coverageUnitIds: ["api"], dependsOn: ["discover-receipt"], sourceIds: ["api"] }];
  writeJson(path.join(workdir, "analysis", "spec.json"), { version: 2, pages, pageAssignments: assignments });
  writeJson(path.join(workdir, "analysis", "page-assignments.json"), assignments);
  writeJson(path.join(workdir, "analysis", "receipts", "plan.json"), { planned: true });
  writeJson(path.join(workdir, "analysis", "handoffs", "plan.json"), {
    version: 2,
    phase: "plan",
    producer: "planner",
    inputCheckpointDigests: [discover.checkpoint.checkpointDigest],
    artifacts: [
      { id: "plan-receipt", type: "receipt", owner: "planner", path: "analysis/receipts/plan.json", dependsOn: ["discovery-map"] },
      { id: "spec", type: "spec", owner: "planner", path: "analysis/spec.json", dependsOn: ["discovery-map"] },
      { id: "page-assignments", type: "assignment-map", owner: "planner", path: "analysis/page-assignments.json", dependsOn: ["spec"] },
    ],
  });
  const plan = checkpointRun(root, { runId: "run-1", workdir }, { phase: "plan", proposalPath: "analysis/handoffs/plan.json" });
  return { root, workdir, discover, plan, inventory, pages, assignments };
}

describe("v2 plan gate", () => {
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
