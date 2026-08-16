import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export async function exists(location: string): Promise<boolean> {
  try {
    await stat(location);
    return true;
  } catch {
    return false;
  }
}

export async function markdownFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await markdownFiles(root, child));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(child);
  }
  return files.sort();
}

export function relativePosix(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join("/");
}

export function inside(root: string, candidate: string): string {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`path escapes root: ${candidate}`);
  return absoluteCandidate;
}

export async function readText(location: string): Promise<string> {
  return await readFile(location, "utf8");
}

/** Write UTF-8 text via temp file in the same directory, then rename (atomic on same filesystem). */
export type DurableFilePhase =
  | "file_synced"
  | "renamed"
  | "appended"
  | "claimed"
  | "directory_created"
  | "removed"
  | "directory_synced";

export interface DurableFileOptions {
  fault?: (phase: DurableFilePhase) => void | Promise<void>;
}

export interface DurableRemoveOptions extends DurableFileOptions {
  recursive?: boolean;
  force?: boolean;
}

export async function writeText(location: string, text: string, options: DurableFileOptions = {}): Promise<void> {
  await writeFileDurable(location, text, options);
}

export async function writeFileDurable(
  location: string,
  content: string | Uint8Array,
  options: DurableFileOptions = {},
): Promise<void> {
  const directory = path.dirname(location);
  const temporary = path.join(directory, `.${path.basename(location)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(content);
      await file.sync();
      await options.fault?.("file_synced");
    } finally {
      await file.close();
    }
    await rename(temporary, location);
    await options.fault?.("renamed");
    await syncDirectory(directory);
    await options.fault?.("directory_synced");
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Append UTF-8 text and make both the bytes and directory entry durable. */
export async function appendText(location: string, text: string, options: DurableFileOptions = {}): Promise<void> {
  const file = await open(location, "a");
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
    await options.fault?.("appended");
  } finally {
    await file.close();
  }
  await syncDirectory(path.dirname(location));
  await options.fault?.("directory_synced");
}

/** Create a new UTF-8 file exclusively and durably, suitable for active markers. */
export async function claimText(location: string, text: string, options: DurableFileOptions = {}): Promise<void> {
  const file = await open(location, "wx");
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
    await options.fault?.("claimed");
  } finally {
    await file.close();
  }
  await syncDirectory(path.dirname(location));
  await options.fault?.("directory_synced");
}

/** Remove a filesystem entry and durably record its absence in the parent. */
export async function removePath(location: string, options: DurableRemoveOptions = {}): Promise<void> {
  const existed = await lstat(location).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  await rm(location, { recursive: options.recursive ?? false, force: options.force ?? false });
  if (!existed) return;
  await options.fault?.("removed");
  await syncDirectory(path.dirname(location));
  await options.fault?.("directory_synced");
}

/** Rename an entry and durably record both sides when crossing directories. */
export async function renamePath(source: string, target: string, options: DurableFileOptions = {}): Promise<void> {
  await rename(source, target);
  await options.fault?.("renamed");
  const sourceDirectory = path.dirname(source);
  const targetDirectory = path.dirname(target);
  await syncDirectory(sourceDirectory);
  if (targetDirectory !== sourceDirectory) await syncDirectory(targetDirectory);
  await options.fault?.("directory_synced");
}

/** Create every missing directory component and durably record each parent entry. */
export async function ensureDirectory(location: string, options: DurableFileOptions = {}): Promise<void> {
  const absolute = path.resolve(location);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Path must be a regular directory: ${current}`);
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory);
    } catch (error) {
      if (!(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
      const entry = await lstat(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Path must be a regular directory: ${directory}`);
    }
    await options.fault?.("directory_created");
    await syncDirectory(path.dirname(directory));
    await options.fault?.("directory_synced");
  }
}

/** Make a preceding same-directory rename durable where the platform supports it. */
export async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR" || code === "EPERM";
}

const LOCK_POLL_MS = 20;
const LOCK_INITIALIZATION_GRACE_MS = 1_000;
const lockQueues = new Map<string, Promise<void>>();

interface ExclusiveLockRecord {
  version: 1;
  pid: number;
  token: string;
  acquiredAt: string;
}

/** Process-local serialize plus a wx filesystem lease with pid/token ownership and stale reclaim. */
export async function withExclusiveLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(lockPath);
  const previous = lockQueues.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(async () => {
    await ensureDirectory(path.dirname(lockPath));
    return await withFilesystemLease(lockPath, fn);
  });
  const tail = task.then(() => undefined, () => undefined);
  lockQueues.set(key, tail);
  try { return await task; }
  finally { if (lockQueues.get(key) === tail) lockQueues.delete(key); }
}

async function withFilesystemLease<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  const record: ExclusiveLockRecord = {
    version: 1,
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
  };
  for (;;) {
    try {
      await claimText(lockPath, `${JSON.stringify(record)}\n`);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const observedText = await readLockText(lockPath);
    if (observedText === undefined) continue;
    const observed = parseExclusiveLock(observedText);
    if (!observed && await lockIsInitializing(lockPath)) {
      await delay(LOCK_POLL_MS);
      continue;
    }
    if (!observed || !processIsAlive(observed.pid)) {
      const currentText = await readLockText(lockPath);
      if (currentText === observedText) await removePath(lockPath, { force: true });
      continue;
    }
    await delay(LOCK_POLL_MS);
  }
  try { return await fn(); }
  finally {
    const current = parseExclusiveLock(await readLockText(lockPath));
    if (current?.token === token) await removePath(lockPath, { force: true });
  }
}

async function readLockText(lockPath: string): Promise<string | undefined> {
  try { return await readFile(lockPath, "utf8"); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function parseExclusiveLock(text: string | undefined): { pid: number; token?: string } | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as { pid?: unknown; token?: unknown };
    if (!Number.isInteger(record.pid) || (record.pid as number) < 1) return undefined;
    return {
      pid: record.pid as number,
      ...(typeof record.token === "string" && record.token ? { token: record.token } : {}),
    };
  } catch {
    return undefined;
  }
}

async function lockIsInitializing(lockPath: string): Promise<boolean> {
  try { return Date.now() - (await lstat(lockPath)).mtimeMs < LOCK_INITIALIZATION_GRACE_MS; }
  catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
