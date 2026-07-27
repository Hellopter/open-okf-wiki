import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWikiNav,
  buildWikiNavPathTree,
  defaultWikiBrowsePage,
  firstWikiNavPage,
  parseWikiIndexListing,
  WIKI_NAV_UNLISTED_TITLE,
  type WikiNavNode,
} from "./wiki-nav.js";

function concept(path: string, title: string, type = "Concept"): {
  path: string;
  content: string;
  title: string;
  type: string;
} {
  return {
    path,
    title,
    type,
    content: `---\ntype: ${type}\ntitle: ${title}\n---\n\nBody.\n`,
  };
}

function pathsOf(nodes: WikiNavNode[]): string[] {
  const out: string[] = [];
  const walk = (list: WikiNavNode[]) => {
    for (const n of list) {
      if (n.kind === "page") out.push(n.path);
      else walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

test("parseWikiIndexListing reads headings and bullet links in order", () => {
  const entries = parseWikiIndexListing(`---
okf_version: "0.2"
---

# Intro

* [Overview](overview.md) - The big picture.
* [Architecture](/architecture.md)

# Modules

- [Core](modules/core.md)
`);
  assert.deepEqual(entries, [
    { kind: "heading", title: "Intro" },
    {
      kind: "link",
      title: "Overview",
      href: "overview.md",
      description: "The big picture.",
    },
    { kind: "link", title: "Architecture", href: "/architecture.md" },
    { kind: "heading", title: "Modules" },
    { kind: "link", title: "Core", href: "modules/core.md" },
  ]);
});

test("buildWikiNav follows root index order and groups", () => {
  const nav = buildWikiNav([
    concept("architecture.md", "Architecture", "Architecture"),
    concept("overview.md", "Overview", "Overview"),
    concept("modules/core.md", "Core", "Module"),
    {
      path: "index.md",
      content: [
        "# Start here",
        "",
        "* [Overview](overview.md) - intro",
        "* [Architecture](architecture.md)",
        "",
        "# Modules",
        "",
        "* [Core](modules/core.md)",
      ].join("\n"),
    },
  ]);

  assert.equal(nav.length, 2);
  assert.equal(nav[0]?.kind, "group");
  assert.equal(nav[0]?.kind === "group" && nav[0].title, "Start here");
  assert.deepEqual(pathsOf(nav), ["overview.md", "architecture.md", "modules/core.md"]);
  assert.equal(firstWikiNavPage(nav), "overview.md");
});

test("buildWikiNav expands nested index as dir node", () => {
  const nav = buildWikiNav([
    concept("overview.md", "Overview", "Overview"),
    concept("modules/core.md", "Core", "Module"),
    concept("modules/api.md", "API", "Module"),
    {
      path: "index.md",
      content: "# Wiki\n\n* [Overview](overview.md)\n* [Modules](modules/index.md)\n",
    },
    {
      path: "modules/index.md",
      content: "# modules/\n\n* [API](api.md)\n* [Core](core.md)\n",
    },
  ]);

  assert.deepEqual(pathsOf(nav), ["overview.md", "modules/api.md", "modules/core.md"]);
  const group = nav[0];
  assert.ok(group && group.kind === "group");
  const modules = group.children.find((c) => c.kind === "dir");
  assert.ok(modules && modules.kind === "dir");
  assert.equal(modules.path, "modules");
  assert.equal(modules.title, "Modules");
  assert.deepEqual(
    modules.children.map((c) => (c.kind === "page" ? c.path : c.kind)),
    ["modules/api.md", "modules/core.md"],
  );
});

test("buildWikiNav appends unlisted concept pages", () => {
  const nav = buildWikiNav([
    concept("overview.md", "Overview", "Overview"),
    concept("orphan.md", "Orphan"),
    {
      path: "index.md",
      content: "* [Overview](overview.md)\n",
    },
  ]);
  const unlisted = nav.find((n) => n.kind === "group" && n.source === "unlisted");
  assert.ok(unlisted && unlisted.kind === "group");
  assert.equal(unlisted.title, WIKI_NAV_UNLISTED_TITLE);
  assert.deepEqual(pathsOf([unlisted]), ["orphan.md"]);
});

test("buildWikiNav falls back to type-aware path tree without root index", () => {
  const nav = buildWikiNav([
    concept("modules/z.md", "Z", "Module"),
    concept("modules/a.md", "A", "Module"),
    concept("overview.md", "Overview", "Overview"),
    concept("architecture.md", "Architecture", "Architecture"),
  ]);
  // Dirs first, then root files by type rank (Overview before Architecture).
  assert.deepEqual(pathsOf(nav), [
    "modules/a.md",
    "modules/z.md",
    "overview.md",
    "architecture.md",
  ]);
  assert.equal(nav[0]?.kind, "dir");
  assert.equal(nav[1]?.kind, "page");
  assert.equal(nav[1]?.kind === "page" && nav[1].path, "overview.md");
});

test("buildWikiNavPathTree nests directories", () => {
  const meta = new Map([
    ["overview.md", { title: "Overview", type: "Overview" }],
    ["modules/a.md", { title: "A", type: "Module" }],
  ]);
  const tree = buildWikiNavPathTree(["overview.md", "modules/a.md"], meta);
  assert.equal(tree[0]?.kind, "dir");
  assert.equal(tree[1]?.kind, "page");
  assert.equal(tree[1]?.kind === "page" && tree[1].path, "overview.md");
});

test("defaultWikiBrowsePage prefers first nav entry over overview alpha", () => {
  const nav = buildWikiNav([
    concept("architecture.md", "Architecture", "Architecture"),
    concept("overview.md", "Overview", "Overview"),
    {
      path: "index.md",
      content: "* [Architecture](architecture.md)\n* [Overview](overview.md)\n",
    },
  ]);
  assert.equal(defaultWikiBrowsePage(nav, ["architecture.md", "overview.md"]), "architecture.md");
});

test("buildWikiNav resolves directory slash links to nested index", () => {
  const nav = buildWikiNav([
    concept("flows/x.md", "X", "Flow"),
    {
      path: "index.md",
      content: "* [Flows](flows/)\n",
    },
    {
      path: "flows/index.md",
      content: "* [X](x.md)\n",
    },
  ]);
  assert.deepEqual(pathsOf(nav), ["flows/x.md"]);
});

test("buildWikiNav skips log.md and duplicate links", () => {
  const nav = buildWikiNav([
    concept("overview.md", "Overview", "Overview"),
    {
      path: "index.md",
      content: "* [Overview](overview.md)\n* [Again](overview.md)\n* [Log](log.md)\n",
    },
    { path: "log.md", content: "# Log\n" },
  ]);
  assert.deepEqual(pathsOf(nav), ["overview.md"]);
});
