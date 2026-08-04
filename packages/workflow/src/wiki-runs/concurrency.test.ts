import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ORCHESTRATION,
  resolveOrchestration,
  resolvePlanScoutConcurrency,
  type WorkspaceConfig,
} from "@okf-wiki/contract/workspace";
import {
  canClaimKind,
  concurrencyLimitForKind,
  resolveSchedulerOrchestration,
} from "./concurrency.js";

function workspace(orchestration?: Partial<WorkspaceConfig["orchestration"]>): WorkspaceConfig {
  return {
    version: 3,
    id: "ws",
    name: "Test",
    rootPath: "/tmp/ws",
    sources: [],
    model: { profileId: "p", id: "m" },
    publicationPath: "/tmp/pub",
    limits: {
      requestTimeoutSeconds: 600,
      retry: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 2000,
        provider: { maxRetries: 0, maxRetryDelayMs: 60_000 },
      },
    },
    roleModels: {},
    orchestration: { ...DEFAULT_ORCHESTRATION, ...orchestration },
    planConfirm: true,
    operatorTools: ["read", "grep", "find", "ls"],
    wikiLanguage: "en",
    createdAt: "2026-07-29T00:00:00.000Z",
  } as unknown as WorkspaceConfig;
}

test("resolveSchedulerOrchestration fills defaults via contract resolveOrchestration", () => {
  const resolved = resolveSchedulerOrchestration(workspace({ domainConcurrency: 4 }));
  assert.equal(resolved.domainConcurrency, 4);
  assert.equal(resolved.maxLeafFanOut, DEFAULT_ORCHESTRATION.maxLeafFanOut);
  assert.equal(resolved.reviewCouncilSize, DEFAULT_ORCHESTRATION.reviewCouncilSize);
  assert.deepEqual(
    resolved,
    resolveOrchestration({ ...DEFAULT_ORCHESTRATION, domainConcurrency: 4 }),
  );
});

test("leaf concurrency is domainConcurrency × min(leafConcurrency, maxLeafFanOut)", () => {
  // defaults: domainConcurrency 2, leafConcurrency 2 → leaf limit 4
  assert.equal(
    concurrencyLimitForKind(
      workspace({ domainConcurrency: 2, leafConcurrency: 2 }),
      "research.leaf",
    ),
    4,
  );
  // leafConcurrency 1 → leaf limit 2
  assert.equal(
    concurrencyLimitForKind(
      workspace({ domainConcurrency: 2, leafConcurrency: 1 }),
      "research.leaf",
    ),
    2,
  );
  // default leafConcurrency (2) with domainConcurrency 3 → 6
  assert.equal(concurrencyLimitForKind(workspace({ domainConcurrency: 3 }), "research.leaf"), 6);
  // maxLeafFanOut caps the per-domain width
  assert.equal(
    concurrencyLimitForKind(workspace({ domainConcurrency: 2, maxLeafFanOut: 1 }), "research.leaf"),
    2,
  );
  assert.equal(concurrencyLimitForKind(workspace({ domainConcurrency: 1 }), "research.domain"), 1);
});

test("review concurrency defaults to council size and respects cap", () => {
  assert.equal(concurrencyLimitForKind(workspace({ reviewCouncilSize: 3 }), "review.seat"), 3);
  assert.equal(
    concurrencyLimitForKind(
      workspace({ reviewCouncilSize: 3, reviewConcurrency: 1 }),
      "review.seat",
    ),
    1,
  );
});

test("mechanical kinds are unbounded; single-pipeline Pi is 1", () => {
  assert.equal(concurrencyLimitForKind(workspace(), "validate.pre"), Number.POSITIVE_INFINITY);
  assert.equal(concurrencyLimitForKind(workspace(), "publish"), Number.POSITIVE_INFINITY);
  assert.equal(concurrencyLimitForKind(workspace(), "plan"), 1);
  assert.equal(concurrencyLimitForKind(workspace(), "write.root"), 1);
});

test("plan.scout concurrency: planScoutCount=0 still gets floor ≥ 2 (not serial)", () => {
  // Bug: planScoutCount || 1 forced multi-source hybrid surveys to run serially.
  assert.equal(concurrencyLimitForKind(workspace({ planScoutCount: 0 }), "plan.scout"), 2);
  assert.equal(resolvePlanScoutConcurrency({ planScoutCount: 0 }), 2);
  // Thematic count > 0 uses max(count, 2).
  assert.equal(concurrencyLimitForKind(workspace({ planScoutCount: 3 }), "plan.scout"), 3);
  assert.equal(concurrencyLimitForKind(workspace({ planScoutCount: 1 }), "plan.scout"), 2);
});

test("plan.scout concurrency prefers explicit planScoutConcurrency and respects cap", () => {
  assert.equal(
    concurrencyLimitForKind(
      workspace({ planScoutCount: 0, planScoutConcurrency: 1 }),
      "plan.scout",
    ),
    1,
  );
  assert.equal(
    concurrencyLimitForKind(
      workspace({ planScoutCount: 0, planScoutConcurrency: 4 }),
      "plan.scout",
    ),
    4,
  );
  assert.equal(
    concurrencyLimitForKind(
      workspace({
        planScoutCount: 0,
        planScoutConcurrency: 8,
        maxPlanScoutConcurrency: 6,
      }),
      "plan.scout",
    ),
    6,
  );
  // Default cap is 4 even when thematic count would want more via floor.
  assert.equal(
    concurrencyLimitForKind(
      workspace({ planScoutCount: 4, maxPlanScoutConcurrency: 4 }),
      "plan.scout",
    ),
    4,
  );
  assert.equal(
    concurrencyLimitForKind(
      workspace({ planScoutCount: 4, maxPlanScoutConcurrency: 3 }),
      "plan.scout",
    ),
    3,
  );
});

test("canClaimKind respects running counts", () => {
  const ws = workspace({ domainConcurrency: 2 });
  assert.equal(canClaimKind(ws, "research.leaf", { "research.leaf": 3 }), true);
  assert.equal(canClaimKind(ws, "research.leaf", { "research.leaf": 4 }), false);
  assert.equal(canClaimKind(ws, "research.domain", new Map([["research.domain", 1]])), true);
  assert.equal(canClaimKind(ws, "research.domain", new Map([["research.domain", 2]])), false);
});

test("canClaimKind allows second plan.scout when planScoutCount=0 (floor 2)", () => {
  const ws = workspace({ planScoutCount: 0 });
  assert.equal(canClaimKind(ws, "plan.scout", { "plan.scout": 0 }), true);
  assert.equal(canClaimKind(ws, "plan.scout", { "plan.scout": 1 }), true);
  assert.equal(canClaimKind(ws, "plan.scout", { "plan.scout": 2 }), false);
});
