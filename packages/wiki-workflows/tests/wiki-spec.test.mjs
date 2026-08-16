import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWikiSpec,
  sameWikiCluster,
  wikiSpecClusterId,
  wikiSpecClusterPaths,
  wikiSpecClusters,
  wikiSpecDomainIds,
  wikiSpecPagePaths,
  wikiSpecPageType,
  wikiSpecPages,
} from "../dist/lead.js";

const validPages = [
  "overview.md",
  "billing/domain.md",
  "billing/invoice/concept.md",
  "billing/invoice/models.md",
  "billing/invoice/models/line-item.md",
  "billing/invoice/sequences.md",
];

const validSpec = () => ({ pages: [...validPages] });

test("accepts a slim pages spec and derives host-owned page types", () => {
  const spec = parseWikiSpec(validSpec());
  assert.deepEqual(spec, { pages: validPages });
  assert.deepEqual(wikiSpecPagePaths(spec), validPages);
  assert.deepEqual(wikiSpecPages(spec), [
    { path: "overview.md", pageType: "overview" },
    { path: "billing/domain.md", pageType: "domain" },
    { path: "billing/invoice/concept.md", pageType: "concept" },
    { path: "billing/invoice/models.md", pageType: "data" },
    { path: "billing/invoice/models/line-item.md", pageType: "data" },
    { path: "billing/invoice/sequences.md", pageType: "flow" },
  ]);
  assert.equal(wikiSpecPageType("billing/invoice/models.md"), "data");
  assert.equal(wikiSpecPageType("billing/invoice/sequences.md"), "flow");
  assert.deepEqual(wikiSpecDomainIds(spec), ["billing"]);
});

test("accepts optional architecture.md and a domain that contains only domain.md", () => {
  const spec = parseWikiSpec({ pages: ["overview.md", "architecture.md", "billing/domain.md"] });
  assert.deepEqual(wikiSpecPages(spec).map((page) => page.pageType), ["overview", "architecture", "domain"]);
  assert.deepEqual(wikiSpecClusters(spec), ["_root", "billing"]);
});

test("rejects version, extra fields, and overview as an object", () => {
  assert.throws(() => parseWikiSpec({ version: 1, pages: validPages }), /unknown field/);
  assert.throws(() => parseWikiSpec({ pages: validPages, extra: true }), /unknown field/);
  assert.throws(() => parseWikiSpec({ overview: { path: "overview.md" } }), /unknown field|pages/);
  assert.throws(() => parseWikiSpec({ pages: validPages, overview: { path: "overview.md" } }), /unknown field/);
});

test("rejects illegal paths and type-bucket concept names", () => {
  const illegal = [
    "billing/concepts/invoice.md",
    "billing/flows/collection.md",
    "billing/states/invoice.md",
    "billing/data/invoice.md",
    "billing/modules/ledger.md",
    "billing/concept.md",
    "invoice/flows.md",
    "billing/invoice/models/line/item.md",
    "billing/invoice/unknown.md",
    "wiki/overview.md",
    "Billing/domain.md",
  ];
  for (const path of illegal) {
    assert.throws(() => parseWikiSpec({ pages: ["overview.md", "billing/domain.md", path] }));
  }
  assert.throws(() => parseWikiSpec({ pages: ["overview.md", "billing/domain.md", "overview.md"] }));
});

test("rejects missing overview.md and missing domain.md", () => {
  assert.throws(() => parseWikiSpec({ pages: ["billing/domain.md"] }));
  assert.throws(() => parseWikiSpec({ pages: ["overview.md"] }));
  assert.throws(() => parseWikiSpec({ pages: ["overview.md", "billing/invoice/concept.md"] }));
  assert.throws(() => parseWikiSpec({
    pages: ["overview.md", "core/domain.md", "billing/invoice/concept.md"],
  }));
});

test("cluster helpers group root, domain, and concept pages", () => {
  const spec = parseWikiSpec({
    pages: [
      "overview.md",
      "architecture.md",
      "billing/domain.md",
      "billing/invoice/concept.md",
      "billing/invoice/flows.md",
      "billing/invoice/states.md",
      "billing/invoice/data.md",
      "billing/invoice/modules.md",
    ],
  });
  assert.equal(wikiSpecClusterId("overview.md"), "_root");
  assert.equal(wikiSpecClusterId("architecture.md"), "_root");
  assert.equal(wikiSpecClusterId("wiki/overview.md"), "_root");
  assert.equal(wikiSpecClusterId("wiki/architecture.md"), "_root");
  assert.equal(wikiSpecClusterId("billing/domain.md"), "billing");
  assert.equal(wikiSpecClusterId("wiki/billing/domain.md"), "billing");
  assert.equal(wikiSpecClusterId("billing/invoice/concept.md"), "billing/invoice");
  assert.equal(wikiSpecClusterId("wiki/billing/invoice/models/foo.md"), "billing/invoice");
  assert.deepEqual(wikiSpecClusters(spec), ["_root", "billing", "billing/invoice"]);
  assert.deepEqual(wikiSpecClusterPaths(spec, "_root"), ["overview.md", "architecture.md"]);
  assert.deepEqual(wikiSpecClusterPaths(spec, "billing"), ["billing/domain.md"]);
  assert.deepEqual(wikiSpecClusterPaths(spec, "billing/invoice"), [
    "billing/invoice/concept.md",
    "billing/invoice/flows.md",
    "billing/invoice/states.md",
    "billing/invoice/data.md",
    "billing/invoice/modules.md",
  ]);
  assert.equal(sameWikiCluster(["billing/invoice/concept.md", "wiki/billing/invoice/flows.md"]), true);
  assert.equal(sameWikiCluster(["wiki/billing/domain.md"]), true);
  assert.equal(sameWikiCluster(["billing/domain.md", "billing/invoice/concept.md"]), false);
  assert.equal(sameWikiCluster(["overview.md", "architecture.md"]), true);
  assert.equal(sameWikiCluster(["overview.md", "core/domain.md"]), false);
  assert.equal(sameWikiCluster(["overview.md"]), true);
  assert.equal(sameWikiCluster([]), false);
});
