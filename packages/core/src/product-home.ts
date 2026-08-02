/**
 * Cross-tool Agent Skills layout (agentskills.io / Codex / Grok):
 *
 * - User:      `~/.agents/skills/<name>/SKILL.md`
 * - Workspace: `{root}/.agents/skills/<name>/SKILL.md`
 *
 * Product meta (`~/.okf-wiki`, `{root}/.okf-wiki`) stays separate — skills use
 * the portable `.agents` directory, not a product-private path.
 */

import { homedir } from "node:os";
import path from "node:path";
import { WORKSPACE_DIR_NAME } from "./run-layout.js";

/** Frontmatter / directory name of the product Producer Skill. */
export const DEFAULT_PRODUCER_SKILL_NAME = "repository-wiki-producer";

/** Portable agents root directory name (project + user). */
export const AGENTS_DIR_NAME = ".agents";

/** Skills subdirectory under `.agents` (Agent Skills convention). */
export const SKILLS_DIR_NAME = "skills";

/** Subdirectory under product home for server runtime logs. */
export const PRODUCT_LOGS_DIR_NAME = "logs";

/**
 * Machine-local product home (app index, provider catalog, server logs).
 * `$OKF_WIKI_HOME` when set, otherwise `{homedir}/.okf-wiki`.
 * Cross-platform via `os.homedir()` + `path.join` (Windows: `%USERPROFILE%\.okf-wiki`).
 */
export function productHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.OKF_WIKI_HOME?.trim();
  if (home) return path.resolve(home);
  return path.join(homedir(), WORKSPACE_DIR_NAME);
}

/**
 * Default directory for server runtime logs: `{productHome}/logs`.
 * Not under a Workspace rootPath — agent traces stay workspace-local.
 */
export function defaultServerLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(productHomeDir(env), PRODUCT_LOGS_DIR_NAME);
}

/**
 * User-level skills directory: `~/.agents/skills`.
 * Independent of `$OKF_WIKI_HOME` (that only holds product app/provider state).
 */
export function homeSkillsDir(): string {
  return path.join(homedir(), AGENTS_DIR_NAME, SKILLS_DIR_NAME);
}

/**
 * User-level Producer Skill path:
 * `~/.agents/skills/repository-wiki-producer`.
 */
export function homeProducerSkillPath(skillName: string = DEFAULT_PRODUCER_SKILL_NAME): string {
  const name = skillName.trim() || DEFAULT_PRODUCER_SKILL_NAME;
  return path.join(homeSkillsDir(), name);
}

/**
 * Workspace-level skills directory: `{root}/.agents/skills`.
 */
export function workspaceSkillsDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), AGENTS_DIR_NAME, SKILLS_DIR_NAME);
}

/**
 * Workspace-level Producer Skill path:
 * `{root}/.agents/skills/repository-wiki-producer`.
 */
export function workspaceProducerSkillPath(
  workspaceRoot: string,
  skillName: string = DEFAULT_PRODUCER_SKILL_NAME,
): string {
  const name = skillName.trim() || DEFAULT_PRODUCER_SKILL_NAME;
  return path.join(workspaceSkillsDir(workspaceRoot), name);
}

/** True when `candidate` is under the user `~/.agents/skills` tree. */
export function isUnderHomeSkills(candidate: string): boolean {
  const root = path.resolve(homeSkillsDir());
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** True when `candidate` is under `{workspaceRoot}/.agents/skills`. */
export function isUnderWorkspaceSkills(workspaceRoot: string, candidate: string): boolean {
  const root = path.resolve(workspaceSkillsDir(workspaceRoot));
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}
