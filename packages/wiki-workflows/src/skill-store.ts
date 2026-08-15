import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const PRODUCTION_SKILL_REQUIRED_FILES = [
  "SKILL.md",
  "references/common.md",
  "references/research.md",
  "references/write.md",
  "references/review.md",
] as const;

/** Packaged production skill; resolved from dist/ to ../skills/wiki-production. */
export function packagedProductionSkillRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills/wiki-production");
}

export function skillWorkspacePath(runId: string): string {
  assertRunId(runId);
  return `.okf-wiki/runs/${runId}/skill`;
}

/** Copy the packaged production skill into the run directory. Replaces a stale copy. */
export async function materializeProductionSkill(
  workspace: string,
  runId: string,
  sourceRoot = packagedProductionSkillRoot(),
): Promise<string> {
  assertRunId(runId);
  await assertProductionSkillTree(sourceRoot, "Packaged Wiki production skill");
  const destination = path.resolve(workspace, skillWorkspacePath(runId));
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(sourceRoot, destination, { recursive: true });
  await assertProductionSkillTree(destination, "Materialized Wiki production skill");
  return destination;
}

export async function assertProductionSkillTree(root: string, label: string): Promise<void> {
  for (const relative of PRODUCTION_SKILL_REQUIRED_FILES) {
    const file = path.join(root, ...relative.split("/"));
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`${label} is not a file: ${relative}`);
    } catch (error) {
      if (isMissing(error)) throw new Error(`${label} is missing ${relative}`);
      throw error;
    }
  }
}

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`Invalid Wiki run id: ${runId}`);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
