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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  applySealedPublicationCandidate,
  reconcilePublicationApply,
} from "./apply.js";
import { digestPublicationTree, digestPublicationTreeContentOnly } from "./digest.js";
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

async function materializeFixture(root: string): Promise<{
  candidate: string;
  publication: string;
  expected: string;
  candidateDigest: string;
}> {
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
  return { candidate, publication, expected, candidateDigest };
}

test("apply sweeps effect-scoped residue from a crashed apply", async () => {
  const root = await tempDir("okf-apply-sweep-");
  const { candidate, publication, expected } = await materializeFixture(root);
  const effectKey = "publish:sweep:0:deadbeef";
  const token = createHash("sha256").update(effectKey).digest("hex").slice(0, 16);
  const nextPath = `${publication}.next.${token}`;
  const prevPath = `${publication}.prev.${token}`;
  await mkdir(nextPath, { recursive: true });
  await mkdir(prevPath, { recursive: true });
  await writeFile(path.join(nextPath, "stale.txt"), "x\n", "utf8");
  await writeFile(path.join(prevPath, "stale.txt"), "y\n", "utf8");

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

test("applySealedPublicationCandidate conflicts when live baseline drifts", async () => {
  const root = await tempDir("okf-apply-cas-conflict-");
  const { candidate, publication, expected } = await materializeFixture(root);
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
  const root = await tempDir("okf-apply-cas-ok-");
  const { candidate, publication, expected, candidateDigest } = await materializeFixture(root);
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
  const root = await tempDir("okf-apply-abort-");
  const { candidate, publication, expected } = await materializeFixture(root);
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
  const root = await tempDir("okf-apply-seal-recon-");
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
  const root = await tempDir("okf-apply-recon-fail-");
  const { candidate, publication, expected, candidateDigest } = await materializeFixture(root);
  const effectKey = "publish:recon-fail:0:aa";
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
  const root = await tempDir("okf-apply-recon-next-");
  const { candidate, publication, expected, candidateDigest } = await materializeFixture(root);
  const effectKey = "publish:recon-next:0:bb";
  const token = createHash("sha256").update(effectKey).digest("hex").slice(0, 16);
  const nextPath = `${publication}.next.${token}`;
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
  const root = await tempDir("okf-apply-recon-prev-");
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
  const root = await tempDir("okf-apply-cas-order-");
  const { candidate, publication, expected } = await materializeFixture(root);
  const order: string[] = [];
  const result = await applySealedPublicationCandidate({
    candidateDir: candidate,
    publicationPath: publication,
    expectedLiveDigest: expected,
    effectKey: "publish:cas-order:0:dd",
    beginApply: async () => {
      order.push("beginApply");
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
