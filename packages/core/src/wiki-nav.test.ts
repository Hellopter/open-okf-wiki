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

function concept(
  path: string,
  title: string,
  type = "Concept",
): {
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

// ---------------------------------------------------------------------------
// Edge cases (audit lock-in)
// ---------------------------------------------------------------------------

test("buildWikiNav A→B→A cross-index cycle does not hang; back-edge omitted", () => {
  // buildingIndexes prevents infinite recursion: the back-edge yields no children.
  const nav = buildWikiNav([
    concept("a/page.md", "A Page"),
    concept("b/page.md", "B Page"),
    {
      path: "index.md",
      content: "* [A](a/index.md)\n",
    },
    {
      path: "a/index.md",
      content: "* [Page A](page.md)\n* [B](../b/index.md)\n",
    },
    {
      path: "b/index.md",
      content: "* [Page B](page.md)\n* [Back to A](../a/index.md)\n",
    },
  ]);
  assert.deepEqual(pathsOf(nav), ["a/page.md", "b/page.md"]);
  // A dir is present; B is nested under A; cycle back-edge does not re-enter A.
  const aDir =
    nav.find((n) => n.kind === "dir" && n.path === "a") ??
    (nav[0]?.kind === "group"
      ? nav[0].children.find((n) => n.kind === "dir" && n.path === "a")
      : undefined);
  assert.ok(aDir && aDir.kind === "dir");
  const bDir = aDir.children.find((n) => n.kind === "dir" && n.path === "b");
  assert.ok(bDir && bDir.kind === "dir");
  assert.equal(
    bDir.children.some((n) => n.kind === "dir" && n.path === "a"),
    false,
  );
});

test("buildWikiNav empty children after covered omit dir; empty heading groups drop", () => {
  const nav = buildWikiNav([
    concept("modules/core.md", "Core", "Module"),
    {
      path: "index.md",
      content: [
        "# Empty",
        "",
        "# Listed first",
        "",
        "* [Core](modules/core.md)",
        "",
        "# Nested",
        "",
        "* [Modules](modules/)",
      ].join("\n"),
    },
    {
      path: "modules/index.md",
      // Sole child already covered at root → empty children → Modules dir omitted.
      content: "* [Core](core.md)\n",
    },
  ]);
  assert.deepEqual(pathsOf(nav), ["modules/core.md"]);
  assert.equal(
    nav.some((n) => n.kind === "group" && n.title === "Empty"),
    false,
  );
  assert.equal(
    pathsOf(nav).includes("modules/core.md") &&
      !nav.some(
        (n) => n.kind === "dir" || (n.kind === "group" && n.children.some((c) => c.kind === "dir")),
      ),
    true,
  );
});

test("buildWikiNav multi-index same page: first index wins", () => {
  const nav = buildWikiNav([
    concept("shared.md", "Shared"),
    concept("other.md", "Other"),
    {
      path: "index.md",
      content: "* [Alpha](a/index.md)\n* [Beta](b/index.md)\n",
    },
    {
      path: "a/index.md",
      content: "* [Shared first](../shared.md)\n",
    },
    {
      path: "b/index.md",
      content: "* [Shared again](../shared.md)\n* [Other](../other.md)\n",
    },
  ]);
  assert.deepEqual(pathsOf(nav), ["shared.md", "other.md"]);
  // Title comes from the first listing (entry title / meta), not the second.
  const shared = (() => {
    const walk = (nodes: WikiNavNode[]): WikiNavNode | undefined => {
      for (const n of nodes) {
        if (n.kind === "page" && n.path === "shared.md") return n;
        if (n.kind === "dir" || n.kind === "group") {
          const found = walk(n.children);
          if (found) return found;
        }
      }
      return undefined;
    };
    return walk(nav);
  })();
  assert.ok(shared && shared.kind === "page");
  assert.equal(shared.title, "Shared");
  // shared appears only once
  assert.equal(pathsOf(nav).filter((p) => p === "shared.md").length, 1);
});

test("parseWikiIndexListing skips empty / whitespace-only title links", () => {
  const entries = parseWikiIndexListing(
    ["* [ ](overview.md)", "* [](architecture.md)", "* [Real](real.md)"].join("\n"),
  );
  assert.deepEqual(entries, [{ kind: "link", title: "Real", href: "real.md" }]);
});

test("parseWikiIndexListing treats fragment-only href carefully (skipped)", () => {
  const entries = parseWikiIndexListing(
    ["* [Section](#section)", "* [Page with fragment](overview.md#intro)", "* [Bare hash](#)"].join(
      "\n",
    ),
  );
  // Fragment-only → empty path after strip → skipped.
  // Page + fragment → page target kept, fragment dropped.
  assert.deepEqual(entries, [{ kind: "link", title: "Page with fragment", href: "overview.md" }]);
});

test("buildWikiNav never lists reserved index.md / log.md as concept leaves", () => {
  const nav = buildWikiNav([
    concept("overview.md", "Overview", "Overview"),
    concept("modules/core.md", "Core", "Module"),
    {
      path: "index.md",
      content: "* [Overview](overview.md)\n* [Modules](modules/)\n* [Log](log.md)\n",
    },
    {
      path: "modules/index.md",
      content: "* [Core](core.md)\n",
    },
    { path: "log.md", content: "# Changelog\n" },
  ]);
  const all = pathsOf(nav);
  assert.deepEqual(all, ["overview.md", "modules/core.md"]);
  assert.equal(
    all.some((p) => p.endsWith("index.md") || p.endsWith("log.md")),
    false,
  );
});

test("buildWikiNavPathTree dir→file promotion: longer path promotes leaf to dir", () => {
  // When a segment was first a file leaf, a deeper path promotes it to a dir.
  // The original leaf path is no longer emitted (dir wins).
  const meta = new Map<string, { title?: string; type?: string }>([
    ["foo.md", { title: "Foo" }],
    ["foo.md/nested.md", { title: "Nested" }],
  ]);
  const fileFirst = buildWikiNavPathTree(["foo.md", "foo.md/nested.md"], meta);
  assert.equal(fileFirst.length, 1);
  assert.equal(fileFirst[0]?.kind, "dir");
  assert.equal(fileFirst[0]?.kind === "dir" && fileFirst[0].path, "foo.md");
  assert.deepEqual(pathsOf(fileFirst), ["foo.md/nested.md"]);

  // Dir-first order: same structural outcome (file leaf under promoted segment
  // is not re-added when the segment is already a directory).
  const dirFirst = buildWikiNavPathTree(["foo.md/nested.md", "foo.md"], meta);
  assert.equal(dirFirst.length, 1);
  assert.equal(dirFirst[0]?.kind, "dir");
  assert.deepEqual(pathsOf(dirFirst), ["foo.md/nested.md"]);
});

test("buildWikiNav unwrapSoleGroup expands a single nested group unconditionally", () => {
  const nav = buildWikiNav([
    concept("modules/a.md", "A", "Module"),
    concept("modules/b.md", "B", "Module"),
    {
      path: "index.md",
      content: "* [Modules](modules/index.md)\n",
    },
    {
      path: "modules/index.md",
      // Sole group under nested index is unwrapped into the dir's children.
      content: "# modules/\n\n* [A](a.md)\n* [B](b.md)\n",
    },
  ]);
  const modules =
    nav.find((n) => n.kind === "dir") ??
    (nav[0]?.kind === "group" ? nav[0].children.find((n) => n.kind === "dir") : undefined);
  assert.ok(modules && modules.kind === "dir");
  assert.equal(
    modules.children.every((c) => c.kind === "page"),
    true,
  );
  assert.equal(
    modules.children.some((c) => c.kind === "group"),
    false,
  );
  assert.deepEqual(pathsOf([modules]), ["modules/a.md", "modules/b.md"]);

  // Multiple groups: not a sole group → keep group structure (no unwrap).
  const multi = buildWikiNav([
    concept("modules/a.md", "A", "Module"),
    concept("modules/b.md", "B", "Module"),
    {
      path: "index.md",
      content: "* [Modules](modules/index.md)\n",
    },
    {
      path: "modules/index.md",
      content: "# One\n\n* [A](a.md)\n\n# Two\n\n* [B](b.md)\n",
    },
  ]);
  const modulesMulti =
    multi.find((n) => n.kind === "dir") ??
    (multi[0]?.kind === "group" ? multi[0].children.find((n) => n.kind === "dir") : undefined);
  assert.ok(modulesMulti && modulesMulti.kind === "dir");
  assert.equal(modulesMulti.children.length, 2);
  assert.equal(
    modulesMulti.children.every((c) => c.kind === "group"),
    true,
  );
});
