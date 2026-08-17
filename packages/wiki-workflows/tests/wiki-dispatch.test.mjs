import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { WikiLeadRun } from "../dist/lead.js";
import {
  createWikiDelegateCancelTool,
  createWikiDelegateCollectTool,
  createWikiDelegateStartTool,
  createWikiFinishTool,
  createWikiPlanTool,
  createWikiTaxonomyTool,
} from "../dist/lead/host-tools.js";

const policy = { templates: { requiredSections: [] }, review: { mustCover: [] } };
const spec = { pages: ["overview.md", "source/source.md", "source/core/domain.md"] };

async function lead(t, sourceScopeIds = ["source"], maxDelegatedTasks) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-dispatch-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  for (const scope of sourceScopeIds) {
    const source = path.join(root, scope);
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "a.ts"), "export const a = true;\n");
    execFileSync("git", ["init", "--quiet"], { cwd: source });
  }
  return await WikiLeadRun.open({
    workspace: root,
    runId: "run-1",
    candidateWikiRoot: path.join(root, ".okf-wiki", "runs", "run-1", "candidate", "wiki"),
    policy,
    assertActive: async () => {},
    executionToken: "execution-1",
    allowedSourceScopeIds: sourceScopeIds,
    ...(maxDelegatedTasks === undefined ? {} : { maxDelegatedTasks }),
  });
}

async function settleResearch(run, contracts, extra = {}) {
  for (const contract of contracts) {
    const followups = extra.followups ?? [];
    await run.taskTransitions.taskStarted(contract.batchId, contract.id, { attempt: 1 });
    await run.taskTransitions.taskSettled(contract.batchId, contract.id, { attempt: 1, receipt: {
      id: contract.id, role: "research", status: extra.status ?? "complete", summary: "complete", outputs: [],
      completedAssignmentIds: extra.status === "complete" || extra.status === undefined ? contract.assignmentIds : [],
      needsFollowup: followups.length > 0, followups, coverage: contract.assignmentIds, gaps: [], attempts: 1,
      ...(extra.error ? { error: extra.error } : {}), contractId: contract.contractId, contractDigest: contract.contractDigest,
    } });
  }
}

async function collect(run, contracts) {
  await run.taskTransitions.tasksCollected(contracts[0].batchId, contracts.map((contract) => contract.id));
}

test("workflow tool schemas expose no prose or opaque Run IDs", () => {
  const empty = [createWikiDelegateStartTool(async () => ({})), createWikiTaxonomyTool(async () => ({})), createWikiPlanTool(async () => ({})), createWikiFinishTool(async () => ({}))];
  for (const tool of empty) {
    assert.equal(Check(tool.parameters, {}), true);
    assert.equal(Check(tool.parameters, { tasks: [] }), false);
  }
  const collectTool = createWikiDelegateCollectTool(async () => ({}));
  assert.equal(Check(collectTool.parameters, { until: "all", timeoutSeconds: 10 }), true);
  assert.equal(Check(collectTool.parameters, { batchId: 1, until: "all", timeoutSeconds: 10 }), false);
  const cancel = createWikiDelegateCancelTool(async () => ({}));
  for (const reasonCode of ["superseded", "blocked", "user_requested"]) assert.equal(Check(cancel.parameters, { reasonCode }), true);
  assert.equal(Check(cancel.parameters, { reasonCode: "shutdown" }), false);
  assert.equal(Check(cancel.parameters, { taskIds: ["task-1"] }), false);
});

test("coordinator mints discovery identities and requires complete pinned Source coverage", async (t) => {
  const run = await lead(t, ["source-a", "source-b"]);
  await assert.rejects(run.startNextReadyWave([{ sourceScopeId: "source-a", instruction: "Survey A" }]), /cover every pinned Source: source-b/);
  assert.equal(await run.currentActiveWave(), undefined);
  const queued = await run.startNextReadyWave([
    { sourceScopeId: "source-a", instruction: "Survey A" },
    { sourceScopeId: "source-b", instruction: "Survey B" },
  ]);
  assert.equal(queued.wave, "discovery");
  assert.deepEqual(queued.contracts.map((contract) => contract.id), ["research-b1-t1", "research-b1-t2"]);
  assert.deepEqual(queued.contracts.map((contract) => contract.assignmentIds), [["a-b1-t1"], ["a-b1-t2"]]);
  assert.deepEqual(await run.currentActiveWave(), { wave: "discovery", batchId: 1 });
});

test("taxonomy cannot bypass discovery and must cover every pinned Source", async (t) => {
  const run = await lead(t, ["source-a", "source-b"]);
  await assert.rejects(run.saveTaxonomy({ revision: 1, decisions: [], conflictIds: [] }), /discovery research wave/);
  const discovery = await run.startNextReadyWave([
    { sourceScopeId: "source-a", instruction: "Survey A" },
    { sourceScopeId: "source-b", instruction: "Survey B" },
  ]);
  await settleResearch(run, discovery.contracts);
  await collect(run, discovery.contracts);
  await assert.rejects(run.saveTaxonomy({ revision: 1, decisions: [], conflictIds: [] }), /taxonomy decisions must not be empty/);
  await assert.rejects(run.saveTaxonomy({ revision: 1, decisions: [{ sourceScopeId: "source-a", domainId: "core", conceptIds: [] }], conflictIds: [] }), /cover every pinned Source: source-b/);
  await assert.rejects(
    run.saveTaxonomy({
      extra: true,
      revision: 1,
      decisions: [{ sourceScopeId: "nope", domainId: "core", conceptIds: [] }],
      conflictIds: [],
    }),
    (error) => {
      assert.match(error.message, /unknown fields: extra/);
      assert.match(error.message, /scopes outside pinned sources: nope \(allowed: source-a, source-b\)/);
      assert.match(error.message, /cover every pinned Source: source-a, source-b/);
      return true;
    },
  );
});

test("supplement inherits scopes and embeds the human question instead of blocker IDs", async (t) => {
  const run = await lead(t);
  const discovery = await run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Survey" }]);
  await settleResearch(run, discovery.contracts, { status: "incomplete", followups: [{ id: "gap-discover", kind: "evidence_gap", question: "Which fallback is authoritative?", sourceScopeIds: ["source"] }] });
  await collect(run, discovery.contracts);
  const supplement = await run.startNextReadyWave();
  assert.equal(supplement.wave, "supplement");
  assert.deepEqual(supplement.contracts[0].domainScopeIds, []);
  assert.deepEqual(supplement.contracts[0].lensScopeIds, []);
  assert.match(supplement.contracts[0].instruction, /Which fallback is authoritative\?/);
  assert.doesNotMatch(supplement.contracts[0].instruction, /gap-discover/);
});

test("coordinator expands accepted spec into host-derived write tasks", async (t) => {
  const run = await lead(t);
  const discovery = await run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Survey" }]);
  await settleResearch(run, discovery.contracts);
  await collect(run, discovery.contracts);
  await run.saveTaxonomy({ revision: 1, decisions: [{ sourceScopeId: "source", domainId: "core", conceptIds: [] }], conflictIds: [] });
  await run.saveSpec(spec);
  const writes = await run.startNextReadyWave();
  assert.equal(writes.wave, "write");
  assert.deepEqual(writes.contracts.map((contract) => contract.writePaths), [["wiki/overview.md"], ["wiki/source/source.md"], ["wiki/source/core/domain.md"]]);
  assert.ok(writes.contracts.every((contract) => contract.sourceScopeIds.join() === "source"));
});

test("taxonomy sourceScopeId must match the Wiki source folder", async (t) => {
  const run = await lead(t);
  const discovery = await run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Survey" }]);
  await settleResearch(run, discovery.contracts);
  await collect(run, discovery.contracts);
  await run.saveTaxonomy({ revision: 1, decisions: [{ sourceScopeId: "source", domainId: "core", conceptIds: [] }], conflictIds: [] });
  await assert.rejects(run.saveSpec({ pages: ["overview.md", "api/source.md", "api/core/domain.md"] }), /taxonomy domains not owned by their source: source\/core/);
});

test("budget preflight leaves no partial active wave", async (t) => {
  const run = await lead(t, ["source"], 0);
  await assert.rejects(run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Survey" }]), /Delegated task limit exhausted/);
  assert.equal(await run.currentActiveWave(), undefined);
});
