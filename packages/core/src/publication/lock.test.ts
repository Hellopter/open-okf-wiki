import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EMPTY_PUBLICATION_DIGEST } from "./digest.js";
import { capturePublicationBaseline, withPublicationLock } from "./lock.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test("capturePublicationBaseline returns EMPTY_PUBLICATION_DIGEST for missing live tree", async () => {
  const root = await tempDir("okf-pub-baseline-");
  const publication = path.join(root, "wiki");
  const digest = await capturePublicationBaseline(publication);
  assert.equal(digest, EMPTY_PUBLICATION_DIGEST);
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

test("withPublicationLock serializes same-path work in-process", async () => {
  const root = await tempDir("okf-pub-mutex-");
  const publication = path.join(root, "wiki");
  const order: number[] = [];
  const a = withPublicationLock(publication, async () => {
    order.push(1);
    await new Promise((r) => setTimeout(r, 30));
    order.push(2);
    return "a";
  });
  const b = withPublicationLock(publication, async () => {
    order.push(3);
    return "b";
  });
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  assert.deepEqual(order, [1, 2, 3]);
});
