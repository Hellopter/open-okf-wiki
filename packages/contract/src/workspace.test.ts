import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ORCHESTRATION,
  resolveOrchestration,
  WorkspaceConfigSchema,
  WorkspaceSourceSchema,
} from "./workspace.js";

test("WorkspaceSourceSchema accepts a clean local source", () => {
  const source = WorkspaceSourceSchema.parse({
    id: "application",
    path: "D:/src/my-app",
  });
  assert.equal(source.applyDefaultIgnores, true);
  assert.deepEqual(source.ignore, []);
  // Legacy records without origin normalize to path-linked on parse.
  assert.deepEqual(source.origin, { type: "path" });
});

test("WorkspaceSourceSchema accepts clone origin", () => {
  const source = WorkspaceSourceSchema.parse({
    id: "openwiki",
    path: "D:/ws/demo/sources/openwiki",
    origin: {
      type: "clone",
      remoteUrl: "https://example.com/openwiki.git",
      clonedAt: new Date().toISOString(),
    },
  });
  assert.equal(source.origin.type, "clone");
});

test("WorkspaceConfigSchema rejects secrets-shaped extra keys only via strict parse of known fields", () => {
  const ws = WorkspaceConfigSchema.parse({
    id: "ws_1",
    name: "Demo",
    rootPath: "D:/ws/demo",
    sources: [{ id: "application", path: "D:/src/app" }],
    model: { id: "openai/corp-model" },
    publicationPath: "D:/ws/demo/wiki",
    createdAt: new Date().toISOString(),
  });
  assert.equal(ws.planConfirm, true);
  assert.equal(ws.orchestration.maxDomainFanOut, 4);
  // Phase 7 light path defaults.
  assert.equal(ws.orchestration.reviewCouncilSize, 1);
  assert.equal(ws.orchestration.planScoutCount, 0);
  assert.equal(ws.orchestration.domainConcurrency, 2);
  assert.equal(ws.orchestration.leafConcurrency, 2);
  assert.deepEqual(ws.operatorTools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(ws.roleModels.reviewers, []);
  assert.equal(ws.version, 1);
  assert.equal(ws.wikiLanguage, "en");
  assert.deepEqual(ws.sources[0]?.origin, { type: "path" });
});

test("WorkspaceConfigSchema accepts wikiLanguage zh", () => {
  const ws = WorkspaceConfigSchema.parse({
    id: "ws_1",
    name: "Demo",
    rootPath: "D:/ws/demo",
    sources: [],
    model: { id: "openai/corp-model" },
    publicationPath: "D:/ws/demo/wiki",
    wikiLanguage: "zh",
    createdAt: new Date().toISOString(),
  });
  assert.equal(ws.wikiLanguage, "zh");
});

test("WorkspaceConfigSchema strips legacy orchestration MaxSteps keys", () => {
  const ws = WorkspaceConfigSchema.parse({
    id: "ws_1",
    name: "Demo",
    rootPath: "D:/ws/demo",
    sources: [],
    model: { id: "openai/corp-model" },
    publicationPath: "D:/ws/demo/wiki",
    createdAt: new Date().toISOString(),
    orchestration: {
      maxDepth: 2,
      maxDomainFanOut: 3,
      maxLeafFanOut: 5,
      rootMaxSteps: 96,
      domainMaxSteps: 12,
      leafMaxSteps: 8,
      reviewerMaxSteps: 8,
      planMaxSteps: 24,
      reviewCouncilSize: 2,
    },
  });
  assert.equal(ws.orchestration.maxDomainFanOut, 3);
  assert.equal(ws.orchestration.reviewCouncilSize, 2);
  assert.equal("rootMaxSteps" in ws.orchestration, false);
  assert.equal("planMaxSteps" in ws.orchestration, false);
});

test("resolveOrchestration fills schema defaults and preserves partials", () => {
  assert.deepEqual(resolveOrchestration(null), DEFAULT_ORCHESTRATION);
  assert.deepEqual(resolveOrchestration(undefined), DEFAULT_ORCHESTRATION);
  // Phase 7 light path: 0 scouts, 1 review lens.
  assert.equal(DEFAULT_ORCHESTRATION.planScoutCount, 0);
  assert.equal(DEFAULT_ORCHESTRATION.reviewCouncilSize, 1);
  const partial = resolveOrchestration({ domainConcurrency: 4, reviewCouncilSize: 1 });
  assert.equal(partial.domainConcurrency, 4);
  assert.equal(partial.reviewCouncilSize, 1);
  assert.equal(partial.maxDomainFanOut, DEFAULT_ORCHESTRATION.maxDomainFanOut);
  assert.equal(partial.maxLeafFanOut, DEFAULT_ORCHESTRATION.maxLeafFanOut);
  assert.equal(partial.planScoutCount, DEFAULT_ORCHESTRATION.planScoutCount);
  assert.equal(partial.maxDepth, DEFAULT_ORCHESTRATION.maxDepth);
  assert.equal(partial.leafConcurrency, DEFAULT_ORCHESTRATION.leafConcurrency);
  assert.equal(partial.leafConcurrency, 2);
  assert.equal("reviewConcurrency" in partial, false);
});

test("leafConcurrency defaults to 2 and accepts overrides", () => {
  assert.equal(DEFAULT_ORCHESTRATION.leafConcurrency, 2);
  assert.equal(resolveOrchestration({}).leafConcurrency, 2);
  assert.equal(resolveOrchestration({ leafConcurrency: 4 }).leafConcurrency, 4);
  const ws = WorkspaceConfigSchema.parse({
    id: "ws_1",
    name: "Demo",
    rootPath: "D:/ws/demo",
    sources: [],
    model: { id: "openai/corp-model" },
    publicationPath: "D:/ws/demo/wiki",
    createdAt: new Date().toISOString(),
    orchestration: { leafConcurrency: 8 },
  });
  assert.equal(ws.orchestration.leafConcurrency, 8);
});
