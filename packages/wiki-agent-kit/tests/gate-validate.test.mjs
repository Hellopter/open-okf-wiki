import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertCoverage,
  assertSemanticSufficiency,
  gatePlan,
  verifyPlanGate,
  writePlanGateReceipt,
} from "../scripts/lib/gate.mjs";
import {
  candidateSealStatus,
  regenerateIndexes,
  sealCandidate,
  validateWorkdir,
} from "../scripts/lib/validate.mjs";

function minimalProjectModel(overrides = {}) {
  return {
    version: 1,
    productPurpose: "Provide an authenticated API for demo resources",
    actors: [{ id: "actor:user", title: "User", evidenceIds: ["evidence:readme"] }],
    domains: [
      {
        id: "domain:api",
        title: "API",
        summary: "HTTP API surface",
        evidenceIds: ["evidence:readme"],
      },
    ],
    capabilities: [
      {
        id: "capability:serve",
        title: "Serve resources",
        summary: "Expose demo resources over HTTP",
        evidenceIds: ["evidence:a-java"],
      },
    ],
    entities: [],
    rules: [],
    flows: [
      {
        id: "flow:request",
        title: "Handle request",
        trigger: "HTTP request arrives",
        outcome: "JSON response returned",
        steps: [
          { order: 1, summary: "Route request" },
          { order: 2, summary: "Return payload" },
        ],
        branches: [],
        failures: [{ summary: "Validation failure returns 400" }],
        stateChanges: [],
        sideEffects: [],
        participatingKnowledgeIds: ["domain:api", "capability:serve"],
        evidenceIds: ["evidence:a-java"],
      },
    ],
    modules: [{ id: "module:api", title: "api", coverageUnitIds: ["api"] }],
    dataModels: [],
    mappings: [
      {
        id: "map:api-module",
        fromId: "domain:api",
        toId: "module:api",
        kind: "implemented-by",
        evidenceIds: ["evidence:a-java"],
      },
    ],
    conflicts: [],
    gaps: [],
    openQuestions: [],
    ...overrides,
  };
}

function criticalPage(overrides = {}) {
  return {
    path: "overview.md",
    type: "Overview",
    title: "Demo",
    question: "What does this service do?",
    critical: true,
    audiences: ["new-engineer", "llm"],
    requiredSections: ["Purpose", "Evidence"],
    knowledgeIds: ["domain:api"],
    evidenceIds: ["evidence:a-java"],
    coverageUnitIds: ["api"],
    ...overrides,
  };
}

function makePlanningWorkdir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gate-"));
  fs.mkdirSync(path.join(tmp, "inputs"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "analysis"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "inputs", "inventory.json"),
    JSON.stringify({
      tier: "L1",
      sourceCount: 1,
      coverageUnits: [{ id: "api", kind: "source", sourceId: "api", required: true }],
    }),
  );
  fs.writeFileSync(
    path.join(tmp, "analysis", "discovery-map.json"),
    JSON.stringify({
      domains: [
        {
          id: "domain:api",
          title: "API",
          summary: "HTTP API domain",
          coverageUnitIds: ["api"],
        },
      ],
      flows: [],
      coverageUnits: [{ id: "api", required: true }],
    }),
  );
  fs.writeFileSync(path.join(tmp, "analysis", "project-model.json"), JSON.stringify(minimalProjectModel()));
  fs.writeFileSync(
    path.join(tmp, "analysis", "spec.json"),
    JSON.stringify({ pages: [criticalPage()] }),
  );
  return tmp;
}

describe("gates", () => {
  it("requires each coverage unit to be bound or structurally cancelled", () => {
    const inventory = { coverageUnits: [{ id: "api", required: true }] };
    assert.equal(assertCoverage({ inventory, spec: { pages: [] } }).ok, false);
    assert.equal(
      assertCoverage({
        inventory,
        spec: {
          pages: [],
          coverageCancellations: [{ coverageUnitId: "api", cancelled: true, reason: "out of scope" }],
        },
      }).ok,
      true,
    );
    const missingReason = assertCoverage({
      inventory,
      spec: { pages: [], coverageCancellations: [{ coverageUnitId: "api", cancelled: true }] },
    });
    assert.equal(missingReason.ok, false);
    assert.ok(missingReason.errors.some((error) => error.includes("reason")));
  });

  it("requires explicit cross-source evidence or cancellation", () => {
    const result = assertSemanticSufficiency({
      inventory: { tier: "L3", sourceCount: 2 },
      discoveryMap: { domains: [{ id: "d1", title: "D", summary: "domain" }], flows: [] },
      projectModel: minimalProjectModel(),
      spec: {
        pages: [criticalPage({ coverageUnitIds: [] })],
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("cross-source")));
  });

  it("binds gate receipts to inventory, discovery, project model, and spec digests", () => {
    const workdir = makePlanningWorkdir();
    assert.equal(gatePlan(workdir).ok, true, JSON.stringify(gatePlan(workdir).errors));
    const { receipt } = writePlanGateReceipt(workdir, "run-1", "kit-1");
    assert.ok(receipt);
    assert.ok(receipt.digests.projectModel);
    assert.equal(verifyPlanGate(workdir, "run-1", "kit-1").ok, true);
    fs.writeFileSync(
      path.join(workdir, "analysis", "spec.json"),
      JSON.stringify({
        pages: [criticalPage({ coverageUnitIds: [], knowledgeIds: ["domain:api"], evidenceIds: ["evidence:a-java"] })],
      }),
    );
    const stale = verifyPlanGate(workdir, "run-1", "kit-1");
    assert.equal(stale.ok, false);
    assert.ok(stale.errors.some((error) => error.includes("gate") || error.includes("stale")));
  });

  it("rejects missing or stale project model digests on L1+", () => {
    const workdir = makePlanningWorkdir();
    const { receipt } = writePlanGateReceipt(workdir, "run-model", "kit-1");
    assert.ok(receipt);
    fs.writeFileSync(
      path.join(workdir, "analysis", "project-model.json"),
      JSON.stringify(minimalProjectModel({ productPurpose: "Changed purpose for digest drift" })),
    );
    const stale = verifyPlanGate(workdir, "run-model", "kit-1");
    assert.equal(stale.ok, false);
    assert.ok(stale.errors.some((error) => /projectModel|stale|planning artifacts/i.test(error)));

    fs.rmSync(path.join(workdir, "analysis", "project-model.json"));
    const missing = gatePlan(workdir);
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some((error) => /project-model|projectModel/i.test(error)));
  });

  it("fails L1+ project models that lack purpose, domains/capabilities, or complete flows", () => {
    const base = {
      inventory: { tier: "L1", sourceCount: 1 },
      discoveryMap: {
        domains: [{ id: "domain:api", title: "API", summary: "API domain" }],
        flows: [],
      },
      spec: { pages: [criticalPage()] },
    };
    const emptyPurpose = assertSemanticSufficiency({
      ...base,
      projectModel: minimalProjectModel({ productPurpose: "   " }),
    });
    assert.equal(emptyPurpose.ok, false);
    assert.ok(emptyPurpose.errors.some((error) => error.includes("productPurpose")));

    const noDomainCapability = assertSemanticSufficiency({
      ...base,
      projectModel: minimalProjectModel({ domains: [], capabilities: [] }),
    });
    assert.equal(noDomainCapability.ok, false);
    assert.ok(noDomainCapability.errors.some((error) => /domains|capabilities/i.test(error)));

    const emptyFlow = assertSemanticSufficiency({
      ...base,
      projectModel: minimalProjectModel({
        flows: [{ id: "flow:broken", title: "Broken", trigger: "", outcome: "", steps: [], evidenceIds: [] }],
      }),
    });
    assert.equal(emptyFlow.ok, false);
    assert.ok(emptyFlow.errors.some((error) => error.includes("structurally incomplete")));
  });

  it("rejects project-model collection items with missing or empty ids", () => {
    const result = assertSemanticSufficiency({
      inventory: { tier: "L1", sourceCount: 1 },
      discoveryMap: {
        domains: [{ id: "domain:api", title: "API", summary: "API domain" }],
        flows: [],
      },
      projectModel: minimalProjectModel({
        actors: [{ id: "   ", title: "Nameless" }, { title: "Also nameless" }],
        gaps: [{ summary: "gap without id" }],
      }),
      spec: { pages: [criticalPage()] },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("project-model.actors[0] lacks non-empty id")));
    assert.ok(result.errors.some((error) => error.includes("project-model.actors[1] lacks non-empty id")));
    assert.ok(result.errors.some((error) => error.includes("project-model.gaps[0] lacks non-empty id")));
  });

  it("rejects project-model flow steps with missing or invalid order", () => {
    const base = {
      inventory: { tier: "L1", sourceCount: 1 },
      discoveryMap: {
        domains: [{ id: "domain:api", title: "API", summary: "API domain" }],
        flows: [],
      },
      spec: { pages: [criticalPage()] },
    };
    const missingOrder = assertSemanticSufficiency({
      ...base,
      projectModel: minimalProjectModel({
        flows: [
          {
            id: "flow:no-order",
            title: "No order",
            trigger: "request",
            outcome: "response",
            steps: [{ summary: "Handle without order" }],
            evidenceIds: ["evidence:a-java"],
          },
        ],
      }),
    });
    assert.equal(missingOrder.ok, false);
    assert.ok(missingOrder.errors.some((error) => error.includes("project-model flow is structurally incomplete")));

    const invalidOrder = assertSemanticSufficiency({
      ...base,
      projectModel: minimalProjectModel({
        flows: [
          {
            id: "flow:bad-order",
            title: "Bad order",
            trigger: "request",
            outcome: "response",
            steps: [{ order: 0, summary: "Zero is invalid" }, { order: 1.5, summary: "Non-integer" }],
            evidenceIds: ["evidence:a-java"],
          },
        ],
      }),
    });
    assert.equal(invalidOrder.ok, false);
    assert.ok(invalidOrder.errors.some((error) => error.includes("project-model flow is structurally incomplete")));
  });

  it("fails critical pages missing reader/section/knowledge/evidence contracts", () => {
    const result = assertSemanticSufficiency({
      inventory: { tier: "L1", sourceCount: 1 },
      discoveryMap: {
        domains: [{ id: "domain:api", title: "API", summary: "API domain" }],
        flows: [],
      },
      projectModel: minimalProjectModel(),
      spec: {
        pages: [
          {
            path: "overview.md",
            type: "Overview",
            title: "Demo",
            critical: true,
            audiences: ["new-engineer"],
            coverageUnitIds: ["api"],
          },
        ],
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("reader question")));
    assert.ok(result.errors.some((error) => error.includes("requiredSections")));
    assert.ok(result.errors.some((error) => error.includes("knowledgeIds")));
    assert.ok(result.errors.some((error) => error.includes("evidenceIds")));
  });

  it("allows L0 runs without a project model while warning", () => {
    const result = assertSemanticSufficiency({
      inventory: { tier: "L0", sourceCount: 1 },
      discoveryMap: { domains: [], flows: [] },
      projectModel: null,
      spec: {
        pages: [
          {
            path: "overview.md",
            critical: false,
            question: "What is this library?",
            requiredSections: ["Purpose"],
            knowledgeIds: ["lib"],
            evidenceIds: ["evidence:readme"],
            coverageUnitIds: [],
          },
        ],
      },
    });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((warning) => /project-model/i.test(warning)));
  });
});

describe("candidate validation", () => {
  it("resolves local relative citations and seals a valid candidate", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-val-"));
    const candidate = path.join(tmp, "candidate");
    const source = path.join(tmp, "sources", "api", "src", "A.java");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.join(candidate, "modules"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "analysis"), { recursive: true });
    fs.writeFileSync(source, "line1\nline2\nline3\n");
    fs.writeFileSync(
      path.join(candidate, "overview.md"),
      [
        "---",
        "type: Overview",
        "title: Demo",
        "description: A demo page.",
        "---",
        "",
        "## Purpose",
        "",
        "Demo overview.",
        "",
        "## Evidence",
        "",
        "[Auth](./modules/auth.md)",
        "[Source: src/A.java L1-L2](../sources/api/src/A.java#L1-L2)",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(candidate, "modules", "auth.md"),
      [
        "---",
        "type: Module",
        "title: Auth",
        "description: Auth implementation.",
        "---",
        "",
        "## Purpose",
        "",
        "Auth module.",
        "",
        "## Evidence",
        "",
        "[Source: src/A.java L2](../../sources/api/src/A.java#L2)",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmp, "analysis", "spec.json"),
      JSON.stringify({
        pages: [
          criticalPage({
            path: "overview.md",
            requiredSections: ["Purpose", "Evidence"],
            coverageUnitIds: ["api"],
          }),
          criticalPage({
            path: "modules/auth.md",
            type: "Module",
            title: "Auth",
            question: "How does auth work?",
            requiredSections: ["Purpose", "Evidence"],
            knowledgeIds: ["module:auth"],
            coverageUnitIds: ["api"],
          }),
        ],
      }),
    );
    const result = validateWorkdir(tmp, { wikiLanguage: "en" });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const indexes = regenerateIndexes(candidate, { wikiLanguage: "en" });
    assert.ok(indexes.written >= 2);
    const rootIndex = fs.readFileSync(path.join(candidate, "index.md"), "utf8");
    assert.match(rootIndex, /okf_version: "0\.2"/);
    assert.match(rootIndex, /# Index/);
    assert.match(rootIndex, /\[Demo\]\(\.\/overview\.md\) — A demo page\./);
    const nestedIndex = fs.readFileSync(path.join(candidate, "modules", "index.md"), "utf8");
    assert.doesNotMatch(nestedIndex, /okf_version/);
    assert.match(nestedIndex, /\[Auth\]\(\.\/auth\.md\) — Auth implementation\./);
    const manifest = sealCandidate(tmp, result);
    assert.ok(manifest.candidateDigest);
    assert.equal(candidateSealStatus(tmp).valid, true);
    fs.appendFileSync(path.join(candidate, "overview.md"), "changed after seal\n");
    assert.equal(candidateSealStatus(tmp).valid, false);
  });

  it("rejects legacy and escaping citations", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-val-bad-"));
    fs.mkdirSync(path.join(tmp, "candidate"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "sources", "api", "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "sources", "api", "src", "A.java"), "only line\n");
    fs.writeFileSync(
      path.join(tmp, "candidate", "overview.md"),
      [
        "---",
        "type: Overview",
        "title: Demo",
        "description: A demo page.",
        "---",
        "",
        "[Source](repo:src/A.java#L1)",
        "[Source: src/A.java L2](../sources/api/src/A.java#L2)",
        "[Source](../../outside.java#L1)",
        "",
      ].join("\n"),
    );
    const result = validateWorkdir(tmp);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("legacy repo:")));
    assert.ok(result.errors.some((error) => error.includes("line range out of bounds")));
    assert.ok(result.errors.some((error) => error.includes("frozen source")));
  });

  it("requires a Spec and rejects candidate pages outside it", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-val-spec-"));
    const candidate = path.join(tmp, "candidate");
    fs.mkdirSync(path.join(tmp, "sources", "api", "src"), { recursive: true });
    fs.mkdirSync(candidate, { recursive: true });
    fs.writeFileSync(path.join(tmp, "sources", "api", "src", "A.java"), "line\n");
    fs.writeFileSync(
      path.join(candidate, "extra.md"),
      ["---", "type: Concept", "title: Extra", "description: Extra page.", "---", "", "[Source](../sources/api/src/A.java#L1)"].join("\n"),
    );
    let result = validateWorkdir(tmp);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("missing or invalid Spec")));

    fs.mkdirSync(path.join(tmp, "analysis"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "analysis", "spec.json"), JSON.stringify({ pages: [] }));
    result = validateWorkdir(tmp);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("absent from the Spec")));
  });

  it("accepts Chinese pages and rejects English-only pages under zh policy", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-val-zh-"));
    const candidate = path.join(tmp, "candidate");
    fs.mkdirSync(path.join(tmp, "sources", "api", "src"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "inputs"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "analysis"), { recursive: true });
    fs.mkdirSync(candidate, { recursive: true });
    fs.writeFileSync(path.join(tmp, "sources", "api", "src", "A.java"), "line1\n");
    fs.writeFileSync(path.join(tmp, "inputs", "run-policy.json"), JSON.stringify({ wikiLanguage: "zh" }));
    fs.writeFileSync(
      path.join(tmp, "analysis", "spec.json"),
      JSON.stringify({
        pages: [
          criticalPage({
            title: "概览",
            question: "这个服务做什么？",
            requiredSections: ["业务目标", "证据"],
          }),
        ],
      }),
    );
    fs.writeFileSync(
      path.join(candidate, "overview.md"),
      [
        "---",
        "type: Overview",
        "title: 服务概览",
        "description: 说明演示服务的业务目标与边界。",
        "---",
        "",
        "## 业务目标",
        "",
        "该服务向调用方提供演示资源。",
        "",
        "## 证据",
        "",
        "[Source: src/A.java L1](../sources/api/src/A.java#L1)",
        "",
      ].join("\n"),
    );
    const ok = validateWorkdir(tmp);
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));

    fs.writeFileSync(
      path.join(candidate, "overview.md"),
      [
        "---",
        "type: Overview",
        "title: Service overview",
        "description: English only description.",
        "---",
        "",
        "## 业务目标",
        "",
        "This service only has English prose.",
        "",
        "## 证据",
        "",
        "[Source: src/A.java L1](../sources/api/src/A.java#L1)",
        "",
      ].join("\n"),
    );
    const bad = validateWorkdir(tmp);
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((error) => /CJK text in title/i.test(error)));
    assert.ok(bad.errors.some((error) => /CJK text in description/i.test(error)));
    assert.ok(bad.errors.some((error) => /meaningful CJK prose/i.test(error)));
  });

  it("verifies required section headings from the Spec", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-val-sections-"));
    const candidate = path.join(tmp, "candidate");
    fs.mkdirSync(path.join(tmp, "sources", "api", "src"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "analysis"), { recursive: true });
    fs.mkdirSync(candidate, { recursive: true });
    fs.writeFileSync(path.join(tmp, "sources", "api", "src", "A.java"), "line1\n");
    fs.writeFileSync(
      path.join(tmp, "analysis", "spec.json"),
      JSON.stringify({
        pages: [criticalPage({ requiredSections: ["Purpose", "Failure modes"] })],
      }),
    );
    fs.writeFileSync(
      path.join(candidate, "overview.md"),
      [
        "---",
        "type: Overview",
        "title: Demo",
        "description: A demo page.",
        "---",
        "",
        "## Purpose",
        "",
        "Only purpose exists.",
        "",
        "[Source: src/A.java L1](../sources/api/src/A.java#L1)",
        "",
      ].join("\n"),
    );
    const result = validateWorkdir(tmp, { wikiLanguage: "en" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("missing required section heading: Failure modes")));
  });

  it("builds Chinese indexes with title and description", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ow-idx-zh-"));
    const candidate = path.join(tmp, "candidate");
    fs.mkdirSync(path.join(candidate, "flows"), { recursive: true });
    fs.writeFileSync(
      path.join(candidate, "overview.md"),
      ["---", "type: Overview", "title: 概览", "description: 项目总览页面。", "---", "", "正文", ""].join("\n"),
    );
    fs.writeFileSync(
      path.join(candidate, "flows", "submit.md"),
      ["---", "type: Business Process", "title: 提交流程", "description: 描述提交主路径。", "---", "", "正文", ""].join("\n"),
    );
    const result = regenerateIndexes(candidate, { wikiLanguage: "zh-CN" });
    assert.equal(result.wikiLanguage, "zh");
    const root = fs.readFileSync(path.join(candidate, "index.md"), "utf8");
    assert.match(root, /okf_version: "0\.2"/);
    assert.match(root, /# 索引/);
    assert.match(root, /## 目录/);
    assert.match(root, /## 页面/);
    assert.match(root, /\[概览\]\(\.\/overview\.md\) — 项目总览页面。/);
    const nested = fs.readFileSync(path.join(candidate, "flows", "index.md"), "utf8");
    assert.doesNotMatch(nested, /okf_version/);
    assert.match(nested, /# 索引/);
    assert.match(nested, /\[提交流程\]\(\.\/submit\.md\) — 描述提交主路径。/);
  });
});
