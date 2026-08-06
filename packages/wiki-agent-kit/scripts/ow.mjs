#!/usr/bin/env node
/**
 * ow — open wiki CLI (workspace scaffold, freeze, gates, validate).
 * Usage: ow <command> [args]
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { freezeRun, listRuns, loadRunMeta } from "./lib/freeze.mjs";
import { verifyPlanGate, writePlanGateReceipt } from "./lib/gate.mjs";
import { effectiveSourceIgnores, listPresetSummaries, loadIgnorePresets } from "./lib/ignores.mjs";
import { assertInstalledAssets, installAll } from "./lib/install.mjs";
import { resolveWorkspaceRoot } from "./lib/paths.mjs";
import { retryFromPhase } from "./lib/run-state.mjs";
import {
  addCloneSource,
  addPathSource,
  listSources,
  removeSource,
} from "./lib/sources.mjs";
import {
  candidateSealStatus,
  regenerateIndexes,
  sealCandidate,
  validateWorkdir,
} from "./lib/validate.mjs";
import {
  findSource,
  initWorkspace,
  loadWorkspace,
  saveWorkspace,
} from "./lib/workspace.mjs";

function die(msg, code = 1) {
  console.error(`ow: ${msg}`);
  process.exit(code);
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args.flags[key] = true;
      } else {
        args.flags[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function workspaceRoot(flags) {
  return resolveWorkspaceRoot(process.cwd(), flags.workspace || flags.ws || flags.cwd);
}

function cmdInit(args) {
  const dir = path.resolve(args._[0] || ".");
  const name = args.flags.name || path.basename(dir);
  const lang = args.flags.lang || args.flags.language || "en";
  const force = Boolean(args.flags.force);
  const { created, workspace } = initWorkspace(dir, {
    name,
    wikiLanguage: lang,
    force,
  });
  const installed = installAll(dir, { force: false });

  let sourceResult = null;
  if (args.flags.clone) {
    sourceResult = addCloneSource(dir, {
      url: args.flags.clone,
      id: args.flags.id,
      ref: args.flags.ref,
    });
  } else if (args.flags.path) {
    sourceResult = addPathSource(dir, {
      linkedPath: args.flags.path,
      id: args.flags.id,
    });
  }

  if (args.flags.preset && sourceResult?.source) {
    const ws = loadWorkspace(dir);
    const src = findSource(ws, sourceResult.source.id);
    src.presets = [...new Set([...(src.presets || []), args.flags.preset])];
    saveWorkspace(dir, ws);
    sourceResult.source = src;
  }

  printJson({
    ok: true,
    created,
    workspace: path.join(dir, "workspace.json"),
    wikiLanguage: workspace.wikiLanguage,
    install: installed,
    source: sourceResult?.source ?? null,
    hint: sourceResult?.hint ?? null,
  });
}

function cmdSource(args) {
  const root = workspaceRoot(args.flags);
  const sub = args._[0];
  if (sub === "list") {
    printJson({ sources: listSources(root) });
    return;
  }
  if (sub === "remove") {
    const id = args._[1] || args.flags.id;
    if (!id) die("usage: ow source remove <id>");
    printJson(removeSource(root, id));
    return;
  }
  if (sub === "add") {
    const kind = args._[1];
    if (kind === "clone") {
      const url = args._[2] || args.flags.url;
      if (!url) die("usage: ow source add clone <url> [--id] [--ref]");
      const r = addCloneSource(root, { url, id: args.flags.id, ref: args.flags.ref });
      printJson({ ok: true, ...r });
      return;
    }
    if (kind === "path") {
      const p = args._[2] || args.flags.path;
      if (!p) die("usage: ow source add path <dir> [--id]");
      const r = addPathSource(root, { linkedPath: p, id: args.flags.id });
      printJson({ ok: true, ...r });
      return;
    }
  }
  die("usage: ow source add clone|path … | list | remove <id>");
}

function cmdIgnore(args) {
  const root = workspaceRoot(args.flags);
  const sub = args._[0];
  if (sub === "presets") {
    printJson({ presets: listPresetSummaries() });
    return;
  }
  if (sub === "show") {
    const ws = loadWorkspace(root);
    const id = args._[1];
    const sources = id ? ws.sources.filter((s) => s.id === id) : ws.sources;
    printJson({
      sources: sources.map((s) => ({
        id: s.id,
        applyDefaultIgnores: s.applyDefaultIgnores !== false,
        presets: s.presets || [],
        ignore: s.ignore || [],
        effective: effectiveSourceIgnores(s),
      })),
    });
    return;
  }
  if (sub === "defaults") {
    const onoff = args._[1];
    const sourceId = args.flags.source || args.flags.id;
    if (onoff !== "on" && onoff !== "off") die("usage: ow ignore defaults on|off [--source id]");
    const ws = loadWorkspace(root);
    const apply = onoff === "on";
    if (sourceId) {
      const s = findSource(ws, sourceId);
      if (!s) die(`unknown source: ${sourceId}`);
      s.applyDefaultIgnores = apply;
    } else {
      for (const s of ws.sources) s.applyDefaultIgnores = apply;
      ws.defaultSourceIgnores = { enabled: apply };
    }
    saveWorkspace(root, ws);
    printJson({ ok: true, applyDefaultIgnores: apply, sourceId: sourceId || "*" });
    return;
  }
  if (sub === "set") {
    const sourceId = args._[1];
    if (!sourceId) die("usage: ow ignore set <sourceId> --add GLOB | --preset ID | --remove GLOB");
    const ws = loadWorkspace(root);
    const s = findSource(ws, sourceId);
    if (!s) die(`unknown source: ${sourceId}`);
    s.ignore = s.ignore || [];
    s.presets = s.presets || [];
    if (args.flags.preset) {
      const presets = loadIgnorePresets();
      if (!presets[args.flags.preset]) die(`unknown preset: ${args.flags.preset}`);
      if (!s.presets.includes(args.flags.preset)) s.presets.push(args.flags.preset);
    }
    if (args.flags.add) {
      const g = args.flags.add;
      if (!s.ignore.includes(g)) s.ignore.push(g);
    }
    // multi --add via remaining _
    for (let i = 2; i < args._.length; i++) {
      if (!s.ignore.includes(args._[i])) s.ignore.push(args._[i]);
    }
    if (args.flags.remove) {
      s.ignore = s.ignore.filter((x) => x !== args.flags.remove);
      s.presets = s.presets.filter((x) => x !== args.flags.remove);
    }
    saveWorkspace(root, ws);
    printJson({
      ok: true,
      source: s,
      effective: effectiveSourceIgnores(s),
    });
    return;
  }
  die("usage: ow ignore show|set|defaults|presets …");
}

function cmdConfig(args) {
  const root = workspaceRoot(args.flags);
  const sub = args._[0];
  if (sub === "set") {
    const key = args._[1];
    const val = args._[2];
    if (key !== "wikiLanguage" || (val !== "en" && val !== "zh")) {
      die("usage: ow config set wikiLanguage en|zh");
    }
    const ws = loadWorkspace(root);
    ws.wikiLanguage = val;
    saveWorkspace(root, ws);
    printJson({ ok: true, wikiLanguage: val });
    return;
  }
  if (sub === "get") {
    const ws = loadWorkspace(root);
    printJson({ wikiLanguage: ws.wikiLanguage, name: ws.name, id: ws.id });
    return;
  }
  die("usage: ow config set wikiLanguage en|zh | get");
}

function cmdStatus(args) {
  const root = workspaceRoot(args.flags);
  const ws = loadWorkspace(root);
  const runs = listRuns(root);
  printJson({
    root,
    name: ws.name,
    wikiLanguage: ws.wikiLanguage,
    sources: ws.sources.map((s) => ({
      id: s.id,
      origin: s.origin?.type,
      applyDefaultIgnores: s.applyDefaultIgnores !== false,
      presets: s.presets || [],
    })),
    runs: runs.slice(0, 10).map((meta) => summarizeRun(root, meta)),
  });
}

function cmdInstall(args) {
  const root = workspaceRoot(args.flags);
  loadWorkspace(root);
  if (args._.length) die("usage: ow install [--force]");
  const force = Boolean(args.flags.force);
  printJson(installAll(root, { force }));
}

function workflowInvocation(name, root, runId, workdir) {
  return {
    command: `/${name}`,
    args: { runId, workdir },
    cwd: root,
    instructions: `Start a new Claude Code session from ${root}, then run /${name} with the args object above.`,
  };
}

function cmdFreeze(args) {
  const root = workspaceRoot(args.flags);
  const focus = args.flags.focus;
  const result = freezeRun(root, { focus });
  const out = {
    ok: true,
    runId: result.runId,
    workdir: result.workdir,
    inventoryTier: result.inventory.tier,
    coverageUnits: result.inventory.coverageUnits.length,
    workflow: workflowInvocation("wiki-plan", root, result.runId, result.workdir),
  };
  printJson(out);
}

function runWorkdir(root, runId) {
  const meta = loadRunMeta(root, runId);
  return { meta, workdir: path.resolve(root, meta.workdir) };
}

function cmdGate(args) {
  const root = workspaceRoot(args.flags);
  const sub = args._[0];
  if (sub !== "plan" && sub !== "check") die("usage: ow gate plan|check --run <runId>");
  const runId = args.flags.run || args._[1];
  if (!runId) die("usage: ow gate plan|check --run <runId>");
  const { meta, workdir } = runWorkdir(root, runId);
  if (sub === "check") {
    const check = verifyPlanGate(workdir, runId, meta.skillDigest);
    printJson(check);
    if (!check.ok) process.exit(2);
    return;
  }
  const { result, receipt } = writePlanGateReceipt(workdir, runId, meta.skillDigest);
  printJson({
    ...result,
    receipt,
    ...(receipt ? { workflow: workflowInvocation("wiki-write-review", root, runId, workdir) } : {}),
  });
  if (!result.ok) process.exit(2);
}

function cmdValidate(args) {
  const root = workspaceRoot(args.flags);
  const runId = args.flags.run || args._[0];
  if (!runId) die("usage: ow validate --run <runId>");
  const { meta, workdir } = runWorkdir(root, runId);
  const gate = verifyPlanGate(workdir, runId, meta.skillDigest);
  if (!gate.ok) {
    printJson(gate);
    process.exit(2);
  }
  const seal = candidateSealStatus(workdir);
  if (seal.sealed) {
    die(
      seal.valid
        ? "candidate is already sealed; run: ow retry --run <id> --from write to create a replacement"
        : "sealed candidate was modified; its manifest no longer matches. Run: ow retry --run <id> --from write",
    );
  }
  const candidateDir = path.join(workdir, "candidate");
  let wikiLanguage = meta.wikiLanguage ?? "en";
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(workdir, "inputs", "run-policy.json"), "utf8"));
    if (policy?.wikiLanguage) wikiLanguage = policy.wikiLanguage;
  } catch {
    // Fall back to run meta / English when policy is absent.
  }
  regenerateIndexes(candidateDir, { wikiLanguage });
  const result = validateWorkdir(workdir, { wikiLanguage });
  const manifest = result.ok ? sealCandidate(workdir, result) : null;
  printJson({ ...result, manifest });
  if (!result.ok) process.exit(2);
}

function cmdRetry(args) {
  const root = workspaceRoot(args.flags);
  const runId = args.flags.run || args._[0];
  const from = args.flags.from || args._[1] || "plan";
  if (!runId) die("usage: ow retry --run <runId> --from plan|write");
  printJson(retryFromPhase(root, runId, from));
}

const MIN_CLAUDE_WORKFLOW_VERSION = [2, 1, 154];

function parseVersion(output) {
  const match = String(output).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function isSupportedVersion(version, minimum = MIN_CLAUDE_WORKFLOW_VERSION) {
  if (!version) return false;
  for (let index = 0; index < minimum.length; index++) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

function runSummary(meta, status, extra = {}) {
  return {
    runId: meta.runId,
    status,
    createdAt: meta.createdAt,
    wikiLanguage: meta.wikiLanguage,
    focus: meta.focus,
    sourceCount: meta.sources?.length ?? 0,
    inventoryTier: meta.inventoryTier,
    coverageUnitCount: meta.coverageUnitCount,
    workdir: meta.workdir,
    ...extra,
  };
}

function summarizeRun(root, meta) {
  if (meta.status === "corrupt") return meta;
  try {
    const workdir = path.resolve(root, meta.workdir);
    const seal = candidateSealStatus(workdir);
    if (seal.sealed) return runSummary(meta, seal.valid ? "sealed" : "tampered");
    const gate = verifyPlanGate(workdir, meta.runId, meta.skillDigest);
    if (gate.ok) return runSummary(meta, "write-ready");
    if (fs.existsSync(path.join(workdir, "analysis", "spec.json"))) {
      return runSummary(meta, "planned");
    }
    return runSummary(meta, "frozen");
  } catch (error) {
    return runSummary(meta, "invalid", { error: error.message });
  }
}

function cmdDoctor(args) {
  const root = workspaceRoot(args.flags);
  loadWorkspace(root);
  let assets;
  try {
    assets = assertInstalledAssets(root);
  } catch (error) {
    assets = { ok: false, error: error.message };
  }
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5000 });
  const rawVersion = probe.error ? "" : `${probe.stdout || ""}\n${probe.stderr || ""}`;
  const version = parseVersion(rawVersion);
  const claude = {
    found: !probe.error && probe.status === 0,
    version: version ? version.join(".") : null,
    minimumVersion: MIN_CLAUDE_WORKFLOW_VERSION.join("."),
    versionSupported: isSupportedVersion(version),
  };
  const dynamicWorkflowPrerequisite = {
    required: true,
    locallyVerifiable: false,
    action: "In a new Claude Code session started from this workspace, verify Dynamic Workflows are enabled in /config.",
  };
  printJson({
    ok: assets.ok && claude.found && claude.versionSupported,
    workspace: root,
    assets,
    claude,
    dynamicWorkflowPrerequisite,
  });
}

function cmdHelp() {
  console.log(`ow — open wiki CLI

Usage:
  ow init [dir] --name N --lang en|zh [--clone URL|--path DIR] [--id ID] [--ref REF] [--preset PRESET]
  ow source add clone <url> [--id] [--ref]
  ow source add path <dir> [--id]
  ow source list | remove <id>
  ow ignore show [sourceId]
  ow ignore set <sourceId> --add GLOB | --preset ID | --remove GLOB
  ow ignore defaults on|off [--source id]
  ow ignore presets
  ow config set wikiLanguage en|zh | get
  ow status [--workspace DIR]
  ow install [--force]
  ow doctor [--workspace DIR]
  ow freeze [--focus TEXT] [--workspace DIR]
  ow gate plan|check --run <runId>
  ow validate --run <runId>
  ow retry --run <runId> --from plan|write

Global: --workspace <dir>  (default: cwd)
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    cmdHelp();
    return;
  }
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  try {
    switch (cmd) {
      case "init":
        return cmdInit(args);
      case "source":
        return cmdSource(args);
      case "ignore":
        return cmdIgnore(args);
      case "config":
        return cmdConfig(args);
      case "status":
        return cmdStatus(args);
      case "install":
        return cmdInstall(args);
      case "doctor":
        return cmdDoctor(args);
      case "freeze":
        return cmdFreeze(args);
      case "gate":
        return cmdGate(args);
      case "validate":
        return cmdValidate(args);
      case "retry":
        return cmdRetry(args);
      default:
        die(`unknown command: ${cmd} (try ow help)`);
    }
  } catch (e) {
    die(e.stack || e.message || String(e));
  }
}

main();
