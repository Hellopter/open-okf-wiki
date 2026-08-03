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

test("validateWikiTree fails when Spec critical page is missing", async () => {
  const root = await tempDir("okf-val-critical-");
  await writeMd(root, "overview.md", goodPage("Overview", "Hello.", "Overview"));
  await writeMd(root, "index.md", listingIndex);
  const result = await validateWikiTree(root, {
    requiredPages: [
      { path: "overview.md", critical: true },
      { path: "modules/missing.md", critical: true },
      { path: "optional.md", critical: false },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /critical page missing: modules\/missing\.md/);
  assert.equal(
    result.errors.some((e) => e.includes("optional.md")),
    false,
  );
});

test("validateWikiTree accepts when all critical pages exist", async () => {
  const root = await tempDir("okf-val-critical-ok-");
  await writeMd(root, "overview.md", goodPage("Overview", "Hello.", "Overview"));
  await writeMd(root, "modules/core.md", goodPage("Core", "Hello.", "Module"));
  await writeMd(root, "index.md", listingIndex);
  const result = await validateWikiTree(root, {
    requiredPages: [
      { path: "overview.md" }, // critical defaults true
      { path: "modules/core.md", critical: true },
    ],
  });
  assert.equal(result.ok, true, result.errors.join("; "));
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

test("validateWikiTree rejects missing SOURCE_COVERAGE when coveragePlan provided", async () => {
  const wiki = await tempDir("okf-val-src-cov-");
  const apiSrc = await tempDir("okf-val-api-src-");
  const webSrc = await tempDir("okf-val-web-src-");
  await writeFile(path.join(apiSrc, "main.go"), "package main\n");
  await writeFile(path.join(webSrc, "index.ts"), "export {};\n");

  // Only cites api — web source unit is missing.
  await writeMd(
    wiki,
    "overview.md",
    `---\ntype: Overview\ntitle: Overview\n---\n\nBody [Source](repo:api/main.go#L1).\n`,
  );
  await writeMd(wiki, "index.md", listingIndex);

  const result = await validateWikiTree(wiki, {
    sources: [
      { id: "api", path: apiSrc },
      { id: "web", path: webSrc },
    ],
    coveragePlan: {
      version: 1,
      requiredUnits: [
        { id: "api", kind: "source", sourceId: "api" },
        { id: "web", kind: "source", sourceId: "web" },
      ],
      cancelled: [],
      lightPath: false,
      reasons: [],
      maxSurfacesRequired: 12,
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /SOURCE_COVERAGE:.*\bweb\b/);
  assert.equal(
    result.errors.some((e) => e.includes('"api"') && e.includes("no page covers")),
    false,
    "api should be covered by overview citation",
  );
});

test("validateWikiTree accepts coveragePlan when all source units are cited", async () => {
  const wiki = await tempDir("okf-val-src-cov-ok-");
  const apiSrc = await tempDir("okf-val-api2-");
  const webSrc = await tempDir("okf-val-web2-");
  await writeFile(path.join(apiSrc, "main.go"), "package main\n");
  await writeFile(path.join(webSrc, "index.ts"), "export {};\n");

  await writeMd(
    wiki,
    "overview.md",
    `---\ntype: Overview\ntitle: Overview\n---\n\n[Source](repo:api/main.go#L1) [Source](repo:web/index.ts#L1).\n`,
  );
  await writeMd(wiki, "index.md", listingIndex);

  const result = await validateWikiTree(wiki, {
    sources: [
      { id: "api", path: apiSrc },
      { id: "web", path: webSrc },
    ],
    coveragePlan: {
      requiredUnits: [
        { id: "api", kind: "source", sourceId: "api" },
        { id: "web", kind: "source", sourceId: "web" },
      ],
    },
  });
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("validateWikiTree rejects SURFACE_COVERAGE for unbound surface unit", async () => {
  const wiki = await tempDir("okf-val-surf-");
  const src = await tempDir("okf-val-surf-src-");
  await mkdir(path.join(src, "packages/core"), { recursive: true });
  await writeFile(path.join(src, "packages/core/index.ts"), "export {};\n");
  await writeFile(path.join(src, "README.md"), "# r\n");

  await writeMd(
    wiki,
    "overview.md",
    `---\ntype: Overview\ntitle: Overview\n---\n\nOnly root [Source](repo:README.md#L1).\n`,
  );
  await writeMd(wiki, "index.md", listingIndex);

  const result = await validateWikiTree(wiki, {
    sources: [{ id: "mono", path: src }],
    coveragePlan: {
      requiredUnits: [
        {
          id: "mono::packages/core",
          kind: "surface",
          sourceId: "mono",
          path: "packages/core",
        },
      ],
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /SURFACE_COVERAGE:.*mono::packages\/core/);
});

test("validateWikiTree enforces coverageObligations page binding", async () => {
  const wiki = await tempDir("okf-val-ob-");
  const src = await tempDir("okf-val-ob-src-");
  await writeFile(path.join(src, "lib.ts"), "export {};\n");

  await writeMd(
    wiki,
    "overview.md",
    `---\ntype: Overview\ntitle: Overview\n---\n\n[Source](repo:lib.ts#L1).\n`,
  );
  await writeMd(wiki, "index.md", listingIndex);

  const missingPage = await validateWikiTree(wiki, {
    sources: [{ id: "main", path: src }],
    requireCitations: true,
    coverageObligations: [{ unitId: "main", pagePath: "modules/main.md" }],
  });
  assert.equal(missingPage.ok, false);
  assert.match(missingPage.errors.join("; "), /SOURCE_COVERAGE:.*modules\/main\.md/);

  await writeMd(
    wiki,
    "modules/main.md",
    `---\ntype: Module\ntitle: Main\n---\n\n[Source](repo:lib.ts#L1).\n`,
  );
  const ok = await validateWikiTree(wiki, {
    sources: [{ id: "main", path: src }],
    requireCitations: true,
    coverageObligations: [{ unitId: "main", pagePath: "modules/main.md" }],
  });
  assert.equal(ok.ok, true, ok.errors.join("; "));
});

test("validateWikiTree CROSS_SOURCE_FLOW requires ≥2 source ids on Flow pages", async () => {
  const wiki = await tempDir("okf-val-flow-");
  const apiSrc = await tempDir("okf-val-flow-api-");
  const webSrc = await tempDir("okf-val-flow-web-");
  await writeFile(path.join(apiSrc, "handler.go"), "package api\n");
  await writeFile(path.join(webSrc, "client.ts"), "export {};\n");

  await writeMd(
    wiki,
    "overview.md",
    `---\ntype: Overview\ntitle: Overview\n---\n\n[Source](repo:api/handler.go#L1) [Source](repo:web/client.ts#L1).\n`,
  );
  // Flow only cites one source → fail.
  await writeMd(
    wiki,
    "flows/checkout.md",
    `---\ntype: Flow\ntitle: Checkout\n---\n\nPath [Source](repo:api/handler.go#L1).\n`,
  );
  await writeMd(wiki, "index.md", listingIndex);

  const bad = await validateWikiTree(wiki, {
    sources: [
      { id: "api", path: apiSrc },
      { id: "web", path: webSrc },
    ],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("; "), /CROSS_SOURCE_FLOW:.*flows\/checkout\.md/);

  await writeMd(
    wiki,
    "flows/checkout.md",
    `---\ntype: Flow\ntitle: Checkout\n---\n\n[Source](repo:api/handler.go#L1) then [Source](repo:web/client.ts#L1).\n`,
  );
  const good = await validateWikiTree(wiki, {
    sources: [
      { id: "api", path: apiSrc },
      { id: "web", path: webSrc },
    ],
  });
  assert.equal(good.ok, true, good.errors.join("; "));
});

