/**
 * Shared concurrency and cleanup primitives for single-process Node RMW,
 * exclusive on-disk locks, and best-effort teardown of failed freeze trees.
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { makeTreeWritable } from "./immutable-tree.js";

/**
 * In-process per-key mutex. Concurrent callers for the same `key` serialize
 * so RMW rules (cancel-wins, last-write-wins) see the latest settled state.
 *
 * The queue stores a settling tail so a rejected job never stalls later work.
 * Each module keeps its own `Map` for isolation.
 */
export function withPerKeyMutex<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.finally(() => {
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  });
  return run;
}

/**
 * Exclusive directory lock via non-recursive `mkdir` (EEXIST when held).
 * A lock older than `staleMs` is treated as crash residue and reclaimed.
 */
export async function withLockedDir<T>(
  lockDir: string,
  opts: { staleMs: number },
  fn: () => Promise<T>,
): Promise<T> {
  await acquireLockDir(lockDir, opts.staleMs);
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function tryCreateLockDir(lockDir: string): Promise<"acquired" | "busy"> {
  try {
    await mkdir(lockDir); // non-recursive: EEXIST when another holder has it
    return "acquired";
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
      return "busy";
    }
    throw error;
  }
}

async function acquireLockDir(lockDir: string, staleMs: number): Promise<void> {
  if ((await tryCreateLockDir(lockDir)) === "acquired") {
    return;
  }

  const info = await stat(lockDir).catch(() => null);
  if (!info) {
    // Holder released between EEXIST and stat — one retry, then fail closed.
    if ((await tryCreateLockDir(lockDir)) === "acquired") {
      return;
    }
    throw new Error(`lock directory is busy and not stale: ${lockDir}`);
  }

  if (Date.now() - info.mtimeMs > staleMs) {
    await rm(lockDir, { recursive: true, force: true });
    // Reclaim is racy: another process may create the dir first.
    if ((await tryCreateLockDir(lockDir)) === "acquired") {
      return;
    }
    throw new Error(`lock directory is busy and not stale: ${lockDir}`);
  }

  throw new Error(`lock directory is busy and not stale: ${lockDir}`);
}

/**
 * Best-effort unlock + remove of a failed, run-owned materialisation tree.
 * Writable failures are swallowed so cleanup still attempts `rm`.
 */
export async function cleanupWritableTree(dir: string): Promise<void> {
  await makeTreeWritable(dir).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}
