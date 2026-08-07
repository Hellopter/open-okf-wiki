import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import YAML from "yaml";
import {
  RUNTIME_MANIFEST_VERSION,
  approveRunPlanGate,
  assertRuntime,
  ensureRuntime,
  getWorkspaceStatus,
  getRunPaths,
  initWorkspace,
  initializePiWorkspace,
  addLinkedSource,
  loadWorkspace,
  mergeRunSurveyReceipts,
  prepareRun,
  publishRunArtifacts,
  validateRunCandidate,
} from "../scripts/lib/index.mjs";
import { writeSurveyReceipts } from "./survey-fixtures.mjs";

const RUNTIME = {
  extension: "@okf-wiki/pi-wiki-agent",
  workflow: { id: "wiki", digest: `sha256:${"1".repeat(64)}` },
};

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wiki-core-"));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "src", "app.js"), "export const answer = 42;\n");
  const workspace = path.join(root, "workspace");
  const initialized = initializePiWorkspace(workspace, {
    name: "pi-demo",
    wikiLanguage: "zh",
    runtime: RUNTIME,
    source: { type: "path", path: source, id: "app" },
  });
  return { root, source, workspace, initialized };
}

function publish(root, runId, workdir, phase, artifacts) {
  const artifactsJsonPath = `analysis/receipts/${phase}-artifacts.json`;
  writeJson(path.join(workdir, artifactsJsonPath), artifacts);
  return publishRunArtifacts(root, { runId, phase, artifactsJsonPath });
}

function makePlanReady(workspace, prepared) {
  const { workdir, runId } = prepared;
  const inventory = JSON.parse(fs.readFileSync(path.join(workdir, "inputs", "inventory.json"), "utf8"));
  const coverageUnitIds = inventory.coverageUnits.filter((unit) => unit.required === true).map((unit) => unit.id);
  writeSurveyReceipts(workdir, inventory, { evidencePathByUnit: { app: "sources/app/src/app.js" } });
  const survey = mergeRunSurveyReceipts(workspace, { runId, pass: 1 });
  const surveyArtifacts = JSON.parse(fs.readFileSync(path.join(workdir, survey.artifactsPath), "utf8"));
  publish(workspace, runId, workdir, "discover", surveyArtifacts);
  const pages = [{ path: "overview.md", type: "Overview", critical: true, coverageUnitIds, owner: "integration" }];
  const assignments = [
    { pagePath: "overview.md", owner: "integration", role: "integration", coverageUnitIds, dependsOn: ["survey:app"], sourceIds: ["app"] },
  ];
  writeJson(path.join(workdir, "analysis", "spec.json"), { version: 2, wikiLanguage: "zh", pages, pageAssignments: assignments });
  writeJson(path.join(workdir, "analysis", "page-assignments.json"), assignments);
  writeJson(path.join(workdir, "analysis", "receipts", "plan.json"), { planned: true });
  publish(workspace, runId, workdir, "plan", [
    { id: "plan-receipt", type: "receipt", path: "analysis/receipts/plan.json" },
    { id: "spec", type: "spec", path: "analysis/spec.json" },
    { id: "page-assignments", type: "assignment-map", path: "analysis/page-assignments.json" },
  ]);
  const gate = approveRunPlanGate(workspace, { runId });
  assert.equal(gate.ok, true, JSON.stringify(gate));
  return { workdir, runId };
}

function makeWriteReviewReady(workspace, ready) {
  const { workdir, runId } = ready;
  fs.writeFileSync(
    path.join(workdir, "candidate", "overview.md"),
    ["---", "type: Overview", "title: Demo", "description: A source-grounded demo.", "---", "", "[Source](../sources/app/src/app.js#L1)", ""].join("\n"),
  );
  writeJson(path.join(workdir, "analysis", "receipts", "write-sources.json"), { pages: ["overview.md"] });
  publish(workspace, runId, workdir, "write-sources", [{ id: "pages", type: "candidate-pages", path: "candidate/overview.md" }]);
  writeJson(path.join(workdir, "analysis", "receipts", "write.json"), { integrated: true });
  publish(workspace, runId, workdir, "write", [{ id: "write-receipt", type: "receipt", path: "analysis/receipts/write.json" }]);
  writeJson(path.join(workdir, "analysis", "receipts", "review-1.json"), { clean: true });
  const review = publish(workspace, runId, workdir, "review-1", [{ id: "review", type: "review", path: "analysis/receipts/review-1.json" }]);
  writeJson(path.join(workdir, "analysis", "defects.json"), { version: 2, clean: true, defects: [] });
  return review;
}

describe("Pi runtime core API", () => {
  it("creates a Pi-bound workspace without copying host assets", () => {
    const { workspace, initialized } = makeWorkspace();
    assert.equal(initialized.created, true);
    assert.equal(initialized.workspace.wikiLanguage, "zh");
    assert.equal(YAML.parse(fs.readFileSync(path.join(workspace, "workspace.yaml"), "utf8")).version, 3);
    assert.ok(!fs.existsSync(path.join(workspace, ".claude")));

    const runtime = assertRuntime(workspace).runtime;
    assert.equal(runtime.version, RUNTIME_MANIFEST_VERSION);
    assert.equal(runtime.kind, "pi");
    assert.equal(runtime.extension, RUNTIME.extension);
    assert.equal(runtime.workflow.id, "wiki");
    assert.match(runtime.workflow.digest, /^sha256:[a-f0-9]{64}$/);
    assert.match(runtime.core.digest, /^sha256:[a-f0-9]{64}$/);
    assert.match(runtime.method.digest, /^sha256:[a-f0-9]{64}$/);

    const status = getWorkspaceStatus(workspace);
    assert.equal(status.runtime, "pi");
    assert.equal(status.active, null);
    assert.equal(status.sources[0].id, "app");
  });

  it("requires a Pi descriptor at initialization and exposes adapter-compatible state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wiki-init-"));
    assert.throws(() => initWorkspace(root, {}), /runtime descriptor/i);
    const initialized = initWorkspace(root, { name: "adapter", runtimeDefinition: RUNTIME });
    assert.equal(initialized.initialized, true);
    assert.equal(initialized.root, root);
    assert.equal(loadWorkspace(root)?.initialized, true);
    assert.equal(loadWorkspace(path.join(root, "not-a-workspace")), undefined);
    assert.equal(getRunPaths(root), undefined);
    assert.equal(ensureRuntime(root, { runtimeDefinition: RUNTIME }).installed, false);
  });

  it("preserves validated source-specific ignores through the Pi linked-source API", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wiki-source-ignore-"));
    const workspace = path.join(root, "workspace");
    const source = path.join(root, "source");
    fs.mkdirSync(source, { recursive: true });
    initWorkspace(workspace, { runtimeDefinition: RUNTIME });

    const linked = addLinkedSource(workspace, {
      path: source,
      id: "project",
      ignore: [" sources/** ", "sources/**"],
    });
    assert.deepEqual(linked.ignore, ["sources/**"]);
    assert.throws(
      () => addLinkedSource(workspace, { path: source, id: "invalid", ignore: ["!sources/**"] }),
      /negated source ignore/i,
    );
  });

  it("requires a valid Pi runtime and freezes no executable host CLI authority", () => {
    const { workspace } = makeWorkspace();
    const prepared = prepareRun(workspace, { mode: "auto" });
    assert.equal(prepared.startAt, "survey");
    const policy = JSON.parse(fs.readFileSync(path.join(prepared.workdir, "inputs", "run-policy.json"), "utf8"));
    assert.equal(policy.runtime.kind, "pi");
    assert.equal(policy.runtime.extension, RUNTIME.extension);
    assert.equal(Object.hasOwn(policy, "hostCli"), false);
    assert.deepEqual(getRunPaths(workspace), {
      root: workspace,
      runId: prepared.runId,
      workdir: prepared.workdir,
      inputsDir: path.join(prepared.workdir, "inputs"),
      sourcesDir: path.join(prepared.workdir, "sources"),
      methodDir: path.join(prepared.workdir, "method"),
      analysisDir: path.join(prepared.workdir, "analysis"),
      candidateDir: path.join(prepared.workdir, "candidate"),
    });

    fs.writeFileSync(path.join(workspace, ".wiki-agent", "runtime.json"), "{}\n");
    assert.throws(() => prepareRun(workspace, { mode: "auto" }), /runtime manifest/i);
  });

  it("rejects a resumed run after the Pi workflow descriptor changes, but restart freezes the new binding", () => {
    const { workspace } = makeWorkspace();
    const original = prepareRun(workspace, { mode: "auto" });
    const updatedRuntime = {
      ...RUNTIME,
      workflow: { id: "wiki-v2", digest: `sha256:${"3".repeat(64)}` },
    };
    ensureRuntime(workspace, { runtimeDefinition: updatedRuntime });

    for (const mode of ["auto", "plan", "write", "retry-plan", "retry-write"]) {
      assert.throws(
        () => prepareRun(workspace, { mode }),
        /different Pi runtime.*\/wiki --restart/i,
        `${mode} must not resume a run frozen for a previous workflow descriptor`,
      );
    }

    const restarted = prepareRun(workspace, { mode: "restart" });
    assert.notEqual(restarted.runId, original.runId);
    const policy = JSON.parse(fs.readFileSync(path.join(restarted.workdir, "inputs", "run-policy.json"), "utf8"));
    assert.deepEqual(policy.runtime, { kind: "pi", extension: updatedRuntime.extension, workflow: updatedRuntime.workflow });
  });

  it("returns the plan-only ready marker when the active plan already has a valid gate", () => {
    const { workspace } = makeWorkspace();
    const prepared = prepareRun(workspace, { mode: "auto" });
    const ready = makePlanReady(workspace, prepared);

    const planOnly = prepareRun(workspace, { mode: "plan" });
    assert.equal(planOnly.runId, ready.runId);
    assert.equal(planOnly.mode, "plan");
    assert.equal(planOnly.startAt, "ready");
    assert.match(planOnly.inputCheckpointDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(planOnly.summary, /ready for explicit write/i);
  });

  it("runs gate and candidate validation through direct host APIs", () => {
    const { workspace } = makeWorkspace();
    const prepared = prepareRun(workspace, { mode: "auto" });
    const ready = makePlanReady(workspace, prepared);
    const review = makeWriteReviewReady(workspace, ready);

    const validation = validateRunCandidate(workspace, { runId: ready.runId });
    assert.equal(validation.ok, true, JSON.stringify(validation));
    assert.match(validation.manifest.candidateDigest, /^[a-f0-9]{64}$/);
    assert.equal(validation.reviewCheckpointDigest, review.checkpointDigest);

    writeJson(path.join(ready.workdir, "analysis", "validation.json"), validation);
    const terminal = publish(workspace, ready.runId, ready.workdir, "validate", [
      { id: "validation", type: "validation", path: "analysis/validation.json" },
      { id: "manifest", type: "manifest", path: "analysis/candidate.manifest.json" },
    ]);
    assert.match(terminal.checkpointDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(getWorkspaceStatus(workspace).active.status, "sealed");
  });
});
