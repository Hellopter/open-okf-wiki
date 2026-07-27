import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_ORCHESTRATION as CONTRACT_DEFAULT,
  WorkspaceOrchestrationSchema,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { DEFAULT_ORCHESTRATION, requestTimeoutMs, resolveOrchestration } from "./budgets.js";

describe("DEFAULT_ORCHESTRATION", () => {
  it("matches contract schema defaults (sole authority)", () => {
    assert.deepEqual(DEFAULT_ORCHESTRATION, CONTRACT_DEFAULT);
    assert.deepEqual(DEFAULT_ORCHESTRATION, WorkspaceOrchestrationSchema.parse({}));
    assert.equal(DEFAULT_ORCHESTRATION.maxDepth, 2);
    assert.equal(DEFAULT_ORCHESTRATION.maxDomainFanOut, 4);
    assert.equal(DEFAULT_ORCHESTRATION.maxLeafFanOut, 6);
    assert.equal(DEFAULT_ORCHESTRATION.reviewCouncilSize, 3);
    assert.equal(DEFAULT_ORCHESTRATION.planScoutCount, 2);
    assert.equal(DEFAULT_ORCHESTRATION.domainConcurrency, 2);
  });
});

describe("resolveOrchestration", () => {
  it("returns defaults when workspace has no orchestration", () => {
    assert.deepEqual(resolveOrchestration(undefined), DEFAULT_ORCHESTRATION);
    assert.deepEqual(resolveOrchestration(null), DEFAULT_ORCHESTRATION);
    assert.deepEqual(
      resolveOrchestration({ orchestration: undefined } as unknown as WorkspaceConfig),
      DEFAULT_ORCHESTRATION,
    );
  });

  it("fills missing fields from defaults", () => {
    const resolved = resolveOrchestration({
      orchestration: { maxDomainFanOut: 8 },
    } as WorkspaceConfig);
    assert.equal(resolved.maxDomainFanOut, 8);
    assert.equal(resolved.maxDepth, DEFAULT_ORCHESTRATION.maxDepth);
    assert.equal(resolved.reviewCouncilSize, DEFAULT_ORCHESTRATION.reviewCouncilSize);
  });

  it("preserves optional concurrency when set", () => {
    const resolved = resolveOrchestration({
      orchestration: {
        ...DEFAULT_ORCHESTRATION,
        reviewConcurrency: 2,
        planScoutConcurrency: 1,
      },
    } as WorkspaceConfig);
    assert.equal(resolved.reviewConcurrency, 2);
    assert.equal(resolved.planScoutConcurrency, 1);
  });
});

describe("requestTimeoutMs", () => {
  it("converts positive seconds to ms", () => {
    assert.equal(
      requestTimeoutMs({ limits: { requestTimeoutSeconds: 30 } } as WorkspaceConfig),
      30_000,
    );
  });

  it("returns undefined when unset or non-positive", () => {
    assert.equal(requestTimeoutMs(undefined), undefined);
    assert.equal(
      requestTimeoutMs({ limits: { requestTimeoutSeconds: 0 } } as WorkspaceConfig),
      undefined,
    );
  });
});
