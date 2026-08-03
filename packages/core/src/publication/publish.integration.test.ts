/**
 * End-to-end split publish: capture → materialize → apply (no one-shot API).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { OkfStamp } from "../okf-stamp.js";
import { validateWikiIndexes } from "../wiki-index.js";
import { applySealedPublicationCandidate } from "./apply.js";
import { capturePublicationBaseline } from "./lock.js";
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

async function publishViaSplit(input: {
  stagingDir: string;
  publicationPath: string;
  sources?: Array<{ id: string; path: string }>;
  stamp?: OkfStamp;
}): Promise<{
  publicationPath: string;
  pageCount: number;
  rewrittenCitationPages?: number;
  stampedPages?: number;
  logChanges?: number;
  regeneratedIndexes?: number;
}> {
  const publicationPath = path.resolve(input.publicationPath);
  const candidateDir = `${publicationPath}.candidate.test`;
  const expectedLiveDigest = await capturePublicationBaseline(publicationPath);
  const materialized = await materializePublicationCandidate({
    wikiDir: input.stagingDir,
    candidateDir,
    publicationPath,
    ...(input.sources?.length ? { sources: input.sources } : {}),
    ...(input.stamp ? { stamp: input.stamp } : {}),
  });
  const effectKey = `publish:test:${createHash("sha256").update(candidateDir).digest("hex").slice(0, 16)}`;
  const applied = await applySealedPublicationCandidate({
    candidateDir,
    publicationPath,
    expectedLiveDigest,
    effectKey,
  });
  assert.equal(applied.status, "applied", `expected applied, got ${JSON.stringify(applied)}`);
  await rm(candidateDir, { recursive: true, force: true }).catch(() => undefined);
  return {
    publicationPath,
    pageCount: materialized.pageCount,
    ...(materialized.rewrittenCitationPages !== undefined
      ? { rewrittenCitationPages: materialized.rewrittenCitationPages }
      : {}),
    ...(materialized.stampedPages !== undefined ? { stampedPages: materialized.stampedPages } : {}),
    ...(materialized.logChanges !== undefined ? { logChanges: materialized.logChanges } : {}),
    ...(materialized.regeneratedIndexes !== undefined
      ? { regeneratedIndexes: materialized.regeneratedIndexes }
      : {}),
  };
}

test("split publish copies staging into empty publication path", async () => {
  const root = await tempDir("okf-pub-ok-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await writeMd(staging, "modules/core.md", page("Core"));

  const result = await publishViaSplit({
    stagingDir: staging,
    publicationPath: publication,
  });

  assert.equal(result.publicationPath, path.resolve(publication));
  assert.equal(result.pageCount, 2);
  assert.ok((result.regeneratedIndexes ?? 0) >= 2);
  const body = await readFile(path.join(publication, "overview.md"), "utf8");
  assert.match(body, /Overview/);
  const nested = await readFile(path.join(publication, "modules", "core.md"), "utf8");
  assert.match(nested, /Core/);
  const rootIndex = await readFile(path.join(publication, "index.md"), "utf8");
  assert.match(rootIndex, /modules\/index\.md/);
  const modulesIndex = await readFile(path.join(publication, "modules", "index.md"), "utf8");
  assert.match(modulesIndex, /core\.md/);

  const indexCheck = await validateWikiIndexes(publication);
  assert.equal(indexCheck.ok, true, indexCheck.errors.join("; "));
});

test("split publish rewrites repo: citations to relative sources/ paths", async () => {
  const root = await tempDir("okf-pub-cite-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  const sourceRoot = path.join(root, "checkout");
  await mkdir(staging, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "README.md"), "line1\n", "utf8");
  await writeMd(staging, "overview.md", page("Overview", "Note [Source](repo:README.md#L1)."));
  await writeMd(staging, "modules/core.md", page("Core", "Detail [Source](repo:README.md#L1)."));

  const result = await publishViaSplit({
    stagingDir: staging,
    publicationPath: publication,
    sources: [{ id: "app", path: sourceRoot }],
  });

  assert.equal(result.pageCount, 2);
  assert.equal(result.rewrittenCitationPages, 2);

  const stagingBody = await readFile(path.join(staging, "overview.md"), "utf8");
  assert.match(stagingBody, /\[Source\]\(repo:README\.md#L1\)/);

  const overview = await readFile(path.join(publication, "overview.md"), "utf8");
  assert.match(overview, /\[Source\]\(sources\/app\/README\.md#L1\)/);
  assert.doesNotMatch(overview, /repo:README/);

  const nested = await readFile(path.join(publication, "modules", "core.md"), "utf8");
  assert.match(nested, /\[Source\]\(\.\.\/sources\/app\/README\.md#L1\)/);
});

test("split publish stamps OKF provenance on the candidate only", async () => {
  const root = await tempDir("okf-pub-stamp-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await writeMd(staging, "index.md", "# Wiki\n\n* [Overview](overview.md) - intro\n");

  const result = await publishViaSplit({
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

  const log = await readFile(path.join(publication, "log.md"), "utf8");
  assert.match(
    log,
    /^# Wiki Update Log\n\n## 2026-07-26\n\* \*\*Creation\*\*: Added \[Overview\]\(\/overview\.md\)\./,
  );

  const stagingBody = await readFile(path.join(staging, "overview.md"), "utf8");
  assert.doesNotMatch(stagingBody, /generated:/);
});

test("split publish renames existing publication aside then replaces", async () => {
  const root = await tempDir("okf-pub-replace-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await mkdir(publication, { recursive: true });
  await writeFile(path.join(publication, "old.md"), "# Old\n", "utf8");
  await writeMd(staging, "new.md", page("New"));

  const result = await publishViaSplit({
    stagingDir: staging,
    publicationPath: publication,
  });

  assert.equal(result.pageCount, 1);
  const published = await readFile(path.join(publication, "new.md"), "utf8");
  assert.match(published, /New/);

  await assert.rejects(() => readFile(path.join(publication, "old.md"), "utf8"));
  const siblings = await readdir(root);
  assert.ok(
    !siblings.some(
      (name) =>
        name.startsWith("wiki.prev.") ||
        name.startsWith("wiki.next.") ||
        name === "wiki.publish-lock" ||
        name.startsWith("wiki.candidate."),
    ),
    `expected no publish residue, got: ${siblings.join(", ")}`,
  );
});
