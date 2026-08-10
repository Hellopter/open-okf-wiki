import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePage } from "../dist/frontmatter.js";
import { finalizeWiki, materializeWikiIndexes, validateWiki, validateWikiPage } from "../dist/validate.js";

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
    { path: "overview/overview.md", pageType: "overview", findingIds: [] },
    { path: "architecture/design.md", pageType: "architecture", findingIds: ["finding-api"] },
  ];
  return {
    domains: selected.map((selectedPage) => ({
      id: selectedPage.path.split("/", 1)[0],
      title: `${selectedPage.path.split("/", 1)[0]} domain`,
      purpose: "Document the target",
      pages: [{
        pageType: selectedPage.pageType,
        path: selectedPage.path,
        title: selectedPage.path,
        purpose: "Document the target",
        findingIds: selectedPage.findingIds,
      }],
    })),
    crossLinks,
    sharedTerms: [],
  };
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
  if (relative === "overview/overview.md") return "Overview";
  if (relative.startsWith("architecture/")) return "Architecture";
  if (relative.split("/").includes("flows")) return "Flow";
  if (relative.split("/").includes("modules")) return "Module";
  return "Concept";
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("validation is read-only and checks the materialized OKF index projection", async () => {
  const root = await fixture();
  const target = spec({
    crossLinks: [{
      fromPath: "overview/overview.md",
      toPath: "architecture/design.md",
      purpose: "Connect overview to architecture",
    }],
  });
  await writePage(root, "overview/overview.md", page({
    body: "[Architecture](../architecture/design.md)\n[Architecture index](../architecture/index.md)\n",
  }));
  await writePage(root, "architecture/design.md", page({ body: "```mermaid\nflowchart TD\n  A --> B\n```\n" }));
  await writePage(root, "legacy.md");
  await materializeWikiIndexes(root, target);
  const indexBefore = await readFile(path.join(root, "wiki", "index.md"), "utf8");

  assert.deepEqual(await validateWiki(root, target), {
    ok: true,
    issues: [],
    pages: ["architecture/design.md", "overview/overview.md"],
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
  const target = spec({
    crossLinks: [{
      fromPath: "overview/overview.md",
      toPath: "architecture/design.md",
      purpose: "Connect overview to architecture",
    }],
  });
  await writePage(root, "overview/overview.md", page({ body: "[Architecture](../architecture/design.md)\n" }));

  assert.deepEqual(await validateWikiPage(root, target, "overview/overview.md"), []);
  assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), [{
    code: "missing-page",
    page: "architecture/design.md",
    message: "Target page is missing: architecture/design.md",
  }]);

  await writePage(root, "overview/overview.md", page());
  assert.deepEqual(await validateWikiPage(root, target, "overview/overview.md"), [{
    code: "cross-link",
    page: "overview/overview.md",
    message: "Declared cross-link is missing: overview/overview.md -> architecture/design.md",
  }]);
});

test("page validation enforces the Spec type and rejects publisher-owned trust fields", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "architecture/design.md", page({ type: "Concept" }));

  assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), [{
    code: "frontmatter",
    page: "architecture/design.md",
    message: "Frontmatter type must match WikiSpec page type: Architecture",
  }]);

  const forged = page({ type: "Architecture" }).replace(
    "tags:\n",
    "generated: { by: attacker, at: 2026-08-11T00:00:00.000Z }\nverified: true\ntags:\n",
  );
  await writePage(root, "architecture/design.md", forged);
  assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), [{
    code: "frontmatter",
    page: "architecture/design.md",
    message: "Frontmatter field is publisher-owned and forbidden in writer output: generated",
  }, {
    code: "frontmatter",
    page: "architecture/design.md",
    message: "Frontmatter field is publisher-owned and forbidden in writer output: verified",
  }]);
});

test("uses dependency-free Mermaid syntax-lite checks and separate policy diagnostics", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md");

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
    await writePage(root, "architecture/design.md", page({ body: `\`\`\`mermaid\n${diagram}\n\`\`\`\n` }));
    const result = await validateWikiPage(root, target, "architecture/design.md");
    assert.deepEqual(result, [{
      code,
      page: "architecture/design.md",
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
    await writePage(root, "architecture/design.md", page({ body: `\`\`\`mermaid\n${diagram}\n\`\`\`\n` }));
    assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), []);
  }
});

test("an obsolete physical page cannot make a target Wiki link pass", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md", page({ body: "[Legacy](../legacy.md)\n" }));
  await writePage(root, "architecture/design.md");
  await writePage(root, "legacy.md");
  await materializeWikiIndexes(root, target);

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

  assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), []);

  await writePage(root, "architecture/design.md", page().replace("tags:\n  - documentation", "tags: []"));
  assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), [{
    code: "frontmatter",
    page: "architecture/design.md",
    message: "Frontmatter tags must be a non-empty string array",
  }]);
});

test("requires OKF source objects and complete source-id footnotes", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md");

  await writePage(root, "architecture/design.md", page({
    sources: [
      { id: "duplicate", resource: "repo:api/src/index.ts#L1-L1" },
      { id: "duplicate", resource: "repo:api/src/index.ts#L2-L2" },
    ],
  }));
  assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), [{
    code: "frontmatter",
    page: "architecture/design.md",
    message: "Frontmatter source ids must be unique: duplicate",
  }]);

  const escaped = page().replace("Evidence.[^api-index]", "Literal \\[^api-index]");
  await writePage(root, "architecture/design.md", escaped);
  assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), [{
    code: "source-reference",
    page: "architecture/design.md",
    message: "Frontmatter source is not cited by a footnote: api-index",
  }]);

  const duplicateLink = page().replace(
    "[Source](repo:api/src/index.ts#L1-L2)",
    "[Source](repo:api/src/index.ts#L1-L2) [Again](repo:api/src/index.ts#L1-L2)",
  );
  await writePage(root, "architecture/design.md", duplicateLink);
  assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), [{
    code: "source-reference",
    page: "architecture/design.md",
    message: "Source footnote definition must contain exactly one repo resource: api-index",
  }]);

  await writePage(root, "architecture/design.md", page({ body: "Unknown source.[^unknown]\n" }));
  assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), [{
    code: "source-reference",
    page: "architecture/design.md",
    message: "Source footnote reference is not declared in frontmatter sources: unknown",
  }, {
    code: "source-reference",
    page: "architecture/design.md",
    message: "Source footnote reference has no definition: unknown",
  }]);

  const mismatch = page().replace(
    "[^api-index]: [Source](repo:api/src/index.ts#L1-L2)",
    "[^api-index]: [Source](repo:api/src/index.ts#L1-L1)",
  );
  await writePage(root, "architecture/design.md", mismatch);
  assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), [{
    code: "source-reference",
    page: "architecture/design.md",
    message: "Source footnote resource does not match frontmatter source api-index: repo:api/src/index.ts#L1-L1",
  }]);

  const unused = page().replace("Evidence.[^api-index]\n\n", "");
  await writePage(root, "architecture/design.md", unused);
  assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), [{
    code: "source-reference",
    page: "architecture/design.md",
    message: "Frontmatter source is not cited by a footnote: api-index",
  }]);

  await writePage(root, "architecture/design.md", page({ body: "[Direct](repo:api/src/index.ts#L1-L2)\n" }));
  assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), [{
    code: "source-reference",
    page: "architecture/design.md",
    message: "Direct repo citation must use a declared source footnote: repo:api/src/index.ts#L1-L2",
  }]);

  const legacy = page().replace(
    "  - id: api-index\n    resource: repo:api/src/index.ts#L1-L2",
    "  - api/src/index.ts#L1-L2",
  );
  await writePage(root, "architecture/design.md", legacy);
  assert.deepEqual(await validateWikiPage(root, target, "architecture/design.md"), [{
    code: "frontmatter",
    page: "architecture/design.md",
    message: "Frontmatter sources must be a non-empty array of { id, resource } objects",
  }]);
});

test("returns precisely routed issues for missing pages, frontmatter, evidence, cross-links, and Mermaid", async () => {
  const root = await fixture();
  const target = spec({
    pages: [
      { path: "overview/overview.md", pageType: "overview", findingIds: [] },
      { path: "core/broken.md", pageType: "concept", findingIds: ["finding-api"] },
      { path: "core/missing.md", pageType: "module", findingIds: ["finding-api"] },
    ],
    crossLinks: [{ fromPath: "overview/overview.md", toPath: "core/broken.md", purpose: "Required navigation" }],
  });
  await writePage(root, "overview/overview.md");
  await writePage(root, "core/broken.md", [
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
  assert.deepEqual(result.pages, ["core/broken.md", "overview/overview.md"]);
  assert.deepEqual(result.issues, [
    { code: "frontmatter", page: "core/broken.md", message: "Frontmatter requires a non-empty description" },
    { code: "frontmatter", page: "core/broken.md", message: "Frontmatter tags must be a non-empty string array" },
    { code: "source-reference", page: "core/broken.md", message: "frontmatter source broken-source line range exceeds file: repo:api/src/index.ts#L3-L3" },
    { code: "internal-link", page: "core/broken.md", message: "Internal Markdown link target is not in the target Wiki: ./not-planned.md" },
    { code: "missing-page", page: "core/missing.md", message: "Target page is missing: core/missing.md" },
    { code: "cross-link", page: "overview/overview.md", message: "Declared cross-link is missing: overview/overview.md -> core/broken.md" },
    { code: "wiki-index", page: "core/index.md", message: "Required Wiki index is missing: core/index.md" },
    { code: "wiki-index", page: "index.md", message: "Required Wiki index is missing: index.md" },
    { code: "wiki-index", page: "overview/index.md", message: "Required Wiki index is missing: overview/index.md" },
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
    "---\nokf_version: \"0.2\"\n---\n\n# Wiki\n\n## Directories\n\n- [architecture domain](./architecture/index.md): Document the target\n- [overview domain](./overview/index.md): Document the target\n",
  );
  assert.equal(
    await readFile(path.join(root, "wiki", "architecture", "index.md"), "utf8"),
    "# architecture domain\n\nDocument the target\n\n## Pages\n\n- [Example](./design.md): Example documentation\n",
  );
});

test("index materialization is idempotent and never removes concept pages", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md");
  await writePage(root, "architecture/design.md");
  await writePage(root, "obsolete.md");
  await writeFile(path.join(root, "wiki", "index.md"), "stale\n");

  const expected = ["architecture/index.md", "index.md", "overview/index.md"];
  assert.deepEqual(await materializeWikiIndexes(root, target), expected);
  assert.equal(await readFile(path.join(root, "wiki", "obsolete.md"), "utf8"), page({ type: "Concept" }));
  const first = await readFile(path.join(root, "wiki", "index.md"), "utf8");
  assert.deepEqual(await materializeWikiIndexes(root, target), expected);
  assert.equal(await readFile(path.join(root, "wiki", "index.md"), "utf8"), first);
});

test("deep indexes include a localized deterministic concept count", async () => {
  const root = await fixture();
  const target = spec({
    pages: [{ path: "core/flows/request.md", pageType: "flow", findingIds: ["finding-api"] }],
  });
  await writePage(root, "core/flows/request.md");

  await materializeWikiIndexes(root, target);

  assert.equal(
    await readFile(path.join(root, "wiki", "core", "flows", "index.md"), "utf8"),
    "# flows\n\n1 个概念页面\n\n## Pages\n\n- [Example](./request.md): Example documentation\n",
  );
});

test("index projection renders all model-authored metadata as inert text", async () => {
  const root = await fixture();
  const target = spec();
  const architecture = target.domains.find((domain) => domain.id === "architecture");
  architecture.title = "<img src=x onerror=alert(1)>";
  architecture.purpose = "[unsafe](javascript:alert(1))";
  await writePage(root, "overview/overview.md");
  await writePage(root, "architecture/design.md", page({
    title: "<script>alert(1)</script>",
    description: "<img src=x onerror=alert(1)>",
  }));

  await materializeWikiIndexes(root, target);

  const rootIndex = await readFile(path.join(root, "wiki", "index.md"), "utf8");
  const domainIndex = await readFile(path.join(root, "wiki", "architecture", "index.md"), "utf8");
  assert.equal(rootIndex.includes("<img"), false);
  assert.equal(domainIndex.includes("<script>"), false);
  assert.match(rootIndex, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(domainIndex, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.deepEqual((await validateWiki(root, target)).issues, []);
});

test("finalization is idempotent", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md");
  await writePage(root, "architecture/design.md");

  const publicationAt = "2026-08-11T00:00:00.000Z";
  await finalizeWiki(root, target, "wiki", publicationAt);
  const firstIndex = await readFile(path.join(root, "wiki", "index.md"), "utf8");
  const firstPage = await readFile(path.join(root, "wiki", "architecture", "design.md"), "utf8");
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
  assert.equal(await readFile(path.join(root, "wiki", "architecture", "design.md"), "utf8"), firstPage);

  const reverifiedAt = "2026-08-12T00:00:00.000Z";
  await finalizeWiki(root, target, "wiki", reverifiedAt);
  const reverified = parsePage(
    await readFile(path.join(root, "wiki", "architecture", "design.md"), "utf8"),
  ).frontmatter;
  assert.deepEqual(reverified.generated, { by: "open-okf-wiki/1.0.0", at: publicationAt });
  assert.deepEqual(reverified.verified, { by: "process:open-okf-wiki", at: reverifiedAt });
});

test("failed validation performs no deletion", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md", "invalid page");
  await writePage(root, "architecture/design.md");
  await writePage(root, "obsolete.md");
  await writeFile(path.join(root, "wiki", "index.md"), "stale\n");

  await assert.rejects(finalizeWiki(root, target), /requires a valid target Wiki/);

  assert.equal(await readFile(path.join(root, "wiki", "obsolete.md"), "utf8"), page({ type: "Concept" }));
  assert.equal(await readFile(path.join(root, "wiki", "index.md"), "utf8"), "stale\n");
});

test("finalizer refuses Wiki symlinks before deleting obsolete pages", async () => {
  const root = await fixture();
  const target = spec();
  await writePage(root, "overview/overview.md");
  await writePage(root, "architecture/design.md");
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
  await writePage(root, "overview/overview.md");
  await writePage(root, "architecture/design.md");
  await mkdir(path.join(root, "wiki", "overview", "index.md"));
  await writeFile(path.join(root, "wiki", "overview", "index.md", "asset.txt"), "collision\n");

  await assert.rejects(finalizeWiki(root, target), /unexpected Wiki entry/);
  await rm(path.join(root, "wiki", "overview", "index.md"), { recursive: true });

  const result = await finalizeWiki(root, target);
  assert.deepEqual(result.pages, ["architecture/design.md", "overview/overview.md"]);
  assert.equal(await readFile(path.join(root, "wiki", "overview", "index.md"), "utf8"), "# overview domain\n\nDocument the target\n\n## Pages\n\n- [Example](./overview.md): Example documentation\n");
});

test("rejects unsafe Spec paths without touching the Wiki tree", async () => {
  const root = await fixture();
  const target = spec({ pages: [{ path: "../escape.md", pageType: "concept", findingIds: ["finding-api"] }] });

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
    const target = spec({ pages: [{ path: unsafePath, pageType: "concept", findingIds: ["finding-api"] }] });

    const validation = await validateWiki(root, target);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues[0].code, "spec-page");
    await assert.rejects(finalizeWiki(root, target), /unsafe or reserved page path/);
    await assert.rejects(readFile(path.join(root, "wiki", "index.md"), "utf8"));
  }
});
