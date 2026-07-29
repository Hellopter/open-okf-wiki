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
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertNoSymlinkComponents } from "./paths.js";
import {
  applySealedPublicationCandidate,
  capturePublicationBaseline,
  digestPublicationTree,
  digestPublicationTreeContentOnly,
  EMPTY_PUBLICATION_DIGEST,
  materializePublicationCandidate,
  publishStagingToPublication,
  reconcilePublicationApply,
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
    /lock directory is busy and not stale/,
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
  // WikiRuns seal adds a sidecar; effect identity is content-only.
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
