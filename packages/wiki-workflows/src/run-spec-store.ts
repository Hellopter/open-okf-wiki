import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseWikiSpec, type WikiSpec } from "./wiki-spec.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface WikiRunSpecRecord {
  version: 1;
  runId: string;
  revision: number;
  updatedAt: string;
  spec: WikiSpec;
}

export function createWikiRunSpecStore(options: { workspace: string; now?: () => string }) {
  const runsRoot = path.join(path.resolve(options.workspace), ".okf-wiki", "runs");
  const now = options.now ?? (() => new Date().toISOString());
  let operations = Promise.resolve();
  const location = (runId: string): string => {
    if (!SAFE_RUN_ID.test(runId)) throw new Error("Invalid Wiki run spec identifier");
    return path.join(runsRoot, runId, "spec.json");
  };
  const read = async (runId: string): Promise<WikiRunSpecRecord | undefined> => {
    const file = location(runId);
    try {
      const entry = await lstat(file);
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Wiki run spec must be a regular file: ${file}`);
      return parseRecord(JSON.parse(await readFile(file, "utf8")), runId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };
  const enqueue = async <T>(operation: () => Promise<T>): Promise<T> => {
    let result!: T;
    const next = operations.catch(() => {}).then(async () => { result = await operation(); });
    operations = next.catch(() => {});
    await next;
    return result;
  };
  return {
    read,
    async save(runId: string, spec: WikiSpec, expectedRevision?: number): Promise<WikiRunSpecRecord> {
      return await enqueue(async () => {
        const current = await read(runId);
        if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) {
          throw new Error(`WikiSpec revision conflict for run ${runId}: expected ${expectedRevision}, found ${current?.revision ?? 0}`);
        }
        const record: WikiRunSpecRecord = {
          version: 1,
          runId,
          revision: (current?.revision ?? 0) + 1,
          updatedAt: now(),
          spec: parseWikiSpec(spec),
        };
        await writeAtomic(location(runId), `${JSON.stringify(record)}\n`);
        return record;
      });
    },
  };
}

function parseRecord(value: unknown, runId: string): WikiRunSpecRecord {
  if (!value || typeof value !== "object") throw new Error(`Invalid Wiki run spec for run ${runId}`);
  const record = value as Partial<WikiRunSpecRecord>;
  if (record.version !== 1 || record.runId !== runId || !Number.isSafeInteger(record.revision) || (record.revision ?? 0) < 1 || typeof record.updatedAt !== "string") {
    throw new Error(`Invalid Wiki run spec for run ${runId}`);
  }
  return { version: 1, runId, revision: record.revision!, updatedAt: record.updatedAt, spec: parseWikiSpec(record.spec) };
}

async function writeAtomic(location: string, content: string): Promise<void> {
  await mkdir(path.dirname(location), { recursive: true });
  const temporary = `${location}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, location);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
