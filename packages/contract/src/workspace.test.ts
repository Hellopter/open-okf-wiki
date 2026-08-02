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
    origin: { type: "path" },
  });
  assert.equal(source.applyDefaultIgnores, true);
  assert.deepEqual(source.ignore, []);
  assert.deepEqual(source.origin, { type: "path" });
});

test("WorkspaceSourceSchema rejects historical source records without origin", () => {
  assert.equal(
    WorkspaceSourceSchema.safeParse({ id: "application", path: "D:/src/my-app" }).success,
    false,
  );
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
    version: 3,
    id: "ws_1",
    name: "Demo",
    rootPath: "D:/ws/demo",
    sources: [{ id: "application", path: "D:/src/app", origin: { type: "path" } }],
    model: { id: "openai/corp-model" },
    publicationPath: "D:/ws/demo/wiki",
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
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
  assert.equal(ws.version, 3);
  assert.equal(ws.revision, 0);
  assert.equal(ws.wikiLanguage, "en");
  assert.deepEqual(ws.sources[0]?.origin, { type: "path" });
});

test("WorkspaceConfigSchema accepts wikiLanguage zh", () => {
  const ws = WorkspaceConfigSchema.parse({
    version: 3,
    id: "ws_1",
    name: "Demo",
    rootPath: "D:/ws/demo",
    sources: [],
    model: { id: "openai/corp-model" },
    publicationPath: "D:/ws/demo/wiki",
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
    wikiLanguage: "zh",
    createdAt: new Date().toISOString(),
  });
  assert.equal(ws.wikiLanguage, "zh");
});

test("WorkspaceConfigSchema rejects prior workspace formats", () => {
  const base = {
    id: "ws_1",
    name: "Demo",
    rootPath: "D:/ws/demo",
    sources: [],
    model: { id: "openai/corp-model" },
    publicationPath: "D:/ws/demo/wiki",
    createdAt: new Date().toISOString(),
  };

  assert.equal(WorkspaceConfigSchema.safeParse(base).success, false);
  assert.equal(WorkspaceConfigSchema.safeParse({ ...base, version: 1 }).success, false);
  assert.equal(
    WorkspaceConfigSchema.safeParse({
      ...base,
      version: 2,
      orchestration: { maxDepth: 2 },
    }).success,
    false,
  );
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
  assert.equal(partial.leafConcurrency, DEFAULT_ORCHESTRATION.leafConcurrency);
  assert.equal(partial.leafConcurrency, 2);
  assert.equal("reviewConcurrency" in partial, false);
});

test("leafConcurrency defaults to 2 and accepts overrides", () => {
  assert.equal(DEFAULT_ORCHESTRATION.leafConcurrency, 2);
  assert.equal(resolveOrchestration({}).leafConcurrency, 2);
  assert.equal(resolveOrchestration({ leafConcurrency: 4 }).leafConcurrency, 4);
  const ws = WorkspaceConfigSchema.parse({
    version: 3,
    id: "ws_1",
    name: "Demo",
    rootPath: "D:/ws/demo",
    sources: [],
    model: { id: "openai/corp-model" },
    publicationPath: "D:/ws/demo/wiki",
    createdAt: new Date().toISOString(),
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4, leafConcurrency: 8 },
  });
  assert.equal(ws.orchestration.leafConcurrency, 8);
});
