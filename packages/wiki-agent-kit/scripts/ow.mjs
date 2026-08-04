#!/usr/bin/env node
/**
 * ow — open wiki CLI (workspace scaffold, freeze, gates, validate).
 * Usage: ow <command> [args]
 */

import fs from "node:fs";
import path from "node:path";
import { freezeRun, listRuns, loadRunMeta } from "./lib/freeze.mjs";
import { verifyPlanGate, writePlanGateReceipt } from "./lib/gate.mjs";
import { effectiveSourceIgnores, listPresetSummaries, loadIgnorePresets } from "./lib/ignores.mjs";
import { assertInstalledAssets, installAll, installSkill, installWorkflows } from "./lib/install.mjs";
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
    runs: runs.slice(0, 10),
  });
}

function cmdInstall(args) {
  const root = workspaceRoot(args.flags);
  loadWorkspace(root);
  const force = Boolean(args.flags.force);
  const what = args._[0] || "all";
  if (what === "all") printJson(installAll(root, { force }));
  else if (what === "workflows") printJson(installWorkflows(root, { force }));
  else if (what === "skill") printJson(installSkill(root, { force }));
  else die("usage: ow install [all|workflows|skill] [--force]");
}

function cmdProduce(args) {
  const root = workspaceRoot(args.flags);
  const focus = args.flags.focus;
  const result = freezeRun(root, { focus });
  const out = {
    ok: true,
    runId: result.runId,
    workdir: result.workdir,
    meta: result.meta,
    inventoryTier: result.inventory.tier,
    coverageUnits: result.inventory.coverageUnits.length,
    next: `Run: ow plan --run ${result.runId} --workspace ${root}`,
  };
  printJson(out);
}

function runWorkdir(root, runId) {
  const meta = loadRunMeta(root, runId);
  return { meta, workdir: path.resolve(root, meta.workdir) };
}

function workflowHint(name, root, runId, workdir) {
  return `In Claude Code (cwd=${root}), run /${name} with args: ${JSON.stringify({ runId, workdir })}`;
}

function cmdPlan(args) {
  const root = workspaceRoot(args.flags);
  const runId = args.flags.run || args._[0];
  if (!runId) die("usage: ow plan --run <runId>");
  assertInstalledAssets(root);
  const { meta, workdir } = runWorkdir(root, runId);
  const workflow = path.join(root, ".claude", "workflows", "wiki-plan.workflow.js");
  if (!fs.existsSync(workflow)) die("wiki-plan workflow missing; run: ow install workflows --force");
  meta.status = "planning";
  meta.phase = "discover";
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, ".wiki-agent", "runs", runId, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  printJson({ ok: true, runId, workdir, next: workflowHint("wiki-plan", root, runId, workdir) });
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
  if (receipt) {
    meta.status = "plan-gated";
    meta.phase = "write";
    meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(root, ".wiki-agent", "runs", runId, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }
  printJson({ ...result, receipt });
  if (!result.ok) process.exit(2);
}

function cmdWrite(args) {
  const root = workspaceRoot(args.flags);
  const runId = args.flags.run || args._[0];
  if (!runId) die("usage: ow write --run <runId>");
  assertInstalledAssets(root);
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
        ? "candidate is sealed; run: ow retry --run <id> --from write"
        : "sealed candidate was modified; its manifest no longer matches. Run: ow retry --run <id> --from write",
    );
  }
  const workflow = path.join(root, ".claude", "workflows", "wiki-write-review.workflow.js");
  if (!fs.existsSync(workflow)) die("wiki-write-review workflow missing; run: ow install workflows --force");
  meta.status = "writing";
  meta.phase = "write";
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, ".wiki-agent", "runs", runId, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  printJson({ ok: true, runId, workdir, next: workflowHint("wiki-write-review", root, runId, workdir) });
}

function cmdValidate(args) {
  const root = workspaceRoot(args.flags);
  const runId = args.flags.run || args._[0];
  if (!runId) die("usage: ow validate --run <runId>");
  const { meta, workdir } = runWorkdir(root, runId);
  const seal = candidateSealStatus(workdir);
  if (seal.sealed) {
    die(
      seal.valid
        ? "candidate is already sealed; run: ow retry --run <id> --from write to create a replacement"
        : "sealed candidate was modified; its manifest no longer matches. Run: ow retry --run <id> --from write",
    );
  }
  const candidateDir = path.join(workdir, "candidate");
  regenerateIndexes(candidateDir);
  const result = validateWorkdir(workdir);
  const manifest = result.ok ? sealCandidate(workdir, result) : null;
  if (manifest) {
    meta.status = "sealed";
    meta.phase = "complete";
    meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(root, ".wiki-agent", "runs", runId, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }
  printJson({ ...result, manifest });
  if (!result.ok) process.exit(2);
}

function cmdRetry(args) {
  const root = workspaceRoot(args.flags);
  const runId = args.flags.run || args._[0];
  const from = args.flags.from || args._[1] || "plan";
  if (!runId) die("usage: ow retry --run <runId> --from <phase>");
  printJson(retryFromPhase(root, runId, from));
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
  ow install [all|workflows|skill] [--force]
  ow produce [--focus TEXT] [--workspace DIR]
  ow plan --run <runId>
  ow gate plan|check --run <runId>
  ow write --run <runId>
  ow validate --run <runId>
  ow retry --run <runId> --from <phase>

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
      case "produce":
        return cmdProduce(args);
      case "plan":
        return cmdPlan(args);
      case "gate":
        return cmdGate(args);
      case "write":
        return cmdWrite(args);
      case "validate":
        return cmdValidate(args);
      case "retry":
        return cmdRetry(args);
      case "continue":
        die("ow continue was removed; resume Claude workflows from /workflows in the same session");
        return;
      default:
        die(`unknown command: ${cmd} (try ow help)`);
    }
  } catch (e) {
    die(e.stack || e.message || String(e));
  }
}

main();
