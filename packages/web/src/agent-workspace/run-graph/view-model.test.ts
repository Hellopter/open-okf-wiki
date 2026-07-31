import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunGraphSnapshot } from "@okf-wiki/contract";
import { runGraphToViewModel } from "./view-model.ts";

describe("runGraphToViewModel", () => {
  it("layers topology and picks latest attempt per node", () => {
    const snapshot: RunGraphSnapshot = {
      topologyVersion: 1,
      topology: [
        { nodeKey: "plan", kind: "plan", label: "Plan" },
        { nodeKey: "domain-core", kind: "domain", label: "Core", parentKey: "plan" },
        { nodeKey: "write", kind: "write", label: "Write", dependsOn: ["domain-core"] },
        { nodeKey: "review", kind: "review", label: "Review", dependsOn: ["write"] },
      ],
      attempts: [
        {
          attemptId: "domain-core@0",
          nodeKey: "domain-core",
          runIndex: 0,
          role: "domain",
          status: "done",
          summary: "first",
        },
        {
          attemptId: "domain-core@1",
          nodeKey: "domain-core",
          runIndex: 1,
          role: "domain",
          status: "running",
          summary: "retry",
        },
        {
          attemptId: "write@0",
          nodeKey: "write",
          runIndex: 0,
          role: "root_write",
          status: "done",
        },
      ],
      playhead: { nodeKey: "domain-core", attemptId: "domain-core@1" },
    };

    const vm = runGraphToViewModel(snapshot);
    assert.equal(vm.topologyVersion, 1);
    assert.ok(vm.layers.some((l) => l.id === "research"));
    assert.ok(vm.layers.some((l) => l.id === "write"));
    const domain = vm.layers.flatMap((l) => l.nodes).find((n) => n.nodeKey === "domain-core");
    assert.ok(domain);
    assert.equal(domain.status, "running");
    assert.equal(domain.attemptCount, 2);
    assert.equal(domain.latestAttempt?.summary, "retry");
    assert.equal(domain.parentKey, "plan");
    assert.deepEqual(vm.edges, [{ from: "plan", to: "domain-core" }]);
    assert.equal(vm.playhead?.attemptId, "domain-core@1");
  });

  it("handles empty snapshot", () => {
    const vm = runGraphToViewModel({ topologyVersion: 0, topology: [], attempts: [] });
    assert.equal(vm.layers.length, 0);
    assert.deepEqual(vm.edges, []);
    assert.equal(vm.attempts.length, 0);
  });

  it("does not invent edges for missing parents or dependsOn metadata", () => {
    const vm = runGraphToViewModel({
      topologyVersion: 1,
      topology: [
        { nodeKey: "child", kind: "leaf", label: "Child", parentKey: "missing" },
        { nodeKey: "dependent", kind: "write", label: "Dependent", dependsOn: ["child"] },
      ],
      attempts: [],
    });

    assert.deepEqual(vm.edges, []);
  });
});
