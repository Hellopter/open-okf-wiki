/**
 * Freeze sources + skill into a run workdir; record digests and effective ignores.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { effectiveSourceIgnores, pathMatchesIgnore } from "./ignores.mjs";
import { buildInventory, writeInventory } from "./inventory.mjs";
import { ensureWorkflowsInstalled, installAll } from "./install.mjs";
import { agentsSkillsDir, kitSkillDir, runDir, runsDir } from "./paths.mjs";
import { resolveSourceAbs } from "./sources.mjs";
import { loadWorkspace } from "./workspace.mjs";

function sha256DirSample(abs, patterns, { maxFiles = 5000 } = {}) {
  const hash = createHash("sha256");
  const files = [];
  const stack = [""];
  while (stack.length && files.length < maxFiles) {
    const rel = stack.pop();
    const dir = rel ? path.join(abs, rel) : abs;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const norm = childRel.replace(/\\/g, "/");
      if (pathMatchesIgnore(norm, patterns)) continue;
      if (ent.isDirectory()) stack.push(norm);
      else if (ent.isFile()) files.push(norm);
    }
  }
  files.sort();
  for (const f of files) {
    hash.update(f);
    hash.update("\0");
    try {
      hash.update(fs.readFileSync(path.join(abs, f)));
    } catch {
      hash.update("?");
    }
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), fileCount: files.length };
}

function gitHead(abs) {
  const r = spawnSync("git", ["-C", abs, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim();
  return null;
}

function copyTreeFiltered(srcAbs, destAbs, patterns) {
  fs.mkdirSync(destAbs, { recursive: true });
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const fromDir = rel ? path.join(srcAbs, rel) : srcAbs;
    const toDir = rel ? path.join(destAbs, rel) : destAbs;
    fs.mkdirSync(toDir, { recursive: true });
    let entries;
    try {
      entries = fs.readdirSync(fromDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const norm = childRel.replace(/\\/g, "/");
      if (pathMatchesIgnore(norm, patterns)) continue;
      const from = path.join(fromDir, ent.name);
      const to = path.join(toDir, ent.name);
      if (ent.isDirectory()) {
        stack.push(norm);
      } else if (ent.isFile()) {
        fs.copyFileSync(from, to);
      } else if (ent.isSymbolicLink()) {
        // materialize as copy of target if file; skip dangling
        try {
          const real = fs.realpathSync(from);
          if (fs.statSync(real).isFile()) fs.copyFileSync(real, to);
        } catch {
          /* skip */
        }
      }
    }
  }
}

function copySkill(destSkillDir) {
  const from = kitSkillDir();
  if (!fs.existsSync(from)) {
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(destSkillDir, "SKILL.md"),
      "---\nname: repository-wiki-producer\ndescription: Placeholder skill\n---\n\n# Placeholder\n",
      "utf8",
    );
    return { digest: "placeholder", path: destSkillDir };
  }
  fs.cpSync(from, destSkillDir, { recursive: true });
  const { digest } = sha256DirSample(destSkillDir, []);
  return { digest, path: destSkillDir };
}

/**
 * Create a new run, freeze sources+skill, write inventory.
 * @returns {{ runId: string, runDir: string, workdir: string, meta: object }}
 */
export function freezeRun(root, { focus } = {}) {
  const workspace = loadWorkspace(root);
  if (!workspace.sources?.length) {
    throw new Error("workspace has no sources; run: ow source add clone|path …");
  }
  installAll(root, { force: false });
  ensureWorkflowsInstalled(root);

  const runId = randomUUID().slice(0, 8) + Date.now().toString(36).slice(-4);
  const rdir = runDir(root, runId);
  const workdir = path.join(rdir, "workdir");
  fs.mkdirSync(path.join(workdir, "sources"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "inputs"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "analysis"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "wiki"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "analysis", "receipts", "survey"), { recursive: true });
  fs.mkdirSync(path.join(workdir, "analysis", "receipts", "semantic"), { recursive: true });

  const sourceSnapshots = [];
  for (const src of workspace.sources) {
    const abs = resolveSourceAbs(root, src);
    const patterns = effectiveSourceIgnores(src);
    const head = gitHead(abs);
    const dest = path.join(workdir, "sources", src.id);
    copyTreeFiltered(abs, dest, patterns);
    const { digest, fileCount } = sha256DirSample(dest, []);
    sourceSnapshots.push({
      sourceId: src.id,
      gitHead: head,
      contentDigest: digest,
      fileCount,
      effectiveIgnores: patterns,
      applyDefaultIgnores: src.applyDefaultIgnores !== false,
      presets: src.presets ?? [],
      userIgnore: src.ignore ?? [],
    });
  }

  const skill = copySkill(path.join(workdir, "skill"));
  // also prefer workspace-installed skill if present
  const wsSkill = agentsSkillsDir(root);
  if (fs.existsSync(path.join(wsSkill, "SKILL.md"))) {
    fs.rmSync(path.join(workdir, "skill"), { recursive: true, force: true });
    fs.cpSync(wsSkill, path.join(workdir, "skill"), { recursive: true });
    skill.digest = sha256DirSample(path.join(workdir, "skill"), []).digest;
  }

  const inventory = buildInventory(root, workspace);
  writeInventory(workdir, inventory);

  const runPolicy = {
    wikiLanguage: workspace.wikiLanguage,
    focus: focus || null,
    tier: inventory.tier,
  };
  fs.writeFileSync(
    path.join(workdir, "inputs", "run-policy.json"),
    `${JSON.stringify(runPolicy, null, 2)}\n`,
    "utf8",
  );

  const meta = {
    runId,
    status: "frozen",
    phase: "freeze",
    createdAt: new Date().toISOString(),
    wikiLanguage: workspace.wikiLanguage,
    focus: focus || null,
    skillDigest: skill.digest,
    sources: sourceSnapshots,
    inventoryTier: inventory.tier,
    coverageUnitCount: inventory.coverageUnits.length,
    workdir: path.relative(root, workdir),
  };
  fs.writeFileSync(path.join(rdir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(rdir, "journal.jsonl"), "", "utf8");

  // Empty discovery-map shell under inputs/ as a starting point only.
  // The filled map should be written to analysis/discovery-map.json during Discover;
  // optionally seal a copy back to inputs/discovery-map.json. gatePlan prefers
  // analysis/ when present (especially when it has domains).
  const emptyMap = {
    version: 1,
    sources: inventory.sources.map((s) => ({
      sourceId: s.sourceId,
      role: null,
      entryPoints: [],
      surfaces: s.surfaces,
      purpose: null,
      evidencePaths: [],
    })),
    domains: [],
    flows: [],
    concepts: [],
    openQuestions: [],
    coverageUnits: inventory.coverageUnits,
  };
  fs.writeFileSync(
    path.join(workdir, "inputs", "discovery-map.json"),
    `${JSON.stringify(emptyMap, null, 2)}\n`,
    "utf8",
  );

  return { runId, runDir: rdir, workdir, meta, inventory };
}

export function loadRunMeta(root, runId) {
  const metaPath = path.join(runDir(root, runId), "meta.json");
  if (!fs.existsSync(metaPath)) throw new Error(`unknown run: ${runId}`);
  return JSON.parse(fs.readFileSync(metaPath, "utf8"));
}

export function listRuns(root) {
  const dir = runsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((id) => fs.existsSync(path.join(dir, id, "meta.json")))
    .map((id) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, id, "meta.json"), "utf8"));
      } catch {
        return { runId: id, status: "corrupt" };
      }
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
