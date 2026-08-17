import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePage } from "../dist/frontmatter.js";
import {
  canonicalizeWikiPageContent,
  validateWiki,
  validateWikiPage,
  validateWikiPageContent,
} from "../dist/lead/validate.js";
import { materializeWikiIndexes } from "../dist/lead/indexes.js";
import { finalizeWiki, materializeValidatedWikiIndexes } from "../dist/lead/finalize.js";

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

function spec(pages) {
  return { pages: pages ?? ["overview.md", "architecture.md", "api/source.md", "api/core/domain.md"] };
}

async function writeSpecPages(root, target, contents = {}) {
  for (const relative of target.pages) {
    await writePage(root, relative, contents[relative]);
  }
}

function page({
  type = "__AUTO__",
  title = "Example",
  description = "Example documentation",
  sources = [{ id: "api-index", resource: "repo:api/src/index.ts#L1-L2" }],
  body = "",
} = {}) {
  const citations = sources
    .filter((source) => source?.id && source?.resource)
    .map((source) => `Evidence.[^${source.id}]\n\n[^${source.id}]: [Source](${source.resource})`)
    .join("\n\n");
  return `---\ntype: ${type}\ntitle: ${title}\ndescription: ${description}\ntags:\n  - documentation\nsources:\n${sources.map((source) => `  - id: ${source.id}\n    resource: ${source.resource}`).join("\n")}\n---\n\n${body}${body && citations ? "\n" : ""}${citations}\n`;
}

async function writePage(root, relative, content = page()) {
  const absolute = path.join(root, "wiki", ...relative.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content.replace("type: __AUTO__", `type: ${expectedPageType(relative)}`));
}

function expectedPageType(relative) {
  if (relative === "overview.md") return "Overview";
  if (relative === "architecture.md") return "Architecture";
  const filename = relative.split("/").at(-1);
  if (filename === "source.md") return "Source";
  if (filename === "domain.md") return "Domain";
  if (filename === "concept.md") return "Concept";
  if (filename === "flows.md" || filename === "sequences.md") return "Flow";
  if (filename === "states.md") return "State";
  if (filename === "data.md" || filename === "models.md") return "Data";
  if (filename === "modules.md") return "Module";
  if (relative.split("/").includes("models")) return "Data";
  if (relative.split("/").includes("flows")) return "Flow";
  if (relative.split("/").includes("modules")) return "Module";
  return "Concept";
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("validation is read-only and checks the materialized OKF index projection", async () => {
  const root = await fixture();
  const target = spec();
  await writeSpecPages(root, target, {
    "overview.md": page({
      body: "[Architecture](./architecture.md)\n[Core index](./api/core/index.md)\n",
    }),
    "architecture.md": page({ body: "```mermaid\nflowchart TD\n  A --> B\n```\n" }),
    "api/source.md": page(),
    "api/core/domain.md": page(),
  });
  await writePage(root, "legacy.md");
  await materializeWikiIndexes(root, target);
  const indexBefore = await readFile(path.join(root, "wiki", "index.md"), "utf8");

  assert.deepEqual(await validateWiki(root, target), {
    ok: true,
    issues: [],
    pages: ["api/core/domain.md", "api/source.md", "architecture.md", "overview.md"],
    obsoletePages: ["legacy.md"],
  });
  assert.equal(await readFile(path.join(root, "wiki", "index.md"), "utf8"), indexBefore);

  await writeFile(path.join(root, "wiki", "index.md"), "# stale\n");
  assert.deepEqual((await validateWiki(root, target)).issues, [{
    code: "wiki-index",
    page: "index.md",
    message: "Wiki index does not match the deterministic OKF projection: index.md",
  }]);
});

test("page validation checks only local content and planned outgoing links", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview.md", page({ body: "[Architecture](./architecture.md)\n" }));

  assert.deepEqual(await validateWikiPage(root, target, "overview.md"), []);
  assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), [{
    code: "missing-page",
    page: "architecture.md",
    message: "Target page is missing: architecture.md",
  }]);

  await writePage(root, "overview.md", page({ body: "[Missing](./not-planned.md)\n" }));
  assert.deepEqual(await validateWikiPage(root, target, "overview.md"), [{
    code: "internal-link",
    page: "overview.md",
    message: "Internal Markdown link target is not in the target Wiki: ./not-planned.md",
  }]);
});

test("content validation rejects invalid writer output before touching the candidate", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview.md");
  const before = await readFile(path.join(root, "wiki", "overview.md"), "utf8");
  const invalid = page({
    description: "",
    body: "## Present\n\n```mermaid\nflowchart TD\n  click A callback\n```\n",
  });

  assert.deepEqual(
    await validateWikiPageContent(root, target, "overview.md", invalid.replace("type: __AUTO__", "type: Overview"), "wiki", undefined, ["Required"]),
    [{ code: "frontmatter", page: "overview.md", message: "Frontmatter requires a non-empty description" },
      { code: "mermaid-policy", page: "overview.md", message: "Mermaid fence on line 4 is invalid: interactive Mermaid click actions are not allowed" },
      { code: "required-section", page: "overview.md", message: "Required section is missing: Required" }],
  );
  assert.equal(await readFile(path.join(root, "wiki", "overview.md"), "utf8"), before);

  const unformatted = before.replace("title: Example", "title:   Example");
  const canonical = canonicalizeWikiPageContent(unformatted);
  assert.equal(canonicalizeWikiPageContent(canonical), canonical);
  assert.equal(parsePage(canonical).frontmatter.title, "Example");
});

test("finalization revalidates required sections even when pre-write validation was bypassed", async () => {
  const root = await fixture();
  const target = spec();
  await writeSpecPages(root, target);
  const publicationAt = "2026-08-11T00:00:00.000Z";

  await assert.rejects(
    finalizeWiki(root, target, "wiki", publicationAt, ["Operational guarantees"]),
    /Required section is missing: Operational guarantees/,
  );
  await assert.rejects(readFile(path.join(root, "wiki", "index.md"), "utf8"));
  assert.equal(Object.hasOwn(parsePage(await readFile(path.join(root, "wiki", "overview.md"), "utf8")).frontmatter, "verified"), false);
});

test("review indexes materialize only after all pages pass final deterministic checks", async () => {
  const root = await fixture();
  const target = spec();
  await writeSpecPages(root, target, {
    "overview.md": page({ body: "## Required\n" }),
    "architecture.md": page({ body: "## Required\n" }),
    "api/source.md": page({ body: "## Required\n" }),
    "api/core/domain.md": page({ body: "## Required\n" }),
  });

  assert.deepEqual(
    await materializeValidatedWikiIndexes(root, target, "wiki", undefined, ["Required"]),
    ["api/core/index.md", "api/index.md", "index.md"],
  );
  await writePage(root, "architecture.md");
  const indexBefore = await readFile(path.join(root, "wiki", "index.md"), "utf8");
  await assert.rejects(
    materializeValidatedWikiIndexes(root, target, "wiki", undefined, ["Required"]),
    /Required section is missing: Required/,
  );
  assert.equal(await readFile(path.join(root, "wiki", "index.md"), "utf8"), indexBefore);
});

test("page validation enforces the Spec type and rejects publisher-owned trust fields", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "architecture.md", page({ type: "Concept" }));

  assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), [{
    code: "frontmatter",
    page: "architecture.md",
    message: "Frontmatter type must match WikiSpec page type: Architecture",
  }]);

  const forged = page({ type: "Architecture" }).replace(
    "tags:\n",
    "generated: { by: attacker, at: 2026-08-11T00:00:00.000Z }\nverified: true\ntags:\n",
  );
  await writePage(root, "architecture.md", forged);
  assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), [{
    code: "frontmatter",
    page: "architecture.md",
    message: "Frontmatter field is publisher-owned and forbidden in writer output: generated",
  }, {
    code: "frontmatter",
    page: "architecture.md",
    message: "Frontmatter field is publisher-owned and forbidden in writer output: verified",
  }]);
});

test("uses dependency-free Mermaid syntax-lite checks and separate policy diagnostics", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview.md");

  const cases = [
    ["graph TD\n  A --> B", "mermaid-syntax", "diagram declaration must be flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, or erDiagram"],
    ["flowchart TD\n  A[Safe\u0001]", "mermaid-syntax", "diagram contains an invalid control character on line 2"],
    ["flowchart TD\n  A[Safe]\n  click A callback", "mermaid-policy", "interactive Mermaid click actions are not allowed"],
    ["flowchart TD\n  %%{init: { 'theme': 'base' }}%%\n  A --> B", "mermaid-policy", "Mermaid configuration directives are not allowed"],
    ["flowchart TD\n  A[\"<a href='javascript&#58;alert(1)'>unsafe</a>\"]", "mermaid-policy", "diagram contains an unsafe URL"],
    ["flowchart TD\n  A[\"<a href='java&#115;cript:alert(1)'>unsafe</a>\"]", "mermaid-policy", "diagram contains an unsafe URL"],
    ["flowchart TD\n  A[\"<span onclick='run()'>unsafe</span>\"]", "mermaid-policy", "diagram contains an HTML event handler"],
  ];
  for (const [diagram, code, expected] of cases) {
    await writePage(root, "architecture.md", page({ body: `\`\`\`mermaid\n${diagram}\n\`\`\`\n` }));
    const result = await validateWikiPage(root, target, "architecture.md");
    assert.deepEqual(result, [{
      code,
      page: "architecture.md",
      message: `Mermaid fence on line 2 is invalid: ${expected}`,
    }]);
  }

  const valid = [
    "flowchart TD\n  A[\"中文; label\"] --> end",
    "flowchart LR\n  A[\"<span once=value>data: pipeline</span>\"] --> B",
    "flowchart TD\n  %% { ordinary comment }\n  A --> B",
    "sequenceDiagram\n  Alice->>Bob: data: set once=value (unclosed text",
    "classDiagram\n  class User",
    "stateDiagram-v2\n  [*] --> Ready",
    "erDiagram\n  USER ||--o{ ORDER : places",
  ];
  for (const diagram of valid) {
    await writePage(root, "architecture.md", page({ body: `\`\`\`mermaid\n${diagram}\n\`\`\`\n` }));
    assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), []);
  }
});

test("an obsolete physical page cannot make a target Wiki link pass", async () => {
  const root = await fixture();
  const target = spec();
  await writeSpecPages(root, target, {
    "overview.md": page({ body: "[Legacy](./legacy.md)\n" }),
  });
  await writePage(root, "legacy.md");
  await materializeWikiIndexes(root, target);

  const result = await validateWiki(root, target);

  assert.equal(result.ok, false);
  assert.deepEqual(result.obsoletePages, ["legacy.md"]);
  assert.deepEqual(result.issues, [{
    code: "internal-link",
    page: "overview.md",
    message: "Internal Markdown link target is not in the target Wiki: ./legacy.md",
  }]);
});

test("frontmatter tags are optional but validated when present", async () => {
  const root = await fixture();
  const target = spec();
  const withoutTags = page().replace("tags:\n  - documentation\n", "");
  await writePage(root, "overview.md", withoutTags);
  await writePage(root, "architecture.md", withoutTags);

  assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), []);

  await writePage(root, "architecture.md", page().replace("tags:\n  - documentation", "tags: []"));
  assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), [{
    code: "frontmatter",
    page: "architecture.md",
    message: "Frontmatter tags must be a non-empty string array",
  }]);
});

test("requires OKF source objects and complete source-id footnotes", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview.md");

  await writePage(root, "architecture.md", page({
    sources: [
      { id: "duplicate", resource: "repo:api/src/index.ts#L1-L1" },
      { id: "duplicate", resource: "repo:api/src/index.ts#L2-L2" },
    ],
  }));
  assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), [{
    code: "frontmatter",
    page: "architecture.md",
    message: "Frontmatter source ids must be unique: duplicate",
  }]);

  const escaped = page().replace("Evidence.[^api-index]", "Literal \\[^api-index]");
  await writePage(root, "architecture.md", escaped);
  assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), [{
    code: "source-reference",
    page: "architecture.md",
    message: "Frontmatter source is not cited by a footnote: api-index — cite the claim with [^api-index] in the body",
  }]);

  const duplicateLink = page().replace(
    "[Source](repo:api/src/index.ts#L1-L2)",
    "[Source](repo:api/src/index.ts#L1-L2) [Again](repo:api/src/index.ts#L1-L2)",
  );
  await writePage(root, "architecture.md", duplicateLink);
  assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), [{
    code: "source-reference",
    page: "architecture.md",
    message: "Source footnote definition must contain exactly one repo resource: api-index — use exactly one [Source](repo:...) link in [^api-index]",
  }]);

  await writePage(root, "architecture.md", page({ body: "Unknown source.[^unknown]\n" }));
  assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), [{
    code: "source-reference",
    page: "architecture.md",
    message: "Source footnote reference is not declared in frontmatter sources: unknown — add { id: \"unknown\", resource: \"repo:...\" } to frontmatter sources",
  }, {
    code: "source-reference",
    page: "architecture.md",
    message: "Source footnote reference has no definition: unknown — add [^unknown]: [Source](repo:...) matching the frontmatter resource",
  }]);

  const mismatch = page().replace(
    "[^api-index]: [Source](repo:api/src/index.ts#L1-L2)",
    "[^api-index]: [Source](repo:api/src/index.ts#L1-L1)",
  );
  await writePage(root, "architecture.md", mismatch);
  assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), [{
    code: "source-reference",
    page: "architecture.md",
    message: "Source footnote resource does not match frontmatter source api-index: repo:api/src/index.ts#L1-L1 — set the footnote link equal to frontmatter resource repo:api/src/index.ts#L1-L2",
  }]);

  const unused = page().replace("Evidence.[^api-index]\n\n", "");
  await writePage(root, "architecture.md", unused);
  assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), [{
    code: "source-reference",
    page: "architecture.md",
    message: "Frontmatter source is not cited by a footnote: api-index — cite the claim with [^api-index] in the body",
  }]);

  await writePage(root, "architecture.md", page({ body: "[Direct](repo:api/src/index.ts#L1-L2)\n" }));
  assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), [{
    code: "source-reference",
    page: "architecture.md",
    message: "Direct repo citation must use a declared source footnote: repo:api/src/index.ts#L1-L2 — cite with [^id] in body and define [^id]: [Source](repo:...) instead of linking repo: in prose",
  }]);

  const legacy = page().replace(
    "  - id: api-index\n    resource: repo:api/src/index.ts#L1-L2",
    "  - api/src/index.ts#L1-L2",
  );
  await writePage(root, "architecture.md", legacy);
  assert.deepEqual(await validateWikiPage(root, target, "architecture.md"), [{
    code: "frontmatter",
    page: "architecture.md",
    message: "Frontmatter sources must be a non-empty array of { id, resource } objects",
  }]);
});

test("returns precisely routed issues for missing pages, frontmatter, evidence, and undeclared internal links", async () => {
  const root = await fixture();
  const target = spec(["overview.md", "api/source.md", "api/core/domain.md", "api/core/broken/concept.md", "api/core/missing/modules.md"]);
  await writePage(root, "overview.md");
  await writePage(root, "api/source.md");
  await writePage(root, "api/core/domain.md");
  await writePage(root, "api/core/broken/concept.md", [
    "---",
    "type: Concept",
    "title: Broken",
    "description: 1",
    "tags: [documentation, 2]",
    "sources:",
    "  - id: broken-source",
    "    resource: repo:api/src/index.ts#L3-L3",
    "---",
    "",
    "```mermaid",
    "flowchart TD",
    "  A --> end",
    "```",
    "[Missing](./not-planned.md)",
    "Evidence.[^broken-source]",
    "",
    "[^broken-source]: [Source](repo:api/src/index.ts#L3-L3)",
  ].join("\n"));

  const result = await validateWiki(root, target);

  assert.equal(result.ok, false);
  assert.deepEqual(result.pages, ["api/core/broken/concept.md", "api/core/domain.md", "api/source.md", "overview.md"]);
  assert.deepEqual(result.issues, [
    { code: "frontmatter", page: "api/core/broken/concept.md", message: "Frontmatter requires a non-empty description" },
    { code: "frontmatter", page: "api/core/broken/concept.md", message: "Frontmatter tags must be a non-empty string array" },
    { code: "source-reference", page: "api/core/broken/concept.md", message: "frontmatter source broken-source line range exceeds file: repo:api/src/index.ts#L3-L3" },
    { code: "internal-link", page: "api/core/broken/concept.md", message: "Internal Markdown link target is not in the target Wiki: ./not-planned.md" },
    { code: "missing-page", page: "api/core/missing/modules.md", message: "Target page is missing: api/core/missing/modules.md" },
    { code: "wiki-index", page: "api/core/broken/index.md", message: "Required Wiki index is missing: api/core/broken/index.md" },
    { code: "wiki-index", page: "api/core/index.md", message: "Required Wiki index is missing: api/core/index.md" },
    { code: "wiki-index", page: "api/core/missing/index.md", message: "Required Wiki index is missing: api/core/missing/index.md" },
    { code: "wiki-index", page: "api/index.md", message: "Required Wiki index is missing: api/index.md" },
    { code: "wiki-index", page: "index.md", message: "Required Wiki index is missing: index.md" },
  ]);
});

test("finalization removes obsolete Markdown, rebuilds exact indexes, and preserves assets", async () => {
  const root = await fixture();
  const target = spec();
  await writeSpecPages(root, target, {
    "overview.md": page({ body: "[Architecture](./architecture.md)\n" }),
  });
  await writePage(root, "removed/old.md");
  await writePage(root, ".legacy.md");
  await writeFile(path.join(root, "wiki", "index.md"), "stale\n");
  await mkdir(path.join(root, "wiki", "architecture"), { recursive: true });
  await writeFile(path.join(root, "wiki", "architecture", "index.md"), "stale\n");
  await writeFile(path.join(root, "wiki", "removed", "diagram.png"), "asset\n");
  await writeFile(path.join(root, "wiki", ".asset"), "hidden asset\n");

  const result = await finalizeWiki(root, target);

  assert.deepEqual(result, {
    pages: ["api/core/domain.md", "api/source.md", "architecture.md", "overview.md"],
    obsoletePages: [".legacy.md", "removed/old.md"],
    removedPages: [".legacy.md", "removed/old.md"],
    rebuiltIndexes: ["api/core/index.md", "api/index.md", "index.md"],
  });
  assert.equal(await readFile(path.join(root, "wiki", "removed", "diagram.png"), "utf8"), "asset\n");
  assert.equal(await readFile(path.join(root, "wiki", ".asset"), "utf8"), "hidden asset\n");
  await assert.rejects(readFile(path.join(root, "wiki", ".legacy.md"), "utf8"));
  await assert.rejects(readFile(path.join(root, "wiki", "removed", "old.md"), "utf8"));
  assert.equal(
    await readFile(path.join(root, "wiki", "index.md"), "utf8"),
    "---\nokf_version: \"0.2\"\n---\n\n# Wiki\n\n## Directories\n\n- [Example](./api/index.md): Example documentation\n\n## Pages\n\n- [Example](./architecture.md): Example documentation\n- [Example](./overview.md): Example documentation\n",
  );
  assert.equal(
    await readFile(path.join(root, "wiki", "api", "core", "index.md"), "utf8"),
    "# Example\n\nExample documentation\n\n## Pages\n\n- [Example](./domain.md): Example documentation\n",
  );
});

test("index materialization is idempotent and never removes concept pages", async () => {
  const root = await fixture();
  const target = spec();
  await writeSpecPages(root, target);
  await writePage(root, "obsolete.md");
  await writeFile(path.join(root, "wiki", "index.md"), "stale\n");

  const expected = ["api/core/index.md", "api/index.md", "index.md"];
  assert.deepEqual(await materializeWikiIndexes(root, target), expected);
  assert.equal(await readFile(path.join(root, "wiki", "obsolete.md"), "utf8"), page({ type: "Concept" }));
  const first = await readFile(path.join(root, "wiki", "index.md"), "utf8");
  assert.deepEqual(await materializeWikiIndexes(root, target), expected);
  assert.equal(await readFile(path.join(root, "wiki", "index.md"), "utf8"), first);
});

test("concept directory indexes fall back to the directory name", async () => {
  const root = await fixture();
  const target = spec(["overview.md", "api/core/domain.md", "api/core/request/flows.md"]);
  await writeSpecPages(root, target);

  await materializeWikiIndexes(root, target);

  assert.equal(
    await readFile(path.join(root, "wiki", "api", "core", "request", "index.md"), "utf8"),
    "# request\n\n## Pages\n\n- [Example](./flows.md): Example documentation\n",
  );
});

test("standard topology creates root, domain, and concept indexes", async () => {
  const root = await fixture();
  const target = spec([
    "overview.md",
    "architecture.md",
    "api/payments/domain.md",
    "api/payments/invoice/concept.md",
    "api/payments/invoice/flows.md",
    "api/payments/invoice/states.md",
    "api/payments/invoice/data.md",
  ]);
  await writeSpecPages(root, target, {
    "api/payments/domain.md": page({ title: "Payments", description: "Payment lifecycle" }),
    "api/payments/invoice/concept.md": page({ title: "Invoice", description: "Invoice lifecycle" }),
  });

  assert.deepEqual(await materializeWikiIndexes(root, target), [
    "api/index.md",
    "api/payments/index.md",
    "api/payments/invoice/index.md",
    "index.md",
  ]);
  assert.match(await readFile(path.join(root, "wiki", "api", "payments", "index.md"), "utf8"), /^# Payments\n\nPayment lifecycle/m);
  assert.match(await readFile(path.join(root, "wiki", "api", "payments", "invoice", "index.md"), "utf8"), /^# Invoice/m);
  assert.deepEqual((await validateWiki(root, target)).issues, []);
});

test("index projection renders all model-authored metadata as inert text", async () => {
  const root = await fixture();
  const target = spec();
  await writeSpecPages(root, target, {
    "architecture.md": page({
      title: '"<script>alert(1)</script>"',
      description: '"<img src=x onerror=alert(1)>"',
    }),
    "api/core/domain.md": page({
      title: '"<img src=x onerror=alert(1)>"',
      description: '"[unsafe](javascript:alert(1))"',
    }),
  });

  await materializeWikiIndexes(root, target);

  const rootIndex = await readFile(path.join(root, "wiki", "index.md"), "utf8");
  const domainIndex = await readFile(path.join(root, "wiki", "api", "core", "index.md"), "utf8");
  assert.equal(rootIndex.includes("<img"), false);
  assert.equal(domainIndex.includes("<script>"), false);
  assert.match(rootIndex, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(domainIndex, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(rootIndex, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.deepEqual((await validateWiki(root, target)).issues, []);
});

test("finalization is idempotent", async () => {
  const root = await fixture();
  const target = spec();
  await writeSpecPages(root, target);

  const publicationAt = "2026-08-11T00:00:00.000Z";
  await finalizeWiki(root, target, "wiki", publicationAt);
  const firstIndex = await readFile(path.join(root, "wiki", "index.md"), "utf8");
  const firstPage = await readFile(path.join(root, "wiki", "architecture.md"), "utf8");
  const stamped = parsePage(firstPage).frontmatter;
  assert.deepEqual(stamped.generated, { by: "open-okf-wiki/1.0.0", at: publicationAt });
  assert.deepEqual(stamped.verified, { by: "process:open-okf-wiki", at: publicationAt });
  assert.equal(Object.hasOwn(stamped, "human"), false);
  assert.equal(Object.hasOwn(stamped, "stale_after"), false);
  assert.deepEqual((await validateWiki(root, target)).issues, []);

  const second = await finalizeWiki(root, target, "wiki", publicationAt);

  assert.deepEqual(second.obsoletePages, []);
  assert.deepEqual(second.removedPages, []);
  assert.equal(await readFile(path.join(root, "wiki", "index.md"), "utf8"), firstIndex);
  assert.equal(await readFile(path.join(root, "wiki", "architecture.md"), "utf8"), firstPage);

  const reverifiedAt = "2026-08-12T00:00:00.000Z";
  await finalizeWiki(root, target, "wiki", reverifiedAt);
  const reverified = parsePage(
    await readFile(path.join(root, "wiki", "architecture.md"), "utf8"),
  ).frontmatter;
  assert.deepEqual(reverified.generated, { by: "open-okf-wiki/1.0.0", at: publicationAt });
  assert.deepEqual(reverified.verified, { by: "process:open-okf-wiki", at: reverifiedAt });
});

test("failed validation performs no deletion", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview.md", "invalid page");
  await writePage(root, "architecture.md");
  await writePage(root, "core/domain.md");
  await writePage(root, "obsolete.md");
  await writeFile(path.join(root, "wiki", "index.md"), "stale\n");

  await assert.rejects(finalizeWiki(root, target), /requires a valid target Wiki/);

  assert.equal(await readFile(path.join(root, "wiki", "obsolete.md"), "utf8"), page({ type: "Concept" }));
  assert.equal(await readFile(path.join(root, "wiki", "index.md"), "utf8"), "stale\n");
});

test("finalizer refuses Wiki symlinks before deleting obsolete pages", async () => {
  const root = await fixture();
  const target = spec();
  await writeSpecPages(root, target);
  await writePage(root, "obsolete.md");
  await materializeWikiIndexes(root, target);
  const outside = path.join(root, "outside.md");
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(root, "wiki", "linked.md"), "file");

  const validation = await validateWiki(root, target);
  assert.deepEqual(validation.issues, [{ code: "wiki-safety", message: "Wiki tree must not contain symbolic links: linked.md" }]);
  await assert.rejects(finalizeWiki(root, target), /must not contain symbolic links/);
  assert.equal(await readFile(path.join(root, "wiki", "obsolete.md"), "utf8"), page({ type: "Concept" }));
  assert.equal(await readFile(outside, "utf8"), "outside\n");
});

test("a partially failed finalization can be retried", async () => {
  const root = await fixture();
  const target = spec();
  await writeSpecPages(root, target);
  await mkdir(path.join(root, "wiki", "api", "core", "index.md"));
  await writeFile(path.join(root, "wiki", "api", "core", "index.md", "asset.txt"), "collision\n");

  await assert.rejects(finalizeWiki(root, target), /unexpected Wiki entry/);
  await rm(path.join(root, "wiki", "api", "core", "index.md"), { recursive: true });

  const result = await finalizeWiki(root, target);
  assert.deepEqual(result.pages, ["api/core/domain.md", "api/source.md", "architecture.md", "overview.md"]);
  assert.equal(await readFile(path.join(root, "wiki", "api", "core", "index.md"), "utf8"), "# Example\n\nExample documentation\n\n## Pages\n\n- [Example](./domain.md): Example documentation\n");
});

test("rejects an unsafe writer-requested page path before reading the Wiki tree", async () => {
  const root = await fixture();
  const target = spec();

  assert.deepEqual(await validateWikiPage(root, target, "../escape.md"), [{
    code: "spec-page",
    page: "../escape.md",
    message: "Page is unsafe or reserved: ../escape.md",
  }]);
});
