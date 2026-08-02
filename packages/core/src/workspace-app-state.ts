import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { atomicCreateJson } from "./atomic-write.js";
import { withPerKeyMutex } from "./atomicity.js";
import { WORKSPACE_DIR_NAME } from "./run-layout.js";

export const APP_STATE_FILE_NAME = "app.json";
const RECENT_WORKSPACE_LIMIT = 32;
const APP_STATE_LOCK_SUFFIX = ".lock";
const APP_STATE_LOCK_RETRY_MS = 10;
const APP_STATE_LOCK_WAIT_MS = 30_000;

/**
 * Per-path write queue: read-modify-write cycles on app.json are serialized
 * within this process so concurrent register/remove/set calls cannot drop
 * each other's updates (last-write-wins on the whole file otherwise).
 */
const appStateQueues = new Map<string, Promise<unknown>>();

type AppStateLockRecord = { pid?: number; token?: string };

/**
 * User-level app state file.
 * `$OKF_WIKI_HOME/app.json` when set, otherwise `~/.okf-wiki/app.json`.
 */
export function defaultAppStatePath(): string {
  const home = process.env.OKF_WIKI_HOME?.trim();
  if (home) {
    return path.join(path.resolve(home), APP_STATE_FILE_NAME);
  }
  return path.join(homedir(), WORKSPACE_DIR_NAME, APP_STATE_FILE_NAME);
}

/**
 * User-level app state (`~/.okf-wiki/app.json` or `$OKF_WIKI_HOME/app.json`).
 * Secrets never appear here. Skill toggle is edited from the Settings page only.
 */
export type AppState = {
  version: 1;
  recentRootPaths: string[];
  /**
   * When true (default), resolve the Producer Skill from
   * `~/.agents/skills/repository-wiki-producer` when the workspace has no
   * project skill. When false, fall back to the package-embedded skill only.
   * Configured via Settings UI / PATCH /api/app-settings (not env).
   */
  loadHomeSkills?: boolean;
};

/** Effective default when `loadHomeSkills` is omitted from app.json. */
export const DEFAULT_LOAD_HOME_SKILLS = true;

/**
 * Whether home skills (`~/.agents/skills`) are used.
 * Reads app.json only (Settings page); no environment override.
 */
export function resolveLoadHomeSkills(state: Pick<AppState, "loadHomeSkills">): boolean {
  if (typeof state.loadHomeSkills === "boolean") {
    return state.loadHomeSkills;
  }
  return DEFAULT_LOAD_HOME_SKILLS;
}

export async function readAppState(
  appStatePath: string = defaultAppStatePath(),
): Promise<AppState> {
  let raw: string;
  try {
    raw = await readFile(appStatePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { version: 1, recentRootPaths: [] };
    }
    // Transient I/O failures (EACCES, EIO, …) must not read as an empty state:
    // a subsequent write would persist the emptied recent list.
    throw error;
  }
  try {
    const data = JSON.parse(raw) as Partial<AppState>;
    const recent = Array.isArray(data.recentRootPaths)
      ? data.recentRootPaths.filter((p): p is string => typeof p === "string" && p.trim() !== "")
      : [];
    const state: AppState = { version: 1, recentRootPaths: recent };
    if (typeof data.loadHomeSkills === "boolean") {
      state.loadHomeSkills = data.loadHomeSkills;
    }
    return state;
  } catch {
    // Corrupt JSON: recoverable — treat as empty (recent list is best-effort).
    return { version: 1, recentRootPaths: [] };
  }
}

export async function writeAppState(appStatePath: string, state: AppState): Promise<void> {
  const dir = path.dirname(appStatePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${appStatePath}.${process.pid}.${Date.now()}.tmp`;
  const body: AppState = {
    version: 1,
    recentRootPaths: state.recentRootPaths,
  };
  if (typeof state.loadHomeSkills === "boolean") {
    body.loadHomeSkills = state.loadHomeSkills;
  }
  await writeFile(tempPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await rename(tempPath, appStatePath);
}

/** Read loadHomeSkills from app.json (Settings page). */
export async function getLoadHomeSkills(
  appStatePath: string = defaultAppStatePath(),
): Promise<boolean> {
  const state = await readAppState(appStatePath);
  return resolveLoadHomeSkills(state);
}

/**
 * Persist `loadHomeSkills` in app.json (Settings page / API).
 * Returns the stored state and the effective value.
 */
export async function setLoadHomeSkills(
  loadHomeSkills: boolean,
  appStatePath: string = defaultAppStatePath(),
): Promise<{ state: AppState; effective: boolean }> {
  return withAppStateLock(appStatePath, async () => {
    const prev = await readAppState(appStatePath);
    const state: AppState = {
      version: 1,
      recentRootPaths: prev.recentRootPaths,
      loadHomeSkills,
    };
    await writeAppState(appStatePath, state);
    return { state, effective: resolveLoadHomeSkills(state) };
  });
}

/** Prepend a workspace root to the user-level recent list. */
export async function registerWorkspaceInAppIndex(
  rootPath: string,
  appStatePath: string = defaultAppStatePath(),
): Promise<void> {
  const resolved = path.resolve(rootPath.trim());
  if (resolved === "" || rootPath.trim() === "") {
    throw new Error("rootPath must be a non-empty string");
  }

  await withAppStateLock(appStatePath, async () => {
    const state = await readAppState(appStatePath);
    const recentRootPaths = [
      resolved,
      ...state.recentRootPaths.filter((entry) => path.resolve(entry) !== resolved),
    ].slice(0, RECENT_WORKSPACE_LIMIT);

    await writeAppState(appStatePath, {
      version: 1,
      recentRootPaths,
      ...(typeof state.loadHomeSkills === "boolean"
        ? { loadHomeSkills: state.loadHomeSkills }
        : {}),
    });
  });
}

/** Remove a workspace root from the user-level recent list. */
export async function removeWorkspaceFromAppIndex(
  rootPath: string,
  appStatePath: string = defaultAppStatePath(),
): Promise<boolean> {
  const resolved = path.resolve(rootPath.trim());
  return withAppStateLock(appStatePath, async () => {
    const state = await readAppState(appStatePath);
    const next = state.recentRootPaths.filter((entry) => path.resolve(entry) !== resolved);
    if (next.length === state.recentRootPaths.length) {
      return false;
    }
    await writeAppState(appStatePath, {
      version: 1,
      recentRootPaths: next,
      ...(typeof state.loadHomeSkills === "boolean"
        ? { loadHomeSkills: state.loadHomeSkills }
        : {}),
    });
    return true;
  });
}

/** Read recent workspace root paths from the user-level app index. */
export async function listRecentWorkspaces(
  appStatePath: string = defaultAppStatePath(),
): Promise<string[]> {
  const state = await readAppState(appStatePath);
  return [...state.recentRootPaths];
}

/** Serialize app.json read-modify-write operations across Server processes. */
async function withAppStateLock<T>(appStatePath: string, operation: () => Promise<T>): Promise<T> {
  return withPerKeyMutex(appStateQueues, appStatePath, async () => {
    const lockPath = `${appStatePath}${APP_STATE_LOCK_SUFFIX}`;
    const token = randomUUID();
    await acquireAppStateLock(lockPath, token);
    try {
      return await operation();
    } finally {
      await releaseAppStateLock(lockPath, token);
    }
  });
}

async function acquireAppStateLock(lockPath: string, token: string): Promise<void> {
  const deadline = Date.now() + APP_STATE_LOCK_WAIT_MS;
  for (;;) {
    try {
      await atomicCreateJson(lockPath, { pid: process.pid, token });
      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    const holder = await readAppStateLock(lockPath);
    if (holder.pid !== undefined && isProcessAlive(holder.pid)) {
      if (Date.now() >= deadline) {
        throw new Error(`app state is locked by process ${holder.pid}`);
      }
      await sleep(APP_STATE_LOCK_RETRY_MS);
      continue;
    }

    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      await rename(lockPath, stalePath);
      await rm(stalePath, { force: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

async function releaseAppStateLock(lockPath: string, token: string): Promise<void> {
  try {
    const current = await readAppStateLock(lockPath);
    if (current.token === token) await rm(lockPath, { force: true });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function readAppStateLock(lockPath: string): Promise<AppStateLockRecord> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
    return {
      ...(Number.isInteger(parsed.pid) && (parsed.pid as number) > 0
        ? { pid: parsed.pid as number }
        : {}),
      ...(typeof parsed.token === "string" && parsed.token.length > 0
        ? { token: parsed.token }
        : {}),
    };
  } catch {
    return {};
  }
}

function errorCode(error: unknown): string | undefined {
  let current = error;
  while (current && typeof current === "object") {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
