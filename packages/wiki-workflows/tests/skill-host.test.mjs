import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package.json exposes only the host skill to Pi", async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.skills, ["skills/repository-wiki-producer"]);
  assert.ok(manifest.files.includes("skills/"));
});

test("host skill routes to /wiki and does not describe wiki_plan", async () => {
  const skill = await readFile(path.join(packageRoot, "skills", "repository-wiki-producer", "SKILL.md"), "utf8");
  assert.match(skill, /name: repository-wiki-producer/);
  assert.match(skill, /Invoke the \/wiki command/);
  assert.match(skill, /\/wiki \[focus\]/);
  assert.match(skill, /\/wiki init/);
  assert.doesNotMatch(skill, /wiki_plan/);
  assert.doesNotMatch(skill, /wiki_delegate/);
});
