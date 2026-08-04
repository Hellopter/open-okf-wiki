/**
 * DiscoveryMap + assertSemanticSufficiency — fail-closed unit tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSemanticSufficiency,
  DiscoveryMapSchema,
  parseDiscoveryMap,
  parseDiscoveryMapStrict,
  SemanticSufficiencyError,
} from "./discovery.js";

test("DiscoveryMapSchema accepts full multi-source shape", () => {
  const map = DiscoveryMapSchema.parse({
    sources: [
      {
        sourceId: "api",
        role: "backend",
        entryPoints: ["cmd/server/main.go"],
        surfaces: ["."],
        purpose: "HTTP API",
        evidencePaths: ["sources/api/cmd/server/main.go"],
      },
      {
        sourceId: "web",
        role: "frontend",
        entryPoints: ["src/main.tsx"],
        purpose: "SPA",
        evidencePaths: ["sources/web/src/main.tsx"],
      },
    ],
    domains: [
      {
        id: "auth",
        title: "Auth",
        scope: "Login and tokens",
        coverageUnitIds: ["api", "web"],
        evidencePaths: ["sources/api/auth/"],
        readerQuestion: "How does login work end-to-end?",
      },
    ],
    flows: [
      {
        id: "login",
        title: "Login",
        steps: ["web form", "api token"],
        crossSource: true,
        coverageUnitIds: ["api", "web"],
        evidencePaths: ["sources/web/src/login.tsx"],
      },
    ],
    concepts: [
      {
        id: "jwt",
        term: "JWT",
        definitionHint: "Bearer token",
        evidencePaths: ["sources/api/auth/jwt.go"],
      },
    ],
    modules: [{ id: "auth-pkg", title: "auth", path: "pkg/auth" }],
    openQuestions: [],
    boundaryPaths: ["sources/api/go.mod", "sources/web/package.json"],
    scoutKinds: ["source", "domain", "flow"],
  });
  assert.equal(map.version, 1);
  assert.equal(map.sources.length, 2);
  assert.equal(map.flows[0]?.crossSource, true);
  assert.equal(map.modules?.length, 1);
});

test("parseDiscoveryMap soft-fails on garbage; strict throws", () => {
  assert.equal(parseDiscoveryMap(null), undefined);
  assert.equal(parseDiscoveryMap({ foo: 1 }), undefined);
  assert.ok(parseDiscoveryMap({ version: 1, sources: [] }));
  assert.throws(() => parseDiscoveryMapStrict({ version: 2 }), /invalid|Invalid|Literal/i);
});

test("assertSemanticSufficiency soft-passes light / single-source", () => {
  const soft = assertSemanticSufficiency(undefined, {}, { sourceCount: 1 });
  assert.equal(soft.ok, true);
  assert.equal(soft.stop_reason, "not_required");

  const lightMulti = assertSemanticSufficiency(
    undefined,
    {},
    { sourceCount: 2, lightPath: true },
  );
  assert.equal(lightMulti.ok, true);
  assert.equal(lightMulti.stop_reason, "not_required");
});

test("assertSemanticSufficiency fails multi-source without DiscoveryMap", () => {
  assert.throws(
    () => assertSemanticSufficiency(undefined, {}, { sourceCount: 2, sourceIds: ["a", "b"] }),
    SemanticSufficiencyError,
  );
  const soft = assertSemanticSufficiency(
    undefined,
    {},
    { sourceCount: 2, sourceIds: ["a", "b"] },
    { throwOnGap: false },
  );
  assert.equal(soft.ok, false);
  assert.ok(soft.gaps.includes("_discovery"));
});

test("assertSemanticSufficiency requires evidence per source or cancel", () => {
  const discovery = DiscoveryMapSchema.parse({
    sources: [
      {
        sourceId: "api",
        purpose: "API",
        evidencePaths: ["sources/api/main.go"],
      },
      {
        sourceId: "web",
        purpose: "UI",
        evidencePaths: [],
      },
    ],
    flows: [{ id: "f1", title: "Join", crossSource: true }],
  });

  const soft = assertSemanticSufficiency(
    discovery,
    {},
    { sourceCount: 2, sourceIds: ["api", "web"] },
    { throwOnGap: false },
  );
  assert.equal(soft.ok, false);
  assert.ok(soft.gaps.includes("web"));

  const cancelled = assertSemanticSufficiency(
    discovery,
    {
      sourceCoverage: [{ sourceId: "web", cancelled: true, notes: "docs-only mount" }],
    },
    { sourceCount: 2, sourceIds: ["api", "web"] },
  );
  assert.equal(cancelled.ok, true);
});

test("assertSemanticSufficiency accepts repositoryMap entryPoints as evidence", () => {
  const discovery = DiscoveryMapSchema.parse({
    sources: [
      { sourceId: "api", purpose: "API", evidencePaths: ["sources/api/x"] },
      { sourceId: "web", purpose: "UI", evidencePaths: [] },
    ],
    flows: [{ id: "f1", title: "Join", crossSource: true }],
  });
  const result = assertSemanticSufficiency(
    discovery,
    {
      repositoryMap: {
        sources: [{ sourceId: "web", entryPoints: ["src/main.tsx"] }],
      },
    },
    { sourceCount: 2, sourceIds: ["api", "web"] },
  );
  assert.equal(result.ok, true);
});

test("assertSemanticSufficiency requires cross-source flow or openQuestion", () => {
  const discovery = DiscoveryMapSchema.parse({
    sources: [
      { sourceId: "api", purpose: "API", evidencePaths: ["a"] },
      { sourceId: "web", purpose: "UI", evidencePaths: ["b"] },
    ],
    flows: [{ id: "f1", title: "Local", crossSource: false }],
    openQuestions: [],
  });
  const soft = assertSemanticSufficiency(
    discovery,
    {},
    { sourceCount: 2, sourceIds: ["api", "web"] },
    { throwOnGap: false },
  );
  assert.equal(soft.ok, false);
  assert.ok(soft.gaps.includes("_cross_source"));

  const withQ = assertSemanticSufficiency(
    discovery,
    { openQuestions: ["How do api and web share session cookies?"] },
    { sourceCount: 2, sourceIds: ["api", "web"] },
  );
  assert.equal(withQ.ok, true);
});
