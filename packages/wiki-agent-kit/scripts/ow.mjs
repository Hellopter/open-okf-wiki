#!/usr/bin/env node
/** ow — deterministic host API for the native /wiki workflow. */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readCurrent, resolveActiveRun, setActiveRun } from "./lib/active-run.mjs";
import { checkpointRun, verifyCheckpoint, verifyReviewLeaf } from "./lib/checkpoints.mjs";
import { freezeRun, listRuns, loadRunMeta } from "./lib/freeze.mjs";
import { verifyPlanGate, writePlanGateReceipt } from "./lib/gate.mjs";
import { effectiveSourceIgnores, listPresetSummaries, loadIgnorePresets } from "./lib/ignores.mjs";
import { assertInstalledAssets, assertLegacyAssetsRemovable, installAll } from "./lib/install.mjs";
import { resolveWorkspaceRoot } from "./lib/paths.mjs";
import { prepareRun, PREPARE_MODES } from "./lib/prepare.mjs";
import { addCloneSource, addPathSource, listSources, removeSource } from "./lib/sources.mjs";
import { candidateSealStatus, regenerateIndexes, sealCandidate, validateWorkdir } from "./lib/validate.mjs";
import { findSource, initWorkspace, loadWorkspace, saveWorkspace } from "./lib/workspace.mjs";

function die(message, code = 1) {
  console.error(`ow: ${message}`);
  process.exit(code);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args.flags[key] = true;
    else {
      args.flags[key] = next;
      index++;
    }
  }
  return args;
}

function workspaceRoot(flags) {
  return resolveWorkspaceRoot(process.cwd(), flags.workspace || flags.ws || flags.cwd);
}

function stringFlag(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} requires a non-empty value`);
  return value.trim();
}

function cmdInit(args) {
  if (args.flags.format || args.flags.config) die("workspace v2 always uses workspace.yaml; --format is no longer supported");
  const root = path.resolve(args._[0] || ".");
  if (args.flags.force) assertLegacyAssetsRemovable(root);
  const initialized = initWorkspace(root, {
    name: stringFlag(args.flags.name, "--name") || path.basename(root),
    wikiLanguage: args.flags.lang || args.flags.language || "en",
    force: Boolean(args.flags.force),
  });
  const installed = installAll(root, { force: Boolean(args.flags.force) });

  let source = null;
  let hint = null;
  if (args.flags.clone) {
    ({ source, hint } = addCloneSource(root, { url: args.flags.clone, id: args.flags.id, ref: args.flags.ref }));
  } else if (args.flags.path) {
    ({ source, hint } = addPathSource(root, { linkedPath: args.flags.path, id: args.flags.id }));
  }
  if (args.flags.preset && source) {
    const workspace = loadWorkspace(root);
    const configured = findSource(workspace, source.id);
    configured.presets = [...new Set([...(configured.presets || []), args.flags.preset])];
    saveWorkspace(root, workspace);
    source = configured;
  }
  printJson({
    ok: true,
    created: initialized.created,
    workspace: initialized.configPath,
    format: "yaml",
    wikiLanguage: initialized.workspace.wikiLanguage,
    install: installed,
    source,
    hint,
  });
}

function cmdSource(args) {
  const root = workspaceRoot(args.flags);
  const subcommand = args._[0];
  if (subcommand === "list") return printJson({ sources: listSources(root) });
  if (subcommand === "remove") {
    const id = args._[1] || args.flags.id;
    if (!id) die("usage: ow source remove <id>");
    return printJson(removeSource(root, id));
  }
  if (subcommand === "add") {
    const kind = args._[1];
    if (kind === "clone") {
      const url = args._[2] || args.flags.url;
      if (!url) die("usage: ow source add clone <url> [--id] [--ref]");
      return printJson({ ok: true, ...addCloneSource(root, { url, id: args.flags.id, ref: args.flags.ref }) });
    }
    if (kind === "path") {
      const linkedPath = args._[2] || args.flags.path;
      if (!linkedPath) die("usage: ow source add path <dir> [--id]");
      return printJson({ ok: true, ...addPathSource(root, { linkedPath, id: args.flags.id }) });
    }
  }
  die("usage: ow source add clone|path … | list | remove <id>");
}

function cmdIgnore(args) {
  const root = workspaceRoot(args.flags);
  const subcommand = args._[0];
  if (subcommand === "presets") return printJson({ presets: listPresetSummaries() });
  if (subcommand === "show") {
    const workspace = loadWorkspace(root);
    const id = args._[1];
    const sources = id ? workspace.sources.filter((source) => source.id === id) : workspace.sources;
    return printJson({
      sources: sources.map((source) => ({
        id: source.id,
        applyDefaultIgnores: source.applyDefaultIgnores !== false,
        presets: source.presets || [],
        ignore: source.ignore || [],
        effective: effectiveSourceIgnores(source),
      })),
    });
  }
  if (subcommand === "defaults") {
    const enabled = args._[1];
    const sourceId = args.flags.source || args.flags.id;
    if (enabled !== "on" && enabled !== "off") die("usage: ow ignore defaults on|off [--source id]");
    const workspace = loadWorkspace(root);
    const applyDefaultIgnores = enabled === "on";
    if (sourceId) {
      const source = findSource(workspace, sourceId);
      if (!source) die(`unknown source: ${sourceId}`);
      source.applyDefaultIgnores = applyDefaultIgnores;
    } else {
      for (const source of workspace.sources) source.applyDefaultIgnores = applyDefaultIgnores;
      workspace.defaultSourceIgnores = { enabled: applyDefaultIgnores };
    }
    saveWorkspace(root, workspace);
    return printJson({ ok: true, applyDefaultIgnores, sourceId: sourceId || "*" });
  }
  if (subcommand === "set") {
    const sourceId = args._[1];
    if (!sourceId) die("usage: ow ignore set <sourceId> --add GLOB | --preset ID | --remove GLOB");
    const workspace = loadWorkspace(root);
    const source = findSource(workspace, sourceId);
    if (!source) die(`unknown source: ${sourceId}`);
    source.ignore ||= [];
    source.presets ||= [];
    if (args.flags.preset) {
      const presets = loadIgnorePresets();
      if (!presets[args.flags.preset]) die(`unknown preset: ${args.flags.preset}`);
      if (!source.presets.includes(args.flags.preset)) source.presets.push(args.flags.preset);
    }
    if (args.flags.add && !source.ignore.includes(args.flags.add)) source.ignore.push(args.flags.add);
    for (let index = 2; index < args._.length; index++) {
      if (!source.ignore.includes(args._[index])) source.ignore.push(args._[index]);
    }
    if (args.flags.remove) {
      source.ignore = source.ignore.filter((item) => item !== args.flags.remove);
      source.presets = source.presets.filter((item) => item !== args.flags.remove);
    }
    saveWorkspace(root, workspace);
    return printJson({ ok: true, source, effective: effectiveSourceIgnores(source) });
  }
  die("usage: ow ignore show|set|defaults|presets …");
}

function cmdConfig(args) {
  const root = workspaceRoot(args.flags);
  const subcommand = args._[0];
  if (subcommand === "set") {
    const [key, value] = args._.slice(1);
    if (key !== "wikiLanguage" || (value !== "en" && value !== "zh")) die("usage: ow config set wikiLanguage en|zh");
    const workspace = loadWorkspace(root);
    workspace.wikiLanguage = value;
    saveWorkspace(root, workspace);
    return printJson({ ok: true, wikiLanguage: value });
  }
  if (subcommand === "get") {
    const workspace = loadWorkspace(root);
    return printJson({ wikiLanguage: workspace.wikiLanguage, name: workspace.name, id: workspace.id, version: workspace.version });
  }
  die("usage: ow config set wikiLanguage en|zh | get");
}

function resolveRun(root, args) {
  const run = resolveActiveRun(root, { preferredRunId: args.flags.run });
  if (!run) die("no active run; start /wiki or run ow prepare");
  return run;
}

function runSummary(root, meta) {
  if (!meta || meta.status === "corrupt") return meta || { status: "missing" };
  try {
    const workdir = path.resolve(root, meta.workdir);
    const seal = candidateSealStatus(workdir);
    if (seal.sealed) return { ...meta, status: seal.valid ? "sealed" : "tampered" };
    const gate = verifyPlanGate(workdir, meta.runId, meta.methodDigest);
    if (gate.ok) return { ...meta, status: "write-ready" };
    return { ...meta, status: fs.existsSync(path.join(workdir, "analysis", "spec.json")) ? "planned" : "frozen" };
  } catch (error) {
    return { ...meta, status: "invalid", error: error.message };
  }
}

function cmdStatus(args) {
  const root = workspaceRoot(args.flags);
  const workspace = loadWorkspace(root);
  const active = resolveActiveRun(root);
  printJson({
    root,
    name: workspace.name,
    wikiLanguage: workspace.wikiLanguage,
    workflow: "/wiki",
    sources: workspace.sources.map((source) => ({ id: source.id, origin: source.origin?.type })),
    current: readCurrent(root),
    active: active ? { runId: active.runId, workdir: active.workdir, source: active.source, status: runSummary(root, active.meta).status } : null,
    runs: listRuns(root).slice(0, 10).map((meta) => runSummary(root, meta)),
  });
}

function cmdInstall(args) {
  const root = workspaceRoot(args.flags);
  loadWorkspace(root);
  if (args._.length) die("usage: ow install [--force]");
  printJson(installAll(root, { force: Boolean(args.flags.force) }));
}

function cmdPrepare(args) {
  const root = workspaceRoot(args.flags);
  if (args._.length) die("usage: ow prepare --mode auto|plan|write|retry-plan|retry-write [--focus TEXT]");
  const mode = args.flags.mode || "auto";
  if (!PREPARE_MODES.has(mode)) die(`invalid prepare mode: ${mode}`);
  printJson(prepareRun(root, { mode, focus: stringFlag(args.flags.focus, "--focus") }));
}

function cmdCheckpoint(args) {
  const root = workspaceRoot(args.flags);
  if (args._.length) die("usage: ow checkpoint --phase <phase> --proposal <relative-path>");
  const phase = stringFlag(args.flags.phase, "--phase");
  const proposalPath = stringFlag(args.flags.proposal, "--proposal");
  if (!phase || !proposalPath) die("usage: ow checkpoint --phase <phase> --proposal <relative-path>");
  const run = resolveRun(root, args);
  const result = checkpointRun(root, run, { phase, proposalPath });
  printJson({
    status: "ok",
    checkpointPath: result.checkpointPath,
    checkpointDigest: result.checkpointDigest,
    summary: result.summary,
  });
}

function cmdGate(args) {
  const root = workspaceRoot(args.flags);
  const subcommand = args._[0];
  if (subcommand !== "plan" && subcommand !== "check") die("usage: ow gate plan|check [--run <runId>]");
  const run = resolveRun(root, args);
  if (subcommand === "check") {
    const result = verifyPlanGate(run.workdir, run.runId, run.meta.methodDigest);
    printJson(result);
    if (!result.ok) process.exit(2);
    return;
  }
  const { result, receipt } = writePlanGateReceipt(run.workdir, run.runId, run.meta.methodDigest);
  const current = setActiveRun(root, {
    runId: run.runId,
    workdir: run.workdir,
    phase: receipt ? "write-ready" : "plan-failed",
    status: receipt ? "active" : "blocked",
    checkpointDigest: readCurrent(root)?.checkpointDigest || null,
  });
  printJson({ ...result, receipt, current });
  if (!result.ok) process.exit(2);
}

function cmdValidate(args) {
  const root = workspaceRoot(args.flags);
  const run = resolveRun(root, args);
  const gate = verifyPlanGate(run.workdir, run.runId, run.meta.methodDigest);
  if (!gate.ok) {
    printJson(gate);
    process.exit(2);
  }
  const writeCheckpoint = verifyCheckpoint(run.workdir, "write");
  if (!writeCheckpoint.ok || writeCheckpoint.checkpoint.status !== "complete") {
    printJson({ ok: false, errors: ["missing or invalid write checkpoint", ...(writeCheckpoint.errors || [])] });
    process.exit(2);
  }
  const finalReview = verifyReviewLeaf(run.workdir, run.current);
  if (!finalReview.ok) {
    printJson({ ok: false, errors: ["missing or invalid final review checkpoint", ...finalReview.errors] });
    process.exit(2);
  }
  const defects = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(run.workdir, "analysis", "defects.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  if (defects?.version !== 2 || defects?.clean !== true || !Array.isArray(defects.defects) || defects.defects.length !== 0) {
    printJson({ ok: false, errors: ["final review is not clean or defects.json is invalid"] });
    process.exit(2);
  }
  const seal = candidateSealStatus(run.workdir);
  if (seal.sealed) {
    if (!seal.valid) die("sealed candidate was modified; use /wiki --retry write");
    printJson({
      ok: true,
      alreadySealed: true,
      manifest: seal.manifest,
      reviewCheckpointDigest: finalReview.checkpoint.checkpointDigest,
      current: readCurrent(root),
    });
    return;
  }
  regenerateIndexes(path.join(run.workdir, "candidate"));
  const result = validateWorkdir(run.workdir);
  const manifest = result.ok ? sealCandidate(run.workdir, result) : null;
  // The validate checkpoint is the only transition to sealed. Keep the trusted
  // final review pointer intact until its handoff is checkpointed.
  if (!result.ok) {
    setActiveRun(root, {
      runId: run.runId,
      workdir: run.workdir,
      phase: "validate-failed",
      status: "blocked",
      checkpointDigest: finalReview.checkpoint.checkpointDigest,
    });
  }
  printJson({ ...result, manifest, reviewCheckpointDigest: finalReview.checkpoint.checkpointDigest, current: readCurrent(root) });
  if (!result.ok) process.exit(2);
}

const MIN_CLAUDE_WORKFLOW_VERSION = [2, 1, 154];

function parseVersion(output) {
  const match = String(output).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function isSupportedVersion(version) {
  if (!version) return false;
  return version.every((part, index) => part === MIN_CLAUDE_WORKFLOW_VERSION[index]) ||
    version.findIndex((part, index) => part !== MIN_CLAUDE_WORKFLOW_VERSION[index]) >= 0 &&
      version[version.findIndex((part, index) => part !== MIN_CLAUDE_WORKFLOW_VERSION[index])] >
        MIN_CLAUDE_WORKFLOW_VERSION[version.findIndex((part, index) => part !== MIN_CLAUDE_WORKFLOW_VERSION[index])];
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
  const version = parseVersion(`${probe.stdout || ""}\n${probe.stderr || ""}`);
  const claude = {
    found: !probe.error && probe.status === 0,
    version: version?.join(".") || null,
    minimumVersion: MIN_CLAUDE_WORKFLOW_VERSION.join("."),
    versionSupported: isSupportedVersion(version),
  };
  printJson({
    ok: assets.ok && claude.found && claude.versionSupported,
    workspace: root,
    assets,
    claude,
    dynamicWorkflowPrerequisite: {
      required: true,
      locallyVerifiable: false,
      action: "In a new Claude Code session from this workspace, verify Dynamic Workflows are enabled in /config.",
    },
    current: readCurrent(root),
  });
}

function cmdHelp() {
  console.log(`ow — wiki-agent-kit v2 host CLI

Human entry:
  ow init ./ws --lang zh --path /repo --id app
  cd ./ws && claude
  /wiki [focus]

Workflow host API (JSON):
  ow prepare --mode auto|plan|write|retry-plan|retry-write [--focus TEXT]
  ow checkpoint --phase <phase> --proposal <relative-path>
  ow gate plan|check [--run <runId>]
  ow validate [--run <runId>]
  ow status | doctor | install --force

Workspace setup:
  ow init [dir] --name N --lang en|zh [--clone URL|--path DIR] [--id ID]
  ow source add clone|path … | list | remove <id>
  ow ignore show|set|defaults|presets …
  ow config set wikiLanguage en|zh | get

v2 installs one workflow: /wiki. State lives in .wiki-agent/current.json and run checkpoints.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || ["-h", "--help", "help"].includes(argv[0])) return cmdHelp();
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  try {
    switch (command) {
      case "init": return cmdInit(args);
      case "source": return cmdSource(args);
      case "ignore": return cmdIgnore(args);
      case "config": return cmdConfig(args);
      case "status": return cmdStatus(args);
      case "install": return cmdInstall(args);
      case "doctor": return cmdDoctor(args);
      case "prepare": return cmdPrepare(args);
      case "checkpoint": return cmdCheckpoint(args);
      case "gate": return cmdGate(args);
      case "validate": return cmdValidate(args);
      default: return die(`unknown command: ${command} (try ow help)`);
    }
  } catch (error) {
    return die(error.stack || error.message || String(error));
  }
}

main();
