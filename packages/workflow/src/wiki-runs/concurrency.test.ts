import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ORCHESTRATION,
  resolveOrchestration,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
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

test("canClaimKind respects running counts", () => {
  const ws = workspace({ domainConcurrency: 2 });
  assert.equal(canClaimKind(ws, "research.leaf", { "research.leaf": 3 }), true);
  assert.equal(canClaimKind(ws, "research.leaf", { "research.leaf": 4 }), false);
  assert.equal(canClaimKind(ws, "research.domain", new Map([["research.domain", 1]])), true);
  assert.equal(canClaimKind(ws, "research.domain", new Map([["research.domain", 2]])), false);
});
