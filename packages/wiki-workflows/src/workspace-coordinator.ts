import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./util.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface WikiWorkspaceOwner {
  version: 1;
  pid: number;
  token: string;
  runId?: string;
  createdAt: string;
}

export interface WikiWorkspaceLock {
  workspace: string;
  owner: WikiWorkspaceOwner;
}

interface ReclaimClaim {
  version: 1;
  token: string;
  ownerToken: string;
}

export interface WikiWorkspaceCoordinator {
  acquire(runId?: string): Promise<WikiWorkspaceLock | undefined>;
  updateRun(lock: WikiWorkspaceLock, runId: string): Promise<void>;
  release(lock: WikiWorkspaceLock): Promise<void>;
  currentOwner(): Promise<WikiWorkspaceOwner | undefined>;
}

export function createWikiWorkspaceCoordinator(workspace: string): WikiWorkspaceCoordinator {
  const root = path.resolve(workspace);
  const stateDirectory = path.join(root, ".okf-wiki");
  const lockFile = path.join(stateDirectory, "active.lock");
  const reclaimFile = path.join(stateDirectory, "active.reclaim");
  const metadataFile = (token: string): string => path.join(stateDirectory, `.active.${token}.json`);
  let operationChain = Promise.resolve();

  const serialized = async <T>(operation: () => Promise<T>): Promise<T> => {
    let result!: T;
    const next = operationChain.catch(() => {}).then(async () => { result = await operation(); });
    operationChain = next.then(() => undefined, () => undefined);
    await next;
    return result;
  };

  const readOwner = async (): Promise<WikiWorkspaceOwner | undefined> => {
    try {
      const entry = await lstat(lockFile);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`Wiki workspace lock must be a regular file: ${lockFile}`);
      }
      const value = JSON.parse(await readFile(lockFile, "utf8")) as unknown;
      return isOwner(value) ? value : undefined;
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return undefined;
      throw error;
    }
  };

  const readCurrentOwner = async (): Promise<WikiWorkspaceOwner | undefined> => {
    const owner = await readOwner();
    if (!owner) return undefined;
    let metadata: unknown;
    try {
      metadata = JSON.parse(await readFile(metadataFile(owner.token), "utf8"));
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
    }
    const current = await readOwner();
    if (!current || current.token !== owner.token) return current;
    return isOwner(metadata) && metadata.token === owner.token ? metadata : owner;
  };

  const publishOwner = async (owner: WikiWorkspaceOwner): Promise<boolean> => {
    const temporary = path.join(stateDirectory, `.active.${owner.token}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
      await link(temporary, lockFile);
      return true;
    } catch (error) {
      if (isExists(error)) return false;
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };

  const publishClaim = async (claim: ReclaimClaim): Promise<boolean> => {
    const temporary = path.join(stateDirectory, `.reclaim.${claim.token}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(claim)}\n`, { encoding: "utf8", flag: "wx" });
      await link(temporary, reclaimFile);
      return true;
    } catch (error) {
      if (isExists(error)) return false;
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };

  const reclaimDeadOwner = async (expected: WikiWorkspaceOwner): Promise<boolean> => {
    const claim: ReclaimClaim = { version: 1, token: randomUUID(), ownerToken: expected.token };
    // Fail closed on an existing claim: portable filesystems have no conditional
    // unlink, so auto-cleaning an orphan could delete a newly published claim.
    if (!await publishClaim(claim)) return false;
    try {
      const current = await readOwner();
      if (!current || current.token !== expected.token || pidIsAlive(current.pid)) return false;
      await unlink(lockFile);
      return true;
    } catch {
      return false;
    } finally {
      await unlink(reclaimFile).catch(() => {});
    }
  };

  return {
    async acquire(runId): Promise<WikiWorkspaceLock | undefined> {
      return await serialized(async () => {
        assertRunId(runId);
        await mkdir(stateDirectory, { recursive: true });
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const owner: WikiWorkspaceOwner = {
            version: 1,
            pid: process.pid,
            token: randomUUID(),
            runId,
            createdAt: new Date().toISOString(),
          };
          if (await publishOwner(owner)) return { workspace: root, owner };
          const existing = await readOwner();
          // A malformed regular lock is fail-closed. It cannot be proven stale.
          if (!existing || pidIsAlive(existing.pid) || !await reclaimDeadOwner(existing)) return undefined;
        }
        return undefined;
      });
    },

    async updateRun(lock, runId): Promise<void> {
      await serialized(async () => {
        assertWorkspace(lock, root);
        assertRunId(runId);
        const current = await readOwner();
        if (!current || current.token !== lock.owner.token) throw new Error("Wiki workspace ownership was lost");
        const owner = { ...current, runId };
        const target = metadataFile(current.token);
        const temporary = `${target}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
        try {
          const before = await readOwner();
          if (!before || before.token !== current.token) throw new Error("Wiki workspace ownership was lost");
          await rename(temporary, target);
          const after = await readOwner();
          if (!after || after.token !== current.token) {
            await unlink(target).catch(() => {});
            throw new Error("Wiki workspace ownership was lost");
          }
        } finally {
          await unlink(temporary).catch(() => {});
        }
        lock.owner = owner;
      });
    },

    async release(lock): Promise<void> {
      await serialized(async () => {
        assertWorkspace(lock, root);
        const current = await readOwner();
        if (!current || current.token !== lock.owner.token) return;
        await unlink(lockFile).catch((error) => {
          if (!isMissing(error)) throw error;
        });
        await unlink(metadataFile(lock.owner.token)).catch((error) => {
          if (!isMissing(error)) throw error;
        });
      });
    },

    async currentOwner(): Promise<WikiWorkspaceOwner | undefined> {
      return await readCurrentOwner();
    },
  };
}

function isOwner(value: unknown): value is WikiWorkspaceOwner {
  return isRecord(value) && value.version === 1 && Number.isInteger(value.pid) && Number(value.pid) > 0
    && typeof value.token === "string" && value.token.length > 0
    && (value.runId === undefined || (typeof value.runId === "string" && SAFE_RUN_ID.test(value.runId)))
    && typeof value.createdAt === "string" && value.createdAt.length > 0;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function assertWorkspace(lock: WikiWorkspaceLock, workspace: string): void {
  if (path.resolve(lock.workspace) !== workspace) throw new Error("Wiki workspace lock belongs to a different workspace");
}

function assertRunId(runId: string | undefined): void {
  if (runId !== undefined && !SAFE_RUN_ID.test(runId)) throw new Error("Invalid Wiki run identifier");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}
