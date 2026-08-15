import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { wikiRoleBrief } from "../dist/skill-briefs.js";
import {
  PRODUCTION_SKILL_REQUIRED_FILES,
  materializeProductionSkill,
  packagedProductionSkillRoot,
  skillWorkspacePath,
} from "../dist/skill-store.js";

test("packaged production skill contains required files and not the host skill", async () => {
  const root = packagedProductionSkillRoot();
  assert.match(root, /skills\/wiki-production$/);
  for (const relative of PRODUCTION_SKILL_REQUIRED_FILES) {
    await readFile(path.join(root, ...relative.split("/")), "utf8");
  }
  const production = await readFile(path.join(root, "SKILL.md"), "utf8");
  assert.match(production, /wiki_plan/);
  assert.doesNotMatch(production, /\/wiki init/);
});

test("materialize copies the production skill into the run directory", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const skillRoot = await materializeProductionSkill(workspace, "run-1");
  assert.equal(skillRoot, path.resolve(workspace, skillWorkspacePath("run-1")));
  const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  assert.match(skill, /wiki_plan/);
  assert.doesNotMatch(skill, /\/wiki init/);
  await readFile(path.join(skillRoot, "references", "templates", "overview.md"), "utf8");
});

test("materialize replaces a stale copy and fails when the source tree is incomplete", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const first = await materializeProductionSkill(workspace, "run-2");
  await writeFile(path.join(first, "STALE.md"), "stale\n");
  const second = await materializeProductionSkill(workspace, "run-2");
  await assert.rejects(readFile(path.join(second, "STALE.md"), "utf8"), { code: "ENOENT" });

  const broken = path.join(workspace, "broken-skill");
  await mkdir(broken);
  await writeFile(path.join(broken, "SKILL.md"), "# incomplete\n");
  await assert.rejects(materializeProductionSkill(workspace, "run-3", broken), /missing references\/common.md/);
});

test("resume rematerializes a missing production skill directory", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const skillRoot = await materializeProductionSkill(workspace, "run-4");
  await rm(skillRoot, { recursive: true, force: true });
  const restored = await materializeProductionSkill(workspace, "run-4");
  await readFile(path.join(restored, "SKILL.md"), "utf8");
});

test("role briefs load assigned files and reject missing ones", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const skillRoot = await materializeProductionSkill(workspace, "run-5");
  const lead = wikiRoleBrief(skillRoot, "lead");
  assert.match(lead, /wiki_plan/);
  assert.match(lead, /path#Lx-Ly/);
  assert.doesNotMatch(lead, /\/wiki init/);
  assert.match(wikiRoleBrief(skillRoot, "researcher"), /Write `brief\.md`/);
  assert.match(wikiRoleBrief(skillRoot, "writer"), /templates\/<pageType>\.md/);
  assert.match(wikiRoleBrief(skillRoot, "reviewer"), /wiki_review_finish/);
  await rm(path.join(skillRoot, "references", "write.md"));
  assert.throws(() => wikiRoleBrief(skillRoot, "writer"), /missing references\/write.md/);
});
