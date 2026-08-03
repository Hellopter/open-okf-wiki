/**
 * Unit matrix for shouldAutoRetryResearch (L_control research auto-requeue policy).
 * Uses partialControl fixture — no full SchedulerHost mock zoo.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { WorkspaceConfig } from "@okf-wiki/contract/workspace";
import { shouldAutoRetryResearch } from "../attempt-finish/index.js";
import { fixtureWorkspace, partialControl } from "../testing/control-fixture.js";
import { type ClaimedNode, RESEARCH_AUTO_RETRY_MAX_ATTEMPTS } from "../types.js";

function openPolicyDb(opts: {
  cancelRequested?: boolean;
  failedAttemptCount?: number;
}): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      cancel_requested INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE attempts (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_key TEXT NOT NULL,
      node_generation INTEGER NOT NULL,
      state TEXT NOT NULL
    ) STRICT;
  `);
  db.prepare("INSERT INTO runs (run_id, cancel_requested) VALUES (?, ?)").run(
    "run-1",
    opts.cancelRequested ? 1 : 0,
  );
  const failed = opts.failedAttemptCount ?? 1;
  for (let i = 0; i < failed; i += 1) {
    db.prepare(
      `INSERT INTO attempts (attempt_id, run_id, node_key, node_generation, state)
       VALUES (?, 'run-1', 'research.leaf.core.1', 0, 'failed')`,
    ).run(`attempt-${i}`);
  }
  return db;
}

function ctrl(opts: {
  closed?: boolean;
  retryEnabled?: boolean;
  cancelRequested?: boolean;
  failedAttemptCount?: number;
}) {
  const workspace = fixtureWorkspace({
    limits: { retry: { enabled: opts.retryEnabled ?? true } },
  } as Partial<WorkspaceConfig>);
  return partialControl({
    workspace,
    db: openPolicyDb({
      cancelRequested: opts.cancelRequested,
      failedAttemptCount: opts.failedAttemptCount,
    }),
    closed: opts.closed ?? false,
  });
}

const researchClaim: ClaimedNode = {
  attemptId: "attempt-current",
  nodeGeneration: 0,
  nodeKey: "research.leaf.core.1",
  kind: "research.leaf",
  runId: "run-1",
};

const domainClaim: ClaimedNode = {
  ...researchClaim,
  nodeKey: "research.domain.core",
  kind: "research.domain",
};

const writeClaim: ClaimedNode = {
  ...researchClaim,
  nodeKey: "write.root",
  kind: "write.root",
};

describe("shouldAutoRetryResearch", () => {
  it("allows research.leaf/domain once for infrastructure|transient", () => {
    assert.equal(
      shouldAutoRetryResearch(
        ctrl({ failedAttemptCount: 1 }),
        researchClaim,
        "flake",
        "infrastructure",
      ),
      true,
    );
    assert.equal(
      shouldAutoRetryResearch(ctrl({ failedAttemptCount: 1 }), domainClaim, "flake", "transient"),
      true,
    );
  });

  it("denies non-research kinds even with infrastructure", () => {
    assert.equal(shouldAutoRetryResearch(ctrl({}), writeClaim, "flake", "infrastructure"), false);
  });

  it("denies capacity|budget|policy|provider|cancelled", () => {
    for (const cls of [
      "capacity",
      "budget",
      "policy",
      "provider",
      "cancelled",
      "cancel",
    ] as const) {
      assert.equal(
        shouldAutoRetryResearch(ctrl({}), researchClaim, `msg ${cls}`, cls),
        false,
        `must deny ${cls}`,
      );
    }
  });

  it("denies unknown typed classes", () => {
    assert.equal(shouldAutoRetryResearch(ctrl({}), researchClaim, "schema boom", "schema"), false);
  });

  it("fail-closed when failureClass missing and message is a bare product error", () => {
    assert.equal(
      shouldAutoRetryResearch(
        ctrl({}),
        researchClaim,
        "research.leaf.core.1 requires sealed sources and skill inputs",
      ),
      false,
      "must not requeue bare 'requires sealed sources'",
    );
    assert.equal(shouldAutoRetryResearch(ctrl({}), researchClaim, "boom domain"), false);
  });

  it("allows missing failureClass only for clear transport/infra messages", () => {
    assert.equal(
      shouldAutoRetryResearch(
        ctrl({ failedAttemptCount: 1 }),
        researchClaim,
        "429 Too Many Requests",
      ),
      true,
    );
    assert.equal(
      shouldAutoRetryResearch(ctrl({ failedAttemptCount: 1 }), researchClaim, "connect ECONNRESET"),
      true,
    );
    assert.equal(
      shouldAutoRetryResearch(ctrl({ failedAttemptCount: 1 }), researchClaim, "fetch failed"),
      true,
    );
    assert.equal(
      shouldAutoRetryResearch(
        ctrl({ failedAttemptCount: 1 }),
        researchClaim,
        "provider overloaded",
      ),
      true,
    );
  });

  it("respects retry.enabled=false, closed control, and cancel_requested", () => {
    assert.equal(
      shouldAutoRetryResearch(
        ctrl({ retryEnabled: false }),
        researchClaim,
        "flake",
        "infrastructure",
      ),
      false,
    );
    assert.equal(
      shouldAutoRetryResearch(ctrl({ closed: true }), researchClaim, "flake", "infrastructure"),
      false,
    );
    assert.equal(
      shouldAutoRetryResearch(
        ctrl({ cancelRequested: true }),
        researchClaim,
        "flake",
        "infrastructure",
      ),
      false,
    );
  });

  it("exhausts after RESEARCH_AUTO_RETRY_MAX_ATTEMPTS failed Attempts", () => {
    assert.equal(RESEARCH_AUTO_RETRY_MAX_ATTEMPTS, 2);
    assert.equal(
      shouldAutoRetryResearch(
        ctrl({ failedAttemptCount: 1 }),
        researchClaim,
        "flake",
        "infrastructure",
      ),
      true,
      "first failure may requeue",
    );
    assert.equal(
      shouldAutoRetryResearch(
        ctrl({ failedAttemptCount: 2 }),
        researchClaim,
        "flake",
        "infrastructure",
      ),
      false,
      "second failure stays manual",
    );
  });
});
