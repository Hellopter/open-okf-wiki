import { readFileSync } from "node:fs";
import path from "node:path";

export type WikiSkillRole = "lead" | "researcher" | "writer" | "reviewer";

const ROLE_FILES: Record<WikiSkillRole, readonly string[]> = {
  lead: ["SKILL.md", "references/common.md"],
  researcher: ["references/common.md", "references/research.md"],
  writer: ["references/common.md", "references/write.md"],
  reviewer: ["references/common.md", "references/review.md"],
};

/** Concatenate the assigned role's required skill files from a materialized skill root. */
export function wikiRoleBrief(skillRoot: string, role: WikiSkillRole): string {
  const files = ROLE_FILES[role];
  if (!files) throw new Error(`Unknown Wiki skill role: ${role}`);
  return files.map((relative) => readSkillFile(skillRoot, relative)).join("\n\n");
}

function readSkillFile(skillRoot: string, relative: string): string {
  const file = path.join(skillRoot, ...relative.split("/"));
  try {
    const text = readFileSync(file, "utf8").trim();
    if (!text) throw new Error(`Wiki production skill file is empty: ${relative}`);
    return text;
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Wiki production skill is missing ${relative}`);
    }
    throw error;
  }
}
