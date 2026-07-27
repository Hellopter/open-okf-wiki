import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunGraphSnapshot } from "@okf-wiki/contract";
import { applyGraphProgress, createRunGraphOwner } from "./run-graph-owner.js";

describe("RunGraphOwner (pure + bind)", () => {
  it("attempt upsert streams same attemptId and appends new ids", () => {
    const owner = createRunGraphOwner();
    owner.apply({
      kind: "attempt",
      attempt: {
        attemptId: "domain-1",
        nodeKey: "domain-1",
        runIndex: 0,
        role: "domain",
        status: "running",
        summary: "research",
      },
    });
    owner.apply({
      kind: "attempt",
      attempt: {
        attemptId: "domain-1",
        nodeKey: "domain-1",
        runIndex: 0,
        role: "domain",
        status: "done",
        summary: "done",
      },
    });
    owner.apply({
      kind: "attempt",
      attempt: {
        attemptId: "review-1",
        nodeKey: "review",
        runIndex: 1,
        role: "reviewer",
        status: "running",
      },
    });
    const snap = owner.snapshot();
    assert.equal(snap.attempts.length, 2);
    assert.equal(snap.attempts[0]?.status, "done");
    assert.equal(snap.attempts[1]?.attemptId, "review-1");
    assert.equal(snap.playhead?.attemptId, "review-1");
  });

  it("topology bumps version when omitted and preserves attempts", () => {
    const owner = createRunGraphOwner();
    owner.apply({
      kind: "attempt",
      attempt: {
        attemptId: "plan",
        nodeKey: "plan",
        runIndex: 0,
        role: "plan",
        status: "done",
      },
    });
    owner.apply({
      kind: "topology",
      topology: [
        { nodeKey: "plan", kind: "plan", label: "Plan" },
        { nodeKey: "domain-core", kind: "domain", label: "Core", parentKey: "plan" },
      ],
    });
    let snap = owner.snapshot();
    assert.equal(snap.topologyVersion, 1);
    assert.equal(snap.topology.length, 2);
    assert.equal(snap.attempts.length, 1);

    owner.apply({
      kind: "topology",
      topology: [{ nodeKey: "plan", kind: "plan", label: "Plan v2" }],
    });
    snap = owner.snapshot();
    assert.equal(snap.topologyVersion, 2);
    assert.equal(snap.attempts[0]?.attemptId, "plan");
  });

  it("graph event folds attempts and topology", () => {
    const owner = createRunGraphOwner();
    const graph: RunGraphSnapshot = {
      topologyVersion: 3,
      topology: [{ nodeKey: "write", kind: "write", label: "Write" }],
      attempts: [
        {
          attemptId: "w0",
          nodeKey: "write",
          runIndex: 0,
          role: "root_write",
          status: "done",
        },
      ],
      playhead: { nodeKey: "write", attemptId: "w0" },
    };
    owner.apply({ kind: "graph", graph });
    const snap = owner.snapshot();
    assert.equal(snap.topologyVersion, 3);
    assert.equal(snap.topology[0]?.nodeKey, "write");
    assert.equal(snap.attempts.length, 1);
  });

  it("persist is no-op until bound; then saves snapshot", async () => {
    const owner = createRunGraphOwner();
    owner.apply({
      kind: "attempt",
      attempt: {
        attemptId: "a",
        nodeKey: "a",
        runIndex: 0,
        status: "running",
      },
    });
    await owner.persist(); // unbound — no throw

    const saved: RunGraphSnapshot[] = [];
    owner.bind("run-1", {
      async save(_runId, snapshot) {
        saved.push(snapshot);
      },
      async load() {
        return null;
      },
    });
    await owner.persist();
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.attempts[0]?.attemptId, "a");
  });

  it("applyGraphProgress folds graph kinds and ignores meta", () => {
    const owner = createRunGraphOwner();
    const graphs: RunGraphSnapshot[] = [];
    assert.equal(
      applyGraphProgress(
        owner,
        { kind: "status", status: "producing", summary: "x" },
        (g) => graphs.push(g),
      ),
      false,
    );
    assert.equal(graphs.length, 0);

    assert.equal(
      applyGraphProgress(
        owner,
        {
          kind: "attempt",
          attempt: {
            attemptId: "n1",
            nodeKey: "n1",
            runIndex: 0,
            role: "domain",
            status: "running",
          },
        },
        (g) => graphs.push(g),
      ),
      true,
    );
    assert.equal(graphs.length, 1);
    assert.equal(graphs[0]?.attempts[0]?.attemptId, "n1");
  });
});
