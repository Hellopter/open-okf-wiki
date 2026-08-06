import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { checkpointRun, verifyCheckpoint } from "../scripts/lib/checkpoints.mjs";

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-handoff-v2-"));
  const workdir = path.join(root, ".wiki-agent", "runs", "run-1", "workdir");
  fs.mkdirSync(path.join(workdir, "analysis", "handoffs"), { recursive: true });
  return { root, workdir, run: { runId: "run-1", workdir } };
}

function proposal(phase, artifacts, inputCheckpointDigests = []) {
  return {
    version: 2,
    phase,
    producer: "test-owner",
    status: "complete",
    inputCheckpointDigests,
    artifacts,
    summary: `${phase} summary`,
    openQuestions: [],
  };
}

function publish(root, run, phase, value) {
  const proposalPath = `analysis/handoffs/${phase}.json`;
  writeJson(path.join(run.workdir, proposalPath), value);
  return checkpointRun(root, run, { phase, proposalPath });
}

describe("handoff checkpoints", () => {
  it("publishes immutable digest-bound handoffs and detects later artifact mutation", () => {
    const { root, workdir, run } = setup();
    const receipt = path.join(workdir, "analysis", "receipts", "discover.json");
    writeJson(receipt, { units: ["api"] });
    const discover = publish(root, run, "discover", proposal("discover", [
      { id: "survey-api", type: "survey-receipt", owner: "survey:api", path: "analysis/receipts/discover.json", dependsOn: [], coverageUnitIds: ["api"] },
    ]));
    assert.equal(discover.checkpoint.phase, "discover");
    assert.match(discover.checkpoint.checkpointDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(verifyCheckpoint(workdir, "discover").ok, true);

    const plan = path.join(workdir, "analysis", "spec.json");
    writeJson(plan, { version: 2, pages: [] });
    const planCheckpoint = publish(root, run, "plan", proposal("plan", [
      { id: "spec", type: "spec", owner: "planner", path: "analysis/spec.json", dependsOn: ["survey-api"] },
    ], [discover.checkpoint.checkpointDigest]));
    assert.equal(planCheckpoint.current.phase, "plan");
    assert.equal(verifyCheckpoint(workdir, "plan").ok, true);

    fs.appendFileSync(plan, "\n");
    const invalid = verifyCheckpoint(workdir, "plan");
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors[0], /artifact digest changed/i);
  });

  it("rejects handoff proposals with version 1 or wrong phase and names the mismatch", () => {
    const { root, workdir, run } = setup();
    const receipt = path.join(workdir, "analysis", "receipts", "discover.json");
    writeJson(receipt, { ok: true });
    const artifacts = [
      { id: "discover-receipt", type: "receipt", owner: "survey", path: "analysis/receipts/discover.json", dependsOn: [] },
    ];
    assert.throws(
      () => publish(root, run, "discover", { ...proposal("discover", artifacts), version: 1 }),
      /version=1.*want version=2/i,
    );
    assert.throws(
      () => publish(root, run, "discover", { ...proposal("discover", artifacts), version: "2" }),
      /version="2".*want version=2/i,
    );
    assert.throws(
      () => publish(root, run, "discover", proposal("survey", artifacts)),
      /phase="survey".*phase="discover"/i,
    );
  });

  it("rejects escapes, missing artifacts, invalid dependencies, duplicate ids, and conflicting page owners", () => {
    const { root, workdir, run } = setup();
    const receipt = path.join(workdir, "analysis", "receipts", "discover.json");
    writeJson(receipt, { ok: true });

    assert.throws(
      () => publish(root, run, "discover", proposal("discover", [{ id: "escape", type: "receipt", owner: "survey", path: "../outside.json", dependsOn: [] }])),
      /escapes|relative path/i,
    );
    assert.throws(
      () => publish(root, run, "discover", proposal("discover", [{ id: "missing", type: "receipt", owner: "survey", path: "analysis/receipts/missing.json", dependsOn: [] }])),
      /does not exist/i,
    );
    assert.throws(
      () => publish(root, run, "discover", proposal("discover", [{ id: "bad-dependency", type: "receipt", owner: "survey", path: "analysis/receipts/discover.json", dependsOn: ["unknown"] }])),
      /unknown artifact/i,
    );
    assert.throws(
      () => publish(root, run, "discover", proposal("discover", [
        { id: "same", type: "receipt", owner: "a", path: "analysis/receipts/discover.json", dependsOn: [] },
        { id: "same", type: "receipt", owner: "b", path: "analysis/receipts/discover.json", dependsOn: [] },
      ])),
      /not unique/i,
    );
    assert.throws(
      () => publish(root, run, "discover", proposal("discover", [
        { id: "a", type: "page", owner: "one", path: "analysis/receipts/discover.json", dependsOn: [], pagePaths: ["candidate/overview.md"] },
        { id: "b", type: "page", owner: "two", path: "analysis/receipts/discover.json", dependsOn: [], pagePaths: ["candidate/overview.md"] },
      ])),
      /multiple owners/i,
    );
  });

  it("fails closed when a proposed checkpoint lacks a valid predecessor or a regular proposal file", () => {
    const { root, workdir, run } = setup();
    fs.mkdirSync(path.join(workdir, "analysis", "receipts"), { recursive: true });
    writeJson(path.join(workdir, "analysis", "receipts", "write.json"), { ok: true });
    assert.throws(
      () => publish(root, run, "write", proposal("write", [{ id: "write", type: "receipt", owner: "writer", path: "analysis/receipts/write.json", dependsOn: [] }])),
      /predecessor|input checkpoint|transition/i,
    );

    const external = path.join(root, "outside.json");
    writeJson(external, proposal("discover", [{ id: "x", type: "receipt", owner: "survey", path: "analysis/receipts/write.json", dependsOn: [] }]));
    const proposalLink = path.join(workdir, "analysis", "handoffs", "linked.json");
    try {
      fs.symlinkSync(external, proposalLink);
      assert.throws(
        () => checkpointRun(root, run, { phase: "discover", proposalPath: "analysis/handoffs/linked.json" }),
        /symbolic link|regular file|proposal/i,
      );
    } catch (error) {
      if (error?.code !== "EPERM") throw error;
    }
  });
});
