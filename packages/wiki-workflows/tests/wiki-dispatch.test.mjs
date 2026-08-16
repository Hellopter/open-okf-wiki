import assert from "node:assert/strict";
import test from "node:test";
import { assertDispatchable } from "../dist/wiki-dispatch.js";
import { parseWikiSpec } from "../dist/wiki-spec.js";

function page(pageType, pagePath) {
  return { pageType, path: pagePath, title: pagePath, purpose: "Document", readerQuestions: ["Why?"], requiredFacets: [], findingIds: [] };
}

function spec() {
  return parseWikiSpec({
    version: 1,
    overview: page("overview", "overview.md"),
    architecture: page("architecture", "architecture.md"),
    domains: [{
      id: "core",
      title: "Core",
      purpose: "Core",
      pages: [
        page("domain", "core/domain.md"),
        page("concept", "core/runtime/concept.md"),
        page("flow", "core/runtime/flows.md"),
      ],
    }],
    crossLinks: [],
    sharedTerms: [],
    omissions: [],
  });
}

function writeTask(id, writePaths, extra = {}) {
  return { id, role: "write", instruction: `Write ${id}`, contextRefs: [], writePaths, ...extra };
}

function reviewTask(id, reviewPaths, extra = {}) {
  return { id, role: "review", instruction: `Review ${id}`, contextRefs: [], reviewPaths, ...extra };
}

function researchTask(id, extra = {}) {
  return { id, role: "research", instruction: `Research ${id}`, contextRefs: [], ...extra };
}

const rejects = [
  ["empty instruction", { tasks: [{ ...writeTask("write-core", ["wiki/core/domain.md"]), instruction: "" }], spec: spec() }, /empty instruction/],
  ["whitespace instruction", { tasks: [{ ...writeTask("write-core", ["wiki/core/domain.md"]), instruction: "   " }], spec: spec() }, /empty instruction/],
  ["mix write and review", { tasks: [writeTask("write-core", ["wiki/core/domain.md"]), reviewTask("review-core", ["wiki/core/domain.md"])], spec: spec() }, /mix write and review/],
  ["review while a write is pending", { tasks: [reviewTask("review-core", ["wiki/core/domain.md"])], spec: spec(), pendingWritePaths: ["wiki/core/runtime/concept.md"] }, /writes are pending/],
  ["write path not declared by spec", { tasks: [writeTask("write-missing", ["wiki/missing.md"])], spec: spec() }, /not declared/],
  ["review path not declared by spec", { tasks: [reviewTask("review-missing", ["wiki/missing.md"])], spec: spec() }, /not declared/],
  ["write paths mix root and domain cluster", { tasks: [writeTask("write-mix", ["wiki/overview.md", "wiki/core/domain.md"])], spec: spec() }, /one Wiki cluster/],
  ["review paths mix two domain clusters", { tasks: [reviewTask("review-mix", ["wiki/core/domain.md", "wiki/core/runtime/concept.md"])], spec: spec() }, /one Wiki cluster/],
  ["write path overlaps another task in the batch", { tasks: [writeTask("write-a", ["wiki/core/domain.md"]), writeTask("write-b", ["wiki/core/domain.md"])], spec: spec() }, /overlaps another task/],
  ["write path overlaps an existing non-terminal write", { tasks: [writeTask("write-core", ["wiki/core/domain.md"])], spec: spec(), pendingWritePaths: ["core/domain.md"] }, /existing non-terminal write/],
  ["contextRefs not in the known set", { tasks: [researchTask("research-1", { contextRefs: ["missing-ref"] })] }, /unknown context artifact/],
  ["duplicate task ids", { tasks: [researchTask("same"), researchTask("same")] }, /Duplicate delegate task id/],
  ["delegated task cap", { tasks: [researchTask("a"), researchTask("b")], delegatedTasks: 1, maxDelegatedTasks: 2 }, /Delegated task limit/],
  ["delegate batch cap", { tasks: [researchTask("a")], delegateBatches: 2, maxDelegateBatches: 2 }, /Delegate batch limit/],
  ["research fan-out", { tasks: [researchTask("r1"), researchTask("r2"), researchTask("r3"), researchTask("r4"), researchTask("r5")] }, /at most 4 research/],
  ["write fan-out", { tasks: [writeTask("w1", ["wiki/overview.md"]), writeTask("w2", ["wiki/core/domain.md"]), writeTask("w3", ["wiki/core/runtime/concept.md"])], spec: spec() }, /at most 2 write/],
  ["review fan-out", { tasks: [reviewTask("v1", ["wiki/overview.md"]), reviewTask("v2", ["wiki/core/domain.md"]), reviewTask("v3", ["wiki/core/runtime/concept.md"])], spec: spec() }, /at most 2 review/],
  ["write without a spec", { tasks: [writeTask("write-core", ["wiki/core/domain.md"])] }, /accepted WikiSpec/],
];

for (const [name, input, pattern] of rejects) {
  test(`rejects ${name}`, () => {
    assert.throws(() => assertDispatchable(input), pattern);
  });
}

test("allows a legal write batch for a single cluster", () => {
  assert.doesNotThrow(() => assertDispatchable({
    tasks: [writeTask("write-core", ["wiki/core/domain.md"])],
    spec: spec(),
  }));
});

test("allows overview and architecture as the root cluster", () => {
  assert.doesNotThrow(() => assertDispatchable({
    tasks: [writeTask("write-root", ["wiki/overview.md", "wiki/architecture.md"])],
    spec: spec(),
  }));
});
