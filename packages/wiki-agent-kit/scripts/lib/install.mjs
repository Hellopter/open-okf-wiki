/**
 * Install kit workflows + method skill + human entry skill into a workspace.
 */

import fs from "node:fs";
import path from "node:path";
import {
  agentsSkillsDir,
  claudeEntrySkillDir,
  claudeSkillsDir,
  claudeWorkflowsDir,
  kitEntrySkillDir,
  kitSkillDir,
  kitWorkflowsDir,
  REQUIRED_WORKFLOWS,
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

/** Method skill (hidden from human slash menu; frozen into runs). */
export function installSkill(root, opts = {}) {
  const source = kitSkillDir();
  const targets = [agentsSkillsDir(root), claudeSkillsDir(root)];
  const installs = targets.map((dest) => copyDir(source, dest, opts));
  const expectedDigest = hashTree(source).digest;
  return {
    kind: "method-skill",
    expectedDigest,
    installs: installs.map((install) => ({
      ...install,
      digest: fs.existsSync(install.dest) ? hashTree(install.dest).digest : null,
    })),
  };
}

/** Human entry skill (/wiki). Host UX only; not freeze evidence. */
export function installEntrySkill(root, opts = {}) {
  const source = kitEntrySkillDir();
  if (!fs.existsSync(source)) {
    return { kind: "entry-skill", skipped: true, note: "entry skill not in kit yet" };
  }
  const dest = claudeEntrySkillDir(root);
  const install = copyDir(source, dest, opts);
  // Pin kit root so entry.mjs can call ow.mjs without relying on PATH.
  if (fs.existsSync(dest)) {
    const scriptsDir = path.join(dest, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, "kit-root.json"),
      `${JSON.stringify({ kitRoot: path.resolve(kitEntrySkillDir(), "../.."), writtenAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  }
  return {
    kind: "entry-skill",
    install: {
      ...install,
      digest: fs.existsSync(install.dest) ? hashTree(install.dest).digest : null,
    },
  };
}

export function installAll(root, opts = {}) {
  return {
    workflows: installWorkflows(root, opts),
    skill: installSkill(root, opts),
    entrySkill: installEntrySkill(root, opts),
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

  const entrySource = kitEntrySkillDir();
  if (fs.existsSync(entrySource)) {
    const entryDest = claudeEntrySkillDir(root);
    if (!fs.existsSync(entryDest)) {
      errors.push(`missing installed entry skill: ${entryDest}`);
    } else {
      const skillMd = path.join(entryDest, "SKILL.md");
      if (!fs.existsSync(skillMd)) errors.push(`missing entry skill SKILL.md: ${skillMd}`);
      const entryJs = path.join(entryDest, "scripts", "entry.mjs");
      if (!fs.existsSync(entryJs)) errors.push(`missing entry helper: ${entryJs}`);
      const pin = path.join(entryDest, "scripts", "kit-root.json");
      if (!fs.existsSync(pin)) errors.push(`missing entry kit-root pin: ${pin}`);
      // Compare method-critical files loosely: SKILL.md body may drift only if kit changed;
      // full tree digest would fail because kit-root.json is install-local.
      const kitSkillMd = path.join(entrySource, "SKILL.md");
      if (fs.existsSync(skillMd) && fs.readFileSync(kitSkillMd, "utf8") !== fs.readFileSync(skillMd, "utf8")) {
        errors.push(`installed entry skill drifted from kit: ${skillMd}`);
      }
      const kitEntry = path.join(entrySource, "scripts", "entry.mjs");
      if (fs.existsSync(entryJs) && fs.readFileSync(kitEntry, "utf8") !== fs.readFileSync(entryJs, "utf8")) {
        errors.push(`installed entry helper drifted from kit: ${entryJs}`);
      }
    }
  }

  for (const name of REQUIRED_WORKFLOWS) {
    const source = path.join(kitWorkflowsDir(), name);
    const target = path.join(claudeWorkflowsDir(root), name);
    if (!fs.existsSync(source)) continue;
    if (!fs.existsSync(target)) errors.push(`missing installed workflow: ${target}`);
    else if (fs.readFileSync(source, "utf8") !== fs.readFileSync(target, "utf8")) {
      errors.push(`installed workflow drifted from kit: ${target}`);
    }
  }
  if (errors.length) {
    throw new Error(`${errors.join("; ")}. Run: ow install --force`);
  }
  return { ok: true, skillDigest: expectedSkillDigest };
}

export function ensureWorkflowsInstalled(root) {
  const destDir = claudeWorkflowsDir(root);
  const missing = REQUIRED_WORKFLOWS.some((name) => !fs.existsSync(path.join(destDir, name)));
  if (missing) {
    installWorkflows(root, { force: false });
  }
  return {
    destDir,
    required: REQUIRED_WORKFLOWS,
    exists: REQUIRED_WORKFLOWS.every((name) => fs.existsSync(path.join(destDir, name))),
  };
}
