import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  addPathSource,
  approveRun,
  claimRun,
  completeRunPlanning,
  getRunQuality,
  initWorkspace,
  installRuntime,
  loadWorkspaceDocument,
  prepareRun,
  releaseRun,
  resumeRun,
  setRunStatus,
  saveWorkspace,
  sealBundle,
  stampBundleMetadata,
  validateRunBundle,
  validateBundle,
  verifyFrozenSnapshot,
  regenerateIndexes,
} from "../scripts/lib/index.mjs";

const RUNTIME = {
  extension: "@okf-wiki/pi-wiki-agent",
  workflow: { id: "wiki", digest: `sha256:${"1".repeat(64)}` },
};

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function workspace({ approval = "propose" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-v4-"));
  const source = path.join(root, "source");
  write(path.join(source, "src", "app.js"), "export const answer = 42;\n");
  const workspaceRoot = path.join(root, "workspace");
  initWorkspace(workspaceRoot, { name: "demo", wikiLanguage: "en", runtime: RUNTIME });
  const config = loadWorkspaceDocument(workspaceRoot);
  saveWorkspace(workspaceRoot, { ...config, workflow: { approval } });
  addPathSource(workspaceRoot, { linkedPath: source, id: "app" });
  return { workspaceRoot, source };
}

function plan(run) {
  write(
    path.join(run.evidenceDir, "app.md"),
    "# Application Evidence\n\n- [Application source](inputs/sources/app/src/app.js#L1-L1)\n",
  );
  write(
    run.planPath,
    [
      "# Wiki Plan",
      "",
      "## Page Matrix",
      "",
      "| Page | Coverage Units | Evidence Brief | Diagram |",
      "| --- | --- | --- | --- |",
      "| `domains/app/overview.md` | `app` | `analysis/evidence/app.md` | omitted |",
      "| `domains/app/architecture.md` | `app` | `analysis/evidence/app.md` | omitted |",
      "",
    ].join("\n"),
  );
}

function qualityReport(title, verdict = "PASS") {
  return [
    `# ${title}`,
    "",
    `Verdict: ${verdict}`,
    "Affected pages: None",
    `Findings: ${verdict === "PASS" ? "None" : "Evidence is incomplete"}`,
    `Required repair: ${verdict === "PASS" ? "None" : "Add the missing evidence"}`,
    "",
  ].join("\n");
}

function writePlanningQualityReports(run, { coverageVerdict = "PASS" } = {}) {
  write(run.coverageReviewPath, qualityReport("Coverage Review", coverageVerdict));
  write(run.qualityReportPaths["coverage-rereview"], qualityReport("coverage-rereview"));
}

function writeQualityReports(run, { coverageVerdict = "PASS" } = {}) {
  writePlanningQualityReports(run, { coverageVerdict });
  for (const [id, file] of Object.entries(run.qualityReportPaths).filter(([id]) => id !== "coverage-rereview")) {
    write(file, qualityReport(id));
  }
}

function page(type, title, citation, body = "") {
  return `---\ntype: ${type}\ntitle: ${title}\nsources:\n  - id: app-src\n    resource: inputs/sources/app/src/app.js#L1-L1\n---\n\n[Source](${citation})\n${body}`;
}

function writeBundle(run) {
  write(
    path.join(run.bundleDir, "domains", "app", "overview.md"),
    page("domain", "Application", "../../../inputs/sources/app/src/app.js#L1-L1"),
  );
  write(
    path.join(run.bundleDir, "domains", "app", "architecture.md"),
    page("concept", "Architecture", "../../../inputs/sources/app/src/app.js#L1-L1"),
  );
}

describe("v4 run lifecycle", () => {
  it("freezes inputs into the v4 layout and detects frozen-source mutation", () => {
    const { workspaceRoot } = workspace();
    const run = prepareRun(workspaceRoot);
    assert.equal(run.state.version, 4);
    assert.equal(run.state.status, "planning");
    assert.equal(run.state.approval, "propose");
    assert.ok(fs.existsSync(path.join(run.inputsDir, "sources", "app", "src", "app.js")));
    assert.ok(fs.existsSync(path.join(run.analysisDir, "inventory.md")));
    assert.ok(fs.existsSync(path.join(run.runDir, "method", "METHOD.md")));
    assert.ok(fs.existsSync(path.join(run.runDir, "method", "references", "plan.md")));
    assert.ok(fs.existsSync(run.bundleDir));
    assert.equal(fs.existsSync(path.join(run.runDir, "candidate")), false);
    assert.deepEqual(verifyFrozenSnapshot(run.runDir), { ok: true, errors: [] });
    fs.writeFileSync(path.join(run.sourcesDir, "app", "src", "app.js"), "mutated\n");
    assert.equal(verifyFrozenSnapshot(run.runDir).ok, false);
    fs.appendFileSync(path.join(run.runDir, "method", "METHOD.md"), "\nmutated\n");
    assert.ok(verifyFrozenSnapshot(run.runDir).errors.some((error) => /method digest mismatch/i.test(error)));
  });

  it("proposes, checks the plan digest, approves, stamps metadata, validates, and seals an OKF bundle", () => {
    const { workspaceRoot } = workspace();
    const run = prepareRun(workspaceRoot);
    plan(run);
    writePlanningQualityReports(run);
    const proposal = completeRunPlanning(workspaceRoot, { runId: run.runId, sessionPath: path.join(run.sessionDir, "main.json") });
    assert.equal(proposal.requiresApproval, true);
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.state.sessionPath, "analysis/session/main.json");
    assert.throws(() => resumeRun(workspaceRoot, { runId: run.runId }), /use \/wiki approve/i);
    fs.appendFileSync(run.planPath, "\n- Review source boundaries.\n");
    assert.throws(() => approveRun(workspaceRoot, { runId: run.runId, planDigest: proposal.planDigest }), /plan changed/i);
    writePlanningQualityReports(run);
    const revised = completeRunPlanning(workspaceRoot, { runId: run.runId });
    const approved = approveRun(workspaceRoot, { runId: run.runId, planDigest: revised.planDigest });
    assert.equal(approved.status, "writing");
    writeBundle(run);
    writeQualityReports(run);
    const result = validateRunBundle(workspaceRoot, { runId: run.runId });
    assert.equal(result.ok, true, result.errors?.join("; "));
    assert.equal(result.state.status, "complete");
    assert.match(fs.readFileSync(path.join(run.bundleDir, "index.md"), "utf8"), /okf_version: "0.2"/);
    assert.match(
      fs.readFileSync(path.join(run.bundleDir, "domains", "app", "index.md"), "utf8"),
      /\[architecture\]\(\.\/architecture\.md\)/,
    );
    const concept = fs.readFileSync(path.join(run.bundleDir, "domains", "app", "architecture.md"), "utf8");
    assert.match(concept, /status: draft/);
    assert.match(concept, /by: okf-wiki-agent\/0\.1\.0/);
    const again = validateRunBundle(workspaceRoot, { runId: run.runId });
    assert.equal(again.alreadySealed, true);
  });

  it("auto approval moves directly from durable Markdown planning to writing", () => {
    const { workspaceRoot } = workspace({ approval: "auto" });
    const run = prepareRun(workspaceRoot);
    plan(run);
    writePlanningQualityReports(run);
    const completed = completeRunPlanning(workspaceRoot, { runId: run.runId });
    assert.equal(completed.requiresApproval, false);
    assert.equal(completed.status, "writing");
  });

  it("does not propose a plan before the Page Matrix evidence and coverage re-review pass", () => {
    const { workspaceRoot } = workspace();
    const run = prepareRun(workspaceRoot);
    plan(run);
    assert.throws(() => completeRunPlanning(workspaceRoot, { runId: run.runId }), /plan quality gate failed:.*coverage-review/i);

    writePlanningQualityReports(run);
    write(run.qualityReportPaths["coverage-rereview"], qualityReport("coverage-rereview", "FAIL"));
    assert.throws(() => completeRunPlanning(workspaceRoot, { runId: run.runId }), /final quality report must pass/i);
  });

  it("returns the active run from generate preparation with the Pi status envelope and resumable state", () => {
    const { workspaceRoot } = workspace();
    const first = prepareRun(workspaceRoot);
    const preparedAgain = prepareRun(workspaceRoot);
    assert.equal(preparedAgain.status, "ok");
    assert.equal(preparedAgain.runId, first.runId);
    assert.equal(preparedAgain.state.status, "planning");
    const resumed = resumeRun(workspaceRoot, { runId: first.runId });
    assert.equal(resumed.status, "planning");
    assert.equal(resumed.startAt, "planning");
  });

  it("claims a run atomically and restores its paused state only for the lock owner", () => {
    const { workspaceRoot } = workspace({ approval: "auto" });
    const run = prepareRun(workspaceRoot);
    plan(run);
    writePlanningQualityReports(run);
    completeRunPlanning(workspaceRoot, { runId: run.runId });
    const first = claimRun(workspaceRoot, { runId: run.runId, owner: "orch-a" });
    assert.equal(first.claimed, true);
    assert.equal(claimRun(workspaceRoot, { runId: run.runId, owner: "orch-a" }).claimed, false);
    assert.throws(() => claimRun(workspaceRoot, { runId: run.runId, owner: "orch-b" }), /already claimed/i);
    assert.throws(() => releaseRun(workspaceRoot, { runId: run.runId, owner: "orch-b" }), /not owned/i);
    assert.equal(releaseRun(workspaceRoot, { runId: run.runId, owner: "orch-a" }).released, true);

    setRunStatus(workspaceRoot, { runId: run.runId, status: "paused" });
    const resumed = resumeRun(workspaceRoot, { runId: run.runId });
    assert.equal(resumed.status, "writing");
    setRunStatus(workspaceRoot, { runId: run.runId, status: "stopped" });
    assert.throws(() => resumeRun(workspaceRoot, { runId: run.runId }), /stopped/i);
  });

  it("rejects a bundle whose declared source resource is outside frozen inputs", () => {
    const { workspaceRoot } = workspace({ approval: "auto" });
    const run = prepareRun(workspaceRoot);
    plan(run);
    writePlanningQualityReports(run);
    completeRunPlanning(workspaceRoot, { runId: run.runId });
    writeQualityReports(run);
    write(
      path.join(run.bundleDir, "concepts", "bad.md"),
      "---\ntype: concept\ntitle: Bad\nsources:\n  - id: bad\n    resource: ../../outside.js#L1\n---\n\n[Source](../../inputs/sources/app/src/app.js#L1)\n",
    );
    const result = validateRunBundle(workspaceRoot, { runId: run.runId });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /run-relative under inputs\/sources/.test(error)));
  });

  it("rejects legacy string sources instead of silently accepting a non-OKF handoff", () => {
    const { workspaceRoot } = workspace({ approval: "auto" });
    const run = prepareRun(workspaceRoot);
    plan(run);
    writePlanningQualityReports(run);
    completeRunPlanning(workspaceRoot, { runId: run.runId });
    writeQualityReports(run);
    write(
      path.join(run.bundleDir, "concepts", "legacy.md"),
      "---\ntype: concept\ntitle: Legacy\nsources:\n  - inputs/sources/app/src/app.js#L1\n---\n\n[Source](../../inputs/sources/app/src/app.js#L1)\n",
    );
    const result = validateRunBundle(workspaceRoot, { runId: run.runId });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /sources entries must be mappings/.test(error)));
  });

  it("blocks missing quality reports, exposes host-derived report status, and allows one repair recovery", () => {
    const { workspaceRoot } = workspace({ approval: "auto" });
    const run = prepareRun(workspaceRoot);
    plan(run);
    writePlanningQualityReports(run);
    completeRunPlanning(workspaceRoot, { runId: run.runId });
    writeBundle(run);

    const blocked = validateRunBundle(workspaceRoot, { runId: run.runId });
    assert.equal(blocked.status, "quality_blocked");
    assert.equal(blocked.state.quality.status, "blocked");
    assert.ok(blocked.errors.some((error) => /missing quality report/.test(error)));
    assert.equal(getRunQuality(workspaceRoot, { runId: run.runId }).status, "blocked");
    assert.throws(() => setRunStatus(workspaceRoot, { runId: run.runId, status: "writing" }), /must use resumeRun/i);

    writeQualityReports(run, { coverageVerdict: "FAIL" });
    const recovered = resumeRun(workspaceRoot, { runId: run.runId });
    assert.equal(recovered.status, "writing");
    assert.equal(recovered.qualityRecovery, true);
    const result = validateRunBundle(workspaceRoot, { runId: run.runId });
    assert.equal(result.ok, true, result.errors?.join("; "));
    assert.equal(result.state.quality.status, "passed");
    assert.equal(result.state.quality.recoveryCount, 1);
  });

  it("rejects a required Mermaid diagram when the Page Matrix decision is not satisfied", () => {
    const { workspaceRoot } = workspace({ approval: "auto" });
    const run = prepareRun(workspaceRoot);
    plan(run);
    fs.writeFileSync(
      run.planPath,
      fs.readFileSync(run.planPath, "utf8").replace("| `domains/app/overview.md` | `app` | `analysis/evidence/app.md` | omitted |", "| `domains/app/overview.md` | `app` | `analysis/evidence/app.md` | required |"),
      "utf8",
    );
    writePlanningQualityReports(run);
    completeRunPlanning(workspaceRoot, { runId: run.runId });
    writeBundle(run);
    writeQualityReports(run);

    const result = validateRunBundle(workspaceRoot, { runId: run.runId });
    assert.equal(result.ok, false);
    assert.equal(result.status, "quality_blocked");
    assert.ok(result.errors.some((error) => /requires a Mermaid diagram/.test(error)));
    assert.equal(resumeRun(workspaceRoot, { runId: run.runId }).qualityRecovery, true);
    const stillBlocked = validateRunBundle(workspaceRoot, { runId: run.runId });
    assert.equal(stillBlocked.status, "quality_blocked");
    assert.throws(() => resumeRun(workspaceRoot, { runId: run.runId }), /quality repair limit reached/i);
  });

  it("blocks structurally invalid Mermaid fences without using a browser renderer", () => {
    const { workspaceRoot } = workspace({ approval: "auto" });
    const run = prepareRun(workspaceRoot);
    plan(run);
    fs.writeFileSync(
      run.planPath,
      fs.readFileSync(run.planPath, "utf8").replace("| `domains/app/overview.md` | `app` | `analysis/evidence/app.md` | omitted |", "| `domains/app/overview.md` | `app` | `analysis/evidence/app.md` | useful |"),
      "utf8",
    );
    writePlanningQualityReports(run);
    completeRunPlanning(workspaceRoot, { runId: run.runId });
    writeBundle(run);
    write(
      path.join(run.bundleDir, "domains", "app", "overview.md"),
      page("domain", "Application", "../../../inputs/sources/app/src/app.js#L1-L1", "\n```mermaid\nflowchart TD\n  A[Start] --> end[Done]\n```\n"),
    );
    writeQualityReports(run);

    const result = validateRunBundle(workspaceRoot, { runId: run.runId });
    assert.equal(result.status, "quality_blocked");
    assert.ok(result.errors.some((error) => /reserved word `end`/.test(error)));
  });

  it("does not let direct sealing bypass final quality reports", () => {
    const { workspaceRoot } = workspace({ approval: "auto" });
    const run = prepareRun(workspaceRoot);
    plan(run);
    writePlanningQualityReports(run);
    completeRunPlanning(workspaceRoot, { runId: run.runId });
    writeBundle(run);
    assert.equal(stampBundleMetadata(run.runDir).ok, true);
    regenerateIndexes(run.runDir);
    const validation = validateBundle(run.runDir);
    assert.equal(validation.ok, true, validation.errors.join("; "));
    assert.throws(() => sealBundle(run.runDir, validation), /without passing quality reports/i);
  });
});
