import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateWikiTree, WIKI_VALIDATE_MAX_FILE_BYTES } from "./validate-wiki.js";
import {
  isReservedWikiPath,
  parseWikiFrontmatter,
  splitWikiFrontmatter,
  wikiMarkdownBody,
} from "./wiki-tree.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeMd(root: string, rel: string, body: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
}

const goodPage = (title: string, body = "Hello.", type = "Concept") =>
  `---\ntype: ${type}\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;

const listingIndex = `# Pages

* [Overview](overview.md) - Repository overview
`;

test("parseWikiFrontmatter accepts quoted and plain titles", () => {
  assert.equal(parseWikiFrontmatter("---\ntitle: Hello\n---\n\n# H\n")?.values.title, "Hello");
  assert.equal(
    parseWikiFrontmatter('---\ntitle: "Quoted Title"\n---\n\nx\n')?.values.title,
    "Quoted Title",
  );
  assert.equal(
    parseWikiFrontmatter("---\ntitle: 'Also Fine'\n---\n\nx\n")?.values.title,
    "Also Fine",
  );
});

test("parseWikiFrontmatter rejects missing or empty title", () => {
  assert.equal(parseWikiFrontmatter("# No frontmatter\n"), null);
  assert.equal(parseWikiFrontmatter("---\nfoo: bar\n---\n\nx\n")?.values.title, undefined);
  assert.equal(parseWikiFrontmatter("---\ntitle:\n---\n\nx\n")?.values.title, undefined);
  assert.equal(parseWikiFrontmatter("---\ntitle:   \n---\n\nx\n")?.values.title, undefined);
  assert.equal(parseWikiFrontmatter('---\ntitle: ""\n---\n\nx\n')?.values.title, undefined);
});

test("parseWikiFrontmatter exposes concept type and title once", () => {
  assert.deepEqual(parseWikiFrontmatter("---\ntype: Overview\ntitle: X\n---\n")?.values, {
    type: "Overview",
    title: "X",
  });
  assert.equal(parseWikiFrontmatter("---\ntitle: X\n---\n")?.values.type, undefined);
  assert.equal(isReservedWikiPath("index.md"), true);
  assert.equal(isReservedWikiPath("modules/index.md"), true);
  assert.equal(isReservedWikiPath("log.md"), true);
  assert.equal(isReservedWikiPath("overview.md"), false);
});

test("splitWikiFrontmatter returns null without a frontmatter block", () => {
  assert.equal(splitWikiFrontmatter("# No frontmatter\n"), null);
  assert.equal(splitWikiFrontmatter("---\nno closing fence\n"), null);
  assert.equal(wikiMarkdownBody("# Body only\n"), "# Body only\n");
});

test("splitWikiFrontmatter handles BOM, CRLF, and spaced closing fences", () => {
  const bom = String.fromCharCode(0xfeff);
  const withBom = `${bom}---\ntitle: BomPage\n---\n\n# H\n`;
  const bomSplit = splitWikiFrontmatter(withBom);
  assert.equal(bomSplit?.bom, bom);
  assert.equal(bomSplit?.values.title, "BomPage");
  assert.equal(bomSplit?.inner, "title: BomPage");
  assert.equal(bomSplit?.rest, "\n\n# H\n");
  assert.equal(wikiMarkdownBody(withBom), "\n# H\n");

  const crlf = "---\r\ntitle: Crlf\r\n---\r\n\r\nBody\r\n";
  const crlfSplit = splitWikiFrontmatter(crlf);
  assert.equal(crlfSplit?.values.title, "Crlf");
  assert.equal(crlfSplit?.inner, "title: Crlf");
  assert.equal(wikiMarkdownBody(crlf), "\r\nBody\r\n");

  const spacedClose = "---\ntitle: Spaced\n---  \n\nAfter\n";
  const spaced = splitWikiFrontmatter(spacedClose);
  assert.equal(spaced?.values.title, "Spaced");
  assert.equal(wikiMarkdownBody(spacedClose), "\nAfter\n");

  const tabClose = "---\ntitle: Tabbed\n---\t\nBody\n";
  assert.equal(splitWikiFrontmatter(tabClose)?.values.title, "Tabbed");
  assert.equal(wikiMarkdownBody(tabClose), "Body\n");

  // Close fence must be alone on its line; `---Body` is not a fence.
  assert.equal(splitWikiFrontmatter("---\ntitle: Tight\n---Body\n"), null);

  // Close fence at EOF (no trailing newline) still parses; rest may be empty.
  const eofClose = "---\ntitle: Eof\n---";
  assert.equal(splitWikiFrontmatter(eofClose)?.values.title, "Eof");
  assert.equal(splitWikiFrontmatter(eofClose)?.rest, "");
  assert.equal(wikiMarkdownBody(eofClose), "");

  // Body immediately after the close line's newline (no blank line).
  const noBlank = "---\ntitle: Tight\n---\nBody\n";
  assert.equal(splitWikiFrontmatter(noBlank)?.rest, "\nBody\n");
  assert.equal(wikiMarkdownBody(noBlank), "Body\n");

  // Empty frontmatter block.
  const empty = "---\n---\n# H\n";
  assert.equal(splitWikiFrontmatter(empty)?.inner, "");
  assert.equal(splitWikiFrontmatter(empty)?.rest, "\n# H\n");
  assert.equal(wikiMarkdownBody(empty), "# H\n");
});

test("parseWikiFrontmatter is a projection of splitWikiFrontmatter", () => {
  const content = "---\ntype: Overview\ntitle: X\n---\n\n# X\n";
  const split = splitWikiFrontmatter(content)!;
  const parsed = parseWikiFrontmatter(content)!;
  assert.equal(parsed.body, split.inner);
  assert.deepEqual(parsed.values, split.values);
});

test("validateWikiTree accepts a minimal valid tree", async () => {
  const root = await tempDir("okf-val-ok-");
  await writeMd(root, "overview.md", goodPage("Overview", "Hello.", "Overview"));
  await writeMd(root, "modules/core.md", goodPage("Core", "Hello.", "Module"));
  await writeMd(root, "index.md", listingIndex);
  const result = await validateWikiTree(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.pageCount, 3);
});

test("validateWikiTree warns (non-blocking) on missing description", async () => {
  const root = await tempDir("okf-val-desc-");
  await writeMd(root, "overview.md", goodPage("Overview", "Hello.", "Overview"));
  await writeMd(
    root,
    "modules/core.md",
    "---\ntype: Module\ntitle: Core\ndescription: One line.\n---\n\nBody.\n",
  );
  await writeMd(root, "index.md", listingIndex);
  const result = await validateWikiTree(root);
  // Missing description never blocks (OKF permissive conformance)…
  assert.equal(result.ok, true, result.errors.join("; "));
  // …but is surfaced for exactly the pages lacking it (index.md exempt).
  assert.deepEqual(result.warnings, [
    "overview.md: missing frontmatter description (OKF v0.2 recommended)",
  ]);
});

test("validateWikiTree rejects concept page without type", async () => {
  const root = await tempDir("okf-val-type-");
  await writeMd(root, "overview.md", "---\ntitle: Overview\n---\n\n# Overview\n\nBody.\n");
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /type/i);
});

test("validateWikiTree exempts index.md from title/type and citations", async () => {
  const root = await tempDir("okf-val-idx-");
  await writeMd(
    root,
    "overview.md",
    goodPage("Overview", "Note [Source](repo:README.md#L1).", "Overview"),
  );
  await writeMd(root, "index.md", listingIndex);
  // Sources supplied → concept pages need citations; index does not.
  const srcRoot = await tempDir("okf-val-src-");
  await writeFile(path.join(srcRoot, "README.md"), "# R\n");
  const result = await validateWikiTree(root, {
    sources: [{ id: "main", path: srcRoot }],
  });
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("validateWikiTree rejects relative path", async () => {
  const result = await validateWikiTree("relative/wiki");
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /absolute/);
});

test("validateWikiTree rejects missing directory", async () => {
  const root = await tempDir("okf-val-missing-");
  const result = await validateWikiTree(path.join(root, "nope"));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /does not exist/);
});

test("validateWikiTree rejects tree with no markdown", async () => {
  const root = await tempDir("okf-val-empty-");
  await writeFile(path.join(root, "notes.txt"), "x\n");
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /no markdown/);
});

test("validateWikiTree rejects md without frontmatter title", async () => {
  const root = await tempDir("okf-val-fm-");
  await writeMd(root, "bad.md", "# Just a heading\n\nNo frontmatter.\n");
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /frontmatter|title/i);
});

test("validateWikiTree rejects symlink entries inside tree", async () => {
  const root = await tempDir("okf-val-sym-");
  await writeMd(root, "ok.md", goodPage("Ok"));
  const target = path.join(root, "ok.md");
  const link = path.join(root, "link.md");
  try {
    await symlink(target, link);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
      return;
    }
    throw error;
  }
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /symlink/i);
});

test("validateWikiTree rejects oversized file", async () => {
  const root = await tempDir("okf-val-size-");
  const big = "x".repeat(WIKI_VALIDATE_MAX_FILE_BYTES + 10);
  await writeMd(root, "huge.md", `---\ntype: Concept\ntitle: Huge\n---\n\n${big}\n`);
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /max file size/i);
});
