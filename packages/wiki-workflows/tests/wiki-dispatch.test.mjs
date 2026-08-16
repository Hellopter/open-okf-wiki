import assert from "node:assert/strict";
import test from "node:test";
import { assertDispatchable } from "../dist/wiki-dispatch.js";
import { parseWikiSpec } from "../dist/wiki-spec.js";

function spec() {
  return parseWikiSpec({
    pages: [
      "overview.md",
      "architecture.md",
      "core/domain.md",
      "core/runtime/concept.md",
      "core/runtime/flows.md",
    ],
  });
}

function writeTask(id, cluster, extra = {}) {
  return { id, role: "write", instruction: `Write ${id}`, contextRefs: [], cluster, ...extra };
}

function reviewTask(id, cluster, extra = {}) {
  return { id, role: "review", instruction: `Review ${id}`, contextRefs: [], cluster, ...extra };
}

function researchTask(id, extra = {}) {
  return { id, role: "research", instruction: `Research ${id}`, contextRefs: [], ...extra };
}

const rejects = [
  ["empty instruction", { tasks: [{ ...writeTask("write-core", "core"), instruction: "" }], spec: spec() }, /empty instruction/],
  ["whitespace instruction", { tasks: [{ ...writeTask("write-core", "core"), instruction: "   " }], spec: spec() }, /empty instruction/],
  ["mix write and review", { tasks: [writeTask("write-core", "core"), reviewTask("review-core", "core")], spec: spec() }, /mix write and review/],
  ["review while a write is pending", { tasks: [reviewTask("review-core", "core")], spec: spec(), pendingWritePaths: ["wiki/core/runtime/concept.md"] }, /writes are pending/],
  ["unknown write cluster", { tasks: [writeTask("write-missing", "missing")], spec: spec() }, /Unknown Wiki cluster/],
  ["unknown review cluster", { tasks: [reviewTask("review-missing", "missing")], spec: spec() }, /Unknown Wiki cluster/],
  ["empty write cluster", { tasks: [writeTask("write-empty", "")], spec: spec() }, /requires a cluster|Unknown Wiki cluster/],
  ["write cluster not in spec", { tasks: [writeTask("write-billing", "billing")], spec: spec() }, /Unknown Wiki cluster/],
  ["write path not in spec becomes unknown cluster", { tasks: [{ id: "write-missing", role: "write", instruction: "Write", contextRefs: [], writePaths: ["wiki/missing.md"] }], spec: spec() }, /Unknown Wiki cluster|requires a cluster/],
  ["review path not in spec becomes unknown cluster", { tasks: [{ id: "review-missing", role: "review", instruction: "Review", contextRefs: [], reviewPaths: ["wiki/missing.md"] }], spec: spec() }, /Unknown Wiki cluster|requires a cluster/],
  ["write path lists that mix clusters become unknown cluster", { tasks: [{ id: "write-mix", role: "write", instruction: "Write", contextRefs: [], writePaths: ["wiki/overview.md", "wiki/core/domain.md"] }], spec: spec() }, /Unknown Wiki cluster/],
  ["write path overlaps another task in the batch", { tasks: [writeTask("write-a", "core"), writeTask("write-b", "core")], spec: spec() }, /overlaps another task/],
  ["write path overlaps an existing non-terminal write", { tasks: [writeTask("write-core", "core")], spec: spec(), pendingWritePaths: ["core/domain.md"] }, /existing non-terminal write/],
  ["contextRefs not in the known set", { tasks: [researchTask("research-1", { contextRefs: ["missing-ref"] })] }, /unknown context artifact/],
  ["duplicate task ids", { tasks: [researchTask("same"), researchTask("same")] }, /Duplicate delegate task id/],
  ["delegated task cap", { tasks: [researchTask("a"), researchTask("b")], delegatedTasks: 1, maxDelegatedTasks: 2 }, /Delegated task limit/],
  ["delegate batch cap", { tasks: [researchTask("a")], delegateBatches: 2, maxDelegateBatches: 2 }, /Delegate batch limit/],
  ["research fan-out", { tasks: [researchTask("r1"), researchTask("r2"), researchTask("r3"), researchTask("r4"), researchTask("r5")] }, /at most 4 research/],
  ["write fan-out", { tasks: [writeTask("w1", "_root"), writeTask("w2", "core"), writeTask("w3", "core/runtime")], spec: spec() }, /at most 2 write/],
  ["review fan-out", { tasks: [reviewTask("v1", "_root"), reviewTask("v2", "core"), reviewTask("v3", "core/runtime")], spec: spec() }, /at most 2 review/],
  ["write without a spec", { tasks: [writeTask("write-core", "core")] }, /accepted WikiSpec/],
];

for (const [name, input, pattern] of rejects) {
  test(`rejects ${name}`, () => {
    assert.throws(() => assertDispatchable(input), pattern);
  });
}

test("allows a legal write batch for a single cluster", () => {
  assert.doesNotThrow(() => assertDispatchable({
    tasks: [writeTask("write-core", "core")],
    spec: spec(),
  }));
});

test("allows a legal review batch for a single cluster", () => {
  assert.doesNotThrow(() => assertDispatchable({
    tasks: [reviewTask("review-runtime", "core/runtime")],
    spec: spec(),
  }));
});

test("allows overview and architecture as the root cluster", () => {
  assert.doesNotThrow(() => assertDispatchable({
    tasks: [writeTask("write-root", "_root")],
    spec: spec(),
  }));
});

test("research may omit cluster", () => {
  assert.doesNotThrow(() => assertDispatchable({
    tasks: [researchTask("research-1"), researchTask("research-2", { cluster: "ignored" })],
  }));
});
