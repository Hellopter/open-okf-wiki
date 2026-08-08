import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateWiki } from "../dist/validate.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-validate-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const answer = 42;\nexport default answer;\n");
  await mkdir(path.join(root, "wiki", "architecture"), { recursive: true });
  return root;
}

function page({ sources = ["src/index.ts#L1-L2"], body = "" } = {}) {
  return `---\ntype: concept\ntitle: Example\ndescription: Example documentation\nsources:\n${sources.map((source) => `  - ${source}`).join("\n")}\n---\n\n${body}`;
}

test("finalization rebuilds deterministic nested indexes and validates a source-grounded page", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "wiki", "overview.md"), page({ body: "[Source](repo:src/index.ts#L1-L1)\n[Architecture](./architecture/design.md)\n" }));
  await writeFile(path.join(root, "wiki", "architecture", "design.md"), page({ body: "```mermaid\nflowchart TD\n  A --> B\n```\n" }));

  const result = await validateWiki(root);

  assert.deepEqual(result, { ok: true, errors: [], pages: ["architecture/design.md", "overview.md"] });
  assert.equal(
    await readFile(path.join(root, "wiki", "index.md"), "utf8"),
    "# Wiki\n\n## Directories\n\n- [architecture/](./architecture/index.md)\n\n## Pages\n\n- [overview](./overview.md)\n",
  );
  assert.equal(
    await readFile(path.join(root, "wiki", "architecture", "index.md"), "utf8"),
    "# architecture\n\n## Pages\n\n- [design](./design.md)\n",
  );
});

test("rejects malformed frontmatter and invalid workspace source ranges", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "wiki", "invalid.md"), "---\ntype: \ntitle: Example\ndescription: 1\nsources: [../src/index.ts#L1-L1, src/index.ts#L8-L2, src/index.ts#L3-L3, src/missing.ts#L1-L1]\n---\n");

  const result = await validateWiki(root);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "invalid.md: frontmatter requires a non-empty type",
    "invalid.md: frontmatter requires a non-empty description",
    "invalid.md: frontmatter source must be workspace-relative with #Lx-Ly: ../src/index.ts#L1-L1",
    "invalid.md: frontmatter source has an invalid line range: src/index.ts#L8-L2",
    "invalid.md: frontmatter source line range exceeds file: src/index.ts#L3-L3",
    "invalid.md: frontmatter source file is missing: src/missing.ts#L1-L1",
  ]);
});

test("rejects invalid repo citations, escaping Wiki links, missing links, and unsafe Mermaid", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "wiki", "invalid.md"), page({ body: [
    "[Bad repo](repo:../src/index.ts#L1-L1)",
    "[Malformed repo](repo:src/index.ts)",
    "[Escape](../README.md)",
    "[Missing](./missing.md)",
    "```mermaid",
    "flowchart TD",
    "  A --> end",
    "```",
    "```mermaid",
    "flowchart TD",
    "  click A call launch()",
    "```",
    "```mermaid",
    "flowchart TD",
  ].join("\n") }));

  const result = await validateWiki(root);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "invalid.md: Mermaid fence on line 6 is invalid: flowchart uses reserved word `end` as a node id",
    "invalid.md: Mermaid fence on line 10 is invalid: interactive Mermaid callbacks are not allowed",
    "invalid.md: Mermaid fence opened on line 14 is not closed",
    "invalid.md: repo citation must be repo:<workspace-relative-path>#Lx-Ly: repo:../src/index.ts#L1-L1",
    "invalid.md: repo citation must be repo:<workspace-relative-path>#Lx-Ly: repo:src/index.ts",
    "invalid.md: internal Markdown link escapes wiki/: ../README.md",
    "invalid.md: internal Markdown link target is missing: ./missing.md",
  ]);
});

test("only finalizes the fixed wiki output directory and rejects a linked Wiki root", async () => {
  const root = await fixture();
  const fixed = await validateWiki(root, "documentation");
  assert.deepEqual(fixed, {
    ok: false,
    errors: ["Wiki output is fixed at workspace-relative wiki/"],
    pages: [],
  });

  const linkedRoot = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-linked-root-"));
  await mkdir(path.join(linkedRoot, "outside"));
  await symlink(path.join(linkedRoot, "outside"), path.join(linkedRoot, "wiki"), "dir");
  const linked = await validateWiki(linkedRoot);
  assert.deepEqual(linked, {
    ok: false,
    errors: ["wiki directory must not be a symbolic link"],
    pages: [],
  });
  await assert.rejects(readFile(path.join(linkedRoot, "outside", "index.md"), "utf8"));
});

test("does not follow sources out of the workspace through symbolic links", async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-outside-source-"));
  await writeFile(path.join(outside, "external.ts"), "export const external = true;\n");
  await symlink(path.join(outside, "external.ts"), path.join(root, "src", "linked.ts"), "file");
  await writeFile(path.join(root, "wiki", "linked.md"), page({ sources: ["src/linked.ts#L1-L1"] }));

  const result = await validateWiki(root);

  assert.deepEqual(result.errors, [
    "linked.md: frontmatter source resolves outside the workspace: src/linked.ts#L1-L1",
  ]);
});

test("validates reference links while ignoring Markdown links in fenced and inline code", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "wiki", "target.md"), page());
  await writeFile(path.join(root, "wiki", "references.md"), page({ body: [
    "[Source][code]",
    "[Target][target]",
    "[code]: repo:src/index.ts#L1-L1",
    "[target]: ./target.md",
    "",
    "`[Ignored inline](repo:src/missing.ts#L1-L1)`",
    "```markdown",
    "[Ignored fence](repo:src/missing.ts#L1-L1)",
    "[Ignored link](./missing.md)",
    "[ignored]: repo:src/missing.ts#L1-L1",
    "```",
  ].join("\n") }));

  const result = await validateWiki(root);

  assert.deepEqual(result, { ok: true, errors: [], pages: ["references.md", "target.md"] });
});
