import assert from "node:assert/strict";
import test from "node:test";
import { parseWikiSpec, wikiSpecPagePaths, wikiSpecPages } from "../dist/wiki-spec.js";

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
      page("concept", "billing/concepts/invoice.md"),
      page("flow", "billing/flows/collection.md"),
      page("state", "billing/states/invoice.md"),
      page("data", "billing/data/invoice.md"),
      page("module", "billing/modules/ledger.md"),
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

test("rejects invalid domain topology, paths, duplicates, and dangling links", () => {
  const cases = [
    (spec) => { spec.domains[0].id = "Billing/Unsafe"; },
    (spec) => { spec.domains[0].pages = spec.domains[0].pages.slice(1); },
    (spec) => { spec.domains[0].pages[1].path = "billing/flows/invoice.md"; },
    (spec) => { spec.domains[0].pages.push(page("flow", "billing/flows/collection.md")); },
    (spec) => { spec.crossLinks[0].toPath = "missing.md"; },
  ];
  for (const mutate of cases) {
    const spec = validSpec();
    mutate(spec);
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

export { validSpec };
