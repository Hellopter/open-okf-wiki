import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateJoin,
  groupAllSucceeded,
  groupHasTerminalFailure,
  siblingsByGroupKey,
} from "../dist/join-barrier.js";

test("empty members are not all-succeeded and not terminal failure", () => {
  assert.equal(groupAllSucceeded([]), false);
  assert.equal(groupHasTerminalFailure([]), false);
  assert.deepEqual(evaluateJoin([]), { ready: false, reason: "not_ready" });
});

test("single succeeded member is ready", () => {
  const members = [{ id: "a", status: "succeeded" }];
  assert.equal(groupAllSucceeded(members), true);
  assert.equal(groupHasTerminalFailure(members), false);
  assert.deepEqual(evaluateJoin(members), { ready: true, reason: "all_succeeded" });
});

test("partial succeeded is not ready", () => {
  const members = [
    { id: "a", status: "succeeded" },
    { id: "b", status: "running" },
    { id: "c", status: "queued" },
  ];
  assert.equal(groupAllSucceeded(members), false);
  assert.equal(groupHasTerminalFailure(members), false);
  assert.deepEqual(evaluateJoin(members), { ready: false, reason: "not_ready" });
});

test("all succeeded is ready", () => {
  const members = [
    { id: "a", status: "succeeded" },
    { id: "b", status: "succeeded" },
    { id: "c", status: "succeeded" },
  ];
  assert.equal(groupAllSucceeded(members), true);
  assert.deepEqual(evaluateJoin(members), { ready: true, reason: "all_succeeded" });
});

test("one failed yields terminal_failure", () => {
  const members = [
    { id: "a", status: "succeeded" },
    { id: "b", status: "failed" },
    { id: "c", status: "running" },
  ];
  assert.equal(groupHasTerminalFailure(members), true);
  assert.equal(groupAllSucceeded(members), false);
  assert.deepEqual(evaluateJoin(members), { ready: false, reason: "terminal_failure" });
});

test("blocked and cancelled are terminal failures", () => {
  assert.equal(groupHasTerminalFailure([{ id: "x", status: "blocked" }]), true);
  assert.equal(groupHasTerminalFailure([{ id: "y", status: "cancelled" }]), true);
  assert.deepEqual(evaluateJoin([{ id: "x", status: "blocked" }]), {
    ready: false,
    reason: "terminal_failure",
  });
  assert.deepEqual(evaluateJoin([{ id: "y", status: "cancelled" }]), {
    ready: false,
    reason: "terminal_failure",
  });
});

test("siblingsByGroupKey filters by kind and group field", () => {
  const nodes = [
    {
      id: "research-a",
      kind: "research",
      status: "succeeded",
      input: { researchGroupId: "research:initial" },
    },
    {
      id: "research-b",
      kind: "research",
      status: "running",
      input: { researchGroupId: "research:initial" },
    },
    {
      id: "research-other",
      kind: "research",
      status: "queued",
      input: { researchGroupId: "research:other" },
    },
    {
      id: "write-a",
      kind: "write",
      status: "queued",
      input: { writeGroupId: "write:initial", researchGroupId: "research:initial" },
    },
    {
      id: "no-input",
      kind: "research",
      status: "queued",
      input: null,
    },
  ];

  const siblings = siblingsByGroupKey(nodes, "research", "researchGroupId", "research:initial");
  assert.deepEqual(siblings, [
    { id: "research-a", status: "succeeded" },
    { id: "research-b", status: "running" },
  ]);

  const multiKind = siblingsByGroupKey(
    nodes,
    ["research", "write"],
    "researchGroupId",
    "research:initial",
  );
  assert.deepEqual(
    multiKind.map((m) => m.id).sort(),
    ["research-a", "research-b", "write-a"],
  );

  assert.deepEqual(
    siblingsByGroupKey(nodes, "research", "researchGroupId", "missing"),
    [],
  );
});

test("siblingsByGroupKey excludes invalidated members so restart waves can rejoin", () => {
  const nodes = [
    {
      id: "research-old-a",
      kind: "research",
      status: "invalidated",
      input: { researchGroupId: "research:0:same" },
    },
    {
      id: "research-old-b",
      kind: "research",
      status: "invalidated",
      input: { researchGroupId: "research:0:same" },
    },
    {
      id: "research-new-a",
      kind: "research",
      status: "succeeded",
      input: { researchGroupId: "research:0:same" },
    },
    {
      id: "research-new-b",
      kind: "research",
      status: "succeeded",
      input: { researchGroupId: "research:0:same" },
    },
  ];

  const siblings = siblingsByGroupKey(nodes, "research", "researchGroupId", "research:0:same");
  assert.deepEqual(siblings, [
    { id: "research-new-a", status: "succeeded" },
    { id: "research-new-b", status: "succeeded" },
  ]);
  assert.deepEqual(evaluateJoin(siblings), { ready: true, reason: "all_succeeded" });
});
