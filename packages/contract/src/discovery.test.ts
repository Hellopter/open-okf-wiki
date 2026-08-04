/**
 * DiscoveryMap + assertSemanticSufficiency — fail-closed unit tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSemanticSufficiency,
  countNonDocEvidencePaths,
  DiscoveryMapSchema,
  isDocLikeEvidencePath,
  MIN_SOURCE_NON_DOC_EVIDENCE,
  parseDiscoveryMap,
  parseDiscoveryMapStrict,
  SemanticSufficiencyError,
  type DiscoveryMap,
} from "./discovery.js";

/** Multi-source map that satisfies the tightened multi-source gate. */
function richMultiSourceMap(overrides: Record<string, unknown> = {}): DiscoveryMap {
  return DiscoveryMapSchema.parse({
    sources: [
      {
        sourceId: "api",
        role: "backend",
        entryPoints: ["cmd/server/main.go"],
        surfaces: ["."],
        purpose: "HTTP API",
        evidencePaths: [
          "sources/api/cmd/server/main.go",
          "sources/api/pkg/auth/handler.go",
          "sources/api/go.mod",
        ],
      },
      {
        sourceId: "web",
        role: "frontend",
        entryPoints: ["src/main.tsx"],
        purpose: "SPA",
        evidencePaths: [
          "sources/web/src/main.tsx",
          "sources/web/src/login.tsx",
          "sources/web/package.json",
        ],
      },
    ],
    domains: [
      {
        id: "auth-api",
        title: "API Auth",
        scope: "Token issuance",
        coverageUnitIds: ["api"],
        evidencePaths: [
          "sources/api/pkg/auth/handler.go",
          "sources/api/pkg/auth/jwt.go",
        ],
        readerQuestion: "How does the API mint tokens?",
      },
      {
        id: "auth-web",
        title: "Web Login",
        scope: "Login form and session cookie",
        coverageUnitIds: ["web"],
        evidencePaths: ["sources/web/src/login.tsx", "sources/web/src/session.ts"],
        readerQuestion: "How does the SPA sign the user in?",
      },
    ],
    flows: [
      {
        id: "login",
        title: "Login",
        steps: ["web form", "api token"],
        crossSource: true,
        coverageUnitIds: ["api", "web"],
        evidencePaths: [
          "sources/web/src/login.tsx",
          "sources/api/pkg/auth/handler.go",
        ],
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
    ...overrides,
  });
}

test("DiscoveryMapSchema accepts full multi-source shape", () => {
  const map = richMultiSourceMap();
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

test("isDocLikeEvidencePath / countNonDocEvidencePaths", () => {
  assert.equal(isDocLikeEvidencePath("sources/api/README.md"), true);
  assert.equal(isDocLikeEvidencePath("sources/api/docs/guide.md"), true);
  assert.equal(isDocLikeEvidencePath("sources/api/LICENSE"), true);
  assert.equal(isDocLikeEvidencePath("sources/api/cmd/main.go"), false);
  assert.equal(
    countNonDocEvidencePaths([
      "sources/api/README.md",
      "sources/api/cmd/main.go",
      "sources/api/pkg/x.go",
    ]),
    2,
  );
  assert.equal(MIN_SOURCE_NON_DOC_EVIDENCE, 2);
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

test("assertSemanticSufficiency accepts rich multi-source map", () => {
  const result = assertSemanticSufficiency(
    richMultiSourceMap(),
    {},
    { sourceCount: 2, sourceIds: ["api", "web"] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.stop_reason, "complete");
  assert.equal(result.gaps.length, 0);
});

test("assertSemanticSufficiency requires ≥N non-doc evidence per source or cancel", () => {
  const discovery = DiscoveryMapSchema.parse({
    sources: [
      {
        sourceId: "api",
        purpose: "API",
        evidencePaths: [
          "sources/api/main.go",
          "sources/api/handler.go",
        ],
      },
      {
        sourceId: "web",
        purpose: "UI",
        // Only README — counts as 0 non-doc
        evidencePaths: ["sources/web/README.md"],
      },
    ],
    domains: [
      {
        id: "d-api",
        title: "API",
        scope: "backend",
        coverageUnitIds: ["api"],
        readerQuestion: "What does the API do?",
      },
      {
        id: "d-web",
        title: "Web",
        scope: "frontend",
        coverageUnitIds: ["web"],
        readerQuestion: "What does the UI do?",
      },
    ],
    flows: [
      {
        id: "f1",
        title: "Join",
        crossSource: true,
        steps: ["web → api"],
        evidencePaths: ["sources/web/src/x.ts", "sources/api/main.go"],
      },
    ],
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
  // With one active source, cross-source is not required.
  const crossRow = cancelled.rows.find((r) => r.unitId === "_cross_source");
  assert.equal(crossRow?.status, "not_required");
});

test("assertSemanticSufficiency rejects README-only evidence even with multiple paths", () => {
  const discovery = DiscoveryMapSchema.parse({
    sources: [
      {
        sourceId: "api",
        purpose: "API",
        evidencePaths: ["sources/api/README.md", "sources/api/docs/overview.md"],
      },
      {
        sourceId: "web",
        purpose: "UI",
        evidencePaths: ["sources/web/src/a.ts", "sources/web/src/b.ts"],
      },
    ],
    domains: [
      {
        id: "d-api",
        title: "API",
        scope: "backend",
        coverageUnitIds: ["api"],
        readerQuestion: "q",
      },
      {
        id: "d-web",
        title: "Web",
        scope: "frontend",
        coverageUnitIds: ["web"],
        readerQuestion: "q",
      },
    ],
    flows: [
      {
        id: "f1",
        title: "Join",
        crossSource: true,
        steps: ["x"],
        evidencePaths: ["sources/web/src/a.ts"],
      },
    ],
  });
  const soft = assertSemanticSufficiency(
    discovery,
    {},
    { sourceCount: 2, sourceIds: ["api", "web"] },
    { throwOnGap: false },
  );
  assert.equal(soft.ok, false);
  assert.ok(soft.gaps.includes("api"));
  assert.match(soft.rows.find((r) => r.unitId === "api")?.reason ?? "", /non-doc/i);
});

test("assertSemanticSufficiency requires discovery sources row (repositoryMap alone insufficient)", () => {
  const discovery = DiscoveryMapSchema.parse({
    sources: [
      {
        sourceId: "api",
        purpose: "API",
        evidencePaths: ["sources/api/x.go", "sources/api/y.go"],
      },
      // web missing from discovery.sources entirely
    ],
    domains: [
      {
        id: "d-api",
        title: "API",
        scope: "backend",
        coverageUnitIds: ["api"],
        readerQuestion: "q",
      },
      {
        id: "d-web",
        title: "Web",
        scope: "frontend",
        coverageUnitIds: ["web"],
        readerQuestion: "q",
      },
    ],
    flows: [
      {
        id: "f1",
        title: "Join",
        crossSource: true,
        steps: ["web → api"],
        evidencePaths: ["sources/api/x.go"],
      },
    ],
  });
  const result = assertSemanticSufficiency(
    discovery,
    {
      repositoryMap: {
        sources: [{ sourceId: "web", entryPoints: ["src/main.tsx"] }],
      },
    },
    { sourceCount: 2, sourceIds: ["api", "web"] },
    { throwOnGap: false },
  );
  assert.equal(result.ok, false);
  assert.ok(result.gaps.includes("web"));
  assert.match(
    result.rows.find((r) => r.unitId === "web")?.reason ?? "",
    /no discovery sources row/i,
  );
});

test("assertSemanticSufficiency requires domain coverageUnitIds per active source", () => {
  const discovery = richMultiSourceMap({
    domains: [
      {
        id: "auth-api",
        title: "API Auth",
        scope: "Token issuance",
        coverageUnitIds: ["api"],
        evidencePaths: ["sources/api/pkg/auth/handler.go"],
        readerQuestion: "How does the API mint tokens?",
      },
      // web has no domain binding
    ],
  });
  const soft = assertSemanticSufficiency(
    discovery,
    {},
    { sourceCount: 2, sourceIds: ["api", "web"] },
    { throwOnGap: false },
  );
  assert.equal(soft.ok, false);
  assert.ok(soft.gaps.includes("domain:web"));
});

test("assertSemanticSufficiency accepts surface coverageUnitIds as domain bind", () => {
  const discovery = richMultiSourceMap({
    domains: [
      {
        id: "auth-api",
        title: "API Auth",
        scope: "Token",
        coverageUnitIds: ["api::pkg/auth"],
        readerQuestion: "q",
      },
      {
        id: "auth-web",
        title: "Web",
        scope: "UI",
        coverageUnitIds: ["web::src"],
        readerQuestion: "q",
      },
    ],
  });
  const result = assertSemanticSufficiency(
    discovery,
    {},
    { sourceCount: 2, sourceIds: ["api", "web"] },
  );
  assert.equal(result.ok, true);
});

test("assertSemanticSufficiency requires qualified cross-source flow or openQuestion", () => {
  // crossSource true but empty steps/evidence → gap
  const emptyCross = richMultiSourceMap({
    flows: [{ id: "f1", title: "Local", crossSource: true, steps: [], evidencePaths: [] }],
    openQuestions: [],
  });
  const soft = assertSemanticSufficiency(
    emptyCross,
    {},
    { sourceCount: 2, sourceIds: ["api", "web"] },
    { throwOnGap: false },
  );
  assert.equal(soft.ok, false);
  assert.ok(soft.gaps.includes("_cross_source"));

  // local-only flow also fails
  const localOnly = richMultiSourceMap({
    flows: [
      {
        id: "f1",
        title: "Local",
        crossSource: false,
        steps: ["in-source"],
        evidencePaths: ["sources/api/x.go"],
      },
    ],
    openQuestions: [],
  });
  const softLocal = assertSemanticSufficiency(
    localOnly,
    {},
    { sourceCount: 2, sourceIds: ["api", "web"] },
    { throwOnGap: false },
  );
  assert.equal(softLocal.ok, false);
  assert.ok(softLocal.gaps.includes("_cross_source"));

  // openQuestion escape hatch
  const withQ = assertSemanticSufficiency(
    localOnly,
    { openQuestions: ["How do api and web share session cookies?"] },
    { sourceCount: 2, sourceIds: ["api", "web"] },
  );
  assert.equal(withQ.ok, true);

  // discovery openQuestions also work
  const withDiscoveryQ = assertSemanticSufficiency(
    richMultiSourceMap({
      flows: [],
      openQuestions: ["Is there a shared auth cookie domain?"],
    }),
    {},
    { sourceCount: 2, sourceIds: ["api", "web"] },
  );
  assert.equal(withDiscoveryQ.ok, true);
});

test("assertSemanticSufficiency accepts cross flow with steps only or evidence only", () => {
  const stepsOnly = richMultiSourceMap({
    flows: [
      {
        id: "f1",
        title: "Join",
        crossSource: true,
        steps: ["web form", "api token"],
        evidencePaths: [],
      },
    ],
  });
  assert.equal(
    assertSemanticSufficiency(stepsOnly, {}, { sourceCount: 2, sourceIds: ["api", "web"] })
      .ok,
    true,
  );

  const evidenceOnly = richMultiSourceMap({
    flows: [
      {
        id: "f1",
        title: "Join",
        crossSource: true,
        steps: [],
        evidencePaths: ["sources/web/src/login.tsx", "sources/api/auth.go"],
      },
    ],
  });
  assert.equal(
    assertSemanticSufficiency(evidenceOnly, {}, { sourceCount: 2, sourceIds: ["api", "web"] })
      .ok,
    true,
  );
});
