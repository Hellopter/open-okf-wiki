import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { publishArtifacts } from "../scripts/lib/publish.mjs";
import { verifyCheckpoint } from "../scripts/lib/checkpoints.mjs";
import { mergeSurveyReceipts } from "../scripts/lib/survey.mjs";
import { writeSurveyReceipts } from "./survey-fixtures.mjs";

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-publish-v3-"));
  const workdir = path.join(root, ".wiki-agent", "runs", "run-1", "workdir");
  fs.mkdirSync(path.join(workdir, "analysis", "publish"), { recursive: true });
  const inventory = {
    tier: "L1",
    coverageUnits: [
      { id: "api", kind: "source", sourceId: "api", path: ".", label: "api", required: true },
      { id: "api::web", kind: "surface", sourceId: "api", path: "web", label: "api::web", required: true },
      { id: "optional", kind: "source", sourceId: "optional", path: ".", label: "optional", required: false },
    ],
  };
  writeJson(path.join(workdir, "inputs", "inventory.json"), inventory);
  writeJson(path.join(root, ".wiki-agent", "current.json"), {
    version: 3,
    runId: "run-1",
    workdir,
    phase: "frozen",
    status: "active",
    checkpointDigest: null,
  });
  return { root, workdir, inventory, run: { runId: "run-1", workdir } };
}

function publish(root, run, phase, artifacts) {
  const relative = `analysis/publish/${phase}.json`;
  writeJson(path.join(run.workdir, relative), artifacts);
  return publishArtifacts(root, run, { phase, artifactsJsonPath: relative });
}

function discoverArtifacts(workdir, inventory) {
  writeSurveyReceipts(workdir, inventory);
  const merged = mergeSurveyReceipts(workdir, { pass: 1 });
  return JSON.parse(fs.readFileSync(path.join(workdir, merged.artifactsPath), "utf8"));
}

describe("artifact checkpoint publishing", () => {
  it("publishes a minimal discover-to-plan chain and detects later artifact mutation", () => {
    const { root, workdir, inventory, run } = setup();
    const discovery = path.join(workdir, "analysis", "discovery-map.json");
    writeJson(discovery, { version: 2, coverageUnits: ["api", "api::web"] });
    const discover = publish(root, run, "discover", discoverArtifacts(workdir, inventory));
    assert.equal(discover.checkpoint.version, 3);
    assert.equal(discover.checkpoint.predecessorDigest, undefined);
    assert.equal("inputCheckpointDigests" in discover.checkpoint, false);
    assert.equal("producer" in discover.checkpoint, false);
    assert.deepEqual(Object.keys(discover.artifacts[0]).sort(), ["digest", "id", "path", "type"]);
    assert.deepEqual(Object.keys(discover.artifacts[1]).sort(), ["coverageUnitIds", "digest", "id", "path", "type"]);

    const spec = path.join(workdir, "analysis", "spec.json");
    writeJson(spec, { version: 2, pages: [] });
    const plan = publish(root, run, "plan", [{ id: "spec", type: "spec", path: "analysis/spec.json" }]);
    assert.equal(plan.checkpoint.predecessorDigest, discover.checkpointDigest);
    assert.equal(verifyCheckpoint(workdir, "plan").ok, true);

    fs.appendFileSync(spec, "\n");
    const invalid = verifyCheckpoint(workdir, "plan");
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors[0], /artifact digest changed/i);
  });

  it("requires the active checkpoint graph rather than caller-supplied predecessor data", () => {
    const { root, workdir, inventory, run } = setup();
    writeJson(path.join(workdir, "analysis", "spec.json"), { version: 2, pages: [] });
    assert.throws(
      () => publish(root, run, "plan", [{ id: "spec", type: "spec", path: "analysis/spec.json" }]),
      /requires active predecessor discover/i,
    );

    writeJson(path.join(workdir, "analysis", "discovery-map.json"), { version: 2 });
    publish(root, run, "discover", discoverArtifacts(workdir, inventory));
    const plan = publish(root, run, "plan", [{ id: "spec", type: "spec", path: "analysis/spec.json" }]);
    assert.match(plan.checkpoint.predecessorDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(plan.current.phase, "plan");
  });

  it("rejects a non-v3 active pointer before accepting artifacts", () => {
    const { root, workdir, inventory, run } = setup();
    writeJson(path.join(root, ".wiki-agent", "current.json"), {
      version: 2,
      runId: "run-1",
      workdir,
      phase: "frozen",
      status: "active",
      checkpointDigest: null,
    });
    writeJson(path.join(workdir, "analysis", "discovery-map.json"), { version: 2 });
    assert.throws(
      () => publish(root, run, "discover", [
        { id: "discovery-map", type: "discovery-map", path: "analysis/discovery-map.json", coverageUnitIds: ["api", "api::web"] },
      ]),
      /selected active run/i,
    );
  });

  it("requires full discovery coverage and rejects legacy control-plane fields", () => {
    const { root, workdir, inventory, run } = setup();
    writeJson(path.join(workdir, "analysis", "discovery-map.json"), { version: 2 });
    assert.throws(
      () => publish(root, run, "discover", [
        { id: "discovery-map", type: "discovery-map", path: "analysis/discovery-map.json", coverageUnitIds: ["api"] },
      ]),
      /do not cover required units: api::web/i,
    );
    assert.throws(
      () => publish(root, run, "discover", [
        { id: "discovery-map", type: "discovery-map", path: "analysis/discovery-map.json", coverageUnitIds: ["api", "api::web", "unknown"] },
      ]),
      /unknown coverage units: unknown/i,
    );
    assert.throws(
      () => publish(root, run, "discover", [
        { id: "discovery-map", type: "discovery-map", path: "analysis/discovery-map.json", coverageUnitIds: ["api", "api::web"], owner: "survey" },
      ]),
      /unsupported field: owner/i,
    );
  });

  it("requires a valid plan gate before publishing write-sources", () => {
    const { root, workdir, inventory, run } = setup();
    writeJson(path.join(workdir, "analysis", "discovery-map.json"), { version: 2 });
    publish(root, run, "discover", discoverArtifacts(workdir, inventory));
    writeJson(path.join(workdir, "analysis", "spec.json"), { version: 2, pages: [] });
    publish(root, run, "plan", [{ id: "spec", type: "spec", path: "analysis/spec.json" }]);
    writeJson(path.join(workdir, "candidate", "overview.md"), "draft\n");
    assert.throws(
      () => publish(root, { ...run, meta: { methodDigest: "sha256:test" } }, "write-sources", [
        { id: "candidate-page", type: "candidate-page", path: "candidate/overview.md" },
      ]),
      /requires a valid plan gate/i,
    );
  });

  it("rejects malformed artifact lists, escapes, symlinks, and non-discover coverage", () => {
    const { root, workdir, inventory, run } = setup();
    const descriptor = path.join(workdir, "analysis", "publish", "not-array.json");
    writeJson(descriptor, { artifacts: [] });
    assert.throws(
      () => publishArtifacts(root, run, { phase: "discover", artifactsJsonPath: "analysis/publish/not-array.json" }),
      /must contain an array/i,
    );

    writeJson(path.join(workdir, "analysis", "discovery-map.json"), { version: 2 });
    assert.throws(
      () => publish(root, run, "discover", [
        { id: "escape", type: "receipt", path: "../outside.json", coverageUnitIds: ["api", "api::web"] },
      ]),
      /escapes|relative path/i,
    );
    publish(root, run, "discover", discoverArtifacts(workdir, inventory));
    writeJson(path.join(workdir, "analysis", "spec.json"), { version: 2 });
    assert.throws(
      () => publish(root, run, "plan", [{ id: "spec", type: "spec", path: "analysis/spec.json", coverageUnitIds: [] }]),
      /only allowed for discover/i,
    );

    const external = path.join(root, "external.json");
    writeJson(external, []);
    const link = path.join(workdir, "analysis", "publish", "link.json");
    try {
      fs.symlinkSync(external, link);
      assert.throws(
        () => publishArtifacts(root, run, { phase: "plan", artifactsJsonPath: "analysis/publish/link.json" }),
        /regular non-symlink/i,
      );
    } catch (error) {
      if (error?.code !== "EPERM") throw error;
    }
  });
});
