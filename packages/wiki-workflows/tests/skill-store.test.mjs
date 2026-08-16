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
  pin,
  reopen,
  skillWorkspacePath,
} from "../dist/skill-store.js";

test("packaged production skill contains required files and not the host skill", async () => {
  const root = packagedProductionSkillRoot();
  assert.match(root, /skills\/wiki-production$/);
  assert.ok(PRODUCTION_SKILL_REQUIRED_FILES.includes("briefs/researcher.md"));
  assert.ok(PRODUCTION_SKILL_REQUIRED_FILES.includes("briefs/writer.md"));
  assert.ok(PRODUCTION_SKILL_REQUIRED_FILES.includes("briefs/reviewer.md"));
  assert.ok(PRODUCTION_SKILL_REQUIRED_FILES.includes("references/topology.md"));
  assert.ok(PRODUCTION_SKILL_REQUIRED_FILES.every((relative) => !relative.startsWith("roles/")));
  for (const relative of PRODUCTION_SKILL_REQUIRED_FILES) {
    await readFile(path.join(root, ...relative.split("/")), "utf8");
  }
  const production = await readFile(path.join(root, "SKILL.md"), "utf8");
  assert.match(production, /wiki_plan/);
  assert.doesNotMatch(production, /\/wiki init/);
});

test("pin copies the production skill into the run directory", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const pinned = await pin(workspace, "run-1");
  assert.equal(pinned.root, path.resolve(workspace, skillWorkspacePath("run-1")));
  assert.match(pinned.digest, /^[a-f0-9]{64}$/);
  const skill = await readFile(path.join(pinned.root, "SKILL.md"), "utf8");
  assert.match(skill, /wiki_plan/);
  assert.doesNotMatch(skill, /\/wiki init/);
  await readFile(path.join(pinned.root, "references", "templates", "overview.md"), "utf8");
});

test("pin replaces a stale copy and fails when the source tree is incomplete", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const first = await pin(workspace, "run-2");
  await writeFile(path.join(first.root, "STALE.md"), "stale\n");
  const second = await pin(workspace, "run-2");
  await assert.rejects(readFile(path.join(second.root, "STALE.md"), "utf8"), { code: "ENOENT" });
  assert.equal(second.digest, first.digest);

  const broken = path.join(workspace, "broken-skill");
  await mkdir(broken);
  await writeFile(path.join(broken, "SKILL.md"), "# incomplete\n");
  await assert.rejects(materializeProductionSkill(workspace, "run-3", broken), /missing briefs\/researcher.md/);
});

test("reopen verifies the pinned digest and rejects a missing snapshot", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const pinned = await pin(workspace, "run-4");
  const restored = await reopen(workspace, "run-4", pinned.digest);
  assert.equal(restored.root, pinned.root);
  assert.equal(restored.digest, pinned.digest);
  await rm(pinned.root, { recursive: true, force: true });
  await assert.rejects(reopen(workspace, "run-4", pinned.digest), /missing SKILL\.md/);
});

test("reopen fails closed when the pinned skill digest no longer matches", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const pinned = await pin(workspace, "run-mismatch");
  await assert.rejects(reopen(workspace, "run-mismatch", "a".repeat(64)), /production skill changed/);
  await assert.rejects(reopen(workspace, "run-mismatch", "not-a-digest"), /digest is invalid/);
  await writeFile(path.join(pinned.root, "SNAPSHOT.md"), "tampered\n");
  await assert.rejects(reopen(workspace, "run-mismatch", pinned.digest), /production skill changed/);
});

test("skill digest pins every file, dot entry, and empty directory and rejects symlinks", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const pinned = await pin(workspace, "digest-run");
  assert.match(pinned.digest, /^[a-f0-9]{64}$/);
  assert.equal((await reopen(workspace, "digest-run", pinned.digest)).digest, pinned.digest);

  await writeFile(path.join(pinned.root, ".pinned"), "one\n");
  const withDotfile = await digestProductionSkillTree(pinned.root);
  assert.notEqual(withDotfile, pinned.digest);
  await assert.rejects(reopen(workspace, "digest-run", pinned.digest), /production skill changed/);
  await mkdir(path.join(pinned.root, ".empty"));
  const withEmptyDirectory = await digestProductionSkillTree(pinned.root);
  assert.notEqual(withEmptyDirectory, withDotfile);
  await writeFile(path.join(pinned.root, "SNAPSHOT.md"), "changed\n");
  assert.notEqual(await digestProductionSkillTree(pinned.root), withEmptyDirectory);

  await symlink(path.join(pinned.root, "SKILL.md"), path.join(pinned.root, "linked-skill"));
  await assert.rejects(digestProductionSkillTree(pinned.root), /symbolic link/);
  await assert.rejects(reopen(workspace, "digest-run", pinned.digest), /symbolic link/);
});

test("briefs point to the shared and assigned production references", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const { root: skillRoot } = await pin(workspace, "run-5");
  const researcher = await readFile(path.join(skillRoot, "briefs", "researcher.md"), "utf8");
  const writer = await readFile(path.join(skillRoot, "briefs", "writer.md"), "utf8");
  const reviewer = await readFile(path.join(skillRoot, "briefs", "reviewer.md"), "utf8");
  assert.match(researcher, /references\/research\.md/);
  assert.match(researcher, /wiki_research_finish/);
  assert.match(writer, /references\/write\.md/);
  assert.match(writer, /references\/templates\/<pageType>\.md/);
  assert.match(reviewer, /references\/review\.md/);
  assert.match(reviewer, /wiki_review_finish/);
});
