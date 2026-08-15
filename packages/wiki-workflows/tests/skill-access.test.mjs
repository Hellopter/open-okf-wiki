import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { workflowTools, workspaceToolPolicy } from "../dist/agent-tools.js";
import { materializeProductionSkill, skillWorkspacePath } from "../dist/skill-store.js";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-access-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "a.ts"), "export const a = true;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: source });
  await writeFile(path.join(root, "workspace.yaml"), [
    "version: 1", "language: en", "defaultSourceIgnores: true",
    "wiki:", "  exclude: []", "  terminology: {}", "  domains: []",
    "sources:", "  - path: source", "    origin:", "      type: link", `      localPath: ${JSON.stringify(source)}`, "",
  ].join("\n"));
  const candidateWikiRoot = path.join(root, ".okf-wiki", "runs", "run-1", "candidate", "wiki");
  await mkdir(candidateWikiRoot, { recursive: true });
  await mkdir(path.join(root, "wiki"), { recursive: true });
  await writeFile(path.join(root, "wiki", "secret.md"), "published\n");
  const skillRoot = await materializeProductionSkill(root, "run-1");
  return { root, candidateWikiRoot, skillRoot };
}

async function call(tools, name, params) {
  const tool = tools.find((value) => value.name === name);
  assert.ok(tool, `missing ${name}`);
  return await tool.execute("call-1", params, new AbortController().signal);
}

test("Lead and leaves can read the materialized skill but cannot write it", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const policy = await workspaceToolPolicy(root, candidateWikiRoot, skillRoot);
  const skillFile = path.join(skillWorkspacePath("run-1"), "SKILL.md");
  const lead = workflowTools(policy, "lead", undefined, ["source"]);
  const read = await call(lead, "read", { path: skillFile });
  assert.match(JSON.stringify(read), /wiki_plan/);

  await assert.rejects(call(lead, "write", { path: skillFile, content: "hijack\n" }), /candidate Wiki|outside|not assigned|Lead may write/);

  const researcher = workflowTools(policy, "researcher", undefined, ["source"]);
  const researchRead = await call(researcher, "read", { path: skillFile });
  assert.match(JSON.stringify(researchRead), /wiki_plan/);
  await assert.rejects(call(researcher, "read", { path: "wiki/secret.md" }), /outside the permitted workspace scope/);
});
