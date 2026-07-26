import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { generateRootIndexIfMissing, renderRootIndex } from "./wiki-index.js";

test("renderRootIndex groups by top directory with root pages first", () => {
  const listing = renderRootIndex([
    { path: "modules/core.md", title: "Core", description: "The core module." },
    { path: "overview.md", title: "Overview", description: "The big picture." },
    { path: "modules/api.md", title: "API" },
    { path: "index.md", title: "ignored" },
  ]);
  assert.equal(
    listing,
    [
      "# Pages",
      "",
      "* [Overview](/overview.md) - The big picture.",
      "",
      "# modules/",
      "",
      "* [API](/modules/api.md)",
      "* [Core](/modules/core.md) - The core module.",
      "",
    ].join("\n"),
  );
});

test("generateRootIndexIfMissing synthesizes from frontmatter, never overwrites", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-idx-"));
  await writeFile(
    path.join(root, "overview.md"),
    "---\ntype: Overview\ntitle: Overview\ndescription: Intro.\n---\nBody.\n",
  );
  await mkdir(path.join(root, "modules"), { recursive: true });
  await writeFile(
    path.join(root, "modules/core.md"),
    "---\ntype: Module\ntitle: Core\n---\nBody.\n",
  );

  assert.equal(await generateRootIndexIfMissing(root), true);
  const listing = await readFile(path.join(root, "index.md"), "utf8");
  assert.match(listing, /\* \[Overview\]\(\/overview\.md\) - Intro\./);
  assert.match(listing, /# modules\/\n\n\* \[Core\]\(\/modules\/core\.md\)/);

  // Second call: listing exists → untouched.
  assert.equal(await generateRootIndexIfMissing(root), false);
});
