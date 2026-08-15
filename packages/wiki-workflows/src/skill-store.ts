import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirectory, removePath, writeFileDurable } from "./files.js";
import { stableStringify } from "./util.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const PRODUCTION_SKILL_REQUIRED_FILES = [
  "SKILL.md",
  "references/common.md",
  "references/research.md",
  "references/write.md",
  "references/review.md",
  "roles/researcher/SKILL.md",
  "roles/writer/SKILL.md",
  "roles/reviewer/SKILL.md",
] as const;

/** Packaged production skill; resolved from dist/ to ../skills/wiki-production. */
export function packagedProductionSkillRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills/wiki-production");
}

export function skillWorkspacePath(runId: string): string {
  assertRunId(runId);
  return `.okf-wiki/runs/${runId}/skill`;
}

/** Snapshot the production skill for a fresh run; resume only verifies that snapshot. */
export async function materializeProductionSkill(
  workspace: string,
  runId: string,
  sourceRoot = packagedProductionSkillRoot(),
  preparation: "fresh" | "resume" = "fresh",
): Promise<string> {
  assertRunId(runId);
  const destination = path.resolve(workspace, skillWorkspacePath(runId));
  if (preparation === "resume") {
    await assertProductionSkillTree(destination, "Materialized Wiki production skill");
    return destination;
  }
  await assertProductionSkillTree(sourceRoot, "Packaged Wiki production skill");
  await removePath(destination, { recursive: true, force: true });
  await ensureDirectory(destination);
  await copyProductionSkillTree(sourceRoot, destination);
  await assertProductionSkillTree(destination, "Materialized Wiki production skill");
  return destination;
}

/** Digest the exact pinned skill tree, including empty and dot directories. */
export async function digestProductionSkillTree(root: string): Promise<string> {
  const entries: Array<{ path: string; type: "directory" } | { path: string; type: "file"; digest: string }> = [];
  await visitSkillTree(path.resolve(root), async (absolute, relative, type) => {
    if (type === "directory") entries.push({ path: relative, type });
    else entries.push({ path: relative, type, digest: createHash("sha256").update(await readFile(absolute)).digest("hex") });
  });
  return createHash("sha256").update(stableStringify(entries)).digest("hex");
}

export async function assertProductionSkillTree(root: string, label: string): Promise<void> {
  for (const relative of PRODUCTION_SKILL_REQUIRED_FILES) {
    const file = path.join(root, ...relative.split("/"));
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not a regular file: ${relative}`);
    } catch (error) {
      if (isMissing(error)) throw new Error(`${label} is missing ${relative}`);
      throw error;
    }
  }
}

async function copyProductionSkillTree(source: string, destination: string): Promise<void> {
  await visitSkillTree(path.resolve(source), async (absolute, relative, type) => {
    const target = path.join(destination, ...relative.split("/"));
    if (type === "directory") await ensureDirectory(target);
    else await writeFileDurable(target, await readFile(absolute));
  });
}

async function visitSkillTree(
  root: string,
  visit: (absolute: string, relative: string, type: "directory" | "file") => void | Promise<void>,
): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Wiki production skill contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) { await visit(absolute, relative, "directory"); await walk(absolute); }
      else if (entry.isFile()) await visit(absolute, relative, "file");
      else throw new Error(`Wiki production skill contains a non-regular entry: ${relative}`);
    }
  };
  await walk(root);
}

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`Invalid Wiki run id: ${runId}`);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
