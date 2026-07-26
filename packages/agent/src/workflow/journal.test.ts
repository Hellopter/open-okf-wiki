import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { AttemptJournal } from "./journal.js";
import { topologyFromSpec } from "./topology.js";

describe("AttemptJournal (pure, no model)", () => {
  it("setTopology preserves prior attempts", () => {
    const journal = new AttemptJournal();
    const a = journal.startAttempt({ nodeKey: "plan", role: "plan" });
    journal.completeAttempt(a.attemptId, { status: "done", summary: "planned" });
    const topo = topologyFromSpec(defaultWikiRunSpec("Demo"));
    journal.setTopology(topo, 1);
    const snap = journal.snapshot();
    assert.equal(snap.topologyVersion, 1);
    assert.ok(snap.topology.some((n) => n.kind === "domain"));
    assert.equal(snap.attempts.length, 1);
    assert.equal(snap.attempts[0]?.status, "done");
  });

  it("append-only: multi-round same nodeKey keeps both attempts", () => {
    const journal = new AttemptJournal();
    const r0 = journal.startAttempt({ nodeKey: "review", role: "reviewer", runIndex: 0 });
    journal.completeAttempt(r0.attemptId, { status: "done", summary: "blocking" });
    const r1 = journal.startAttempt({ nodeKey: "review", role: "reviewer", runIndex: 1 });
    journal.upsert({
      ...r1,
      status: "running",
      summary: "round 2",
    });
    const snap = journal.snapshot();
    const reviews = snap.attempts.filter((a) => a.nodeKey === "review");
    assert.equal(reviews.length, 2);
    assert.equal(reviews[0]?.runIndex, 0);
    assert.equal(reviews[1]?.runIndex, 1);
    assert.equal(snap.playhead?.attemptId, r1.attemptId);
  });

  it("streaming upsert updates same attemptId without duplicating", () => {
    const journal = new AttemptJournal();
    const a = journal.startAttempt({
      nodeKey: "domain-auth",
      role: "domain",
      attemptId: "domain-auth",
    });
    journal.upsert({
      ...a,
      status: "running",
      summary: "mid",
      items: [{ type: "toolCall", name: "read", status: "running" }],
    });
    journal.completeAttempt(a.attemptId, { status: "done", summary: "ok" });
    const snap = journal.snapshot();
    assert.equal(snap.attempts.length, 1);
    assert.equal(snap.attempts[0]?.status, "done");
    assert.equal(snap.attempts[0]?.summary, "ok");
  });
});

describe("topologyFromSpec via workflow (pure)", () => {
  it("builds plan → domain → leaf → write → review chain without LLM", () => {
    const spec = defaultWikiRunSpec("Pure");
    const nodes = topologyFromSpec(spec);
    assert.ok(nodes.some((n) => n.nodeKey === "plan"));
    assert.ok(nodes.some((n) => n.kind === "domain"));
    assert.ok(nodes.some((n) => n.kind === "leaf"));
    assert.ok(nodes.some((n) => n.nodeKey === "root_write"));
    assert.ok(nodes.some((n) => n.nodeKey === "review"));
  });
});
