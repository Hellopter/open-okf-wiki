import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveWikiGraph,
  extractInternalLinkTargets,
  resolveWikiLinkTarget,
  trustTierFromFrontmatter,
} from "./wiki-links.js";

test("resolveWikiLinkTarget handles relative, dot, parent, and bundle-absolute forms", () => {
  assert.equal(resolveWikiLinkTarget("other.md", "modules/core.md"), "modules/other.md");
  assert.equal(resolveWikiLinkTarget("./other.md", "modules/core.md"), "modules/other.md");
  assert.equal(resolveWikiLinkTarget("../overview.md", "modules/core.md"), "overview.md");
  assert.equal(resolveWikiLinkTarget("/concepts/x.md", "modules/core.md"), "concepts/x.md");
  assert.equal(resolveWikiLinkTarget("overview.md", "index.md"), "overview.md");
  // Escapes and schemes resolve to null.
  assert.equal(resolveWikiLinkTarget("../../out.md", "modules/core.md"), null);
  assert.equal(resolveWikiLinkTarget("repo:x.md", "a.md"), null);
  assert.equal(resolveWikiLinkTarget("https://x.test/a.md", "a.md"), null);
});

test("extractInternalLinkTargets skips schemes, keeps fragments off, dedupes", () => {
  const content = [
    "---",
    "type: Concept",
    "title: T",
    "---",
    "",
    "See [a](a.md) and [a again](a.md) and [b](sub/b.md#section).",
    "Cite [Source](repo:src/main.py#L1-L2) and [ext](https://x.test/c.md).",
    "Portable cite [Source](../sources/app/README.md#L1).",
  ].join("\n");
  assert.deepEqual(extractInternalLinkTargets(content), [
    "a.md",
    "sub/b.md",
    "../sources/app/README.md",
  ]);
});

test("trustTierFromFrontmatter maps verified actors to OKF tiers", () => {
  assert.equal(trustTierFromFrontmatter("type: Concept\ntitle: T"), "unverified");
  assert.equal(
    trustTierFromFrontmatter('verified: { by: "process:review-council", at: "2026-01-01" }'),
    "machine-confirmed",
  );
  assert.equal(
    trustTierFromFrontmatter('verified: { by: "human:op", at: "2026-01-01" }'),
    "human-reviewed",
  );
});

test("deriveWikiGraph builds nodes with metadata, deduped edges, and broken links", () => {
  const graph = deriveWikiGraph([
    {
      path: "overview.md",
      content: [
        "---",
        "type: Overview",
        "title: Overview",
        "description: The big picture.",
        "tags: [intro, map]",
        'generated: { by: "okf-wiki/test-model", at: "2026-07-26T12:00:00Z" }',
        'verified: { by: "process:review-council", at: "2026-07-26T12:30:00Z" }',
        "---",
        "",
        "See [core](modules/core.md) and [missing](missing.md).",
        "Cite [Source](sources/app/README.md#L1).",
      ].join("\n"),
    },
    {
      path: "modules/core.md",
      content:
        "---\ntype: Module\ntitle: Core\n---\n\nBack to [overview](../overview.md). Self [me](core.md).",
    },
    {
      path: "index.md",
      content: "# Wiki\n\n* [Overview](overview.md) - o\n* [Gone](gone.md) - broken\n",
    },
  ]);

  // Reserved index.md is not a node.
  assert.deepEqual(graph.nodes.map((n) => n.path).sort(), ["modules/core.md", "overview.md"]);
  const overview = graph.nodes.find((n) => n.path === "overview.md")!;
  assert.equal(overview.type, "Overview");
  assert.equal(overview.description, "The big picture.");
  assert.deepEqual(overview.tags, ["intro", "map"]);
  assert.equal(overview.generatedBy, "okf-wiki/test-model");
  assert.equal(overview.generatedAt, "2026-07-26T12:00:00Z");
  assert.equal(overview.trustTier, "machine-confirmed");
  assert.equal(graph.nodes.find((n) => n.path === "modules/core.md")!.trustTier, "unverified");

  // Edges: overview→core, core→overview; no self edge, no index edges, no sources/ edge.
  assert.deepEqual(graph.edges.map((e) => `${e.from}>${e.to}`).sort(), [
    "modules/core.md>overview.md",
    "overview.md>modules/core.md",
  ]);

  // Broken: overview→missing.md and index→gone.md (reserved pages still checked).
  assert.deepEqual(graph.brokenLinks.map((b) => `${b.from}>${b.resolved ?? b.target}`).sort(), [
    "index.md>gone.md",
    "overview.md>missing.md",
  ]);
});
