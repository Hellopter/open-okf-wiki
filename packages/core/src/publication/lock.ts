/**
 * Exclusive publication lock (ADR 0017 / 0035): in-process mutex + on-disk lock
 * dir so concurrent Wiki Runs targeting the same Published Wiki path fail closed
 * instead of interleaving renames or baseline captures.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { withLockedDir, withPerKeyMutex } from "../atomicity.js";
import { assertAbsolutePath, assertNoSymlinkComponents } from "../paths.js";
import { digestPublicationTree } from "./digest.js";

/** In-process serialization per publication path (same-process publishers). */
const publishTails = new Map<string, Promise<unknown>>();

/** A held lock dir older than this is treated as crash residue. */
const PUBLISH_LOCK_STALE_MS = 10 * 60 * 1000;

export function withPublicationLock<T>(publicationPath: string, fn: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(assertAbsolutePath(publicationPath, "publicationPath"));
  return withPerKeyMutex(publishTails, resolved, () =>
    withLockedDir(`${resolved}.publish-lock`, { staleMs: PUBLISH_LOCK_STALE_MS }, fn),
  );
}

/**
 * Capture the live baseline digest under the publication lock (ADR 0035).
 * Empty / missing publication yields {@link EMPTY_PUBLICATION_DIGEST}.
 */
export async function capturePublicationBaseline(publicationPath: string): Promise<string> {
  const resolved = path.resolve(assertAbsolutePath(publicationPath, "publicationPath"));
  await assertNoSymlinkComponents(path.dirname(resolved), "publicationPath parent");
  await mkdir(path.dirname(resolved), { recursive: true });
  return withPublicationLock(resolved, async () => digestPublicationTree(resolved));
}
