import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { materializePublicationCandidate } from "./materialize.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeMd(root: string, rel: string, body: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
}

function page(title: string, body = "Hello.", type = "Concept"): string {
  return `---\ntype: ${type}\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;
}

test("materialize copies wiki into candidate and regenerates indexes", async () => {
  const root = await tempDir("okf-mat-ok-");
  const staging = path.join(root, "staging");
  const candidate = path.join(root, "candidate");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await writeMd(staging, "modules/core.md", page("Core"));

  const result = await materializePublicationCandidate({
    wikiDir: staging,
    candidateDir: candidate,
    publicationPath: publication,
  });

  assert.equal(result.pageCount, 2);
  assert.ok((result.regeneratedIndexes ?? 0) >= 2);
  const body = await readFile(path.join(candidate, "overview.md"), "utf8");
  assert.match(body, /Overview/);
  // Staging remains untouched.
  const stagingBody = await readFile(path.join(staging, "overview.md"), "utf8");
  assert.doesNotMatch(stagingBody, /generated:/);
});

test("materialize rewrites repo: citations on the candidate only", async () => {
  const root = await tempDir("okf-mat-cite-");
  const staging = path.join(root, "staging");
  const candidate = path.join(root, "candidate");
  const publication = path.join(root, "wiki");
  const sourceRoot = path.join(root, "checkout");
  await mkdir(staging, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "README.md"), "line1\n", "utf8");
  await writeMd(staging, "overview.md", page("Overview", "Note [Source](repo:README.md#L1)."));
  await writeMd(staging, "modules/core.md", page("Core", "Detail [Source](repo:README.md#L1)."));

  const result = await materializePublicationCandidate({
    wikiDir: staging,
    candidateDir: candidate,
    publicationPath: publication,
    sources: [{ id: "app", path: sourceRoot }],
  });

  assert.equal(result.rewrittenCitationPages, 2);
  const stagingBody = await readFile(path.join(staging, "overview.md"), "utf8");
  assert.match(stagingBody, /\[Source\]\(repo:README\.md#L1\)/);
  const overview = await readFile(path.join(candidate, "overview.md"), "utf8");
  assert.match(overview, /\[Source\]\(sources\/app\/README\.md#L1\)/);
  const nested = await readFile(path.join(candidate, "modules", "core.md"), "utf8");
  assert.match(nested, /\[Source\]\(\.\.\/sources\/app\/README\.md#L1\)/);
});

test("materialize stamps OKF provenance and writes log on the candidate", async () => {
  const root = await tempDir("okf-mat-stamp-");
  const staging = path.join(root, "staging");
  const candidate = path.join(root, "candidate");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await writeMd(staging, "index.md", "# Wiki\n\n* [Overview](overview.md) - intro\n");

  const result = await materializePublicationCandidate({
    wikiDir: staging,
    candidateDir: candidate,
    publicationPath: publication,
    stamp: {
      generatedBy: "okf-wiki/test-model",
      generatedAt: "2026-07-26T12:00:00.000Z",
      verified: [{ by: "process:review-council", at: "2026-07-26T12:30:00.000Z" }],
    },
  });
  assert.equal(result.stampedPages, 1);
  assert.equal(result.logChanges, 1);

  const stamped = await readFile(path.join(candidate, "overview.md"), "utf8");
  assert.match(stamped, /generated: \{ by: "okf-wiki\/test-model"/);
  const log = await readFile(path.join(candidate, "log.md"), "utf8");
  assert.match(log, /## 2026-07-26/);
  const stagingBody = await readFile(path.join(staging, "overview.md"), "utf8");
  assert.doesNotMatch(stagingBody, /generated:/);
});

test("materialize rejects overlapping wiki and publication paths", async () => {
  const root = await tempDir("okf-mat-overlap-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "page.md", page("Page"));

  await assert.rejects(
    () =>
      materializePublicationCandidate({
        wikiDir: staging,
        candidateDir: path.join(root, "candidate"),
        publicationPath: path.join(staging, "wiki"),
      }),
    /must not overlap/,
  );
  await assert.rejects(
    () =>
      materializePublicationCandidate({
        wikiDir: staging,
        candidateDir: path.join(root, "candidate"),
        publicationPath: staging,
      }),
    /must not overlap/,
  );
});

test("materialize rejects relative wikiDir", async () => {
  const root = await tempDir("okf-mat-rel-");
  await assert.rejects(
    () =>
      materializePublicationCandidate({
        wikiDir: "relative/staging",
        candidateDir: path.join(root, "candidate"),
        publicationPath: path.join(root, "wiki"),
      }),
    /absolute/,
  );
});

test("materialize rejects relative publicationPath", async () => {
  const root = await tempDir("okf-mat-rel2-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "a.md", page("A"));
  await assert.rejects(
    () =>
      materializePublicationCandidate({
        wikiDir: staging,
        candidateDir: path.join(root, "candidate"),
        publicationPath: "relative/wiki",
      }),
    /absolute/,
  );
});

test("materialize rejects missing wiki directory", async () => {
  const root = await tempDir("okf-mat-missing-");
  await assert.rejects(
    () =>
      materializePublicationCandidate({
        wikiDir: path.join(root, "no-such"),
        candidateDir: path.join(root, "candidate"),
        publicationPath: path.join(root, "wiki"),
      }),
    /does not exist/,
  );
});

test("materialize rejects wiki with no markdown", async () => {
  const root = await tempDir("okf-mat-empty-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, "notes.txt"), "x\n");
  await assert.rejects(
    () =>
      materializePublicationCandidate({
        wikiDir: staging,
        candidateDir: path.join(root, "candidate"),
        publicationPath: path.join(root, "wiki"),
      }),
    /no markdown|validation/i,
  );
});

test("materialize rejects symlink publicationPath", async () => {
  const root = await tempDir("okf-mat-symlink-");
  const staging = path.join(root, "staging");
  const realTarget = path.join(root, "real-wiki");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await mkdir(realTarget, { recursive: true });
  await writeMd(staging, "a.md", page("A"));
  try {
    await symlink(realTarget, publication, "dir");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
      return;
    }
    throw error;
  }

  await assert.rejects(
    () =>
      materializePublicationCandidate({
        wikiDir: staging,
        candidateDir: path.join(root, "candidate"),
        publicationPath: publication,
      }),
    /symlink/,
  );
});

test("materialize rejects md without title frontmatter", async () => {
  const root = await tempDir("okf-mat-fm-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "bad.md", "# No frontmatter\n");
  await assert.rejects(
    () =>
      materializePublicationCandidate({
        wikiDir: staging,
        candidateDir: path.join(root, "candidate"),
        publicationPath: path.join(root, "wiki"),
      }),
    /validation|frontmatter|title/i,
  );
});
