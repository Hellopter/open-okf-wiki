import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  AGENTS_DIR_NAME,
  defaultServerLogDir,
  homeProducerSkillPath,
  homeSkillsDir,
  isUnderHomeSkills,
  isUnderWorkspaceSkills,
  PRODUCT_LOGS_DIR_NAME,
  productHomeDir,
  SKILLS_DIR_NAME,
  workspaceProducerSkillPath,
  workspaceSkillsDir,
} from "./product-home.js";
import { WORKSPACE_DIR_NAME } from "./run-layout.js";
import { copySkillTree, skillForkDir } from "./skill-fork.js";
import {
  type AppState,
  DEFAULT_LOAD_HOME_SKILLS,
  resolveLoadHomeSkills,
  setLoadHomeSkills,
  writeAppState,
} from "./workspace-app-state.js";

const prevHome = process.env.HOME;
const prevOkfHome = process.env.OKF_WIKI_HOME;

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = prevHome;
  }
  if (prevOkfHome === undefined) {
    delete process.env.OKF_WIKI_HOME;
  } else {
    process.env.OKF_WIKI_HOME = prevOkfHome;
  }
});

test("productHomeDir uses OKF_WIKI_HOME when set", async () => {
  const custom = await mkdtemp(path.join(tmpdir(), "okf-product-home-"));
  assert.equal(productHomeDir({ OKF_WIKI_HOME: custom }), path.resolve(custom));
  assert.equal(
    defaultServerLogDir({ OKF_WIKI_HOME: custom }),
    path.join(path.resolve(custom), PRODUCT_LOGS_DIR_NAME),
  );
});

test("productHomeDir falls back to {homedir}/.okf-wiki", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "okf-home-product-"));
  process.env.HOME = fakeHome;
  delete process.env.OKF_WIKI_HOME;
  assert.equal(productHomeDir({}), path.join(fakeHome, WORKSPACE_DIR_NAME));
  assert.equal(
    defaultServerLogDir({}),
    path.join(fakeHome, WORKSPACE_DIR_NAME, PRODUCT_LOGS_DIR_NAME),
  );
});

test("home skills use portable ~/.agents/skills", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "okf-home-agents-"));
  process.env.HOME = fakeHome;
  assert.equal(homeSkillsDir(), path.join(fakeHome, AGENTS_DIR_NAME, SKILLS_DIR_NAME));
  assert.equal(
    homeProducerSkillPath(),
    path.join(fakeHome, ".agents", "skills", "repository-wiki-producer"),
  );
  assert.equal(isUnderHomeSkills(homeProducerSkillPath()), true);
  assert.equal(isUnderHomeSkills("/tmp/other"), false);
});

test("workspace skills use {root}/.agents/skills", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-ws-agents-"));
  assert.equal(workspaceSkillsDir(root), path.join(root, ".agents", "skills"));
  assert.equal(
    workspaceProducerSkillPath(root),
    path.join(root, ".agents", "skills", "repository-wiki-producer"),
  );
  assert.equal(skillForkDir(root), workspaceProducerSkillPath(root));
  assert.equal(isUnderWorkspaceSkills(root, skillForkDir(root)), true);
  assert.equal(isUnderWorkspaceSkills(root, path.join(root, ".okf-wiki")), false);
});

test("resolveLoadHomeSkills reads app.json only (no env)", () => {
  assert.equal(resolveLoadHomeSkills({}), DEFAULT_LOAD_HOME_SKILLS);
  assert.equal(resolveLoadHomeSkills({ loadHomeSkills: false }), false);
  assert.equal(resolveLoadHomeSkills({ loadHomeSkills: true }), true);
  // Env must not affect page setting
  process.env.OKF_WIKI_LOAD_HOME_SKILLS = "0";
  assert.equal(resolveLoadHomeSkills({ loadHomeSkills: true }), true);
  delete process.env.OKF_WIKI_LOAD_HOME_SKILLS;
});

test("setLoadHomeSkills persists in app.json", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "okf-app-skills-"));
  const appStatePath = path.join(home, "app.json");
  const result = await setLoadHomeSkills(false, appStatePath);
  assert.equal(result.state.loadHomeSkills, false);
  const raw = JSON.parse(await readFile(appStatePath, "utf8")) as AppState;
  assert.equal(raw.loadHomeSkills, false);

  await writeAppState(appStatePath, {
    version: 1,
    recentRootPaths: ["/ws"],
    loadHomeSkills: true,
  });
  const again = JSON.parse(await readFile(appStatePath, "utf8")) as AppState;
  assert.equal(again.loadHomeSkills, true);
  assert.deepEqual(again.recentRootPaths, ["/ws"]);
});

test("copySkillTree seeds once unless force", async () => {
  const source = await mkdtemp(path.join(tmpdir(), "okf-src-skill-"));
  const destRoot = await mkdtemp(path.join(tmpdir(), "okf-dest-skill-"));
  const dest = path.join(destRoot, "repository-wiki-producer");
  await writeFile(path.join(source, "SKILL.md"), "# src\n");

  const first = await copySkillTree({ sourceSkillPath: source, destSkillPath: dest });
  assert.equal(first.seeded, true);
  await writeFile(path.join(dest, "SKILL.md"), "# customized\n");

  const second = await copySkillTree({ sourceSkillPath: source, destSkillPath: dest });
  assert.equal(second.seeded, false);
  assert.equal(await readFile(path.join(dest, "SKILL.md"), "utf8"), "# customized\n");

  const forced = await copySkillTree({
    sourceSkillPath: source,
    destSkillPath: dest,
    force: true,
  });
  assert.equal(forced.seeded, true);
  assert.equal(await readFile(path.join(dest, "SKILL.md"), "utf8"), "# src\n");
});
