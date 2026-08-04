/**
 * Install kit workflows + skill into a workspace.
 */

import fs from "node:fs";
import path from "node:path";
import {
  agentsSkillsDir,
  claudeWorkflowsDir,
  kitSkillDir,
  kitWorkflowsDir,
} from "./paths.mjs";

function copyDir(src, dest, { force = false } = {}) {
  if (!fs.existsSync(src)) throw new Error(`missing kit asset: ${src}`);
  if (fs.existsSync(dest)) {
    if (!force) return { skipped: true, dest };
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return { skipped: false, dest };
}

function copyWorkflows(root, { force = false } = {}) {
  const srcDir = kitWorkflowsDir();
  const destDir = claudeWorkflowsDir(root);
  fs.mkdirSync(destDir, { recursive: true });
  if (!fs.existsSync(srcDir)) {
    return { files: [], note: "no kit workflows yet" };
  }
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js"));
  const results = [];
  for (const f of files) {
    const from = path.join(srcDir, f);
    const to = path.join(destDir, f);
    if (fs.existsSync(to) && !force) {
      results.push({ file: f, skipped: true });
      continue;
    }
    fs.copyFileSync(from, to);
    results.push({ file: f, skipped: false });
  }
  return { files: results, destDir };
}

export function installWorkflows(root, opts = {}) {
  return copyWorkflows(root, opts);
}

export function installSkill(root, opts = {}) {
  const dest = agentsSkillsDir(root);
  return { ...copyDir(kitSkillDir(), dest, opts), kind: "skill" };
}

export function installAll(root, opts = {}) {
  return {
    workflows: installWorkflows(root, opts),
    skill: installSkill(root, opts),
  };
}

export function ensureWorkflowsInstalled(root) {
  const destDir = claudeWorkflowsDir(root);
  const produce = path.join(destDir, "wiki-produce.workflow.js");
  if (!fs.existsSync(produce)) {
    installWorkflows(root, { force: false });
  }
  // if kit still has no produce file, that's ok for early phases
  return { producePath: produce, exists: fs.existsSync(produce) };
}
