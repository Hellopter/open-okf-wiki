import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  canonicalizeCitationInContent,
  canonicalizeCitationTarget,
  canonicalizeWikiTreeCitations,
  formatRepoCitation,
  parseSourceCitations,
  resolveCitationFile,
  sourceRootMapFromSources,
  validateCitationFormat,
  validateCitationResolve,
} from "./citations.js";
import { validateWikiTree } from "./validate-wiki.js";

test("parseSourceCitations: single and multi-repo forms", () => {
  const text = [
    "Fact A [Source](repo:src/main.ts#L10-L20).",
    "Fact B [Source](repo:my-lib/pkg/a.go#L1).",
    "Fact C [Source](repo:README.md).",
  ].join("\n");
  const cites = parseSourceCitations(text);
  assert.equal(cites.length, 3);
  assert.equal(cites[0]!.target, "src/main.ts");
  assert.equal(cites[0]!.lineStart, 10);
  assert.equal(cites[0]!.lineEnd, 20);
  assert.equal(cites[1]!.target, "my-lib/pkg/a.go");
  assert.equal(cites[1]!.lineStart, 1);
  assert.equal(cites[1]!.lineEnd, undefined);
  assert.equal(cites[2]!.target, "README.md");
});

test("validateCitationFormat rejects path escape and bad ranges", () => {
  const bad = parseSourceCitations(
    "x [Source](repo:../etc/passwd#L0-L2) y [Source](repo:a.ts#L5-L2)",
  );
  const errors = validateCitationFormat(bad, "p.md");
  assert.ok(errors.some((e) => e.includes("repository-relative")));
  assert.ok(errors.some((e) => e.includes("line end before start")));
});

test("canonicalizeCitationTarget: single strips sources/<id>/", () => {
  const r = canonicalizeCitationTarget("sources/ebase-2/pom.xml", {
    sourceIds: ["ebase-2"],
    multiSource: false,
  });
  assert.deepEqual(r, { ok: true, target: "pom.xml" });
});

test("canonicalizeCitationTarget: multi strips sources/ keeps id", () => {
  const r = canonicalizeCitationTarget("sources/a/x.ts", {
    sourceIds: ["a", "b"],
    multiSource: true,
  });
  assert.deepEqual(r, { ok: true, target: "a/x.ts" });
});

test("canonicalizeCitationTarget: single strips registered id prefix", () => {
  const r = canonicalizeCitationTarget("ebase-2/pom.xml", {
    sourceIds: ["ebase-2"],
    multiSource: false,
  });
  assert.deepEqual(r, { ok: true, target: "pom.xml" });
});

test("canonicalizeCitationTarget: multi keeps id prefix", () => {
  const r = canonicalizeCitationTarget("a/x.ts", {
    sourceIds: ["a", "b"],
    multiSource: true,
  });
  assert.deepEqual(r, { ok: true, target: "a/x.ts" });
});

test("canonicalizeCitationTarget: multi bare path errors", () => {
  const r = canonicalizeCitationTarget("orphan.ts", {
    sourceIds: ["a", "b"],
    multiSource: true,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /multi-source citation must start with a source id/);
  }
});

test("canonicalizeCitationTarget: real repo path sources/foo.ts is not stripped", () => {
  // id is "main", not "foo" — sources/ is a real directory under the repo.
  const r = canonicalizeCitationTarget("sources/foo.ts", {
    sourceIds: ["main"],
    multiSource: false,
  });
  assert.deepEqual(r, { ok: true, target: "sources/foo.ts" });
});

test("canonicalizeCitationTarget: nested real path sources/dir/file.ts is not stripped", () => {
  // id is "main", not "dir" — sources/dir/ is a real nested path under the repo.
  const r = canonicalizeCitationTarget("sources/dir/file.ts", {
    sourceIds: ["main"],
    multiSource: false,
  });
  assert.deepEqual(r, { ok: true, target: "sources/dir/file.ts" });
});

test("resolveCitationFile: nested real path sources/dir/file.ts against snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-cite-nested-src-"));
  const src = path.join(root, "repo");
  await mkdir(path.join(src, "sources", "dir"), { recursive: true });
  await writeFile(path.join(src, "sources", "dir", "file.ts"), "export {};\n", "utf8");
  const map = sourceRootMapFromSources([{ id: "main", path: src }]);
  const cites = parseSourceCitations("see [Source](repo:sources/dir/file.ts#L1)");
  // canonicalize must leave the real nested path intact
  const canon = canonicalizeCitationTarget(cites[0]!.target, {
    sourceIds: ["main"],
    multiSource: false,
  });
  assert.deepEqual(canon, { ok: true, target: "sources/dir/file.ts" });
  const resolved = resolveCitationFile(cites[0]!, map);
  assert.ok(resolved && !("error" in resolved));
  if (resolved && !("error" in resolved)) {
    assert.equal(resolved.relPath, "sources/dir/file.ts");
    assert.equal(resolved.sourceId, "main");
    assert.equal(resolved.absPath, path.resolve(src, "sources/dir/file.ts"));
  }
  assert.deepEqual(await validateCitationResolve(cites, "p.md", map), []);
});

test("canonicalizeCitationTarget: rejects escape and absolute", () => {
  assert.equal(
    canonicalizeCitationTarget("../etc/passwd", {
      sourceIds: ["main"],
      multiSource: false,
    }).ok,
    false,
  );
  assert.equal(
    canonicalizeCitationTarget("/abs/path", {
      sourceIds: ["main"],
      multiSource: false,
    }).ok,
    false,
  );
});

test("canonicalizeCitationTarget: empty after strip errors", () => {
  const r = canonicalizeCitationTarget("sources/ebase-2", {
    sourceIds: ["ebase-2"],
    multiSource: false,
  });
  assert.equal(r.ok, false);
});

test("formatRepoCitation preserves line fragments", () => {
  assert.equal(formatRepoCitation("pom.xml"), "[Source](repo:pom.xml)");
  assert.equal(formatRepoCitation("pom.xml", 1), "[Source](repo:pom.xml#L1)");
  assert.equal(formatRepoCitation("pom.xml", 1, 1), "[Source](repo:pom.xml#L1)");
  assert.equal(formatRepoCitation("pom.xml", 1, 3), "[Source](repo:pom.xml#L1-L3)");
});

test("canonicalizeCitationInContent rewrites mount-form citations", () => {
  const md =
    "A [Source](repo:sources/ebase-2/pom.xml#L1-L2) and [Source](repo:src/a.ts#L3).";
  const out = canonicalizeCitationInContent(md, {
    sourceIds: ["ebase-2"],
    multiSource: false,
  });
  assert.equal(out.changed, true);
  assert.equal(out.errors.length, 0);
  assert.equal(
    out.content,
    "A [Source](repo:pom.xml#L1-L2) and [Source](repo:src/a.ts#L3).",
  );
});

test("resolveCitationFile after canonicalize finds mount-form citation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-cite-mount-"));
  const src = path.join(root, "repo");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "pom.xml"), "<project/>\n", "utf8");
  const map = sourceRootMapFromSources([{ id: "ebase-2", path: src }]);
  const cites = parseSourceCitations("see [Source](repo:sources/ebase-2/pom.xml#L1)");
  const resolved = resolveCitationFile(cites[0]!, map);
  assert.ok(resolved && !("error" in resolved));
  if (resolved && !("error" in resolved)) {
    assert.equal(resolved.relPath, "pom.xml");
    assert.equal(resolved.sourceId, "ebase-2");
    assert.equal(resolved.absPath, path.resolve(src, "pom.xml"));
  }
  assert.deepEqual(await validateCitationResolve(cites, "p.md", map), []);
});

test("resolveCitationFile multi mount-form", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-cite-multi-"));
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  await writeFile(path.join(a, "x.ts"), "export {};\n", "utf8");
  const map = sourceRootMapFromSources([
    { id: "a", path: a },
    { id: "b", path: b },
  ]);
  const cites = parseSourceCitations("see [Source](repo:sources/a/x.ts#L1)");
  const resolved = resolveCitationFile(cites[0]!, map);
  assert.ok(resolved && !("error" in resolved));
  if (resolved && !("error" in resolved)) {
    assert.equal(resolved.relPath, "x.ts");
    assert.equal(resolved.sourceId, "a");
  }
});

test("validateCitationResolve: file + line bounds against snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-cite-"));
  const src = path.join(root, "repo");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "README.md"), "line1\nline2\nline3\n", "utf8");
  const map = sourceRootMapFromSources([{ id: "main", path: src }]);
  const ok = parseSourceCitations("see [Source](repo:README.md#L1-L2)");
  assert.deepEqual(await validateCitationResolve(ok, "p.md", map), []);
  const oob = parseSourceCitations("see [Source](repo:README.md#L1-L99)");
  const err = await validateCitationResolve(oob, "p.md", map);
  assert.ok(err.some((e) => e.includes("out of bounds")));
  const missing = parseSourceCitations("see [Source](repo:nope.ts#L1)");
  const err2 = await validateCitationResolve(missing, "p.md", map);
  assert.ok(err2.some((e) => e.includes("not found")));
});

test("validateWikiTree with sources requires resolvable citations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-cite-"));
  const src = path.join(root, "src");
  const wiki = path.join(root, "wiki");
  await mkdir(src, { recursive: true });
  await mkdir(wiki, { recursive: true });
  await writeFile(path.join(src, "README.md"), "# hi\n", "utf8");
  await writeFile(
    path.join(wiki, "overview.md"),
    "---\ntype: Overview\ntitle: Overview\n---\n\n# Overview\n\nBody without cite.\n",
    "utf8",
  );
  const fail = await validateWikiTree(wiki, {
    sources: [{ id: "main", path: src }],
  });
  assert.equal(fail.ok, false);
  assert.ok(fail.errors.some((e) => e.includes("missing Source Citation")));

  await writeFile(
    path.join(wiki, "overview.md"),
    "---\ntype: Overview\ntitle: Overview\n---\n\n# Overview\n\nNote [Source](repo:README.md#L1).\n",
    "utf8",
  );
  const pass = await validateWikiTree(wiki, {
    sources: [{ id: "main", path: src }],
  });
  assert.equal(pass.ok, true, pass.errors.join("; "));
  assert.equal(pass.citationCount, 1);
});

test("canonicalizeWikiTreeCitations rewrites a temp wiki dir", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-canon-"));
  await writeFile(
    path.join(root, "overview.md"),
    "Note [Source](repo:sources/main/README.md#L1).\n",
    "utf8",
  );
  await mkdir(path.join(root, "modules"), { recursive: true });
  await writeFile(
    path.join(root, "modules", "runtime.md"),
    "Also [Source](repo:sources/main/src/a.ts#L2-L4).\n",
    "utf8",
  );
  const result = await canonicalizeWikiTreeCitations(root, {
    sourceIds: ["main"],
    multiSource: false,
  });
  assert.equal(result.rewrittenPages, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(
    await readFile(path.join(root, "overview.md"), "utf8"),
    "Note [Source](repo:README.md#L1).\n",
  );
  assert.equal(
    await readFile(path.join(root, "modules", "runtime.md"), "utf8"),
    "Also [Source](repo:src/a.ts#L2-L4).\n",
  );
});
