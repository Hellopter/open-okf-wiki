import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWikiSpec,
  sameWikiCluster,
  wikiSpecClusterId,
  wikiSpecClusterPaths,
  wikiSpecClusters,
  wikiSpecPagePaths,
  wikiSpecPages,
} from "../dist/wiki-spec.js";

const page = (pageType, path) => ({
  pageType, path, title: path, purpose: `Explain ${path}`,
  readerQuestions: ["How does it work?"], requiredFacets: [], findingIds: [],
});

const validSpec = () => ({
  version: 1,
  overview: page("overview", "overview.md"),
  architecture: page("architecture", "architecture.md"),
  domains: [{
    id: "billing", title: "Billing", purpose: "Billing behavior", pages: [
      page("domain", "billing/domain.md"),
      page("concept", "billing/invoice/concept.md"),
      page("flow", "billing/invoice/flows.md"),
      page("state", "billing/invoice/states.md"),
      page("data", "billing/invoice/data.md"),
      page("module", "billing/invoice/modules.md"),
    ],
  }],
  crossLinks: [{ fromPath: "overview.md", toPath: "billing/domain.md", purpose: "Domain navigation" }],
  sharedTerms: [{ term: "Invoice", definition: "A receivable" }], omissions: [],
});

test("parses and flattens the complete versioned Wiki topology", () => {
  const spec = parseWikiSpec(validSpec());
  assert.equal(wikiSpecPages(spec).length, 8);
  assert.deepEqual(wikiSpecPagePaths(spec).slice(0, 3), ["overview.md", "architecture.md", "billing/domain.md"]);
});

test("accepts concept cluster pages including sequences and model slugs", () => {
  const spec = validSpec();
  spec.domains[0].pages.push(
    page("flow", "billing/invoice/sequences.md"),
    page("data", "billing/invoice/models.md"),
    page("data", "billing/invoice/models/line-item.md"),
  );
  const parsed = parseWikiSpec(spec);
  assert.equal(wikiSpecPages(parsed).length, 11);
});

test("accepts a domain that contains only domain.md", () => {
  const spec = validSpec();
  spec.domains[0].pages = [page("domain", "billing/domain.md")];
  const parsed = parseWikiSpec(spec);
  assert.equal(wikiSpecPages(parsed).length, 3);
  assert.deepEqual(wikiSpecClusters(parsed), ["_root", "billing"]);
});

test("rejects invalid domain topology, paths, duplicates, and dangling links", () => {
  const cases = [
    (spec) => { spec.domains[0].id = "Billing/Unsafe"; },
    (spec) => { spec.domains[0].pages = spec.domains[0].pages.slice(1); },
    (spec) => { spec.domains[0].pages[1].path = "billing/invoice/flows.md"; },
    (spec) => { spec.domains[0].pages.push(page("flow", "billing/invoice/flows.md")); },
    (spec) => { spec.crossLinks[0].toPath = "missing.md"; },
  ];
  for (const mutate of cases) {
    const spec = validSpec();
    mutate(spec);
    assert.throws(() => parseWikiSpec(spec));
  }
});

test("rejects old type-bucket paths and pages outside a concept cluster", () => {
  const cases = [
    ["concept", "billing/concepts/invoice.md"],
    ["flow", "billing/flows/collection.md"],
    ["state", "billing/states/invoice.md"],
    ["data", "billing/data/invoice.md"],
    ["module", "billing/modules/ledger.md"],
    ["concept", "billing/concept.md"],
    ["flow", "invoice/flows.md"],
    ["data", "billing/invoice/models/line/item.md"],
    ["concept", "billing/invoice/unknown.md"],
  ];
  for (const [pageType, path] of cases) {
    const spec = validSpec();
    spec.domains[0].pages[1] = page(pageType, path);
    assert.throws(() => parseWikiSpec(spec));
  }
});

test("rejects unknown fields at every contract boundary", () => {
  const spec = validSpec();
  spec.unplanned = true;
  assert.throws(() => parseWikiSpec(spec), /unknown field/);
  const nested = validSpec();
  nested.domains[0].pages[0].extra = true;
  assert.throws(() => parseWikiSpec(nested), /unknown field/);
});

test("rejects unknown description fields on the spec and on a page", () => {
  const spec = validSpec();
  spec.description = "not part of WikiSpec";
  assert.throws(() => parseWikiSpec(spec), /unknown field/);
  const page = validSpec();
  page.overview.description = "not a page field";
  assert.throws(() => parseWikiSpec(page), /unknown field/);
});

test("rejects overview when it is a string", () => {
  const spec = validSpec();
  spec.overview = "overview.md";
  assert.throws(() => parseWikiSpec(spec));
});

test("treats architecture null as absent", () => {
  const spec = validSpec();
  spec.architecture = null;
  const parsed = parseWikiSpec(spec);
  assert.equal("architecture" in parsed, false);
  assert.equal(wikiSpecPages(parsed).length, 7);
  assert.deepEqual(wikiSpecPagePaths(parsed).slice(0, 2), ["overview.md", "billing/domain.md"]);
});

test("TypeBox structure errors include a field path", () => {
  const spec = validSpec();
  delete spec.overview.title;
  assert.throws(() => parseWikiSpec(spec), /\/overview\/title/);
});

test("cluster helpers group root, domain, and concept pages", () => {
  const spec = parseWikiSpec(validSpec());
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
