import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  type OkfStamp,
  stampConceptPage,
  stampRootIndex,
  stampWikiTreeForPublish,
} from "./okf-stamp.js";
import { parseWikiFrontmatter } from "./wiki-tree.js";

const STAMP: OkfStamp = {
  generatedBy: "okf-wiki/openai/gpt-test",
  generatedAt: "2026-07-26T12:00:00.000Z",
};

const VERIFIED_STAMP: OkfStamp = {
  ...STAMP,
  verified: [{ by: "process:review-council", at: "2026-07-26T12:30:00.000Z" }],
};

test("stampConceptPage appends generated inside existing frontmatter", () => {
  const page = "---\ntype: Concept\ntitle: T\n---\n\nBody.\n";
  const out = stampConceptPage(page, STAMP);
  assert.match(
    out,
    /generated: \{ by: "okf-wiki\/openai\/gpt-test", at: "2026-07-26T12:00:00\.000Z" \}/,
  );
  assert.ok(out.endsWith("\n\nBody.\n"));
  // Frontmatter still parses and keeps original keys.
  const fm = parseWikiFrontmatter(out);
  assert.equal(fm?.values.type, "Concept");
  assert.equal(fm?.values.title, "T");
});

test("stampConceptPage adds single verified as a bare mapping", () => {
  const out = stampConceptPage("---\ntype: Concept\ntitle: T\n---\nBody.\n", VERIFIED_STAMP);
  assert.match(
    out,
    /verified: \{ by: "process:review-council", at: "2026-07-26T12:30:00\.000Z" \}/,
  );
});

test("stampConceptPage writes multiple verified entries as a list", () => {
  const out = stampConceptPage("---\ntype: Concept\ntitle: T\n---\nBody.\n", {
    ...STAMP,
    verified: [
      { by: "process:review-council", at: "2026-07-26T12:30:00.000Z" },
      { by: "process:hard-validate", at: "2026-07-26T12:31:00.000Z" },
    ],
  });
  assert.match(out, /verified:\n {2}- \{ by: "process:review-council",/);
  assert.match(out, /\n {2}- \{ by: "process:hard-validate",/);
});

test("stampConceptPage never overwrites model-authored generated/verified", () => {
  const page =
    '---\ntype: Concept\ntitle: T\ngenerated: { by: "x/y", at: "2020-01-01T00:00:00Z" }\n---\nBody.\n';
  assert.equal(stampConceptPage(page, STAMP), page);
  const verifiedPage =
    '---\ntype: Concept\ntitle: T\nverified: { by: "human:a", at: "2020-01-01T00:00:00Z" }\n---\nBody.\n';
  const out = stampConceptPage(verifiedPage, VERIFIED_STAMP);
  assert.match(out, /generated:/);
  assert.equal(out.match(/verified:/g)?.length, 1);
});

test("stampConceptPage leaves pages without frontmatter untouched", () => {
  assert.equal(stampConceptPage("# No frontmatter\n", STAMP), "# No frontmatter\n");
});

test("stampRootIndex creates frontmatter when the listing has none", () => {
  const out = stampRootIndex("# Wiki\n\n* [Overview](overview.md) - intro\n", "0.2");
  assert.ok(out.startsWith('---\nokf_version: "0.2"\n---\n\n# Wiki\n'));
});

test("stampRootIndex appends okf_version to existing frontmatter once", () => {
  const withFm = '---\nokf_version: "0.2"\n---\n\n# Wiki\n';
  assert.equal(stampRootIndex(withFm, "0.2"), withFm);
});

test("stampWikiTreeForPublish stamps concepts, root index, and skips nested reserved files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-stamp-"));
  await writeFile(path.join(root, "overview.md"), "---\ntype: Overview\ntitle: O\n---\nBody.\n");
  await writeFile(path.join(root, "index.md"), "# Listing\n\n* [O](overview.md) - o\n");
  await writeFile(path.join(root, "log.md"), "# Log\n\n## 2026-07-26\n* **Creation**: init.\n");
  await mkdir(path.join(root, "modules"), { recursive: true });
  await writeFile(
    path.join(root, "modules/core.md"),
    "---\ntype: Module\ntitle: Core\n---\nBody.\n",
  );
  await writeFile(path.join(root, "modules/index.md"), "# Modules\n\n* [Core](core.md) - c\n");

  const result = await stampWikiTreeForPublish(root, VERIFIED_STAMP);
  assert.equal(result.stampedPages, 2);
  assert.equal(result.rootIndexStamped, true);

  const overview = await readFile(path.join(root, "overview.md"), "utf8");
  assert.match(overview, /generated: \{ by: "okf-wiki\/openai\/gpt-test"/);
  assert.match(overview, /verified: \{ by: "process:review-council"/);

  const rootIndex = await readFile(path.join(root, "index.md"), "utf8");
  assert.match(rootIndex, /^---\nokf_version: "0\.2"\n---\n/);

  // Nested index.md and log.md stay untouched (reserved, no okf_version).
  const nestedIndex = await readFile(path.join(root, "modules/index.md"), "utf8");
  assert.equal(nestedIndex, "# Modules\n\n* [Core](core.md) - c\n");
  const log = await readFile(path.join(root, "log.md"), "utf8");
  assert.ok(!log.includes("generated:"));
});
