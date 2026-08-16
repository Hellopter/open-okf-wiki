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
    "core/domain.md",
    "core/runtime/concept.md",
    "core/runtime/flows.md",
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
  if (withSpec) await run.saveSpec(spec);
  return run;
}

const rejects = [
  ["empty instruction", (run) => run.dispatch([{ ...writeTask("write-core", "core"), instruction: "" }]), /empty instruction/],
  ["whitespace instruction", (run) => run.dispatch([{ ...writeTask("write-core", "core"), instruction: "   " }]), /empty instruction/],
  ["mix write and review", (run) => run.dispatch([writeTask("write-core", "core"), reviewTask("review-core", "core")]), /mix write and review/],
  ["unknown write cluster", (run) => run.dispatch([writeTask("write-missing", "missing")]), /Unknown Wiki cluster/],
  ["unknown review cluster", (run) => run.dispatch([reviewTask("review-missing", "missing")]), /Unknown Wiki cluster/],
  ["empty write cluster", (run) => run.dispatch([writeTask("write-empty", "")]), /requires a cluster|Unknown Wiki cluster/],
  ["write cluster not in spec", (run) => run.dispatch([writeTask("write-billing", "billing")]), /Unknown Wiki cluster/],
  ["write path not in spec becomes unknown cluster", (run) => run.dispatch([{ id: "write-missing", role: "write", instruction: "Write", sourceScopeIds: [], contextRefs: [], writePaths: ["wiki/missing.md"] }]), /Unknown Wiki cluster|requires a cluster/],
  ["review path not in spec becomes unknown cluster", (run) => run.dispatch([{ id: "review-missing", role: "review", instruction: "Review", sourceScopeIds: [], contextRefs: [], reviewPaths: ["wiki/missing.md"] }]), /Unknown Wiki cluster|requires a cluster/],
  ["write path lists that mix clusters become unknown cluster", (run) => run.dispatch([{ id: "write-mix", role: "write", instruction: "Write", sourceScopeIds: [], contextRefs: [], writePaths: ["wiki/overview.md", "wiki/core/domain.md"] }]), /Unknown Wiki cluster/],
  ["write path overlaps another task in the batch", (run) => run.dispatch([writeTask("write-a", "core"), writeTask("write-b", "core")]), /overlaps another task/],
  ["contextRefs not in the known set", (run) => run.dispatch([researchTask("research-1", { contextRefs: ["missing-ref"] })]), /unknown context artifact/],
  ["duplicate task ids", (run) => run.dispatch([researchTask("same"), researchTask("same")]), /Duplicate delegate task id/],
  ["research fan-out", (run) => run.dispatch([researchTask("r1"), researchTask("r2"), researchTask("r3"), researchTask("r4"), researchTask("r5")]), /at most 4 research/],
  ["write fan-out", (run) => run.dispatch([writeTask("w1", "_root"), writeTask("w2", "core"), writeTask("w3", "core/runtime")]), /at most 2 write/],
  ["review fan-out", (run) => run.dispatch([reviewTask("v1", "_root"), reviewTask("v2", "core"), reviewTask("v3", "core/runtime")]), /at most 2 review/],
];

for (const [name, action, pattern] of rejects) {
  test(`rejects ${name}`, async (t) => {
    const run = await lead(t);
    await assert.rejects(action(run), pattern);
  });
}

test("rejects review while a write is pending", async (t) => {
  const run = await lead(t);
  await run.dispatch([writeTask("write-core", "core")]);
  await assert.rejects(run.dispatch([reviewTask("review-core", "core")]), /writes are pending/);
});

test("rejects write path overlaps an existing non-terminal write", async (t) => {
  const run = await lead(t);
  await run.dispatch([writeTask("write-existing", "core")]);
  await assert.rejects(run.dispatch([writeTask("write-core", "core")]), /existing non-terminal write/);
});

test("rejects write without a spec", async (t) => {
  const run = await lead(t, false);
  await assert.rejects(run.dispatch([writeTask("write-core", "core")]), /accepted WikiSpec/);
});

test("allows a legal write batch for a single cluster", async (t) => {
  const run = await lead(t);
  const queued = await run.dispatch([writeTask("write-core", "core")]);
  assert.equal(queued.batchId, 1);
  assert.deepEqual(queued.contracts[0].writePaths, ["wiki/core/domain.md"]);
});

test("allows a legal review batch for a single cluster", async (t) => {
  const run = await lead(t);
  const page = (type, title) => ["---", `type: ${type}`, `title: ${title}`, "description: Runtime", "sources:", "  - id: src", "    resource: repo:source/a.ts#L1-L1", "---", "", "Runtime.[^src]", "", "[^src]: [Source](repo:source/a.ts#L1-L1)", ""].join("\n");
  for (const [rel, type, title] of [
    ["overview.md", "Overview", "Overview"],
    ["architecture.md", "Architecture", "Architecture"],
    ["core/domain.md", "Domain", "Core"],
    ["core/runtime/concept.md", "Concept", "Runtime"],
    ["core/runtime/flows.md", "Flow", "Flows"],
  ]) {
    const absolute = path.join(run.candidateWikiRoot, rel);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, page(type, title));
  }
  const queued = await run.dispatch([reviewTask("review-runtime", "core/runtime")]);
  assert.deepEqual(queued.contracts[0].reviewPaths, ["wiki/core/runtime/concept.md", "wiki/core/runtime/flows.md"]);
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
