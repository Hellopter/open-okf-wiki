import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PRODUCTION_SKILL_REQUIRED_FILES,
  digestProductionSkillTree,
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
  for (const role of ["researcher", "writer", "reviewer"]) {
    const roleSkill = await readFile(path.join(root, "roles", role, "SKILL.md"), "utf8");
    assert.match(roleSkill, new RegExp(`name: wiki-production-${role}`));
  }
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

test("resume preserves the run skill snapshot and rejects a missing snapshot", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const skillRoot = await materializeProductionSkill(workspace, "run-4");
  await writeFile(path.join(skillRoot, "SNAPSHOT.md"), "pinned\n");
  const restored = await materializeProductionSkill(workspace, "run-4", undefined, "resume");
  assert.equal(await readFile(path.join(restored, "SNAPSHOT.md"), "utf8"), "pinned\n");
  await rm(skillRoot, { recursive: true, force: true });
  await assert.rejects(materializeProductionSkill(workspace, "run-4", undefined, "resume"), /missing SKILL\.md/);
});

test("skill digest pins every file, dot entry, and empty directory and rejects symlinks", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const skillRoot = await materializeProductionSkill(workspace, "digest-run");
  const initial = await digestProductionSkillTree(skillRoot);
  assert.match(initial, /^[a-f0-9]{64}$/);
  assert.equal(await digestProductionSkillTree(await materializeProductionSkill(workspace, "digest-run", undefined, "resume")), initial);

  await writeFile(path.join(skillRoot, ".pinned"), "one\n");
  const withDotfile = await digestProductionSkillTree(skillRoot);
  assert.notEqual(withDotfile, initial);
  await mkdir(path.join(skillRoot, ".empty"));
  const withEmptyDirectory = await digestProductionSkillTree(skillRoot);
  assert.notEqual(withEmptyDirectory, withDotfile);
  await writeFile(path.join(skillRoot, "SNAPSHOT.md"), "changed\n");
  assert.notEqual(await digestProductionSkillTree(skillRoot), withEmptyDirectory);

  await symlink(path.join(skillRoot, "SKILL.md"), path.join(skillRoot, "linked-skill"));
  await assert.rejects(digestProductionSkillTree(skillRoot), /symbolic link/);
});

test("role skills point to the shared and assigned production references", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const skillRoot = await materializeProductionSkill(workspace, "run-5");
  const researcher = await readFile(path.join(skillRoot, "roles", "researcher", "SKILL.md"), "utf8");
  const writer = await readFile(path.join(skillRoot, "roles", "writer", "SKILL.md"), "utf8");
  const reviewer = await readFile(path.join(skillRoot, "roles", "reviewer", "SKILL.md"), "utf8");
  assert.match(researcher, /references\/research\.md/);
  assert.match(researcher, /wiki_research_finish/);
  assert.match(writer, /references\/write\.md/);
  assert.match(reviewer, /references\/review\.md/);
  assert.match(reviewer, /wiki_review_finish/);
});
