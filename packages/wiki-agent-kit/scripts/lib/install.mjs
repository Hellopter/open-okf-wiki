/**
 * Install kit workflows + skill into a workspace.
 */

import fs from "node:fs";
import path from "node:path";
import {
  agentsSkillsDir,
  claudeSkillsDir,
  claudeWorkflowsDir,
  kitSkillDir,
  kitWorkflowsDir,
} from "./paths.mjs";
import { hashTree } from "./artifacts.mjs";

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
  if (force) {
    for (const legacy of ["wiki-produce.workflow.js"]) {
      fs.rmSync(path.join(destDir, legacy), { force: true });
    }
  }
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
  const source = kitSkillDir();
  const targets = [agentsSkillsDir(root), claudeSkillsDir(root)];
  const installs = targets.map((dest) => copyDir(source, dest, opts));
  const expectedDigest = hashTree(source).digest;
  return {
    kind: "skill",
    expectedDigest,
    installs: installs.map((install) => ({
      ...install,
      digest: fs.existsSync(install.dest) ? hashTree(install.dest).digest : null,
    })),
  };
}

export function installAll(root, opts = {}) {
  return {
    workflows: installWorkflows(root, opts),
    skill: installSkill(root, opts),
  };
}

export function assertInstalledAssets(root) {
  const expectedSkillDigest = hashTree(kitSkillDir()).digest;
  const skillTargets = [agentsSkillsDir(root), claudeSkillsDir(root)];
  const errors = [];
  for (const target of skillTargets) {
    if (!fs.existsSync(target)) {
      errors.push(`missing installed skill: ${target}`);
    } else if (hashTree(target).digest !== expectedSkillDigest) {
      errors.push(`installed skill drifted from kit: ${target}`);
    }
  }
  for (const name of ["wiki-plan.workflow.js", "wiki-write-review.workflow.js"]) {
    const source = path.join(kitWorkflowsDir(), name);
    const target = path.join(claudeWorkflowsDir(root), name);
    if (!fs.existsSync(target)) errors.push(`missing installed workflow: ${target}`);
    else if (fs.readFileSync(source, "utf8") !== fs.readFileSync(target, "utf8")) {
      errors.push(`installed workflow drifted from kit: ${target}`);
    }
  }
  if (errors.length) {
    throw new Error(`${errors.join("; ")}. Run: ow install all --force`);
  }
  return { ok: true, skillDigest: expectedSkillDigest };
}

export function ensureWorkflowsInstalled(root) {
  const destDir = claudeWorkflowsDir(root);
  const plan = path.join(destDir, "wiki-plan.workflow.js");
  const writeReview = path.join(destDir, "wiki-write-review.workflow.js");
  if (!fs.existsSync(plan) || !fs.existsSync(writeReview)) {
    installWorkflows(root, { force: false });
  }
  return {
    planPath: plan,
    writeReviewPath: writeReview,
    exists: fs.existsSync(plan) && fs.existsSync(writeReview),
  };
}
