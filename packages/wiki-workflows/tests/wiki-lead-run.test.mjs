import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { WikiCandidateCorruptionError, WikiLeadRun } from "../dist/wiki-lead-run.js";
import { verifyWikiPublicationSeal } from "../dist/wiki-publication-seal.js";

const policy = { templates: { requiredSections: [] }, review: { mustCover: [] } };

function page(pageType, pagePath) {
  return { pageType, path: pagePath, title: pagePath, purpose: "Document behavior", readerQuestions: [], requiredFacets: [], findingIds: [] };
}

const spec = {
  version: 1,
  overview: page("overview", "overview.md"),
  domains: [{ id: "core", title: "Core", purpose: "Core behavior", pages: [page("domain", "core/domain.md")] }],
  crossLinks: [], sharedTerms: [], omissions: [],
};

function content(type, title, suffix = "") {
  return ["---", `type: ${type}`, `title: ${title}`, "description: Runtime behavior", "sources:", "  - id: source-a", "    resource: repo:source/a.ts#L1-L1", "---", "", `Runtime behavior${suffix}.[^source-a]`, "", "[^source-a]: [Source](repo:source/a.ts#L1-L1)", ""].join("\n");
}

function sourcePlan(root) {
  const source = path.join(root, "source");
  return {
    workspaceRoot: root, workspaceRealPath: root, configPath: path.join(root, "workspace.yaml"), defaultSourceIgnores: true, excludes: [], fingerprint: "a".repeat(64),
    sources: [{ scopeId: "source", logicalPath: "source", absolutePath: source, realPath: source, repositoryRoot: source, repositoryIdentity: "source", head: "0".repeat(40), dirtyFingerprint: "b".repeat(64) }],
  };
}

async function fixture(t, fault, finalizeFault) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-lead-run-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "source"));
  await writeFile(path.join(root, "source", "a.ts"), "export const a = true;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: path.join(root, "source") });
  await writeFile(path.join(root, "workspace.yaml"), [
    "version: 1", "language: en", "defaultSourceIgnores: true", "wiki:", "  exclude: []",
    "sources:", "  - path: source", "    origin:", "      type: link", `      localPath: ${JSON.stringify(path.join(root, "source"))}`, "",
  ].join("\n"));
  const candidate = path.join(root, ".okf-wiki", "runs", "run-1", "candidate", "wiki");
  const runStateFile = path.join(root, ".okf-wiki", "runs", "run-1", "run-state.json");
  await mkdir(path.dirname(runStateFile), { recursive: true });
  await writeFile(runStateFile, JSON.stringify({ version: 2, id: "run-1", status: "running", attempt: 1, executionToken: "execution-1" }));
  const executionFence = { runStateFile, attempt: 1, executionToken: "execution-1" };
  const run = await WikiLeadRun.open({ workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy, fault, finalizeFault, executionFence });
  await run.saveSpec(spec);
  return { root, candidate, run, executionFence };
}

async function completeAndApprove(run) {
  await run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  await run.replacePage({ path: "wiki/core/domain.md", content: content("Domain", "Core"), actor: "lead" });
  const { contracts: [contract] } = await run.queueDelegateBatch([{ id: "review-all", role: "review", instruction: "Review", sourceScopeIds: [], contextRefs: [], reviewPaths: ["wiki/overview.md", "wiki/core/domain.md"] }]);
  const receipt = { id: contract.id, role: "review", status: "complete", summary: "pass", outputs: [], coverage: [], gaps: [], attempts: 1, contractId: contract.contractId, contractDigest: contract.contractDigest, review: { verdict: "pass", reviewedPaths: contract.reviewPaths, findings: [], profileCoverage: [] } };
  await run.taskTransitions.taskStarted(contract.batchId, contract.id, { attempt: 1 });
  await run.taskTransitions.taskSettled(contract.batchId, contract.id, { attempt: 1, receipt });
  return contract;
}

for (const point of ["afterJournal", "afterState", "afterRename", "afterVerify"]) {
  test(`candidate transaction rolls forward after ${point}`, async (t) => {
    let armed = true;
    const { root, candidate, run, executionFence } = await fixture(t, (value) => { if (armed && value === point) throw new Error(`fault:${point}`); });
    await assert.rejects(run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" }), new RegExp(`fault:${point}`));
    armed = false;
    await WikiLeadRun.open({ workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy, executionFence });
    assert.match(await readFile(path.join(candidate, "overview.md"), "utf8"), /Runtime behavior/);
    await assert.rejects(readFile(path.join(root, ".okf-wiki", "runs", "run-1", "candidate-transaction.json")), { code: "ENOENT" });
  });
}

test("candidate recovery rejects an externally modified target it cannot prove", async (t) => {
  let armed = true;
  const { root, candidate, run, executionFence } = await fixture(t, (value) => { if (armed && value === "afterJournal") throw new Error("fault"); });
  await writeFile(path.join(candidate, "overview.md"), "old\n");
  await assert.rejects(run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" }), /fault/);
  armed = false;
  await writeFile(path.join(candidate, "overview.md"), "tampered\n");
  await assert.rejects(WikiLeadRun.open({ workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy, executionFence }), WikiCandidateCorruptionError);
});

test("candidate rejects a symlink page and globally invalidates accepted review after any page write", async (t) => {
  const { root, candidate, run } = await fixture(t);
  await mkdir(path.join(candidate, "core"), { recursive: true });
  await symlink(path.join(root, "source", "a.ts"), path.join(candidate, "overview.md"));
  await assert.rejects(run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" }), /regular file|escapes/);
  await rm(path.join(candidate, "overview.md"));
  await run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  await run.replacePage({ path: "wiki/core/domain.md", content: content("Domain", "Core"), actor: "lead" });
  const { contracts: [contract] } = await run.queueDelegateBatch([{ id: "review", role: "review", instruction: "Review", sourceScopeIds: [], contextRefs: [], reviewPaths: ["wiki/overview.md", "wiki/core/domain.md"] }]);
  const receipt = { id: "review", role: "review", status: "complete", summary: "pass", outputs: [], coverage: [], gaps: [], attempts: 1, contractId: contract.contractId, contractDigest: contract.contractDigest, review: { verdict: "pass", reviewedPaths: contract.reviewPaths, findings: [], profileCoverage: [] } };
  await run.taskTransitions.taskStarted(1, "review", { attempt: 1 });
  await run.taskTransitions.taskSettled(1, "review", { attempt: 1, receipt });
  await run.assertPublishable(contract.reviewPaths, []);
  await run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview", " changed"), actor: "lead" });
  await assert.rejects(run.assertPublishable(contract.reviewPaths, []), /lacks passing independent review/);
});

test("independent WikiLeadRun instances serialize page commits without losing a global Candidate Revision", async (t) => {
  const { root, candidate, run: first, executionFence } = await fixture(t);
  const second = await WikiLeadRun.open({ workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy, executionFence });
  await Promise.all([
    first.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" }),
    second.replacePage({ path: "wiki/core/domain.md", content: content("Domain", "Core"), actor: "lead" }),
  ]);
  assert.match(await readFile(path.join(candidate, "overview.md"), "utf8"), /Runtime behavior/);
  assert.match(await readFile(path.join(candidate, "core", "domain.md"), "utf8"), /Runtime behavior/);
  const state = JSON.parse(await readFile(path.join(root, ".okf-wiki", "runs", "run-1", "lead-state.json"), "utf8"));
  assert.equal(state.candidateRevision, 3);
});

test("each review contract persists an exact independent path basis", async (t) => {
  const { run } = await fixture(t);
  await run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  await run.replacePage({ path: "wiki/core/domain.md", content: content("Domain", "Core"), actor: "lead" });
  const { contracts } = await run.queueDelegateBatch([
    { id: "overview-review", role: "review", instruction: "Review overview", sourceScopeIds: [], contextRefs: [], reviewPaths: ["wiki/overview.md"] },
    { id: "domain-review", role: "review", instruction: "Review domain", sourceScopeIds: [], contextRefs: [], reviewPaths: ["wiki/core/domain.md"] },
  ]);
  assert.deepEqual(contracts[0].reviewBasis.paths, ["wiki/overview.md"]);
  assert.deepEqual(contracts[1].reviewBasis.paths, ["wiki/core/domain.md"]);
  assert.equal(contracts[0].reviewBasis.treeDigest, contracts[1].reviewBasis.treeDigest);
});

test("semantic task transitions reject rollback, collection before terminal, and forged receipts", async (t) => {
  const { run } = await fixture(t);
  const { contracts: [contract] } = await run.queueDelegateBatch([{ id: "research", role: "research", instruction: "Research", sourceScopeIds: [], contextRefs: [] }]);
  await assert.rejects(run.taskTransitions.tasksCollected(1, [contract.id]), /Only terminal/);
  await assert.rejects(run.taskTransitions.taskSettled(1, contract.id, { attempt: 1, receipt: { id: contract.id } }), /Only the current running attempt/);
  await run.taskTransitions.taskStarted(1, contract.id, { attempt: 1 });
  await assert.rejects(run.taskTransitions.taskStarted(1, contract.id, { attempt: 3 }), /not monotonic/);
  const forged = { id: contract.id, role: contract.role, status: "failed", summary: "failed", outputs: [], coverage: [], gaps: [], attempts: 1, contractId: contract.contractId, contractDigest: "f".repeat(64), error: { code: "schema", message: "bad", retryable: false } };
  await assert.rejects(run.taskTransitions.taskSettled(1, contract.id, { attempt: 1, receipt: forged }), /does not match durable contract/);
});

test("persisted delegate history cannot delete queued tasks or forge a phase rollback", async (t) => {
  const { root, candidate, run, executionFence } = await fixture(t);
  const { contracts: [contract] } = await run.queueDelegateBatch([{ id: "durable", role: "research", instruction: "Research", sourceScopeIds: [], contextRefs: [] }]);
  await run.taskTransitions.taskStarted(1, contract.id, { attempt: 1 });
  const stateFile = path.join(root, ".okf-wiki", "runs", "run-1", "lead-state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  state.delegates.batches[0].tasks[0].phase = "queued";
  await writeFile(stateFile, JSON.stringify(state));
  await assert.rejects(WikiLeadRun.open({ workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy, executionFence }), /integrity check/);
  state.delegates.batches[0].tasks = [];
  await writeFile(stateFile, JSON.stringify(state));
  await assert.rejects(WikiLeadRun.open({ workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy, executionFence }), /integrity check/);
});

test("publication seal fails closed after file, dotfile, or empty-directory drift", async (t) => {
  const { candidate, run } = await fixture(t);
  await completeAndApprove(run);
  const seal = await run.sealForPublication({ requiredProfileCoverage: [], publicationAt: "2026-01-01T00:00:00.000Z" });
  assert.equal((await verifyWikiPublicationSeal(seal)).executionToken, "execution-1");
  await writeFile(path.join(candidate, ".drift"), "hidden\n");
  await assert.rejects(verifyWikiPublicationSeal(seal), /changed after it was sealed/);
  await rm(path.join(candidate, ".drift"));
  await mkdir(path.join(candidate, ".empty"));
  await assert.rejects(verifyWikiPublicationSeal(seal), /changed after it was sealed/);
  await rm(path.join(candidate, ".empty"), { recursive: true });
  await writeFile(path.join(candidate, "overview.md"), "tampered\n");
  await assert.rejects(verifyWikiPublicationSeal(seal), /changed after it was sealed/);
});

test("durable execution token fence blocks stale write, settle, and seal after same-attempt resume", async (t) => {
  const { root, candidate } = await fixture(t);
  const runStateFile = path.join(root, ".okf-wiki", "runs", "run-1", "run-state.json");
  await writeFile(runStateFile, JSON.stringify({ version: 2, id: "run-1", status: "running", attempt: 1, executionToken: "execution-old" }));
  const stale = await WikiLeadRun.open({
    workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy,
    executionFence: { runStateFile, attempt: 1, executionToken: "execution-old" },
  });
  await stale.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  const { contracts: [contract] } = await stale.queueDelegateBatch([{ id: "research", role: "research", instruction: "Research", sourceScopeIds: [], contextRefs: [] }]);
  await stale.taskTransitions.taskStarted(contract.batchId, contract.id, { attempt: 1 });
  const receipt = { id: contract.id, role: contract.role, status: "complete", summary: "done", outputs: [], coverage: [], gaps: [], attempts: 1, contractId: contract.contractId, contractDigest: contract.contractDigest };
  await writeFile(runStateFile, JSON.stringify({ version: 2, id: "run-1", status: "running", attempt: 1, executionToken: "execution-new" }));
  await assert.rejects(
    stale.replacePage({ path: "wiki/core/domain.md", content: content("Domain", "Core"), actor: "lead" }),
    /no longer active/,
  );
  await assert.rejects(stale.taskTransitions.taskSettled(contract.batchId, contract.id, { attempt: 1, receipt }), /no longer active/);
  await assert.rejects(stale.sealForPublication({ requiredProfileCoverage: [] }), /no longer active/);
  const current = await WikiLeadRun.open({
    workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy,
    executionFence: { runStateFile, attempt: 1, executionToken: "execution-new" },
  });
  await current.taskTransitions.taskSettled(contract.batchId, contract.id, { attempt: 1, receipt });
});

test("a fenced open performs no candidate or run-directory writes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-lead-fenced-open-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const runStateFile = path.join(root, "cancelled-run.json");
  await writeFile(runStateFile, JSON.stringify({ version: 2, id: "run-2", status: "running", attempt: 1, executionToken: "execution-new" }));
  const candidate = path.join(root, ".okf-wiki", "runs", "run-2", "candidate", "wiki");
  await assert.rejects(WikiLeadRun.open({
    workspace: root, runId: "run-2", candidateWikiRoot: candidate, policy,
    executionFence: { runStateFile, attempt: 1, executionToken: "execution-old" },
  }), /no longer active/);
  await assert.rejects(readFile(candidate), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, ".okf-wiki", "runs", "run-2")), { code: "ENOENT" });
});

test("pinned validation and finalization ignore workspace configuration changes during a run", async (t) => {
  const { root, candidate, executionFence } = await fixture(t);
  const run = await WikiLeadRun.open({
    workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy,
    sourcePlan: sourcePlan(root), language: "en", executionFence,
  });
  await writeFile(path.join(root, "workspace.yaml"), "this is no longer a valid workspace config\n");
  await completeAndApprove(run);
  const seal = await run.sealForPublication({ requiredProfileCoverage: [], publicationAt: "2026-01-01T00:00:00.000Z" });
  await verifyWikiPublicationSeal(seal);
});

for (const point of ["afterFinalizeJournal", "afterValidation", "afterObsoleteRemoval", "afterStamp", "afterIndexes", "afterCleanup", "afterFinalize", "afterSeal"]) {
  test(`publication finalization recovers after ${point}`, async (t) => {
    let armed = true;
    const { root, candidate, run, executionFence } = await fixture(t, undefined, (value) => { if (armed && value === point) throw new Error(`fault:${point}`); });
    await completeAndApprove(run);
    await assert.rejects(run.sealForPublication({ requiredProfileCoverage: [], publicationAt: "2026-01-01T00:00:00.000Z" }), new RegExp(`fault:${point}`));
    armed = false;
    const reopened = await WikiLeadRun.open({ workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy, executionFence });
    const seal = await reopened.sealForPublication({ requiredProfileCoverage: [], publicationAt: "2026-01-01T00:00:00.000Z" });
    await verifyWikiPublicationSeal(seal);
  });
}
