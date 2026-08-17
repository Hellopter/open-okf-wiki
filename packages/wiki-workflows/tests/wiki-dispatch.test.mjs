import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WikiLeadRun } from "../dist/lead.js";

const policy = { templates: { requiredSections: [] }, review: { mustCover: [] } };

const spec = {
  pages: [
    "overview.md",
    "architecture.md",
    "source/source.md",
    "source/core/domain.md",
    "source/core/runtime/concept.md",
    "source/core/runtime/flows.md",
  ],
};

function writeTask(id, cluster, extra = {}) {
  return { id, role: "write", instruction: `Write ${id}`, sourceScopeIds: [], contextRefs: [], cluster, ...extra };
}

function reviewTask(id, cluster, extra = {}) {
  return { id, role: "review", instruction: `Review ${id}`, sourceScopeIds: [], contextRefs: [], cluster, ...extra };
}

function researchTask(id, extra = {}) {
  return { id, role: "research", instruction: `Research ${id}`, sourceScopeIds: [], contextRefs: [], ...extra };
}

async function settleResearch(run, contracts, extra = {}) {
  for (const contract of contracts) {
    const followups = extra.followups ?? [];
    await run.taskTransitions.taskStarted(contract.batchId, contract.id, { attempt: 1 });
    await run.taskTransitions.taskSettled(contract.batchId, contract.id, {
      attempt: 1,
      receipt: {
        id: contract.id,
        role: "research",
        status: extra.status ?? "complete",
        summary: "complete",
        outputs: [],
        completedAssignmentIds: contract.assignmentIds,
        needsFollowup: followups.length > 0,
        followups,
        coverage: contract.assignmentIds,
        gaps: [],
        attempts: 1,
        contractId: contract.contractId,
        contractDigest: contract.contractDigest,
      },
    });
  }
}

async function lead(t, withSpec = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-dispatch-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "a.ts"), "export const a = true;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: source });
  await writeFile(path.join(root, "workspace.yaml"), [
    "version: 1", "language: en", "defaultSourceIgnores: true", "wiki:", "  exclude: []",
    "sources:", "  - path: source", "    origin:", "      type: link", `      localPath: ${JSON.stringify(source)}`, "",
  ].join("\n"));
  const candidate = path.join(root, ".okf-wiki", "runs", "run-1", "candidate", "wiki");
  await mkdir(candidate, { recursive: true });
  const run = await WikiLeadRun.open({
    workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy,
    assertActive: async () => {},
    executionToken: "execution-1",
    sourcePlan: {
      workspaceRoot: root, workspaceRealPath: root, configPath: path.join(root, "workspace.yaml"),
      defaultSourceIgnores: true, excludes: [], fingerprint: "a".repeat(64),
      sources: [{
        scopeId: "source", logicalPath: "source", absolutePath: source, realPath: source,
        repositoryRoot: source, repositoryIdentity: "source", head: "0".repeat(40), dirtyFingerprint: "b".repeat(64),
      }],
    },
    language: "en",
  });
  if (withSpec) {
    await run.saveTaxonomy({ revision: 1, decisions: [{ sourceScopeId: "source", domainId: "core", conceptIds: ["runtime"] }], conflictIds: [] });
    await run.saveSpec(spec);
  }
  return run;
}

const rejects = [
  ["empty instruction", (run) => run.dispatch([{ ...writeTask("write-core", "source/core"), instruction: "" }]), /empty instruction/],
  ["whitespace instruction", (run) => run.dispatch([{ ...writeTask("write-core", "source/core"), instruction: "   " }]), /empty instruction/],
  ["mix write and review", (run) => run.dispatch([writeTask("write-core", "source/core"), reviewTask("review-core", "source/core")]), /mix write and review/],
  ["mix discovery with write", (run) => run.dispatch([researchTask("discover"), writeTask("write-core", "source/core")]), /Discovery research may not mix/],
  ["mix supplement with write", (run) => run.dispatch([researchTask("supplement", { mode: "supplement", resolvesIds: ["gap:discover:1"] }), writeTask("write-core", "source/core")]), /Supplement research may not mix/],
  ["unknown write cluster", (run) => run.dispatch([writeTask("write-missing", "missing")]), /Unknown Wiki cluster/],
  ["unknown review cluster", (run) => run.dispatch([reviewTask("review-missing", "missing")]), /Unknown Wiki cluster/],
  ["empty write cluster", (run) => run.dispatch([writeTask("write-empty", "")]), /requires a cluster|Unknown Wiki cluster/],
  ["write cluster not in spec", (run) => run.dispatch([writeTask("write-billing", "billing")]), /Unknown Wiki cluster/],
  ["write path not in spec becomes unknown cluster", (run) => run.dispatch([{ id: "write-missing", role: "write", instruction: "Write", sourceScopeIds: [], contextRefs: [], writePaths: ["wiki/missing.md"] }]), /Unknown Wiki cluster|requires a cluster/],
  ["review path not in spec becomes unknown cluster", (run) => run.dispatch([{ id: "review-missing", role: "review", instruction: "Review", sourceScopeIds: [], contextRefs: [], reviewPaths: ["wiki/missing.md"] }]), /Unknown Wiki cluster|requires a cluster/],
  ["write path lists that mix clusters become unknown cluster", (run) => run.dispatch([{ id: "write-mix", role: "write", instruction: "Write", sourceScopeIds: [], contextRefs: [], writePaths: ["wiki/overview.md", "wiki/source/core/domain.md"] }]), /Unknown Wiki cluster/],
  ["write path overlaps another task in the batch", (run) => run.dispatch([writeTask("write-a", "source/core"), writeTask("write-b", "source/core")]), /overlaps another task/],
  ["contextRefs not in the known set", (run) => run.dispatch([researchTask("research-1", { contextRefs: ["missing-ref"] })]), /unknown context artifact/],
  ["duplicate task ids", (run) => run.dispatch([researchTask("same"), researchTask("same")]), /Duplicate delegate task id/],
];

for (const [name, action, pattern] of rejects) {
  test(`rejects ${name}`, async (t) => {
    const run = await lead(t);
    await assert.rejects(action(run), pattern);
  });
}

test("rejects review while a write is pending", async (t) => {
  const run = await lead(t);
  await run.dispatch([writeTask("write-core", "source/core")]);
  await assert.rejects(run.dispatch([reviewTask("review-core", "source/core")]), /writes are pending/);
});

test("rejects write path overlaps an existing non-terminal write", async (t) => {
  const run = await lead(t);
  await run.dispatch([writeTask("write-existing", "source/core")]);
  await assert.rejects(run.dispatch([writeTask("write-core", "source/core")]), /existing non-terminal write/);
});

test("rejects write without a spec", async (t) => {
  const run = await lead(t, false);
  await assert.rejects(run.dispatch([writeTask("write-core", "source/core")]), /accepted WikiSpec/);
});

test("wiki_plan is blocked until taxonomy is accepted", async (t) => {
  const run = await lead(t, false);
  await assert.rejects(run.saveSpec(spec), /taxonomy checkpoint/);
});

test("wiki_taxonomy rejects an undeclared source scope", async (t) => {
  const run = await lead(t, false);
  await assert.rejects(
    run.saveTaxonomy({ revision: 1, decisions: [{ sourceScopeId: "other", domainId: "core", conceptIds: ["runtime"] }], conflictIds: [] }),
    /undeclared source scope/,
  );
});

test("wiki_plan rejects taxonomy domains and concepts outside the submitted spec", async (t) => {
  const run = await lead(t, false);
  await run.saveTaxonomy({ revision: 1, decisions: [{ sourceScopeId: "source", domainId: "missing", conceptIds: ["unknown"] }], conflictIds: [] });
  await assert.rejects(run.saveSpec(spec), /taxonomy domain/);

  const conceptRun = await lead(t, false);
  await conceptRun.saveTaxonomy({ revision: 1, decisions: [{ sourceScopeId: "source", domainId: "core", conceptIds: ["unknown"] }], conflictIds: [] });
  await assert.rejects(conceptRun.saveSpec(spec), /taxonomy concept/);
});

test("wiki_plan and write/review dispatch are blocked by open research followups", async (t) => {
  const planRun = await lead(t, false);
  await planRun.saveTaxonomy({ revision: 1, decisions: [{ sourceScopeId: "source", domainId: "core", conceptIds: ["runtime"] }], conflictIds: [] });
  const { contracts } = await planRun.dispatch([researchTask("research-open", { assignmentIds: ["research-open"] })]);
  await settleResearch(planRun, contracts, { followups: [{ id: "gap-research-open", kind: "evidence_gap", question: "Need more evidence", sourceScopeIds: ["source"] }] });
  await assert.rejects(planRun.saveSpec(spec), /research wave is complete/);

  const run = await lead(t);
  const research = await run.dispatch([researchTask("research-open", { assignmentIds: ["research-open"] })]);
  await settleResearch(run, research.contracts, { followups: [{ id: "gap-research-open", kind: "evidence_gap", question: "Need more evidence", sourceScopeIds: ["source"] }] });
  await assert.rejects(run.dispatch([writeTask("write-core", "source/core")]), /complete research wave/);
  await assert.rejects(run.dispatch([reviewTask("review-core", "source/core")]), /complete research wave/);
});

test("allows a legal write batch for a single cluster", async (t) => {
  const run = await lead(t);
  const queued = await run.dispatch([writeTask("write-core", "source/core")]);
  assert.equal(queued.batchId, 1);
  assert.deepEqual(queued.contracts[0].writePaths, ["wiki/source/core/domain.md"]);
});

test("allows a legal review batch for a single cluster", async (t) => {
  const run = await lead(t);
  const page = (type, title) => ["---", `type: ${type}`, `title: ${title}`, "description: Runtime", "sources:", "  - id: src", "    resource: repo:source/a.ts#L1-L1", "---", "", "Runtime.[^src]", "", "[^src]: [Source](repo:source/a.ts#L1-L1)", ""].join("\n");
  for (const [rel, type, title] of [
    ["overview.md", "Overview", "Overview"],
    ["architecture.md", "Architecture", "Architecture"],
    ["source/source.md", "Source", "Source"],
    ["source/core/domain.md", "Domain", "Core"],
    ["source/core/runtime/concept.md", "Concept", "Runtime"],
    ["source/core/runtime/flows.md", "Flow", "Flows"],
  ]) {
    const absolute = path.join(run.candidateWikiRoot, rel);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, page(type, title));
  }
  const queued = await run.dispatch([reviewTask("review-runtime", "source/core/runtime")]);
  assert.deepEqual(queued.contracts[0].reviewPaths, ["wiki/source/core/runtime/concept.md", "wiki/source/core/runtime/flows.md"]);
});

test("allows overview and architecture as the root cluster", async (t) => {
  const run = await lead(t);
  const queued = await run.dispatch([writeTask("write-root", "_root")]);
  assert.deepEqual(queued.contracts[0].writePaths, ["wiki/overview.md", "wiki/architecture.md"]);
});

test("research may omit cluster", async (t) => {
  const run = await lead(t, false);
  const queued = await run.dispatch([researchTask("research-1"), researchTask("research-2", { cluster: "ignored" })]);
  assert.equal(queued.contracts.length, 2);
  assert.equal(queued.contracts[0].role, "research");
});

test("discovery blockers close through a supplement before the write wave", async (t) => {
  const run = await lead(t);
  const discovery = await run.dispatch([researchTask("discover", { assignmentIds: ["discover"] })]);
  await settleResearch(run, discovery.contracts, { followups: [{ id: "gap-discover", kind: "evidence_gap", question: "Need more evidence", sourceScopeIds: ["source"] }] });
  await assert.rejects(run.dispatch([writeTask("write-core", "source/core")]), /complete research wave/);

  const supplement = await run.dispatch([researchTask("supplement", {
    mode: "supplement", assignmentIds: ["supplement"], resolvesIds: ["gap-discover"],
  })]);
  await settleResearch(run, supplement.contracts);
  await assert.rejects(run.dispatch([researchTask("duplicate-supplement", {
    mode: "supplement", assignmentIds: ["duplicate"], resolvesIds: ["gap-discover"],
  })]), /unknown blocker/);
  const writes = await run.dispatch([writeTask("write-core", "source/core")]);
  assert.equal(writes.contracts.length, 1);
});

test("logical waves accept multiple research and write tasks within one batch", async (t) => {
  const run = await lead(t);
  const research = await run.dispatch([
    researchTask("r1"), researchTask("r2"), researchTask("r3"), researchTask("r4"), researchTask("r5"),
  ]);
  assert.equal(research.contracts.length, 5);
  for (const contract of research.contracts) {
    await run.taskTransitions.taskStarted(contract.batchId, contract.id, { attempt: 1 });
    await run.taskTransitions.taskSettled(contract.batchId, contract.id, {
      attempt: 1,
      receipt: {
        id: contract.id,
        role: "research",
        status: "complete",
        summary: "complete",
        outputs: [],
        completedAssignmentIds: contract.assignmentIds,
        needsFollowup: false,
        followups: [],
        coverage: contract.assignmentIds,
        gaps: [],
        attempts: 1,
        contractId: contract.contractId,
        contractDigest: contract.contractDigest,
      },
    });
  }
  const writes = await run.dispatch([
    writeTask("w1", "_root"), writeTask("w2", "source/core"), writeTask("w3", "source/core/runtime"),
  ]);
  assert.equal(writes.contracts.length, 3);
});

test("logical review wave accepts multiple clusters with valid source-aware pages", async (t) => {
  const run = await lead(t);
  const page = (type, title) => ["---", `type: ${type}`, `title: ${title}`, "description: Runtime", "sources:", "  - id: src", "    resource: repo:source/a.ts#L1-L1", "---", "", "Runtime.[^src]", "", "[^src]: [Source](repo:source/a.ts#L1-L1)", ""].join("\n");
  for (const [rel, type, title] of [
    ["overview.md", "Overview", "Overview"],
    ["architecture.md", "Architecture", "Architecture"],
    ["source/source.md", "Source", "Source"],
    ["source/core/domain.md", "Domain", "Core"],
    ["source/core/runtime/concept.md", "Concept", "Runtime"],
    ["source/core/runtime/flows.md", "Flow", "Flows"],
  ]) {
    const absolute = path.join(run.candidateWikiRoot, rel);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, page(type, title));
  }
  const reviews = await run.dispatch([
    reviewTask("v1", "_root"), reviewTask("v2", "source/core"), reviewTask("v3", "source/core/runtime"),
  ]);
  assert.equal(reviews.contracts.length, 3);
});
