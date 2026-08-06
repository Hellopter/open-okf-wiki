import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildHandoffProposal,
  defaultHandoffOut,
  handoffPublish,
  handoffWrite,
  parseArtifactFlag,
  validateHandoffProposalShape,
} from "../scripts/lib/handoff.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const owBin = path.resolve(__dirname, "../scripts/ow.mjs");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setupRun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-handoff-cli-"));
  const workdir = path.join(root, ".wiki-agent", "runs", "run-1", "workdir");
  fs.mkdirSync(path.join(workdir, "analysis", "handoffs"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "analysis", "receipts"), { recursive: true });
  writeJson(path.join(root, ".wiki-agent", "current.json"), {
    version: 2,
    runId: "run-1",
    workdir: path.relative(root, workdir),
    phase: "frozen",
    status: "active",
    checkpointDigest: null,
    updatedAt: new Date().toISOString(),
  });
  writeJson(path.join(root, ".wiki-agent", "runs", "run-1", "meta.json"), {
    runId: "run-1",
    workdir: path.relative(root, workdir),
    methodDigest: "sha256:" + "a".repeat(64),
  });
  return { root, workdir, run: { runId: "run-1", workdir } };
}

describe("handoff library", () => {
  it("always emits version 2 even if caller asks for 1", () => {
    const proposal = buildHandoffProposal({
      version: 1,
      phase: "discover",
      producer: "survey",
      inputCheckpointDigests: [],
      artifacts: [{ id: "map", type: "discovery-map", owner: "survey", path: "analysis/discovery-map.json", dependsOn: [] }],
    });
    assert.equal(proposal.version, 2);
    assert.equal(proposal.phase, "discover");
  });

  it("parses artifact flags with optional dependsOn", () => {
    const a = parseArtifactFlag("map:discovery-map:survey:analysis/discovery-map.json");
    assert.deepEqual(a, {
      id: "map",
      type: "discovery-map",
      owner: "survey",
      path: "analysis/discovery-map.json",
      dependsOn: [],
    });
    const b = parseArtifactFlag("spec:spec:planner:analysis/spec.json:map,discover-receipt");
    assert.equal(b.path, "analysis/spec.json");
    assert.deepEqual(b.dependsOn, ["map", "discover-receipt"]);
  });

  it("rejects bad artifact grammar", () => {
    assert.throws(() => parseArtifactFlag("only-two:parts"), /invalid artifact flag/i);
  });

  it("writes and shape-validates a proposal", () => {
    const { workdir } = setupRun();
    writeJson(path.join(workdir, "analysis", "discovery-map.json"), { version: 1, domains: [], flows: [], coverageUnits: [] });
    const written = handoffWrite(workdir, {
      phase: "discover",
      out: "analysis/handoffs/discovery-pass-1.json",
      producer: "discovery-reducer",
      artifactFlags: ["map:discovery-map:survey:analysis/discovery-map.json"],
      summary: "ok",
    });
    assert.equal(written.proposal.version, 2);
    const onDisk = JSON.parse(fs.readFileSync(path.join(workdir, written.proposalPath), "utf8"));
    assert.equal(onDisk.version, 2);
    const shape = validateHandoffProposalShape(onDisk, { phase: "discover" });
    assert.equal(shape.ok, true);
    assert.equal(defaultHandoffOut("discover", { pass: 2 }), "analysis/handoffs/discovery-pass-2.json");
  });

  it("publishes discover checkpoint when artifacts exist", () => {
    const { root, workdir, run } = setupRun();
    writeJson(path.join(workdir, "analysis", "discovery-map.json"), {
      version: 1,
      domains: [{ id: "d1" }],
      flows: [],
      coverageUnits: [{ id: "app" }],
    });
    const result = handoffPublish(root, run, {
      phase: "discover",
      out: "analysis/handoffs/discovery-pass-1.json",
      producer: "discovery-reducer",
      artifactFlags: ["map:discovery-map:survey:analysis/discovery-map.json"],
      summary: "discovered",
    });
    assert.equal(result.status, "ok");
    assert.ok(result.checkpointDigest);
    assert.ok(fs.existsSync(path.join(workdir, "analysis", "checkpoints", "discover.json")));
  });

  it("fails publish when artifact file is missing", () => {
    const { root, run } = setupRun();
    assert.throws(
      () =>
        handoffPublish(root, run, {
          phase: "discover",
          out: "analysis/handoffs/discovery-pass-1.json",
          producer: "discovery-reducer",
          artifactFlags: ["map:discovery-map:survey:analysis/discovery-map.json"],
        }),
      /does not exist/i,
    );
  });

  it("validateHandoffProposalShape reports version and phase mismatches", () => {
    const bad = {
      version: 1,
      phase: "survey",
      producer: "x",
      inputCheckpointDigests: [],
      artifacts: [{ id: "a", type: "t", owner: "o", path: "analysis/x.json", dependsOn: [] }],
    };
    const result = validateHandoffProposalShape(bad, { phase: "discover" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /version must be number 2/i.test(e)));
    assert.ok(result.errors.some((e) => /phase mismatch/i.test(e)));
  });
});

describe("ow handoff CLI", () => {
  it("writes a proposal via CLI", () => {
    const { root, workdir } = setupRun();
    // Minimal workspace files for resolveRun/load if needed — resolveRun uses current.json
    writeJson(path.join(workdir, "analysis", "discovery-map.json"), { version: 1, domains: [], flows: [], coverageUnits: [] });
    // workspace.yaml may be required by some paths — resolveRun only needs current
    const result = spawnSync(
      process.execPath,
      [
        owBin,
        "handoff",
        "write",
        "--workspace",
        root,
        "--phase",
        "discover",
        "--producer",
        "discovery-reducer",
        "--out",
        "analysis/handoffs/discovery-pass-1.json",
        "--artifact",
        "map:discovery-map:survey:analysis/discovery-map.json",
        "--summary",
        "cli-ok",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const json = JSON.parse(result.stdout);
    assert.equal(json.status, "ok");
    assert.equal(json.proposal.version, 2);
  });
});
