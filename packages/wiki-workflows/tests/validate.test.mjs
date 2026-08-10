import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeWiki, validateWiki } from "../dist/validate.js";

const temporaryDirectories = [];

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-validate-"));
  temporaryDirectories.push(root);
  const source = path.join(root, "api");
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "src", "index.ts"), "export const answer = 42;\nexport default answer;\n");
  git(source, "init", "--quiet");
  await writeFile(path.join(root, "workspace.yaml"), [
    "version: 1",
    "language: zh",
    "defaultSourceIgnores: true",
    "sources:",
    "  - path: api",
    "    origin:",
    "      type: clone",
    "      remoteUrl: https://example.test/api.git",
    "",
  ].join("\n"));
  await mkdir(path.join(root, "wiki"), { recursive: true });
  return root;
}

function spec({ pages, crossLinks = [] } = {}) {
  const selected = pages ?? [
    { path: "overview/overview.md", pageType: "overview", researchScopeIds: [] },
    { path: "architecture/design.md", pageType: "architecture", researchScopeIds: ["api"] },
  ];
  return {
    domains: selected.map((selectedPage) => ({
      id: selectedPage.path.split("/", 1)[0],
      title: selectedPage.path,
      purpose: "Document the target",
      pages: [{
        pageType: selectedPage.pageType,
        path: selectedPage.path,
        title: selectedPage.path,
        purpose: "Document the target",
        researchScopeIds: selectedPage.researchScopeIds,
      }],
    })),
    crossLinks,
    sharedTerms: [],
  };
}

function page({ sources = ["api/src/index.ts#L1-L2"], body = "" } = {}) {
  return `---\ntype: concept\ntitle: Example\ndescription: Example documentation\ntags:\n  - documentation\nsources:\n${sources.map((source) => `  - ${source}`).join("\n")}\n---\n\n${body}`;
}

async function writePage(root, relative, content = page()) {
  const absolute = path.join(root, "wiki", ...relative.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("validation is read-only and checks only Spec pages plus derived indexes", async () => {
  const root = await fixture();
  const target = spec({
    crossLinks: [{
      fromPath: "overview/overview.md",
      toPath: "architecture/design.md",
      purpose: "Connect overview to architecture",
    }],
  });
  await writePage(root, "overview/overview.md", page({
    body: "[Source](repo:api/src/index.ts#L1-L1)\n[Architecture](../architecture/design.md)\n[Architecture index](../architecture/index.md)\n",
  }));
  await writePage(root, "architecture/design.md", page({ body: "```mermaid\nflowchart TD\n  A --> B\n```\n" }));
  await writePage(root, "legacy.md");

  assert.deepEqual(await validateWiki(root, target), {
    ok: true,
    issues: [],
    pages: ["architecture/design.md", "overview/overview.md"],
    obsoletePages: ["legacy.md"],
  });
  await assert.rejects(readFile(path.join(root, "wiki", "index.md"), "utf8"));
});

test("uses the Mermaid parser and rejects interactive or unsafe diagrams", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md");

  const cases = [
    ["flowchart TD\n  A --", "syntax error"],
    ["flowchart TD\n  A[Safe]\n  click A callback", "interactive Mermaid click actions are not allowed"],
    ["flowchart TD\n  A[\"javascript&#58;alert(1)\"]", "diagram contains an unsafe URL"],
    ["flowchart TD\n  A[bad; label]", "diagram contains a semicolon inside a label"],
  ];
  for (const [diagram, expected] of cases) {
    await writePage(root, "architecture/design.md", page({ body: `\`\`\`mermaid\n${diagram}\n\`\`\`\n` }));
    const result = await validateWiki(root, target);
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues, [{
      code: "mermaid",
      page: "architecture/design.md",
      message: `Mermaid fence on line 2 is invalid: ${expected}`,
    }]);
  }

  await writePage(root, "architecture/design.md", page({ body: "```mermaid\nflowchart TD\n  A --> B\n```\n" }));
  assert.deepEqual((await validateWiki(root, target)).issues, []);
});

test("an obsolete physical page cannot make a target Wiki link pass", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md", page({ body: "[Legacy](../legacy.md)\n" }));
  await writePage(root, "architecture/design.md");
  await writePage(root, "legacy.md");

  const result = await validateWiki(root, target);

  assert.equal(result.ok, false);
  assert.deepEqual(result.obsoletePages, ["legacy.md"]);
  assert.deepEqual(result.issues, [{
    code: "internal-link",
    page: "overview/overview.md",
    message: "Internal Markdown link target is not in the target Wiki: ../legacy.md",
  }]);
});

test("frontmatter tags are optional but validated when present", async () => {
  const root = await fixture();
  const target = spec();
  const withoutTags = page().replace("tags:\n  - documentation\n", "");
  await writePage(root, "overview/overview.md", withoutTags);
  await writePage(root, "architecture/design.md", withoutTags);

  assert.deepEqual((await validateWiki(root, target)).issues, []);

  await writePage(root, "architecture/design.md", page().replace("tags:\n  - documentation", "tags: []"));
  assert.deepEqual((await validateWiki(root, target)).issues, [{
    code: "frontmatter",
    page: "architecture/design.md",
    message: "Frontmatter tags must be a non-empty string array",
  }]);
});

test("returns precisely routed issues for missing pages, frontmatter, evidence, cross-links, and Mermaid", async () => {
  const root = await fixture();
  const target = spec({
    pages: [
      { path: "overview/overview.md", pageType: "overview", researchScopeIds: [] },
      { path: "core/broken.md", pageType: "concept", researchScopeIds: ["api"] },
      { path: "core/missing.md", pageType: "module", researchScopeIds: ["api"] },
    ],
    crossLinks: [{ fromPath: "overview/overview.md", toPath: "core/broken.md", purpose: "Required navigation" }],
  });
  await writePage(root, "overview/overview.md");
  await writePage(root, "core/broken.md", [
    "---",
    "type: concept",
    "title: Broken",
    "description: 1",
    "tags: [documentation, 2]",
    "sources: [api/src/index.ts#L3-L3]",
    "---",
    "",
    "```mermaid",
    "flowchart TD",
    "  A --> end",
    "```",
    "[Missing](./not-planned.md)",
  ].join("\n"));

  const result = await validateWiki(root, target);

  assert.equal(result.ok, false);
  assert.deepEqual(result.pages, ["core/broken.md", "overview/overview.md"]);
  assert.deepEqual(result.issues, [
    { code: "frontmatter", page: "core/broken.md", message: "Frontmatter requires a non-empty description" },
    { code: "frontmatter", page: "core/broken.md", message: "Frontmatter tags must be a non-empty string array" },
    { code: "source-reference", page: "core/broken.md", message: "frontmatter source line range exceeds file: api/src/index.ts#L3-L3" },
    { code: "mermaid", page: "core/broken.md", message: "Mermaid fence on line 2 is invalid: flowchart uses reserved word `end` as a node id" },
    { code: "internal-link", page: "core/broken.md", message: "Internal Markdown link target is not in the target Wiki: ./not-planned.md" },
    { code: "missing-page", page: "core/missing.md", message: "Target page is missing: core/missing.md" },
    { code: "cross-link", page: "overview/overview.md", message: "Declared cross-link is missing: overview/overview.md -> core/broken.md" },
  ]);
});

test("finalization removes obsolete Markdown, rebuilds exact indexes, and preserves assets", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md", page({ body: "[Architecture](../architecture/design.md)\n" }));
  await writePage(root, "architecture/design.md");
  await writePage(root, "removed/old.md");
  await writePage(root, ".legacy.md");
  await writeFile(path.join(root, "wiki", "index.md"), "stale\n");
  await writeFile(path.join(root, "wiki", "architecture", "index.md"), "stale\n");
  await writeFile(path.join(root, "wiki", "removed", "diagram.png"), "asset\n");
  await writeFile(path.join(root, "wiki", ".asset"), "hidden asset\n");

  const result = await finalizeWiki(root, target);

  assert.deepEqual(result, {
    pages: ["architecture/design.md", "overview/overview.md"],
    obsoletePages: [".legacy.md", "removed/old.md"],
    removedPages: [".legacy.md", "removed/old.md"],
    rebuiltIndexes: ["architecture/index.md", "index.md", "overview/index.md"],
  });
  assert.equal(await readFile(path.join(root, "wiki", "removed", "diagram.png"), "utf8"), "asset\n");
  assert.equal(await readFile(path.join(root, "wiki", ".asset"), "utf8"), "hidden asset\n");
  await assert.rejects(readFile(path.join(root, "wiki", ".legacy.md"), "utf8"));
  await assert.rejects(readFile(path.join(root, "wiki", "removed", "old.md"), "utf8"));
  assert.equal(
    await readFile(path.join(root, "wiki", "index.md"), "utf8"),
    "# Wiki\n\n## Directories\n\n- [architecture/](./architecture/index.md)\n- [overview/](./overview/index.md)\n",
  );
  assert.equal(
    await readFile(path.join(root, "wiki", "architecture", "index.md"), "utf8"),
    "# architecture\n\n## Pages\n\n- [design](./design.md)\n",
  );
});

test("finalization is idempotent", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md");
  await writePage(root, "architecture/design.md");

  await finalizeWiki(root, target);
  const firstIndex = await readFile(path.join(root, "wiki", "index.md"), "utf8");
  const second = await finalizeWiki(root, target);

  assert.deepEqual(second.obsoletePages, []);
  assert.deepEqual(second.removedPages, []);
  assert.equal(await readFile(path.join(root, "wiki", "index.md"), "utf8"), firstIndex);
});

test("failed validation performs no deletion", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md", "invalid page");
  await writePage(root, "architecture/design.md");
  await writePage(root, "obsolete.md");
  await writeFile(path.join(root, "wiki", "index.md"), "stale\n");

  await assert.rejects(finalizeWiki(root, target), /requires a valid target Wiki/);

  assert.equal(await readFile(path.join(root, "wiki", "obsolete.md"), "utf8"), page());
  assert.equal(await readFile(path.join(root, "wiki", "index.md"), "utf8"), "stale\n");
});

test("finalizer refuses Wiki symlinks before deleting obsolete pages", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md");
  await writePage(root, "architecture/design.md");
  await writePage(root, "obsolete.md");
  const outside = path.join(root, "outside.md");
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(root, "wiki", "linked.md"), "file");

  const validation = await validateWiki(root, target);
  assert.deepEqual(validation.issues, [{ code: "wiki-safety", message: "Wiki tree must not contain symbolic links: linked.md" }]);
  await assert.rejects(finalizeWiki(root, target), /must not contain symbolic links/);
  assert.equal(await readFile(path.join(root, "wiki", "obsolete.md"), "utf8"), page());
  assert.equal(await readFile(outside, "utf8"), "outside\n");
});

test("a partially failed finalization can be retried", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md");
  await writePage(root, "architecture/design.md");
  await mkdir(path.join(root, "wiki", "overview", "index.md"));
  await writeFile(path.join(root, "wiki", "overview", "index.md", "asset.txt"), "collision\n");

  await assert.rejects(finalizeWiki(root, target), /unexpected Wiki entry/);
  await rm(path.join(root, "wiki", "overview", "index.md"), { recursive: true });

  const result = await finalizeWiki(root, target);
  assert.deepEqual(result.pages, ["architecture/design.md", "overview/overview.md"]);
  assert.equal(await readFile(path.join(root, "wiki", "overview", "index.md"), "utf8"), "# overview\n\n## Pages\n\n- [overview](./overview.md)\n");
});

test("rejects unsafe Spec paths without touching the Wiki tree", async () => {
  const root = await fixture();
  const target = spec({ pages: [{ path: "../escape.md", pageType: "concept", researchScopeIds: ["api"] }] });

  assert.deepEqual(await validateWiki(root, target), {
    ok: false,
    issues: [{ code: "spec-page", message: "Spec contains an unsafe or reserved page path: ../escape.md" }],
    pages: [],
    obsoletePages: [],
  });
  await assert.rejects(finalizeWiki(root, target), /unsafe or reserved page path/);
});

test("rejects index-injection Spec paths before finalization writes an index", async () => {
  for (const unsafePath of [
    "core/a](javascript:alert(1)).md",
    "core/page\n- [injected](javascript:alert(1)).md",
  ]) {
    const root = await fixture();
    const target = spec({ pages: [{ path: unsafePath, pageType: "concept", researchScopeIds: ["api"] }] });

    const validation = await validateWiki(root, target);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues[0].code, "spec-page");
    await assert.rejects(finalizeWiki(root, target), /unsafe or reserved page path/);
    await assert.rejects(readFile(path.join(root, "wiki", "index.md"), "utf8"));
  }
});
