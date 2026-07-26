import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ancestorDirPaths, buildWikiPageTree } from "./page-tree.ts";

describe("buildWikiPageTree", () => {
  it("nests modules under a directory node", () => {
    const tree = buildWikiPageTree(["overview.md", "modules/a.md", "modules/b.md", "flows/x.md"]);
    assert.equal(tree[0]?.name, "flows");
    assert.equal(tree[0]?.kind, "dir");
    assert.equal(tree[1]?.name, "modules");
    assert.equal(tree[1]?.kind, "dir");
    assert.equal(tree[2]?.name, "overview.md");
    assert.equal(tree[2]?.kind, "file");
    assert.deepEqual(
      tree[1]?.children?.map((c) => c.path),
      ["modules/a.md", "modules/b.md"],
    );
  });

  it("returns empty for empty input", () => {
    assert.deepEqual(buildWikiPageTree([]), []);
  });
});

describe("ancestorDirPaths", () => {
  it("lists parent dirs", () => {
    assert.deepEqual(ancestorDirPaths("modules/runtime/foo.md"), ["modules", "modules/runtime"]);
    assert.deepEqual(ancestorDirPaths("overview.md"), []);
  });
});
