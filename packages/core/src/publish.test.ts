import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertNoSymlinkComponents } from "./paths.js";
import { publishStagingToPublication } from "./publish.js";
import { countMarkdownFiles } from "./wiki-tree.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeMd(root: string, rel: string, body: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
}

/** Valid wiki page with required YAML frontmatter type + title (OKF + product). */
function page(title: string, body = "Hello.", type = "Concept"): string {
  return `---\ntype: ${type}\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;
}

test("countMarkdownFiles counts nested .md files and ignores non-md", async () => {
  const root = await tempDir("okf-pub-count-");
  await writeMd(root, "overview.md", "# O\n");
  await writeMd(root, "nested/arch.md", "# A\n");
  await writeFile(path.join(root, "notes.txt"), "x\n");
  assert.equal(await countMarkdownFiles(root), 2);
});

test("publishStagingToPublication copies staging into empty publication path", async () => {
  const root = await tempDir("okf-pub-ok-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await writeMd(staging, "modules/core.md", page("Core"));

  const result = await publishStagingToPublication({
    stagingDir: staging,
    publicationPath: publication,
    runId: "run-1",
  });

  assert.equal(result.publicationPath, path.resolve(publication));
  assert.equal(result.pageCount, 2);
  const body = await readFile(path.join(publication, "overview.md"), "utf8");
  assert.match(body, /Overview/);
  const nested = await readFile(path.join(publication, "modules", "core.md"), "utf8");
  assert.match(nested, /Core/);
});

test("publishStagingToPublication rewrites repo: citations to relative sources/ paths", async () => {
  const root = await tempDir("okf-pub-cite-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  const sourceRoot = path.join(root, "checkout");
  await mkdir(staging, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "README.md"), "line1\n", "utf8");
  await writeMd(staging, "overview.md", page("Overview", "Note [Source](repo:README.md#L1)."));
  await writeMd(staging, "modules/core.md", page("Core", "Detail [Source](repo:README.md#L1)."));

  const result = await publishStagingToPublication({
    stagingDir: staging,
    publicationPath: publication,
    sources: [{ id: "app", path: sourceRoot }],
  });

  assert.equal(result.pageCount, 2);
  assert.equal(result.rewrittenCitationPages, 2);

  // Staging keeps Skill-form repo: citations.
  const stagingBody = await readFile(path.join(staging, "overview.md"), "utf8");
  assert.match(stagingBody, /\[Source\]\(repo:README\.md#L1\)/);

  const overview = await readFile(path.join(publication, "overview.md"), "utf8");
  assert.match(overview, /\[Source\]\(sources\/app\/README\.md#L1\)/);
  assert.doesNotMatch(overview, /repo:README/);

  const nested = await readFile(path.join(publication, "modules", "core.md"), "utf8");
  assert.match(nested, /\[Source\]\(\.\.\/sources\/app\/README\.md#L1\)/);
});

test("publishStagingToPublication stamps OKF provenance on the candidate only", async () => {
  const root = await tempDir("okf-pub-stamp-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await writeMd(staging, "index.md", "# Wiki\n\n* [Overview](overview.md) - intro\n");

  const result = await publishStagingToPublication({
    stagingDir: staging,
    publicationPath: publication,
    stamp: {
      generatedBy: "okf-wiki/test-model",
      generatedAt: "2026-07-26T12:00:00.000Z",
      verified: [{ by: "process:review-council", at: "2026-07-26T12:30:00.000Z" }],
    },
  });
  assert.equal(result.stampedPages, 1);
  assert.equal(result.logChanges, 1);

  const published = await readFile(path.join(publication, "overview.md"), "utf8");
  assert.match(published, /generated: \{ by: "okf-wiki\/test-model"/);
  assert.match(published, /verified: \{ by: "process:review-council"/);
  const index = await readFile(path.join(publication, "index.md"), "utf8");
  assert.match(index, /^---\nokf_version: "0\.2"\n---\n/);

  // Deterministic log.md records the first publish (date from generatedAt).
  const log = await readFile(path.join(publication, "log.md"), "utf8");
  assert.match(
    log,
    /^# Wiki Update Log\n\n## 2026-07-26\n\* \*\*Creation\*\*: Added \[Overview\]\(\/overview\.md\)\./,
  );

  // Staging Wiki stays exactly what the model wrote.
  const stagingBody = await readFile(path.join(staging, "overview.md"), "utf8");
  assert.doesNotMatch(stagingBody, /generated:/);
});

test("publishStagingToPublication renames existing publication aside then replaces", async () => {
  const root = await tempDir("okf-pub-replace-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await mkdir(publication, { recursive: true });
  await writeFile(path.join(publication, "old.md"), "# Old\n", "utf8");
  await writeMd(staging, "new.md", page("New"));

  const result = await publishStagingToPublication({
    stagingDir: staging,
    publicationPath: publication,
  });

  assert.equal(result.pageCount, 1);
  const published = await readFile(path.join(publication, "new.md"), "utf8");
  assert.match(published, /New/);

  // Old content is replaced; no aside / candidate / lock residue accumulates
  // (retention is not a product feature — ADR 0017).
  await assert.rejects(() => readFile(path.join(publication, "old.md"), "utf8"));
  const siblings = await readdir(root);
  assert.ok(
    !siblings.some(
      (name) =>
        name.startsWith("wiki.prev.") ||
        name.startsWith("wiki.next.") ||
        name === "wiki.publish-lock",
    ),
    `expected no publish residue, got: ${siblings.join(", ")}`,
  );
});

test("publishStagingToPublication sweeps residue from a crashed publish", async () => {
  const root = await tempDir("okf-pub-sweep-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "page.md", page("Page"));
  await mkdir(path.join(root, "wiki.next.123"), { recursive: true });
  await mkdir(path.join(root, "wiki.prev.456"), { recursive: true });

  await publishStagingToPublication({ stagingDir: staging, publicationPath: publication });

  const siblings = await readdir(root);
  assert.ok(!siblings.includes("wiki.next.123"), "stale candidate should be swept");
  assert.ok(!siblings.includes("wiki.prev.456"), "stale aside should be swept");
});

test("publishStagingToPublication rejects overlapping staging and publication paths", async () => {
  const root = await tempDir("okf-pub-overlap-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "page.md", page("Page"));

  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: path.join(staging, "wiki"),
      }),
    /must not overlap/,
  );
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: staging,
      }),
    /must not overlap/,
  );
});

test("publishStagingToPublication fails closed when another publisher holds the lock", async () => {
  const root = await tempDir("okf-pub-lock-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "page.md", page("Page"));
  // Simulate a concurrent publisher in another process holding the lock.
  await mkdir(`${publication}.publish-lock`, { recursive: true });

  await assert.rejects(
    () => publishStagingToPublication({ stagingDir: staging, publicationPath: publication }),
    /another publish is in progress/,
  );
});

test("publishStagingToPublication rejects relative stagingDir", async () => {
  const root = await tempDir("okf-pub-rel-");
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: "relative/staging",
        publicationPath: path.join(root, "wiki"),
      }),
    /absolute/,
  );
});

test("publishStagingToPublication rejects relative publicationPath", async () => {
  const root = await tempDir("okf-pub-rel2-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "a.md", page("A"));
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: "relative/wiki",
      }),
    /absolute/,
  );
});

test("publishStagingToPublication rejects missing staging", async () => {
  const root = await tempDir("okf-pub-missing-");
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: path.join(root, "no-such"),
        publicationPath: path.join(root, "wiki"),
      }),
    /does not exist/,
  );
});

test("publishStagingToPublication rejects staging with no markdown", async () => {
  const root = await tempDir("okf-pub-empty-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, "notes.txt"), "x\n");
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: path.join(root, "wiki"),
      }),
    /no markdown/,
  );
});

test("publishStagingToPublication rejects symlink publicationPath", async () => {
  const root = await tempDir("okf-pub-symlink-");
  const staging = path.join(root, "staging");
  const realTarget = path.join(root, "real-wiki");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await mkdir(realTarget, { recursive: true });
  await writeMd(staging, "a.md", page("A"));
  try {
    await symlink(realTarget, publication, "dir");
  } catch (error) {
    // Some environments disallow directory symlinks; skip in that case.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
      return;
    }
    throw error;
  }
  const info = await lstat(publication);
  assert.equal(info.isSymbolicLink(), true);

  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: publication,
      }),
    /symlink/,
  );
});

test("assertNoSymlinkComponents accepts real directories", async () => {
  const root = await tempDir("okf-pub-nonsym-");
  await assertNoSymlinkComponents(root, "root");
});

test("publishStagingToPublication rejects md without title frontmatter", async () => {
  const root = await tempDir("okf-pub-fm-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "bad.md", "# No frontmatter\n");
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: path.join(root, "wiki"),
      }),
    /validation|frontmatter|title/i,
  );
});
