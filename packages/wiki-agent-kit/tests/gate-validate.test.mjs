import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertCoverage,
  assertSemanticSufficiency,
  gatePlan,
  verifyPlanGate,
  writePlanGateReceipt,
} from "../scripts/lib/gate.mjs";
import {
  candidateSealStatus,
  regenerateIndexes,
  sealCandidate,
  validateWorkdir,
} from "../scripts/lib/validate.mjs";

function makePlanningWorkdir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gate-"));
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
    path.join(tmp, "analysis", "discovery-map.json"),
    JSON.stringify({ domains: [{ id: "domain:api", coverageUnitIds: ["api"] }], flows: [] }),
  );
  fs.writeFileSync(
    path.join(tmp, "analysis", "spec.json"),
    JSON.stringify({ pages: [{ path: "overview.md", critical: true, coverageUnitIds: ["api"] }] }),
  );
  return tmp;
}

describe("gates", () => {
  it("requires each coverage unit to be bound or structurally cancelled", () => {
    const inventory = { coverageUnits: [{ id: "api", required: true }] };
    assert.equal(assertCoverage({ inventory, spec: { pages: [] } }).ok, false);
    assert.equal(
      assertCoverage({
        inventory,
        spec: {
          pages: [],
          coverageCancellations: [{ coverageUnitId: "api", cancelled: true, reason: "out of scope" }],
        },
      }).ok,
      true,
    );
    const missingReason = assertCoverage({
      inventory,
      spec: { pages: [], coverageCancellations: [{ coverageUnitId: "api", cancelled: true }] },
    });
    assert.equal(missingReason.ok, false);
    assert.ok(missingReason.errors.some((error) => error.includes("reason")));
  });

  it("requires explicit cross-source evidence or cancellation", () => {
    const result = assertSemanticSufficiency({
      inventory: { tier: "L3", sourceCount: 2 },
      discoveryMap: { domains: [], flows: [] },
      spec: { pages: [{ path: "overview.md" }] },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("cross-source")));
  });

  it("binds gate receipts to the exact planning artifacts", () => {
    const workdir = makePlanningWorkdir();
    assert.equal(gatePlan(workdir).ok, true);
    const { receipt } = writePlanGateReceipt(workdir, "run-1", "kit-1");
    assert.ok(receipt);
    assert.equal(verifyPlanGate(workdir, "run-1", "kit-1").ok, true);
    fs.writeFileSync(
      path.join(workdir, "analysis", "spec.json"),
      JSON.stringify({ pages: [{ path: "overview.md", critical: true, coverageUnitIds: [] }] }),
    );
    const stale = verifyPlanGate(workdir, "run-1", "kit-1");
    assert.equal(stale.ok, false);
    assert.ok(stale.errors.some((error) => error.includes("gate") || error.includes("stale")));
  });
});

describe("candidate validation", () => {
  it("resolves local relative citations and seals a valid candidate", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-val-"));
    const candidate = path.join(tmp, "candidate");
    const source = path.join(tmp, "sources", "api", "src", "A.java");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.join(candidate, "modules"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "analysis"), { recursive: true });
    fs.writeFileSync(source, "line1\nline2\nline3\n");
    fs.writeFileSync(
      path.join(candidate, "overview.md"),
      [
        "---",
        "type: Overview",
        "title: Demo",
        "description: A demo page.",
        "---",
        "",
        "[Auth](./modules/auth.md)",
        "[Source: src/A.java L1-L2](../sources/api/src/A.java#L1-L2)",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(candidate, "modules", "auth.md"),
      [
        "---",
        "type: Module",
        "title: Auth",
        "description: Auth implementation.",
        "---",
        "",
        "[Source: src/A.java L2](../../sources/api/src/A.java#L2)",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmp, "analysis", "spec.json"),
      JSON.stringify({ pages: [{ path: "overview.md", critical: true }, { path: "modules/auth.md", critical: true }] }),
    );
    const result = validateWorkdir(tmp);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(regenerateIndexes(candidate).written >= 2);
    const manifest = sealCandidate(tmp, result);
    assert.ok(manifest.candidateDigest);
    assert.equal(candidateSealStatus(tmp).valid, true);
    fs.appendFileSync(path.join(candidate, "overview.md"), "changed after seal\n");
    assert.equal(candidateSealStatus(tmp).valid, false);
  });

  it("rejects legacy and escaping citations", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-val-bad-"));
    fs.mkdirSync(path.join(tmp, "candidate"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "sources", "api", "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "sources", "api", "src", "A.java"), "only line\n");
    fs.writeFileSync(
      path.join(tmp, "candidate", "overview.md"),
      [
        "---",
        "type: Overview",
        "title: Demo",
        "description: A demo page.",
        "---",
        "",
        "[Source](repo:src/A.java#L1)",
        "[Source: src/A.java L2](../sources/api/src/A.java#L2)",
        "[Source](../../outside.java#L1)",
        "",
      ].join("\n"),
    );
    const result = validateWorkdir(tmp);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("legacy repo:")));
    assert.ok(result.errors.some((error) => error.includes("line range out of bounds")));
    assert.ok(result.errors.some((error) => error.includes("frozen source")));
  });

  it("requires a Spec and rejects candidate pages outside it", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-val-spec-"));
    const candidate = path.join(tmp, "candidate");
    fs.mkdirSync(path.join(tmp, "sources", "api", "src"), { recursive: true });
    fs.mkdirSync(candidate, { recursive: true });
    fs.writeFileSync(path.join(tmp, "sources", "api", "src", "A.java"), "line\n");
    fs.writeFileSync(
      path.join(candidate, "extra.md"),
      ["---", "type: Concept", "title: Extra", "description: Extra page.", "---", "", "[Source](../sources/api/src/A.java#L1)"].join("\n"),
    );
    let result = validateWorkdir(tmp);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("missing or invalid Spec")));

    fs.mkdirSync(path.join(tmp, "analysis"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "analysis", "spec.json"), JSON.stringify({ pages: [] }));
    result = validateWorkdir(tmp);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("absent from the Spec")));
  });
});
