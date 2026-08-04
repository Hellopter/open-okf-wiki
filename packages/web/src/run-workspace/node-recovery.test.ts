import assert from "node:assert/strict";
import test from "node:test";
import type { WikiRunSnapshot } from "@okf-wiki/contract/wiki-runs";
import {
  ATTEMPT_ERROR_PREVIEW_CHARS,
  canRerunNode,
  canRetryFailedNode,
  hasLikelyDownstreamConsumers,
  hasMaterializedExecutionTopology,
  isRepairNodeKey,
  lastFailedAttemptForNode,
  listRecoveryTargetNodes,
  listRetryableNodeKeys,
  needsRecoveryBanner,
  shouldShowNoAutoRetryHint,
  truncateAttemptError,
} from "./node-recovery.ts";

const DIGEST = "a".repeat(64);
const ARTIFACT = {
  artifactId: "art-1",
  kind: "receipt" as const,
  digest: DIGEST,
  sealedAt: "2026-08-02T00:00:00.000Z",
};

function baseSnapshot(partial: Partial<WikiRunSnapshot> = {}): WikiRunSnapshot {
  return {
    schema: 5,
    definitionVersion: 5,
    runId: "run-1",
    workspaceId: "ws-1",
    revision: 1,
    state: "failed",
    cancelRequested: false,
    intent: { mode: "generate" },
    pinnedInputs: {
      sources: [
        {
          id: "src-1",
          url: "https://example.com/repo.git",
          commit: "c".repeat(40),
        },
      ],
      skillDigest: DIGEST,
      digest: DIGEST,
    },
    nodes: [],
    edges: [],
    attempts: [],
    gates: [],
    effects: [],
    candidates: [],
    revisions: [],
    reviewThreads: [],
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:01:00.000Z",
    ...partial,
  } as WikiRunSnapshot;
}

test("isRepairNodeKey matches product repair.N keys only", () => {
  assert.equal(isRepairNodeKey("repair.1"), true);
  assert.equal(isRepairNodeKey("repair.12"), true);
  assert.equal(isRepairNodeKey("repair.hv.1"), false);
  assert.equal(isRepairNodeKey("write.root"), false);
});

test("canRetryFailedNode accepts failed node with failed attempt", () => {
  const snapshot = baseSnapshot({
    nodes: [
      {
        key: "research.leaf.a",
        kind: "research",
        state: "failed",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-1",
        outputs: [],
        label: "Leaf A",
      },
    ],
    attempts: [
      {
        attemptId: "att-1",
        nodeKey: "research.leaf.a",
        nodeGeneration: 0,
        runIndex: 1,
        state: "failed",
        inputDigest: DIGEST,
        error: "provider timeout",
        startedAt: "2026-08-02T00:00:00.000Z",
        endedAt: "2026-08-02T00:01:00.000Z",
      },
    ],
  });

  const result = canRetryFailedNode(snapshot, "research.leaf.a");
  assert.deepEqual(result, {
    ok: true,
    attemptId: "att-1",
    generation: 0,
  });
});

test("canRetryFailedNode accepts failed durable plan.scout like a leaf", () => {
  const snapshot = baseSnapshot({
    nodes: [
      {
        key: "plan.scout.entry",
        kind: "plan.scout",
        state: "failed",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-scout",
        outputs: [],
        label: "Scout · entry",
      },
      {
        key: "plan",
        kind: "plan",
        state: "blocked",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: null,
        outputs: [],
        label: "Plan",
      },
    ],
    edges: [{ from: "plan.scout.entry", to: "plan" }],
    attempts: [
      {
        attemptId: "att-scout",
        nodeKey: "plan.scout.entry",
        nodeGeneration: 0,
        runIndex: 1,
        state: "failed",
        inputDigest: DIGEST,
        error: "scout model timeout",
        failureClass: "infrastructure",
        startedAt: "2026-08-02T00:00:00.000Z",
        endedAt: "2026-08-02T00:01:00.000Z",
      },
    ],
  });

  assert.deepEqual(canRetryFailedNode(snapshot, "plan.scout.entry"), {
    ok: true,
    attemptId: "att-scout",
    generation: 0,
  });
  // plan.scout shares L_control transport auto-requeue with research leaf/domain.
  assert.equal(shouldShowNoAutoRetryHint("infrastructure", "plan.scout"), false);
  // Product/schema failures still need manual Retry/Rerun.
  assert.equal(shouldShowNoAutoRetryHint("schema", "plan.scout"), true);
});

test("canRetryFailedNode accepts interrupted last attempt", () => {
  const snapshot = baseSnapshot({
    nodes: [
      {
        key: "plan",
        kind: "plan",
        state: "failed",
        generation: 1,
        currentAttemptId: null,
        lastAttemptId: "att-int",
        outputs: [],
        label: "Plan",
      },
    ],
    attempts: [
      {
        attemptId: "att-int",
        nodeKey: "plan",
        nodeGeneration: 1,
        runIndex: 2,
        state: "interrupted",
        inputDigest: DIGEST,
        error: null,
        startedAt: "2026-08-02T00:00:00.000Z",
        endedAt: "2026-08-02T00:01:00.000Z",
      },
    ],
  });

  assert.equal(canRetryFailedNode(snapshot, "plan").ok, true);
});

test("canRetryFailedNode rejects published and cancelled runs", () => {
  const published = baseSnapshot({
    state: "published",
    nodes: [
      {
        key: "plan",
        kind: "plan",
        state: "failed",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-1",
        outputs: [],
        label: "Plan",
      },
    ],
    attempts: [
      {
        attemptId: "att-1",
        nodeKey: "plan",
        nodeGeneration: 0,
        runIndex: 1,
        state: "failed",
        inputDigest: DIGEST,
        error: "x",
        startedAt: "2026-08-02T00:00:00.000Z",
        endedAt: "2026-08-02T00:01:00.000Z",
      },
    ],
  });
  assert.deepEqual(canRetryFailedNode(published, "plan"), {
    ok: false,
    reasonKey: "runPublished",
  });

  const cancelled = baseSnapshot({
    state: "cancelled",
    cancelRequested: true,
    nodes: published.nodes,
    attempts: published.attempts,
  });
  assert.deepEqual(canRetryFailedNode(cancelled, "plan"), {
    ok: false,
    reasonKey: "runCancelled",
  });
});

test("canRetryFailedNode rejects cancelled/invalidated/non-failed nodes", () => {
  const snapshot = baseSnapshot({
    state: "running",
    nodes: [
      {
        key: "a",
        kind: "research",
        state: "cancelled",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-1",
        outputs: [],
        label: "A",
      },
      {
        key: "b",
        kind: "research",
        state: "invalidated",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-2",
        outputs: [],
        label: "B",
      },
      {
        key: "c",
        kind: "research",
        state: "succeeded",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-3",
        outputs: [],
        label: "C",
      },
    ],
    attempts: [],
  });
  assert.equal(canRetryFailedNode(snapshot, "a").reasonKey, "nodeCancelled");
  assert.equal(canRetryFailedNode(snapshot, "b").reasonKey, "nodeInvalidated");
  assert.equal(canRetryFailedNode(snapshot, "c").reasonKey, "nodeNotFailed");
  assert.equal(canRetryFailedNode(snapshot, "missing").reasonKey, "nodeNotFound");
});

test("canRetryFailedNode rejects freeze before pin and hasConsumers", () => {
  const unpinned = baseSnapshot({
    pinnedInputs: null,
    nodes: [
      {
        key: "freeze",
        kind: "freeze",
        state: "failed",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-f",
        outputs: [],
        label: "Freeze",
      },
    ],
    attempts: [
      {
        attemptId: "att-f",
        nodeKey: "freeze",
        nodeGeneration: 0,
        runIndex: 1,
        state: "failed",
        inputDigest: DIGEST,
        error: "x",
        startedAt: "2026-08-02T00:00:00.000Z",
        endedAt: "2026-08-02T00:01:00.000Z",
      },
    ],
  });
  assert.deepEqual(canRetryFailedNode(unpinned, "freeze"), {
    ok: false,
    reasonKey: "freezeNotPinned",
  });

  const withConsumers = baseSnapshot({
    nodes: [
      {
        key: "plan",
        kind: "plan",
        state: "failed",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-p",
        outputs: [{ role: "spec", artifact: ARTIFACT }],
        label: "Plan",
      },
      {
        key: "write.root",
        kind: "write",
        state: "succeeded",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-w",
        outputs: [],
        label: "Write",
      },
    ],
    edges: [{ from: "plan", to: "write.root" }],
    attempts: [
      {
        attemptId: "att-p",
        nodeKey: "plan",
        nodeGeneration: 0,
        runIndex: 1,
        state: "failed",
        inputDigest: DIGEST,
        error: "x",
        startedAt: "2026-08-02T00:00:00.000Z",
        endedAt: "2026-08-02T00:01:00.000Z",
      },
      {
        attemptId: "att-w",
        nodeKey: "write.root",
        nodeGeneration: 0,
        runIndex: 2,
        state: "succeeded",
        inputDigest: DIGEST,
        error: null,
        startedAt: "2026-08-02T00:00:00.000Z",
        endedAt: "2026-08-02T00:02:00.000Z",
      },
    ],
  });
  assert.equal(hasLikelyDownstreamConsumers(withConsumers, "plan"), true);
  assert.deepEqual(canRetryFailedNode(withConsumers, "plan"), {
    ok: false,
    reasonKey: "hasConsumers",
  });
});

test("canRerunNode allows with warnConsumers and blocks repair / terminal runs", () => {
  const snapshot = baseSnapshot({
    state: "running",
    nodes: [
      {
        key: "write.root",
        kind: "write",
        state: "succeeded",
        generation: 2,
        currentAttemptId: null,
        lastAttemptId: "att-w",
        outputs: [{ role: "wiki_tree", artifact: ARTIFACT }],
        label: "Write",
      },
      {
        key: "validate.pre",
        kind: "validate",
        state: "succeeded",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-v",
        outputs: [],
        label: "Validate",
      },
      {
        key: "repair.1",
        kind: "repair",
        state: "failed",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-r",
        outputs: [],
        label: "Repair 1",
      },
    ],
    edges: [{ from: "write.root", to: "validate.pre" }],
    attempts: [
      {
        attemptId: "att-w",
        nodeKey: "write.root",
        nodeGeneration: 2,
        runIndex: 1,
        state: "succeeded",
        inputDigest: DIGEST,
        error: null,
        startedAt: "2026-08-02T00:00:00.000Z",
        endedAt: "2026-08-02T00:01:00.000Z",
      },
      {
        attemptId: "att-v",
        nodeKey: "validate.pre",
        nodeGeneration: 0,
        runIndex: 2,
        state: "succeeded",
        inputDigest: DIGEST,
        error: null,
        startedAt: "2026-08-02T00:00:00.000Z",
        endedAt: "2026-08-02T00:02:00.000Z",
      },
    ],
  });

  const rerun = canRerunNode(snapshot, "write.root");
  assert.deepEqual(rerun, { ok: true, generation: 2, warnConsumers: true });

  assert.deepEqual(canRerunNode(snapshot, "repair.1"), {
    ok: false,
    reasonKey: "repairNode",
  });

  const published = baseSnapshot({ ...snapshot, state: "published" });
  assert.deepEqual(canRerunNode(published, "write.root"), {
    ok: false,
    reasonKey: "runPublished",
  });
});

test("plan rerun is hard-disabled after execution topology is materialized", () => {
  const bootstrap = baseSnapshot({
    state: "waiting_for_operator",
    nodes: [
      {
        key: "freeze",
        kind: "freeze",
        state: "succeeded",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "a1",
        outputs: [],
        label: "Freeze",
      },
      {
        key: "plan",
        kind: "plan",
        state: "succeeded",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "a2",
        outputs: [],
        label: "Plan",
      },
      {
        key: "gate.plan",
        kind: "gate",
        state: "waiting",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: null,
        outputs: [],
        label: "Plan gate",
      },
    ],
  });
  assert.equal(hasMaterializedExecutionTopology(bootstrap), false);
  assert.deepEqual(canRerunNode(bootstrap, "plan"), { ok: true, generation: 0 });

  const materialized = baseSnapshot({
    state: "running",
    nodes: [
      ...bootstrap.nodes,
      {
        key: "write.root",
        kind: "write",
        state: "ready",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: null,
        outputs: [],
        label: "Write",
      },
    ],
  });
  assert.equal(hasMaterializedExecutionTopology(materialized), true);
  assert.deepEqual(canRerunNode(materialized, "plan"), {
    ok: false,
    reasonKey: "planMaterialized",
  });
});

test("recovery banner helpers list failed nodes and retryable keys", () => {
  const snapshot = baseSnapshot({
    state: "failed",
    nodes: [
      {
        key: "research.leaf.a",
        kind: "research",
        state: "failed",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-1",
        outputs: [],
        label: "Leaf A",
      },
      {
        key: "research.leaf.b",
        kind: "research",
        state: "succeeded",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-2",
        outputs: [],
        label: "Leaf B",
      },
    ],
    attempts: [
      {
        attemptId: "att-1",
        nodeKey: "research.leaf.a",
        nodeGeneration: 0,
        runIndex: 1,
        state: "failed",
        inputDigest: DIGEST,
        error: "x",
        startedAt: "2026-08-02T00:00:00.000Z",
        endedAt: "2026-08-02T00:01:00.000Z",
      },
      {
        attemptId: "att-2",
        nodeKey: "research.leaf.b",
        nodeGeneration: 0,
        runIndex: 2,
        state: "succeeded",
        inputDigest: DIGEST,
        error: null,
        startedAt: "2026-08-02T00:00:00.000Z",
        endedAt: "2026-08-02T00:01:00.000Z",
      },
    ],
  });

  assert.equal(needsRecoveryBanner(snapshot), true);
  assert.deepEqual(
    listRecoveryTargetNodes(snapshot).map((node) => node.key),
    ["research.leaf.a"],
  );
  assert.deepEqual(listRetryableNodeKeys(snapshot), ["research.leaf.a"]);
});

test("truncateAttemptError respects default preview length", () => {
  assert.equal(truncateAttemptError("short"), "short");
  assert.equal(truncateAttemptError("  padded  "), "padded");
  const long = "e".repeat(ATTEMPT_ERROR_PREVIEW_CHARS + 20);
  const truncated = truncateAttemptError(long);
  assert.equal(truncated.length, ATTEMPT_ERROR_PREVIEW_CHARS);
  assert.equal(truncated.endsWith("…"), true);
  assert.equal(truncateAttemptError(long, 10).length, 10);
});

test("lastFailedAttemptForNode returns failed/interrupted last attempt only", () => {
  const snapshot = baseSnapshot({
    nodes: [
      {
        key: "research.leaf.a",
        kind: "research",
        state: "failed",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-1",
        outputs: [],
        label: "Leaf A",
      },
      {
        key: "research.leaf.b",
        kind: "research",
        state: "succeeded",
        generation: 0,
        currentAttemptId: null,
        lastAttemptId: "att-2",
        outputs: [],
        label: "Leaf B",
      },
    ],
    attempts: [
      {
        attemptId: "att-1",
        nodeKey: "research.leaf.a",
        nodeGeneration: 0,
        runIndex: 1,
        state: "failed",
        inputDigest: DIGEST,
        error: "provider timeout after L0",
        failureClass: "infrastructure",
        startedAt: "2026-08-02T00:00:00.000Z",
        endedAt: "2026-08-02T00:01:00.000Z",
      },
      {
        attemptId: "att-2",
        nodeKey: "research.leaf.b",
        nodeGeneration: 0,
        runIndex: 2,
        state: "succeeded",
        inputDigest: DIGEST,
        error: null,
        startedAt: "2026-08-02T00:00:00.000Z",
        endedAt: "2026-08-02T00:01:00.000Z",
      },
    ],
  });

  const failed = lastFailedAttemptForNode(snapshot, "research.leaf.a");
  assert.equal(failed?.attemptId, "att-1");
  assert.equal(failed?.error, "provider timeout after L0");
  assert.equal(failed?.failureClass, "infrastructure");
  assert.equal(lastFailedAttemptForNode(snapshot, "research.leaf.b"), null);
  assert.equal(lastFailedAttemptForNode(snapshot, "missing"), null);
});

test("shouldShowNoAutoRetryHint covers product failures and non-research nodes", () => {
  // Auto-retry kinds use real WikiRunNodeKind values.
  assert.equal(shouldShowNoAutoRetryHint("schema", "research.leaf"), true);
  assert.equal(shouldShowNoAutoRetryHint("quality", "research.domain"), true);
  assert.equal(shouldShowNoAutoRetryHint("provider", "research.leaf"), true);
  assert.equal(shouldShowNoAutoRetryHint("capacity", "research.leaf"), true);
  assert.equal(shouldShowNoAutoRetryHint("budget", "research.domain"), true);
  assert.equal(shouldShowNoAutoRetryHint("cancelled", "research.leaf"), true);
  assert.equal(shouldShowNoAutoRetryHint("infrastructure", "write.root"), true);
  assert.equal(shouldShowNoAutoRetryHint("infrastructure", "plan"), true);
  // Research/plan.scout + infrastructure/transient: may auto-retry — no "will not" hint.
  assert.equal(shouldShowNoAutoRetryHint("infrastructure", "research.leaf"), false);
  assert.equal(shouldShowNoAutoRetryHint("transient", "research.domain"), false);
  assert.equal(shouldShowNoAutoRetryHint("infrastructure", "plan.scout"), false);
  assert.equal(shouldShowNoAutoRetryHint(undefined, "research.leaf"), false);
  assert.equal(shouldShowNoAutoRetryHint(undefined, "plan"), true);
  // Bare "research" is not a real kind — treat as non-research for safety.
  assert.equal(shouldShowNoAutoRetryHint("infrastructure", "research"), true);
});
