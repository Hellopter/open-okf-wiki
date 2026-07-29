import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { OkfStamp } from "./okf-stamp.js";
import { assertNoSymlinkComponents } from "./paths.js";
import {
  applySealedPublicationCandidate,
  capturePublicationBaseline,
  digestPublicationTree,
  digestPublicationTreeContentOnly,
  EMPTY_PUBLICATION_DIGEST,
  manifestPublicationTree,
  materializePublicationCandidate,
  reconcilePublicationApply,
  withPublicationLock,
} from "./publish.js";
import { validateWikiIndexes } from "./wiki-index.js";
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

/**
 * Split-primitive publish used by mechanical coverage (no one-shot API).
 * capture → materialize → apply under the publication lock protocol.
 */
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

test("countMarkdownFiles counts nested .md files and ignores non-md", async () => {
  const root = await tempDir("okf-pub-count-");
  await writeMd(root, "overview.md", "# O\n");
  await writeMd(root, "nested/arch.md", "# A\n");
  await writeFile(path.join(root, "notes.txt"), "x\n");
  assert.equal(await countMarkdownFiles(root), 2);
});

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
  // Always regenerates multi-level indexes on the candidate (even without stamp).
  assert.ok((result.regeneratedIndexes ?? 0) >= 2);
  const body = await readFile(path.join(publication, "overview.md"), "utf8");
  assert.match(body, /Overview/);
  const nested = await readFile(path.join(publication, "modules", "core.md"), "utf8");
  assert.match(nested, /Core/);
  const rootIndex = await readFile(path.join(publication, "index.md"), "utf8");
  assert.match(rootIndex, /modules\/index\.md/);
  const modulesIndex = await readFile(path.join(publication, "modules", "index.md"), "utf8");
  assert.match(modulesIndex, /core\.md/);

  // Defense in depth: post-regenerate validate must pass on the published tree.
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

  // Staging keeps Skill-form repo: citations.
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

  // Old content is replaced; no aside / candidate / lock residue accumulates
  // (retention is not a product feature — ADR 0017).
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

test("apply sweeps effect-scoped residue from a crashed apply", async () => {
  const root = await tempDir("okf-pub-sweep-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  const candidate = path.join(root, "candidate");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "page.md", page("Page"));
  await materializePublicationCandidate({
    wikiDir: staging,
    candidateDir: candidate,
    publicationPath: publication,
  });
  const effectKey = "publish:sweep:0:deadbeef";
  const token = createHash("sha256").update(effectKey).digest("hex").slice(0, 16);
  const nextPath = `${publication}.next.${token}`;
  const prevPath = `${publication}.prev.${token}`;
  await mkdir(nextPath, { recursive: true });
  await mkdir(prevPath, { recursive: true });
  await writeFile(path.join(nextPath, "stale.txt"), "x\n", "utf8");
  await writeFile(path.join(prevPath, "stale.txt"), "y\n", "utf8");

  const expected = await capturePublicationBaseline(publication);
  const applied = await applySealedPublicationCandidate({
    candidateDir: candidate,
    publicationPath: publication,
    expectedLiveDigest: expected,
    effectKey,
  });
  assert.equal(applied.status, "applied");

  const siblings = await readdir(root);
  assert.ok(!siblings.includes(path.basename(nextPath)), "effect next residue should be swept");
  assert.ok(!siblings.includes(path.basename(prevPath)), "effect prev residue should be swept");
});

test("materialize rejects overlapping wiki and publication paths", async () => {
  const root = await tempDir("okf-pub-overlap-");
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

test("publication lock fails closed when another publisher holds the lock", async () => {
  const root = await tempDir("okf-pub-lock-");
  const publication = path.join(root, "wiki");
  // Simulate a concurrent publisher in another process holding the lock.
  await mkdir(`${publication}.publish-lock`, { recursive: true });

  await assert.rejects(
    () => capturePublicationBaseline(publication),
    /lock directory is busy and not stale/,
  );
  await assert.rejects(
    () => withPublicationLock(publication, async () => "never"),
    /lock directory is busy and not stale/,
  );
});

test("materialize rejects relative wikiDir", async () => {
  const root = await tempDir("okf-pub-rel-");
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
  const root = await tempDir("okf-pub-rel2-");
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
  const root = await tempDir("okf-pub-missing-");
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
  const root = await tempDir("okf-pub-empty-");
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
      materializePublicationCandidate({
        wikiDir: staging,
        candidateDir: path.join(root, "candidate"),
        publicationPath: publication,
      }),
    /symlink/,
  );
});

test("assertNoSymlinkComponents accepts real directories", async () => {
  const root = await tempDir("okf-pub-nonsym-");
  await assertNoSymlinkComponents(root, "root");
});

test("materialize rejects md without title frontmatter", async () => {
  const root = await tempDir("okf-pub-fm-");
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

test("manifestPublicationTree is sort-stable, posix-relative, and symlink fail-closed", async () => {
  const root = await tempDir("okf-pub-manifest-");
  await writeMd(root, "z-last.md", page("Z"));
  await writeMd(root, "a-first.md", page("A"));
  await writeMd(root, "nested/b.md", page("B"));
  await writeFile(path.join(root, "plain.txt"), "bytes\n", "utf8");

  const first = await manifestPublicationTree(root);
  const second = await manifestPublicationTree(root);
  assert.deepEqual(first, second);
  assert.equal(first.schema, 1);
  // Visit order is readdir-sorted at each level → stable file list order.
  assert.deepEqual(
    first.files.map((f) => f.path),
    ["a-first.md", "nested/b.md", "plain.txt", "z-last.md"],
  );
  for (const file of first.files) {
    assert.equal(file.path.includes("\\"), false, `path must be posix-relative: ${file.path}`);
    assert.equal(file.digest.length, 64);
    assert.ok(file.size > 0);
  }
  assert.equal(await digestPublicationTree(root), await digestPublicationTree(root));
  assert.equal(await digestPublicationTree(undefined), EMPTY_PUBLICATION_DIGEST);
  assert.equal(await digestPublicationTree(path.join(root, "missing")), EMPTY_PUBLICATION_DIGEST);

  // Symlink entry fails closed (does not follow).
  const linkTarget = path.join(root, "plain.txt");
  const linkPath = path.join(root, "link.txt");
  try {
    await symlink(linkTarget, linkPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return;
    throw error;
  }
  await assert.rejects(() => manifestPublicationTree(root), /non-ordinary entry|symlink/i);
});

test("capturePublicationBaseline returns EMPTY_PUBLICATION_DIGEST for missing live tree", async () => {
  const root = await tempDir("okf-pub-baseline-");
  const publication = path.join(root, "wiki");
  const digest = await capturePublicationBaseline(publication);
  assert.equal(digest, EMPTY_PUBLICATION_DIGEST);
});

test("applySealedPublicationCandidate conflicts when live baseline drifts", async () => {
  const root = await tempDir("okf-pub-cas-conflict-");
  const staging = path.join(root, "staging");
  const candidate = path.join(root, "candidate");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await materializePublicationCandidate({
    wikiDir: staging,
    candidateDir: candidate,
    publicationPath: publication,
  });
  const expected = await capturePublicationBaseline(publication);
  // Drift live after baseline capture.
  await mkdir(publication, { recursive: true });
  await writeMd(publication, "other.md", page("Other"));

  let beginCalled = false;
  const result = await applySealedPublicationCandidate({
    candidateDir: candidate,
    publicationPath: publication,
    expectedLiveDigest: expected,
    effectKey: "publish:run:0:deadbeef",
    beginApply: () => {
      beginCalled = true;
      return true;
    },
  });
  assert.equal(result.status, "conflict");
  assert.equal(beginCalled, false, "beginApply must not run on conflict");
  if (result.status === "conflict") {
    assert.notEqual(result.liveDigest, expected);
  }
});

test("applySealedPublicationCandidate CAS beginApply before rename; reconcile recovers applied", async () => {
  const root = await tempDir("okf-pub-cas-ok-");
  const staging = path.join(root, "staging");
  const candidate = path.join(root, "candidate");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await materializePublicationCandidate({
    wikiDir: staging,
    candidateDir: candidate,
    publicationPath: publication,
  });
  const expected = await capturePublicationBaseline(publication);
  const candidateDigest = await digestPublicationTree(candidate);
  const effectKey = "publish:run-apply:0:abcd";

  let phase = "ready";
  const result = await applySealedPublicationCandidate({
    candidateDir: candidate,
    publicationPath: publication,
    expectedLiveDigest: expected,
    effectKey,
    beginApply: () => {
      phase = "applying";
      return true;
    },
  });
  assert.equal(result.status, "applied");
  assert.equal(phase, "applying");
  if (result.status === "applied") {
    assert.equal(result.liveDigest, candidateDigest);
  }
  const liveBody = await readFile(path.join(publication, "overview.md"), "utf8");
  assert.match(liveBody, /Overview/);

  // Simulate crash after success by asking reconcile with applying semantics.
  const reconciled = await reconcilePublicationApply({
    publicationPath: publication,
    candidateDir: candidate,
    candidateDigest,
    expectedLiveDigest: expected,
    effectKey,
  });
  assert.equal(reconciled.status, "applied");
});

test("applySealedPublicationCandidate aborts without rename when beginApply returns false", async () => {
  const root = await tempDir("okf-pub-abort-");
  const staging = path.join(root, "staging");
  const candidate = path.join(root, "candidate");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await materializePublicationCandidate({
    wikiDir: staging,
    candidateDir: candidate,
    publicationPath: publication,
  });
  const expected = await capturePublicationBaseline(publication);
  const result = await applySealedPublicationCandidate({
    candidateDir: candidate,
    publicationPath: publication,
    expectedLiveDigest: expected,
    effectKey: "publish:run-abort:0:ab",
    beginApply: () => false,
  });
  assert.equal(result.status, "aborted");
  await assert.rejects(() => readFile(path.join(publication, "overview.md"), "utf8"));
});

test("T5 reconcile: live sealed tree matches content-only candidateDigest", async () => {
  const root = await tempDir("okf-pub-seal-recon-");
  const staging = path.join(root, "staging");
  const candidate = path.join(root, "candidate");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await materializePublicationCandidate({
    wikiDir: staging,
    candidateDir: candidate,
    publicationPath: publication,
  });
  // WikiRuns seals candidates with a sidecar; effect identity is content-only.
  const contentDigest = await digestPublicationTree(candidate);
  await writeFile(
    path.join(candidate, ".okf-artifact-manifest.json"),
    `${JSON.stringify({ schema: 1, files: [{ path: "overview.md", digest: "x", size: 1 }] })}\n`,
    "utf8",
  );
  const sealedDigest = await digestPublicationTree(candidate);
  assert.notEqual(sealedDigest, contentDigest);
  assert.equal(await digestPublicationTreeContentOnly(candidate), contentDigest);

  const expected = await capturePublicationBaseline(publication);
  const effectKey = `publish:seal-recon:0:${contentDigest}`;
  const applied = await applySealedPublicationCandidate({
    candidateDir: candidate,
    publicationPath: publication,
    expectedLiveDigest: expected,
    effectKey,
    beginApply: () => true,
  });
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") {
    assert.equal(applied.liveDigest, sealedDigest);
    assert.notEqual(applied.liveDigest, contentDigest);
  }

  // Crash window: effect still applying, live already holds sealed bytes.
  const reconciled = await reconcilePublicationApply({
    publicationPath: publication,
    candidateDir: candidate,
    candidateDigest: contentDigest,
    expectedLiveDigest: expected,
    effectKey,
  });
  assert.equal(reconciled.status, "applied");
});

test("T5 reconcile: live still at baseline → failed (pre-rename crash)", async () => {
  const root = await tempDir("okf-pub-recon-fail-");
  const staging = path.join(root, "staging");
  const candidate = path.join(root, "candidate");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await materializePublicationCandidate({
    wikiDir: staging,
    candidateDir: candidate,
    publicationPath: publication,
  });
  const expected = await capturePublicationBaseline(publication);
  const candidateDigest = await digestPublicationTree(candidate);
  const effectKey = "publish:recon-fail:0:aa";
  // Simulate applying without ever renaming: live still empty baseline.
  const reconciled = await reconcilePublicationApply({
    publicationPath: publication,
    candidateDir: candidate,
    candidateDigest,
    expectedLiveDigest: expected,
    effectKey,
  });
  assert.equal(reconciled.status, "failed");
  if (reconciled.status === "failed") {
    assert.equal(reconciled.liveDigest, expected);
  }
});

test("T5 reconcile: complete swap when live missing and next holds candidate", async () => {
  const root = await tempDir("okf-pub-recon-next-");
  const staging = path.join(root, "staging");
  const candidate = path.join(root, "candidate");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await materializePublicationCandidate({
    wikiDir: staging,
    candidateDir: candidate,
    publicationPath: publication,
  });
  const expected = await capturePublicationBaseline(publication);
  const candidateDigest = await digestPublicationTree(candidate);
  const effectKey = "publish:recon-next:0:bb";
  const token = createHash("sha256").update(effectKey).digest("hex").slice(0, 16);
  const nextPath = `${publication}.next.${token}`;
  // Crash after next materialize, before live rename: no live, next holds candidate.
  await mkdir(path.dirname(publication), { recursive: true });
  await cp(candidate, nextPath, { recursive: true });

  const reconciled = await reconcilePublicationApply({
    publicationPath: publication,
    candidateDir: candidate,
    candidateDigest,
    expectedLiveDigest: expected,
    effectKey,
  });
  assert.equal(reconciled.status, "applied");
  const liveBody = await readFile(path.join(publication, "overview.md"), "utf8");
  assert.match(liveBody, /Overview/);
  await assert.rejects(() => lstat(nextPath));
});

test("T5 reconcile: restore prev aside when live missing mid-swap", async () => {
  const root = await tempDir("okf-pub-recon-prev-");
  const staging = path.join(root, "staging");
  const candidate = path.join(root, "candidate");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await mkdir(publication, { recursive: true });
  await writeMd(publication, "old.md", page("Old"));
  await writeMd(staging, "overview.md", page("Overview"));
  await materializePublicationCandidate({
    wikiDir: staging,
    candidateDir: candidate,
    publicationPath: publication,
  });
  const expected = await digestPublicationTree(publication);
  const candidateDigest = await digestPublicationTree(candidate);
  const effectKey = "publish:recon-prev:0:cc";
  const token = createHash("sha256").update(effectKey).digest("hex").slice(0, 16);
  const prevPath = `${publication}.prev.${token}`;
  // Crash after live→prev, before next→live.
  await rename(publication, prevPath);

  const reconciled = await reconcilePublicationApply({
    publicationPath: publication,
    candidateDir: candidate,
    candidateDigest,
    expectedLiveDigest: expected,
    effectKey,
  });
  assert.equal(reconciled.status, "failed");
  const restored = await readFile(path.join(publication, "old.md"), "utf8");
  assert.match(restored, /Old/);
  await assert.rejects(() => lstat(prevPath));
});

test("T5 beginApply runs after baseline check and before any live mutation", async () => {
  const root = await tempDir("okf-pub-cas-order-");
  const staging = path.join(root, "staging");
  const candidate = path.join(root, "candidate");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await materializePublicationCandidate({
    wikiDir: staging,
    candidateDir: candidate,
    publicationPath: publication,
  });
  const expected = await capturePublicationBaseline(publication);
  const order: string[] = [];
  const result = await applySealedPublicationCandidate({
    candidateDir: candidate,
    publicationPath: publication,
    expectedLiveDigest: expected,
    effectKey: "publish:cas-order:0:dd",
    beginApply: async () => {
      order.push("beginApply");
      // Live must still be absent / baseline — no rename yet.
      try {
        await lstat(publication);
        order.push("live-exists-too-early");
      } catch {
        order.push("live-still-baseline");
      }
      return true;
    },
  });
  assert.equal(result.status, "applied");
  assert.deepEqual(order, ["beginApply", "live-still-baseline"]);
  await readFile(path.join(publication, "overview.md"), "utf8");
});
