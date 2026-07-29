import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  regenerateWikiIndexes,
  renderDirectoryIndex,
  validateWikiIndexes,
  type WikiIndexListEntry,
} from "./wiki-index.js";
import { buildWikiNav } from "./wiki-nav.js";

async function writeConcept(
  root: string,
  rel: string,
  opts: { title: string; type?: string; description?: string; body?: string },
): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  const fm = [
    "---",
    `title: ${opts.title}`,
    ...(opts.type ? [`type: ${opts.type}`] : []),
    ...(opts.description ? [`description: ${opts.description}`] : []),
    "---",
    opts.body ?? "Body.\n",
  ].join("\n");
  await writeFile(abs, fm, "utf8");
}

test("renderDirectoryIndex groups by type with product order and Subdirectories last", () => {
  const entries: WikiIndexListEntry[] = [
    { kind: "page", title: "Core", href: "core.md", type: "Module", description: "Core module." },
    {
      kind: "page",
      title: "Overview",
      href: "overview.md",
      type: "Overview",
      description: "Big picture.",
    },
    { kind: "page", title: "Misc", href: "misc.md" },
    { kind: "dir", title: "modules", href: "modules/index.md", description: "2 pages" },
  ];
  const listing = renderDirectoryIndex(entries);
  assert.equal(
    listing,
    [
      "# Overview",
      "",
      "* [Overview](overview.md) - Big picture.",
      "",
      "# Module",
      "",
      "* [Core](core.md) - Core module.",
      "",
      "# Other",
      "",
      "* [Misc](misc.md)",
      "",
      "# Subdirectories",
      "",
      "* [modules](modules/index.md) - 2 pages",
      "",
    ].join("\n"),
  );
});

test("regenerateWikiIndexes: root links modules/index.md not modules/core.md", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-idx-root-"));
  await writeConcept(root, "overview.md", {
    title: "Overview",
    type: "Overview",
    description: "Intro.",
  });
  await writeConcept(root, "modules/core.md", {
    title: "Core",
    type: "Module",
    description: "The core module.",
  });

  const result = await regenerateWikiIndexes(root);
  assert.deepEqual(result.written.sort(), ["index.md", "modules/index.md"]);

  const rootIndex = await readFile(path.join(root, "index.md"), "utf8");
  assert.match(rootIndex, /\* \[Overview\]\(overview\.md\) - Intro\./);
  assert.match(rootIndex, /\* \[modules\]\(modules\/index\.md\)/);
  assert.doesNotMatch(rootIndex, /modules\/core\.md/);
  // Nested indexes are body-only (okf_version stamped later).
  assert.doesNotMatch(rootIndex, /^---/);

  const modulesIndex = await readFile(path.join(root, "modules/index.md"), "utf8");
  assert.match(modulesIndex, /\* \[Core\]\(core\.md\) - The core module\./);
  assert.doesNotMatch(modulesIndex, /modules\/core\.md/);
});

test("regenerateWikiIndexes: deep path a/b/c.md creates three index levels", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-idx-deep-"));
  await writeConcept(root, "a/b/c.md", { title: "C", type: "Concept", description: "Deep page." });

  const result = await regenerateWikiIndexes(root);
  assert.deepEqual(result.written.sort(), ["a/b/index.md", "a/index.md", "index.md"]);

  const rootIndex = await readFile(path.join(root, "index.md"), "utf8");
  assert.match(rootIndex, /\* \[a\]\(a\/index\.md\)/);
  assert.doesNotMatch(rootIndex, /a\/b\/c\.md/);

  const aIndex = await readFile(path.join(root, "a/index.md"), "utf8");
  assert.match(aIndex, /\* \[b\]\(b\/index\.md\)/);
  assert.doesNotMatch(aIndex, /c\.md/);

  const bIndex = await readFile(path.join(root, "a/b/index.md"), "utf8");
  assert.match(bIndex, /\* \[C\]\(c\.md\) - Deep page\./);
});

test("regenerateWikiIndexes is idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-idx-idemp-"));
  await writeConcept(root, "overview.md", { title: "Overview", type: "Overview" });
  await writeConcept(root, "modules/core.md", { title: "Core", type: "Module" });
  await writeConcept(root, "modules/api.md", { title: "API", type: "Module" });

  await regenerateWikiIndexes(root);
  const firstRoot = await readFile(path.join(root, "index.md"), "utf8");
  const firstMod = await readFile(path.join(root, "modules/index.md"), "utf8");

  const second = await regenerateWikiIndexes(root);
  assert.ok(second.written.length >= 2);
  assert.equal(await readFile(path.join(root, "index.md"), "utf8"), firstRoot);
  assert.equal(await readFile(path.join(root, "modules/index.md"), "utf8"), firstMod);
});

test("regenerateWikiIndexes overwrites existing model-written indexes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-idx-ow-"));
  await writeConcept(root, "overview.md", { title: "Overview", type: "Overview" });
  await writeFile(path.join(root, "index.md"), "# Stale\n\n* [Deep](modules/core.md)\n", "utf8");

  await regenerateWikiIndexes(root);
  const listing = await readFile(path.join(root, "index.md"), "utf8");
  assert.doesNotMatch(listing, /modules\/core\.md/);
  assert.match(listing, /\* \[Overview\]\(overview\.md\)/);
});

test("validateWikiIndexes fails on flat deep links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-idx-val-"));
  await writeConcept(root, "modules/core.md", { title: "Core", type: "Module" });
  await regenerateWikiIndexes(root);

  // Inject a bad root index that deep-links past progressive disclosure.
  await writeFile(path.join(root, "index.md"), "# Bad\n\n* [Core](modules/core.md)\n", "utf8");

  const bad = await validateWikiIndexes(root);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("modules/core.md")));

  // Healthy regenerate passes.
  await regenerateWikiIndexes(root);
  const good = await validateWikiIndexes(root);
  assert.equal(good.ok, true, good.errors.join("; "));
});

test("regenerateWikiIndexes + buildWikiNav yields kind===dir for modules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-idx-nav-"));
  await writeConcept(root, "overview.md", { title: "Overview", type: "Overview" });
  await writeConcept(root, "modules/core.md", { title: "Core", type: "Module" });
  await writeConcept(root, "modules/api.md", { title: "API", type: "Module" });

  await regenerateWikiIndexes(root);

  const pages = [
    {
      path: "overview.md",
      content: await readFile(path.join(root, "overview.md"), "utf8"),
      title: "Overview",
      type: "Overview",
    },
    {
      path: "modules/core.md",
      content: await readFile(path.join(root, "modules/core.md"), "utf8"),
      title: "Core",
      type: "Module",
    },
    {
      path: "modules/api.md",
      content: await readFile(path.join(root, "modules/api.md"), "utf8"),
      title: "API",
      type: "Module",
    },
    {
      path: "index.md",
      content: await readFile(path.join(root, "index.md"), "utf8"),
    },
    {
      path: "modules/index.md",
      content: await readFile(path.join(root, "modules/index.md"), "utf8"),
    },
  ];

  const nav = buildWikiNav(pages);
  const modules = nav
    .flatMap((n) => (n.kind === "group" ? n.children : [n]))
    .find((n) => n.kind === "dir" && n.path === "modules");
  assert.ok(modules && modules.kind === "dir", "expected modules dir node in nav");
  assert.equal(modules.title, "modules");
});

test("regenerateWikiIndexes: garbage-collects stale nested index.md", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-idx-gc-"));
  await writeConcept(root, "overview.md", { title: "Overview", type: "Overview" });
  await writeConcept(root, "modules/core.md", { title: "Core", type: "Module" });

  const first = await regenerateWikiIndexes(root);
  assert.deepEqual(first.written.sort(), ["index.md", "modules/index.md"]);
  assert.deepEqual(first.removed, []);
  await access(path.join(root, "modules/index.md"));

  // Concept gone → nested index must be removed (empty modules/ dir may remain).
  await unlink(path.join(root, "modules/core.md"));
  const second = await regenerateWikiIndexes(root);
  assert.deepEqual(second.written, ["index.md"]);
  assert.deepEqual(second.removed, ["modules/index.md"]);
  await assert.rejects(
    () => access(path.join(root, "modules/index.md")),
    (err: NodeJS.ErrnoException) => err.code === "ENOENT",
  );

  // Root listing no longer links modules/index.md.
  const rootIndex = await readFile(path.join(root, "index.md"), "utf8");
  assert.doesNotMatch(rootIndex, /modules\/index\.md/);
  assert.match(rootIndex, /overview\.md/);
});

test("regenerateWikiIndexes: empty concept set removes all indexes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-idx-empty-"));
  await writeConcept(root, "modules/core.md", { title: "Core", type: "Module" });
  await regenerateWikiIndexes(root);
  await unlink(path.join(root, "modules/core.md"));

  const result = await regenerateWikiIndexes(root);
  assert.deepEqual(result.written, []);
  assert.ok(result.removed.includes("index.md"));
  assert.ok(result.removed.includes("modules/index.md"));
});

test("validateWikiIndexes fails when a needed nested index is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-idx-miss-"));
  await writeConcept(root, "modules/core.md", { title: "Core", type: "Module" });
  await regenerateWikiIndexes(root);
  await unlink(path.join(root, "modules/index.md"));

  const bad = await validateWikiIndexes(root);
  assert.equal(bad.ok, false);
  assert.ok(
    bad.errors.some((e) => /missing index\.md/i.test(e) && /modules/i.test(e)),
    bad.errors.join("; "),
  );
});
