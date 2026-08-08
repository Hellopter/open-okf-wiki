import { createHash } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readText(file: string): Promise<string> {
  return readFile(file, "utf8");
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readText(file)) as T;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeJson(file: string, value: unknown, id: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${id}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function writeText(file: string, value: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value, "utf8");
}

export async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function hashFile(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export interface TreeHash {
  digest: string;
  fileCount: number;
  files: Array<{ path: string; digest: string; size: number }>;
}

export async function hashTree(root: string): Promise<TreeHash> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error(`cannot hash a non-directory tree: ${root}`);
  const files: Array<{ path: string; digest: string; size: number }> = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) {
        const info = await stat(child);
        files.push({ path: childRelative, digest: await hashFile(child), size: info.size });
      } else throw new Error(`cannot hash unsafe tree entry: ${childRelative}`);
    }
  }
  await visit(root);
  const digest = createHash("sha256").update(files.map((file) => `${file.path}\0${file.digest}\0${file.size}\n`).join("")).digest("hex");
  return { digest, fileCount: files.length, files };
}

export async function copyDirectory(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, dereference: false, errorOnExist: false, force: true });
}

export async function copyRegularFile(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

export async function realDirectory(directory: string): Promise<string> {
  const resolved = await realpath(directory);
  if (!(await stat(resolved)).isDirectory()) throw new Error(`not a directory: ${directory}`);
  return resolved;
}
