import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
export async function writeText(location: string, text: string): Promise<void> {
  const directory = path.dirname(location);
  const temporary = path.join(directory, `.${path.basename(location)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, "utf8");
    await rename(temporary, location);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
