import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { writeSurveyReceipts } from "./survey-fixtures.mjs";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-v3-"));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "src", "app.js"), "export const answer = 42;\n");
  fs.mkdirSync(path.join(source, "target"), { recursive: true });
  fs.writeFileSync(path.join(source, "target", "ignored.class"), "ignored");
  const workspace = path.join(root, "workspace");
  const initialized = json(ow(["init", workspace, "--name", "v3-demo", "--lang", "zh", "--path", source, "--id", "app"], root));
  return { root, source, workspace, initialized };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function publish(workspace, phase, workdir, artifacts) {
  const artifactsPath = `analysis/receipts/${phase}-artifacts.json`;
  writeJson(path.join(workdir, artifactsPath), artifacts);
  return json(ow(["publish", "--phase", phase, "--artifacts-json", artifactsPath, "--workspace", workspace], workspace));
}

function makePlanReady(workspace, prepared) {
  const { workdir, runId } = prepared;
  const inventory = JSON.parse(fs.readFileSync(path.join(workdir, "inputs", "inventory.json"), "utf8"));
  const coverageUnitIds = inventory.coverageUnits.filter((unit) => unit.required === true).map((unit) => unit.id);
  const coverageUnitId = coverageUnitIds[0];
  writeSurveyReceipts(workdir, inventory, {
    evidencePathByUnit: { app: "sources/app/src/app.js" },
  });
  const surveyMerge = json(ow(["survey-merge", "--pass", "1", "--workspace", workspace], workspace));
  const surveyArtifacts = JSON.parse(fs.readFileSync(path.join(workdir, surveyMerge.artifactsPath), "utf8"));
  const discover = publish(workspace, "discover", workdir, surveyArtifacts);
  const pages = [{ path: "overview.md", type: "Overview", critical: true, coverageUnitIds, owner: "integration" }];
  const pageAssignments = [{ pagePath: "overview.md", owner: "integration", role: "integration", coverageUnitIds, dependsOn: ["survey:app"], sourceIds: ["app"] }];
  writeJson(path.join(workdir, "analysis", "spec.json"), { version: 2, wikiLanguage: "zh", pages, pageAssignments });
  writeJson(path.join(workdir, "analysis", "page-assignments.json"), pageAssignments);
  const planReceipt = path.join(workdir, "analysis", "receipts", "plan.json");
  writeJson(planReceipt, { planned: true });
  const plan = publish(workspace, "plan", workdir, [
    { id: "plan-receipt", type: "receipt", path: "analysis/receipts/plan.json" },
    { id: "spec", type: "spec", path: "analysis/spec.json" },
    { id: "page-assignments", type: "assignment-map", path: "analysis/page-assignments.json" },
  ]);
  const gate = json(ow(["gate", "plan", "--workspace", workspace], workspace));
  assert.equal(gate.ok, true, JSON.stringify(gate));
  assert.equal(gate.receipt.version, 3);
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
  const writeSources = publish(workspace, "write-sources", workdir, [
    { id: "domain-pages", type: "candidate-pages", path: "candidate/overview.md" },
  ]);
  writeJson(path.join(workdir, "analysis", "receipts", "write.json"), { integrated: true });
  const write = publish(workspace, "write", workdir, [
    { id: "write-receipt", type: "receipt", path: "analysis/receipts/write.json" },
  ]);
  writeJson(path.join(workdir, "analysis", "receipts", "review-1.json"), { clean: true });
  const review = publish(workspace, "review-1", workdir, [
    { id: "review-receipt", type: "review", path: "analysis/receipts/review-1.json" },
  ]);
  writeJson(path.join(workdir, "analysis", "defects.json"), { version: 2, clean: true, defects: [] });
  return { writeSources, write, review };
}

describe("ow v3 workspace and lifecycle", () => {
  it("installs exactly one native workflow and a v3 runtime manifest", () => {
    const { workspace, initialized } = makeWorkspace();
    assert.equal(initialized.format, "yaml");
    assert.equal(initialized.wikiLanguage, "zh");
    const config = YAML.parse(fs.readFileSync(path.join(workspace, "workspace.yaml"), "utf8"));
    assert.equal(config.version, 3);
    assert.ok(!fs.existsSync(path.join(workspace, "workspace.json")));
    assert.ok(!fs.existsSync(path.join(workspace, "workspace.yml")));

    const workflow = path.join(workspace, ".claude", "workflows", "wiki.workflow.js");
    const runtime = JSON.parse(fs.readFileSync(path.join(workspace, ".wiki-agent", "runtime.json"), "utf8"));
    assert.ok(fs.existsSync(workflow));
    assert.equal(runtime.version, 3);
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
      assert.notEqual(ow([command, "--workspace", workspace], workspace).status, 0, `${command} must not remain a v3 CLI command`);
    }

    const status = json(ow(["status", "--workspace", workspace], workspace));
    assert.equal(status.workflow, "/wiki");
    assert.equal(status.current, null);
    const rejected = ow(["init", path.join(workspace, "wrong"), "--format", "json"], workspace);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /workspace v3 always uses workspace\.yaml/i);
  });

  it("rewrites CRLF workflow installs to LF without requiring --force", () => {
    const { workspace } = makeWorkspace();
    const workflow = path.join(workspace, ".claude", "workflows", "wiki.workflow.js");
    const lf = fs.readFileSync(workflow, "utf8");
    assert.equal(lf.includes("\r"), false);
    fs.writeFileSync(workflow, lf.replace(/\n/g, "\r\n"), "utf8");
    assert.ok(fs.readFileSync(workflow, "utf8").includes("\r"));

    const doctorBefore = JSON.parse(ow(["doctor", "--workspace", workspace], workspace).stdout);
    assert.equal(doctorBefore.ok, false);
    assert.match(doctorBefore.assets.error, /CR\/control characters|drifted from kit/i);

    const installed = json(ow(["install", "--workspace", workspace], workspace));
    assert.equal(installed.workflows.files[0].lineEndings, "lf");
    assert.equal(installed.workflows.files[0].skipped, false);
    const rewritten = fs.readFileSync(workflow, "utf8");
    assert.equal(rewritten.includes("\r"), false);
    assert.equal(rewritten, lf);

    const doctorAfter = json(ow(["doctor", "--workspace", workspace], workspace));
    assert.equal(doctorAfter.assets.ok, true);
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
    assert.equal(write.startAt, "write-sources");

    writeJson(path.join(ready.workdir, "candidate", "overview.md"), "partial candidate\n");
    writeJson(path.join(ready.workdir, "analysis", "defects.json"), { version: 2, clean: false, defects: [] });
    const retryWrite = json(ow(["prepare", "--mode", "retry-write", "--workspace", workspace], workspace));
    assert.equal(retryWrite.startAt, "write-sources");
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
    const terminal = publish(workspace, "validate", workdir, [
      { id: "validation-report", type: "validation", path: "analysis/validation.json" },
      { id: "candidate-manifest", type: "manifest", path: "analysis/candidate.manifest.json" },
    ]);
    assert.match(terminal.checkpointDigest, /^sha256:[a-f0-9]{64}$/);
    const current = JSON.parse(fs.readFileSync(path.join(workspace, ".wiki-agent", "current.json"), "utf8"));
    assert.equal(current.phase, "sealed");
    assert.equal(current.status, "sealed");
    assert.equal(current.checkpointDigest, terminal.checkpointDigest);
  });

  it("keeps the final review pointer when candidate validation fails", () => {
    const { workspace } = makeWorkspace();
    const prepared = json(ow(["prepare", "--mode", "auto", "--workspace", workspace], workspace));
    const ready = makePlanReady(workspace, prepared);
    const { workdir } = ready;
    const { review } = makeWriteReviewReady(workspace, ready);
    fs.rmSync(path.join(workdir, "candidate", "overview.md"));

    const failed = ow(["validate", "--workspace", workspace], workspace);
    assert.equal(failed.status, 2);
    const current = JSON.parse(fs.readFileSync(path.join(workspace, ".wiki-agent", "current.json"), "utf8"));
    assert.equal(current.phase, "review-1");
    assert.equal(current.status, "active");
    assert.equal(current.checkpointDigest, review.checkpointDigest);
  });

  it("rejects a pre-repair review until a newer review is the current leaf", () => {
    const { workspace } = makeWorkspace();
    const prepared = json(ow(["prepare", "--mode", "auto", "--workspace", workspace], workspace));
    const ready = makePlanReady(workspace, prepared);
    const { workdir } = ready;
    const { review } = makeWriteReviewReady(workspace, ready);

    writeJson(path.join(workdir, "analysis", "receipts", "repair-1.json"), { repaired: ["overview.md"] });
    const repair = publish(workspace, "repair-1", workdir, [
      { id: "repair-receipt", type: "repair", path: "analysis/receipts/repair-1.json" },
    ]);
    const staleReview = ow(["validate", "--workspace", workspace], workspace);
    assert.equal(staleReview.status, 2);
    assert.match(staleReview.stdout, /current.*review|review.*leaf|terminal review/i);

    writeJson(path.join(workdir, "analysis", "receipts", "review-2.json"), { clean: true });
    const reviewTwo = publish(workspace, "review-2", workdir, [
      { id: "review-2-receipt", type: "review", path: "analysis/receipts/review-2.json" },
    ]);
    const currentReview = json(ow(["validate", "--workspace", workspace], workspace));
    assert.equal(currentReview.ok, true, JSON.stringify(currentReview));
    assert.equal(currentReview.reviewCheckpointDigest, reviewTwo.checkpointDigest);
  });

  it("preserves unrecognized legacy files while force reset removes v3 run state", () => {
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
