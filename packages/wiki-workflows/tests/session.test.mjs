import assert from "node:assert/strict";
import test from "node:test";
import { createWikiRunSession, isWikiRunSession, parseWikiRunSession, WIKI_RUN_POINTER_VERSION } from "../dist/session.js";
import { resolveWikiPolicy, wikiPolicyHash } from "../dist/policy.js";

function snapshot(version = 1, overrides = {}) {
  const policy = resolveWikiPolicy();
  return {
    version,
    id: "run-1",
    cwd: "/workspace",
    requestedMode: "generate",
    language: "zh",
    status: "succeeded",
    round: 0,
    sourceRestartCount: 0,
    maxResearchRounds: 6,
    policy,
    policyHash: wikiPolicyHash(policy),
    nodes: [],
    events: [],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    revision: 3,
    ...overrides,
  };
}

function pointer(overrides = {}) {
  return {
    customType: "okf-wiki-run",
    workspace: "/workspace",
    pointerVersion: WIKI_RUN_POINTER_VERSION,
    runId: "run-1",
    revision: 3,
    status: "succeeded",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function failedResearchNode(error) {
  return {
    id: "research-1",
    kind: "research",
    label: "Research",
    status: "failed",
    dependsOn: [],
    attempt: 1,
    inputFingerprint: "input",
    input: {},
    attemptHistory: [],
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      cost: 0,
      compactions: 0,
      autoRetries: 0,
    },
    activity: { state: "idle", updatedAt: "2026-08-08T00:00:00.000Z" },
    error,
  };
}

test("createWikiRunSession builds a pointer-only session from a snapshot", () => {
  const session = createWikiRunSession(snapshot());
  assert.deepEqual(session, pointer());
  assert.equal("snapshot" in session, false);
  assert.equal(isWikiRunSession(session), true);
  assert.deepEqual(parseWikiRunSession(session), session);
});

test("createWikiRunSession defaults revision to 0 when snapshot has none", () => {
  const body = snapshot();
  delete body.revision;
  const session = createWikiRunSession(body);
  assert.equal(session.revision, 0);
});

test("parseWikiRunSession accepts only pointer-only sessions", () => {
  assert.deepEqual(parseWikiRunSession(pointer()), pointer());
  assert.equal(isWikiRunSession(pointer({ status: "running" })), true);
  assert.equal(isWikiRunSession(pointer({ status: "paused" })), true);
  assert.equal(isWikiRunSession(pointer({ status: "blocked" })), true);
  assert.equal(isWikiRunSession(pointer({ status: "failed" })), true);
  assert.equal(isWikiRunSession(pointer({ status: "cancelled" })), true);
});

test("parseWikiRunSession rejects legacy full-snapshot session entries (fail closed)", () => {
  const legacy = {
    customType: "okf-wiki-run",
    workspace: "/workspace",
    snapshot: snapshot(),
  };
  assert.equal(parseWikiRunSession(legacy), undefined);
  assert.equal(isWikiRunSession(legacy), false);

  // Pointer fields plus a snapshot body still fail closed.
  const hybrid = { ...pointer(), snapshot: snapshot() };
  assert.equal(parseWikiRunSession(hybrid), undefined);
});

test("parseWikiRunSession rejects malformed pointers", () => {
  for (const bad of [
    null,
    undefined,
    {},
    { customType: "other", workspace: "/workspace", pointerVersion: 1, runId: "r", revision: 0, status: "running", updatedAt: "t" },
    { ...pointer(), pointerVersion: 2 },
    { ...pointer(), pointerVersion: "1" },
    { ...pointer(), runId: "" },
    { ...pointer(), runId: 12 },
    { ...pointer(), revision: -1 },
    { ...pointer(), revision: 1.5 },
    { ...pointer(), status: "done" },
    { ...pointer(), updatedAt: "" },
    { ...pointer(), workspace: "" },
  ]) {
    assert.equal(parseWikiRunSession(bad), undefined, `expected reject for ${JSON.stringify(bad)}`);
  }
});

test("snapshot validation remains independent of session pointer parsing", async () => {
  const { explainWikiRunSnapshot, isWikiRunSnapshot, parseWikiRunSnapshot } = await import("../dist/snapshot-validation.js");
  assert.equal(isWikiRunSnapshot(snapshot()), true);
  assert.equal(
    isWikiRunSnapshot({ ...snapshot(), inspection: undefined }),
    true,
    "durable projection may retain the stripped runtime field as an undefined own property",
  );
  assert.equal(
    isWikiRunSnapshot({ ...snapshot(), inspection: { sourcePaths: ["private-runtime-payload"] } }),
    false,
    "the durable contract still rejects a populated runtime inspection",
  );

  const legacyV6 = snapshot(6);
  assert.equal(isWikiRunSnapshot(legacyV6), false);
  const versionReasons = explainWikiRunSnapshot(legacyV6);
  assert.ok(versionReasons.some((reason) => /version: expected 1, got 6/.test(reason)));
  assert.throws(
    () => parseWikiRunSnapshot(legacyV6),
    (error) => error?.code === "snapshot_incompatible" && /version: expected 1, got 6/.test(error.message),
  );

  const withBlockedDetails = {
    ...snapshot(),
    status: "blocked",
    blockedReason: "Validation produced the same unresolved error set twice",
    blockedDetails: {
      code: "same_validation_twice",
      issues: [{ code: "link", page: "core/architecture.md", message: "broken" }],
      defects: [{ kind: "depth", page: "core/architecture.md", detail: "shallow" }],
      page: "core/architecture.md",
      remainingBudget: { localRepairRounds: 0, maxLocalRepairRounds: 3 },
    },
  };
  assert.equal(isWikiRunSnapshot(withBlockedDetails), true);

  const badBlockedDetails = {
    ...snapshot(),
    blockedDetails: { issues: "not-an-array" },
  };
  assert.equal(isWikiRunSnapshot(badBlockedDetails), false);

  const currentSubmissionError = snapshot(undefined, {
    status: "failed",
    nodes: [failedResearchNode({
      message: "Missing submission",
      code: "missing_submission",
      retryable: false,
      requiredSubmissionTools: ["wiki_submit_synthesis_expand", "wiki_submit_synthesis_finalize"],
    })],
  });
  assert.equal(isWikiRunSnapshot(currentSubmissionError), true);

  const legacySubmissionError = structuredClone(currentSubmissionError);
  legacySubmissionError.nodes[0].error = {
    message: "Missing submission",
    code: "missing_submission",
    requiredSubmissionTool: "wiki_submit_synthesis",
  };
  assert.equal(isWikiRunSnapshot(legacySubmissionError), false);

  const unknownErrorField = structuredClone(currentSubmissionError);
  unknownErrorField.nodes[0].error.internal = "must not persist";
  assert.equal(isWikiRunSnapshot(unknownErrorField), false);

  const unknownRootField = { ...snapshot(), runtimeCache: { hydrated: true } };
  assert.equal(isWikiRunSnapshot(unknownRootField), false, "durable v1 rejects runtime-only root fields");

  const archivedRawResult = snapshot(undefined, {
    status: "failed",
    nodes: [failedResearchNode({ message: "failed" })],
  });
  archivedRawResult.nodes[0].attemptHistory.push({
    attempt: 1,
    result: { fullModelPayload: true },
    metrics: archivedRawResult.nodes[0].metrics,
  });
  assert.equal(isWikiRunSnapshot(archivedRawResult), false, "durable v1 rejects old full attempt payloads");

  const tamperedPolicy = snapshot(undefined, {
    policy: { ...snapshot().policy, terminology: { Ledger: "changed without rehashing" } },
  });
  assert.equal(isWikiRunSnapshot(tamperedPolicy), false);
  assert.ok(explainWikiRunSnapshot(tamperedPolicy).some((reason) => /policyHash/.test(reason)));

  for (const mutate of [
    (policy) => { policy.quality.maxSubmissionAttempts = 4; },
    (policy) => { policy.runtime.nodeTimeoutSeconds = 59; },
    (policy) => { policy.runtime.maxAutoRetries = 17; },
    (policy) => { policy.runtime.maxTransientSessionAttempts = 3; },
    (policy) => { policy.runtime.rateLimitCooldownSeconds = 14; },
    (policy) => { policy.terminology.Ledger = ""; },
    (policy) => { policy.domains = [
      { id: "core", title: "Core", include: ["src/**"], exclude: [] },
      { id: "core", title: "Duplicate", include: ["lib/**"], exclude: [] },
    ]; },
  ]) {
    const invalid = snapshot();
    mutate(invalid.policy);
    invalid.policyHash = wikiPolicyHash(invalid.policy);
    assert.equal(isWikiRunSnapshot(invalid), false, "policy schema must be validated independently of its hash");
    assert.ok(explainWikiRunSnapshot(invalid).some((reason) => /invalid pinned Wiki policy/.test(reason)));
  }
});
