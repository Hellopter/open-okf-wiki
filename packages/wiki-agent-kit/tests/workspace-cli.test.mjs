import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OW = path.resolve(__dirname, "../scripts/ow.mjs");

function ow(args, cwd) {
  return spawnSync(process.execPath, [OW, ...args], { cwd, encoding: "utf8" });
}

function json(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-v2-"));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "src", "app.js"), "export const answer = 42;\n");
  fs.mkdirSync(path.join(source, "target"), { recursive: true });
  fs.writeFileSync(path.join(source, "target", "ignored.class"), "ignored");
  const workspace = path.join(root, "workspace");
  const initialized = json(ow(["init", workspace, "--name", "v2-demo", "--lang", "zh", "--path", source, "--id", "app"], root));
  return { root, source, workspace, initialized };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function handoff({ phase, inputCheckpointDigests = [], artifacts, producer = "test" }) {
  return {
    version: 2,
    phase,
    producer,
    status: "complete",
    inputCheckpointDigests,
    artifacts,
    summary: `${phase} handoff`,
    openQuestions: [],
  };
}

function checkpoint(workspace, phase, proposal) {
  const proposalPath = `analysis/handoffs/${phase}.json`;
  writeJson(path.join(proposal.workdir, proposalPath), proposal.value);
  return json(ow(["checkpoint", "--phase", phase, "--proposal", proposalPath, "--workspace", workspace], workspace));
}

function makePlanReady(workspace, prepared) {
  const { workdir, runId } = prepared;
  const inventory = JSON.parse(fs.readFileSync(path.join(workdir, "inputs", "inventory.json"), "utf8"));
  const coverageUnitId = inventory.coverageUnits[0].id;
  writeJson(path.join(workdir, "analysis", "discovery-map.json"), {
    version: 2,
    sources: [{ sourceId: "app" }],
    domains: [{ id: "domain:app", coverageUnitIds: [coverageUnitId] }],
    flows: [],
    coverageUnits: inventory.coverageUnits,
  });
  const discoverReceipt = path.join(workdir, "analysis", "receipts", "discover.json");
  writeJson(discoverReceipt, { coverageUnitId, evidence: ["sources/app/src/app.js"] });
  const discover = checkpoint(workspace, "discover", {
    workdir,
    value: handoff({
      phase: "discover",
      artifacts: [
        { id: "discover-receipt", type: "receipt", owner: "survey:app", path: "analysis/receipts/discover.json", dependsOn: [], coverageUnitIds: [coverageUnitId] },
        { id: "discovery-map", type: "discovery-map", owner: "survey:app", path: "analysis/discovery-map.json", dependsOn: ["discover-receipt"], coverageUnitIds: [coverageUnitId] },
      ],
    }),
  });
  const pages = [{ path: "overview.md", type: "Overview", critical: true, coverageUnitIds: [coverageUnitId], owner: "integration" }];
  const pageAssignments = [{ pagePath: "overview.md", owner: "integration", role: "integration", coverageUnitIds: [coverageUnitId], dependsOn: ["discover-receipt"], sourceIds: ["app"] }];
  writeJson(path.join(workdir, "analysis", "spec.json"), { version: 2, wikiLanguage: "zh", pages, pageAssignments });
  writeJson(path.join(workdir, "analysis", "page-assignments.json"), pageAssignments);
  const planReceipt = path.join(workdir, "analysis", "receipts", "plan.json");
  writeJson(planReceipt, { planned: true });
  const plan = checkpoint(workspace, "plan", {
    workdir,
    value: handoff({
      phase: "plan",
      inputCheckpointDigests: [discover.checkpointDigest],
      artifacts: [
        { id: "plan-receipt", type: "receipt", owner: "planner", path: "analysis/receipts/plan.json", dependsOn: ["discovery-map"] },
        { id: "spec", type: "spec", owner: "planner", path: "analysis/spec.json", dependsOn: ["discovery-map"] },
        { id: "page-assignments", type: "assignment-map", owner: "planner", path: "analysis/page-assignments.json", dependsOn: ["spec"] },
      ],
    }),
  });
  const gate = json(ow(["gate", "plan", "--workspace", workspace], workspace));
  assert.equal(gate.ok, true, JSON.stringify(gate));
  assert.equal(gate.receipt.version, 2);
  assert.equal(runId, gate.current.runId);
  return { workdir, runId, coverageUnitId, discover, plan, gate };
}

function makeWriteReviewReady(workspace, ready) {
  const { workdir } = ready;
  fs.writeFileSync(path.join(workdir, "candidate", "overview.md"), [
    "---",
    "type: Overview",
    "title: Demo",
    "description: A source-grounded demo.",
    "---",
    "",
    "[Source: app.js L1](../sources/app/src/app.js#L1)",
    "",
  ].join("\n"));
  writeJson(path.join(workdir, "analysis", "receipts", "write-sources.json"), { pages: ["overview.md"] });
  const writeSources = checkpoint(workspace, "write-sources", {
    workdir,
    value: handoff({
      phase: "write-sources",
      inputCheckpointDigests: [ready.plan.checkpointDigest],
      artifacts: [{ id: "domain-pages", type: "candidate-pages", owner: "integration", path: "candidate/overview.md", dependsOn: ["spec"], pagePaths: ["candidate/overview.md"] }],
    }),
  });
  writeJson(path.join(workdir, "analysis", "receipts", "write.json"), { integrated: true });
  const write = checkpoint(workspace, "write", {
    workdir,
    value: handoff({
      phase: "write",
      inputCheckpointDigests: [writeSources.checkpointDigest],
      artifacts: [{ id: "write-receipt", type: "receipt", owner: "integration", path: "analysis/receipts/write.json", dependsOn: ["domain-pages"] }],
    }),
  });
  writeJson(path.join(workdir, "analysis", "receipts", "review-1.json"), { clean: true });
  const review = checkpoint(workspace, "review-1", {
    workdir,
    value: handoff({
      phase: "review-1",
      inputCheckpointDigests: [write.checkpointDigest],
      artifacts: [{ id: "review-receipt", type: "review", owner: "reviewer", path: "analysis/receipts/review-1.json", dependsOn: ["write-receipt"] }],
    }),
  });
  writeJson(path.join(workdir, "analysis", "defects.json"), { version: 2, clean: true, defects: [] });
  return { writeSources, write, review };
}

describe("ow v2 workspace and lifecycle", () => {
  it("installs exactly one native workflow and a v2 runtime manifest", () => {
    const { workspace, initialized } = makeWorkspace();
    assert.equal(initialized.format, "yaml");
    assert.equal(initialized.wikiLanguage, "zh");
    const config = YAML.parse(fs.readFileSync(path.join(workspace, "workspace.yaml"), "utf8"));
    assert.equal(config.version, 2);
    assert.ok(!fs.existsSync(path.join(workspace, "workspace.json")));
    assert.ok(!fs.existsSync(path.join(workspace, "workspace.yml")));

    const workflow = path.join(workspace, ".claude", "workflows", "wiki.workflow.js");
    const runtime = JSON.parse(fs.readFileSync(path.join(workspace, ".wiki-agent", "runtime.json"), "utf8"));
    assert.ok(fs.existsSync(workflow));
    assert.equal(runtime.version, 2);
    assert.equal(runtime.workflow.path, workflow);
    assert.match(runtime.workflow.digest, /^[a-f0-9]{64}$/);
    assert.ok(!fs.existsSync(path.join(workspace, ".claude", "skills", "wiki")));
    assert.ok(!fs.existsSync(path.join(workspace, ".claude", "skills", "repository-wiki-producer")));
    for (const legacy of ["wiki-plan.workflow.js", "wiki-write-review.workflow.js", "wiki-produce.workflow.js"]) {
      assert.ok(!fs.existsSync(path.join(workspace, ".claude", "workflows", legacy)));
    }
    const help = ow(["help"], workspace);
    assert.equal(help.status, 0, help.stderr);
    assert.doesNotMatch(help.stdout, /\bow (?:run|freeze|approve|retry)\b/);
    for (const command of ["run", "freeze", "approve", "retry"]) {
      assert.notEqual(ow([command, "--workspace", workspace], workspace).status, 0, `${command} must not remain a v2 CLI command`);
    }

    const status = json(ow(["status", "--workspace", workspace], workspace));
    assert.equal(status.workflow, "/wiki");
    assert.equal(status.current, null);
    const rejected = ow(["init", path.join(workspace, "wrong"), "--format", "json"], workspace);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /workspace v2 always uses workspace\.yaml/i);
  });

  it("prepares, resumes, gates, retries, and never falls back to the newest run", () => {
    const { workspace } = makeWorkspace();
    const first = json(ow(["prepare", "--mode", "auto", "--workspace", workspace], workspace));
    assert.equal(first.startAt, "survey");
    assert.match(first.summary, /created frozen run/i);
    assert.ok(fs.existsSync(path.join(first.workdir, "method", "METHOD.md")));
    assert.ok(!fs.existsSync(path.join(first.workdir, "method", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(first.workdir, "sources", "app", "src", "app.js")));
    assert.ok(!fs.existsSync(path.join(first.workdir, "sources", "app", "target", "ignored.class")));
    const current = JSON.parse(fs.readFileSync(path.join(workspace, ".wiki-agent", "current.json"), "utf8"));
    assert.deepEqual(Object.keys(current).sort(), ["checkpointDigest", "phase", "runId", "status", "updatedAt", "version", "workdir"]);
    assert.ok(!fs.existsSync(path.join(workspace, ".wiki-agent", "next-action.json")));

    const resumed = json(ow(["prepare", "--mode", "auto", "--workspace", workspace], workspace));
    assert.equal(resumed.startAt, "survey");
    assert.match(resumed.summary, /resuming survey/i);
    assert.equal(resumed.runId, first.runId);
    const focused = json(ow(["prepare", "--mode", "auto", "--focus", "authentication flow", "--workspace", workspace], workspace));
    assert.equal(focused.startAt, "survey");
    assert.match(focused.summary, /created frozen run/i);
    assert.notEqual(focused.runId, first.runId);

    const missingPlan = ow(["prepare", "--mode", "write", "--workspace", workspace], workspace);
    assert.equal(missingPlan.status, 1);
    assert.match(missingPlan.stderr, /write-ready|plan checkpoint/i);

    const ready = makePlanReady(workspace, focused);
    const write = json(ow(["prepare", "--mode", "write", "--workspace", workspace], workspace));
    assert.equal(write.runId, focused.runId);
    assert.equal(write.mode, "write");
    assert.equal(write.startAt, "write");

    writeJson(path.join(ready.workdir, "candidate", "overview.md"), "partial candidate\n");
    writeJson(path.join(ready.workdir, "analysis", "defects.json"), { version: 2, clean: false, defects: [] });
    const retryWrite = json(ow(["prepare", "--mode", "retry-write", "--workspace", workspace], workspace));
    assert.equal(retryWrite.startAt, "write");
    assert.ok(fs.existsSync(path.join(ready.workdir, "analysis", "spec.json")));
    assert.ok(fs.existsSync(path.join(ready.workdir, "analysis", "checkpoints", "discover.json")));
    assert.deepEqual(fs.readdirSync(path.join(ready.workdir, "candidate")), []);

    const retryPlan = json(ow(["prepare", "--mode", "retry-plan", "--workspace", workspace], workspace));
    assert.equal(retryPlan.startAt, "plan");
    assert.ok(!fs.existsSync(path.join(ready.workdir, "analysis", "spec.json")));
    assert.ok(fs.existsSync(path.join(ready.workdir, "sources", "app", "src", "app.js")));

    fs.rmSync(path.join(workspace, ".wiki-agent", "current.json"));
    const noFallback = ow(["prepare", "--mode", "write", "--workspace", workspace], workspace);
    assert.equal(noFallback.status, 1);
    assert.match(noFallback.stderr, /no active run/i);
  });

  it("requires write and final-review authority before validation trusts a candidate", () => {
    const { workspace } = makeWorkspace();
    const prepared = json(ow(["prepare", "--mode", "auto", "--workspace", workspace], workspace));
    const ready = makePlanReady(workspace, prepared);
    const { workdir } = ready;

    let validated = ow(["validate", "--workspace", workspace], workspace);
    assert.equal(validated.status, 2);
    assert.match(validated.stdout, /write checkpoint/i);

    const { write, review } = makeWriteReviewReady(workspace, ready);

    validated = ow(["validate", "--workspace", workspace], workspace);
    assert.equal(validated.status, 0, validated.stderr || validated.stdout);
    const validatedJson = JSON.parse(validated.stdout);
    assert.equal(validatedJson.ok, true, JSON.stringify(validatedJson));
    assert.ok(validatedJson.manifest?.candidateDigest);
    assert.equal(validatedJson.current.phase, "review-1");
    assert.notEqual(validatedJson.current.status, "sealed");
    assert.ok(fs.existsSync(path.join(workdir, "analysis", "candidate.manifest.json")));

    const resumeValidate = json(ow(["prepare", "--mode", "auto", "--workspace", workspace], workspace));
    assert.equal(resumeValidate.startAt, "validate");
    assert.equal(resumeValidate.inputCheckpointDigest, review.checkpointDigest);
    const idempotent = json(ow(["validate", "--workspace", workspace], workspace));
    assert.equal(idempotent.ok, true);
    assert.equal(idempotent.alreadySealed, true);
    assert.equal(idempotent.reviewCheckpointDigest, review.checkpointDigest);

    writeJson(path.join(workdir, "analysis", "validation.json"), validatedJson);
    const terminal = checkpoint(workspace, "validate", {
      workdir,
      value: handoff({
        phase: "validate",
        inputCheckpointDigests: [review.checkpointDigest],
        artifacts: [
          { id: "validation-report", type: "validation", owner: "validator", path: "analysis/validation.json", dependsOn: ["review-receipt"] },
          { id: "candidate-manifest", type: "manifest", owner: "validator", path: "analysis/candidate.manifest.json", dependsOn: ["validation-report"] },
        ],
      }),
    });
    assert.match(terminal.checkpointDigest, /^sha256:[a-f0-9]{64}$/);
    const current = JSON.parse(fs.readFileSync(path.join(workspace, ".wiki-agent", "current.json"), "utf8"));
    assert.equal(current.phase, "sealed");
    assert.equal(current.status, "sealed");
    assert.equal(current.checkpointDigest, terminal.checkpointDigest);
  });

  it("rejects a pre-repair review until a newer review is the current leaf", () => {
    const { workspace } = makeWorkspace();
    const prepared = json(ow(["prepare", "--mode", "auto", "--workspace", workspace], workspace));
    const ready = makePlanReady(workspace, prepared);
    const { workdir } = ready;
    const { review } = makeWriteReviewReady(workspace, ready);

    writeJson(path.join(workdir, "analysis", "receipts", "repair-1.json"), { repaired: ["overview.md"] });
    const repair = checkpoint(workspace, "repair-1", {
      workdir,
      value: handoff({
        phase: "repair-1",
        inputCheckpointDigests: [review.checkpointDigest],
        artifacts: [{ id: "repair-receipt", type: "repair", owner: "integration", path: "analysis/receipts/repair-1.json", dependsOn: ["review-receipt"], pagePaths: ["candidate/overview.md"] }],
      }),
    });
    const staleReview = ow(["validate", "--workspace", workspace], workspace);
    assert.equal(staleReview.status, 2);
    assert.match(staleReview.stdout, /current.*review|review.*leaf|terminal review/i);

    writeJson(path.join(workdir, "analysis", "receipts", "review-2.json"), { clean: true });
    const reviewTwo = checkpoint(workspace, "review-2", {
      workdir,
      value: handoff({
        phase: "review-2",
        inputCheckpointDigests: [repair.checkpointDigest],
        artifacts: [{ id: "review-2-receipt", type: "review", owner: "reviewer", path: "analysis/receipts/review-2.json", dependsOn: ["repair-receipt"] }],
      }),
    });
    const currentReview = json(ow(["validate", "--workspace", workspace], workspace));
    assert.equal(currentReview.ok, true, JSON.stringify(currentReview));
    assert.equal(currentReview.reviewCheckpointDigest, reviewTwo.checkpointDigest);
  });

  it("preserves unrecognized legacy files while force reset removes v2 run state", () => {
    const { workspace } = makeWorkspace();
    json(ow(["prepare", "--mode", "auto", "--workspace", workspace], workspace));
    const userSkill = path.join(workspace, ".claude", "skills", "user-owned");
    const oldWorkflow = path.join(workspace, ".claude", "workflows", "wiki-produce.workflow.js");
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, "SKILL.md"), "user-owned\n");
    fs.writeFileSync(oldWorkflow, "legacy\n");
    const refused = ow(["init", workspace, "--force"], workspace);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refusing to delete modified or user-owned legacy assets/i);
    assert.ok(fs.existsSync(oldWorkflow));
    assert.ok(fs.existsSync(path.join(userSkill, "SKILL.md")));

    fs.rmSync(oldWorkflow);
    json(ow(["init", workspace, "--force"], workspace));
    assert.ok(!fs.existsSync(path.join(workspace, ".wiki-agent", "current.json")));
    assert.deepEqual(fs.readdirSync(path.join(workspace, ".wiki-agent", "runs")), []);
    assert.ok(fs.existsSync(path.join(userSkill, "SKILL.md")));
  });
});
