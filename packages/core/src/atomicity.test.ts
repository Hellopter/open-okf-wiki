import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cleanupWritableTree, withLockedDir, withPerKeyMutex } from "./atomicity.js";
import { makeTreeReadOnly } from "./immutable-tree.js";

test("withPerKeyMutex serializes same-key callers and keeps keys independent", async () => {
  const queues = new Map<string, Promise<unknown>>();
  const order: string[] = [];

  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  const a = withPerKeyMutex(queues, "k1", async () => {
    order.push("a-start");
    await gateA;
    order.push("a-end");
    return "a";
  });

  const b = withPerKeyMutex(queues, "k1", async () => {
    order.push("b");
    return "b";
  });

  // Different key must not wait on k1.
  const c = withPerKeyMutex(queues, "k2", async () => {
    order.push("c");
    return "c";
  });

  await c;
  assert.ok(order.includes("c"), "independent key should run while k1 is held");
  assert.ok(!order.includes("b"), "same-key waiter must not start before prior job ends");

  releaseA();
  assert.deepEqual(await Promise.all([a, b, c]), ["a", "b", "c"]);
  assert.deepEqual(
    order.filter((entry) => entry !== "c"),
    ["a-start", "a-end", "b"],
  );
});

test("withPerKeyMutex continues the queue after a rejected job", async () => {
  const queues = new Map<string, Promise<unknown>>();

  const failing = withPerKeyMutex(queues, "k", async () => {
    throw new Error("boom");
  });
  await assert.rejects(() => failing, /boom/);

  const next = await withPerKeyMutex(queues, "k", async () => "ok");
  assert.equal(next, "ok");
});

test("withPerKeyMutex drains a waiter that was queued before the prior rejection", async () => {
  const queues = new Map<string, Promise<unknown>>();
  const order: string[] = [];

  let releaseFail!: () => void;
  const holdFail = new Promise<void>((resolve) => {
    releaseFail = resolve;
  });

  const failing = withPerKeyMutex(queues, "k", async () => {
    order.push("fail-start");
    await holdFail;
    order.push("fail-throw");
    throw new Error("queued-boom");
  });

  // Enqueue while the failing job still holds the key.
  const waiter = withPerKeyMutex(queues, "k", async () => {
    order.push("waiter");
    return "recovered";
  });

  releaseFail();
  await assert.rejects(() => failing, /queued-boom/);
  assert.equal(await waiter, "recovered");
  assert.deepEqual(order, ["fail-start", "fail-throw", "waiter"]);
});

test("withLockedDir acquires, runs, and releases the lock directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-lock-"));
  const lockDir = path.join(root, "held.lock");

  let sawLock = false;
  const result = await withLockedDir(lockDir, { staleMs: 60_000 }, async () => {
    await access(lockDir);
    sawLock = true;
    return 42;
  });

  assert.equal(result, 42);
  assert.equal(sawLock, true);
  await assert.rejects(() => access(lockDir), { code: "ENOENT" });
});

test("withLockedDir fails closed when a fresh lock is held", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-lock-busy-"));
  const lockDir = path.join(root, "held.lock");
  await mkdir(lockDir);

  await assert.rejects(
    () => withLockedDir(lockDir, { staleMs: 60_000 }, async () => "nope"),
    /lock directory is busy and not stale/,
  );

  // Fresh lock must remain for the other holder.
  await access(lockDir);
});

test("withLockedDir reclaims a stale lock directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-lock-stale-"));
  const lockDir = path.join(root, "held.lock");
  await mkdir(lockDir);

  // Age the lock past the stale window (mtime only; atime ignored).
  const staleAt = new Date(Date.now() - 11 * 60 * 1000);
  await utimes(lockDir, staleAt, staleAt);
  const before = await stat(lockDir);
  assert.ok(Date.now() - before.mtimeMs > 10 * 60 * 1000);

  const result = await withLockedDir(lockDir, { staleMs: 10 * 60 * 1000 }, async () => "reclaimed");
  assert.equal(result, "reclaimed");
  await assert.rejects(() => access(lockDir), { code: "ENOENT" });
});

test("withLockedDir releases the lock after the body rejects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-lock-fail-"));
  const lockDir = path.join(root, "held.lock");

  await assert.rejects(
    () =>
      withLockedDir(lockDir, { staleMs: 60_000 }, async () => {
        throw new Error("body failed");
      }),
    /body failed/,
  );
  await assert.rejects(() => access(lockDir), { code: "ENOENT" });
});

test("withLockedDir serializes exclusive holders for the same path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-lock-serial-"));
  const lockDir = path.join(root, "held.lock");
  const order: string[] = [];

  let releaseFirst!: () => void;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let sawBusy!: (error: unknown) => void;
  const busySeen = new Promise<unknown>((resolve) => {
    sawBusy = resolve;
  });

  const first = withLockedDir(lockDir, { staleMs: 60_000 }, async () => {
    order.push("first-hold");
    // While held, a peer must fail closed (disk lock is not a wait queue).
    void withLockedDir(lockDir, { staleMs: 60_000 }, async () => "second").then(
      (value) => sawBusy(new Error(`expected busy, got ${value}`)),
      (error) => {
        order.push("second-busy");
        sawBusy(error);
      },
    );
    await holdFirst;
    order.push("first-done");
    return "first";
  });

  const busyError = await busySeen;
  assert.match(String(busyError), /lock directory is busy and not stale/);
  releaseFirst();
  assert.equal(await first, "first");
  assert.deepEqual(order, ["first-hold", "second-busy", "first-done"]);

  // After release, a new holder can acquire.
  assert.equal(await withLockedDir(lockDir, { staleMs: 60_000 }, async () => "third"), "third");
});

test("cleanupWritableTree unlocks a read-only tree and removes it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-cleanup-"));
  const tree = path.join(root, "frozen");
  await mkdir(path.join(tree, "nested"), { recursive: true });
  await writeFile(path.join(tree, "nested", "file.txt"), "x\n", "utf8");
  await makeTreeReadOnly(tree);

  // Direct rm of a read-only tree can fail on some hosts; cleanup must succeed.
  await cleanupWritableTree(tree);
  await assert.rejects(() => access(tree), { code: "ENOENT" });

  // Parent remains.
  await access(root);
  // Restore writability on the parent for the process exit cleanup path.
  await chmod(root, 0o755).catch(() => undefined);
});
