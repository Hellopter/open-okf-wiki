#!/usr/bin/env node
/**
 * Deterministic helper for the /wiki entry skill.
 *
 * Usage:
 *   node entry.mjs [--workspace DIR] [--focus TEXT] [--approve-plan] [--status-only]
 *
 * Locates the kit ow.mjs via:
 *   1) OW_KIT_ROOT env
 *   2) kit-root.json beside this script (written by ow install)
 *   3) walking up from this file for packages/wiki-agent-kit layout
 *   4) `ow` on PATH
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function die(msg, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: msg, humanEntry: "/wiki", ...extra }, null, 2));
  process.exit(1);
}

function findOw() {
  if (process.env.OW_KIT_ROOT) {
    const candidate = path.join(process.env.OW_KIT_ROOT, "scripts", "ow.mjs");
    if (fs.existsSync(candidate)) return { mode: "node", ow: candidate };
  }
  const pin = path.join(__dirname, "kit-root.json");
  if (fs.existsSync(pin)) {
    try {
      const data = JSON.parse(fs.readFileSync(pin, "utf8"));
      if (data?.kitRoot) {
        const candidate = path.join(data.kitRoot, "scripts", "ow.mjs");
        if (fs.existsSync(candidate)) return { mode: "node", ow: candidate };
      }
    } catch {
      /* ignore */
    }
  }
  // In-kit layout: skill/wiki/scripts → package root
  const inKit = path.resolve(__dirname, "../../..");
  const inKitOw = path.join(inKit, "scripts", "ow.mjs");
  if (fs.existsSync(inKitOw) && fs.existsSync(path.join(inKit, "package.json"))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(inKit, "package.json"), "utf8"));
      if (pkg.name === "@okf-wiki/wiki-agent-kit") return { mode: "node", ow: inKitOw };
    } catch {
      /* ignore */
    }
  }
  // Walk parents for a wiki-agent-kit package
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "packages", "wiki-agent-kit", "scripts", "ow.mjs");
    if (fs.existsSync(candidate)) return { mode: "node", ow: candidate };
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  const which = spawnSync("command", ["-v", "ow"], { encoding: "utf8", shell: true });
  if (which.status === 0 && which.stdout.trim()) {
    return { mode: "bin", ow: which.stdout.trim() };
  }
  return null;
}

function parseArgs(argv) {
  const out = { focus: null, workspace: null, approvePlan: false, statusOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--focus") out.focus = argv[++i] ?? "";
    else if (a === "--workspace") out.workspace = argv[++i] ?? null;
    else if (a === "--approve-plan") out.approvePlan = true;
    else if (a === "--status-only") out.statusOnly = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: entry.mjs [--workspace DIR] [--focus TEXT] [--approve-plan] [--status-only]");
      process.exit(0);
    }
  }
  return out;
}

function runOw(locator, args, workspace) {
  const full = [...args];
  if (workspace) full.push("--workspace", workspace);
  if (locator.mode === "node") {
    return spawnSync(process.execPath, [locator.ow, ...full], {
      encoding: "utf8",
      cwd: workspace || process.cwd(),
    });
  }
  return spawnSync(locator.ow, full, {
    encoding: "utf8",
    cwd: workspace || process.cwd(),
    shell: false,
  });
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function main() {
  const locator = findOw();
  if (!locator) {
    die("cannot locate ow CLI; install kit (pnpm link --global) or re-run: ow install --force", {
      hint: "Expected kit-root.json next to entry.mjs or OW_KIT_ROOT",
    });
  }
  const flags = parseArgs(process.argv.slice(2));
  const workspace = flags.workspace ? path.resolve(flags.workspace) : process.cwd();

  const statusR = runOw(locator, ["status"], workspace);
  if (statusR.status !== 0) {
    die(statusR.stderr || statusR.stdout || "ow status failed", {
      hint: "Run from a wiki workspace (workspace.yaml) after: ow init",
    });
  }
  const status = parseJson(statusR.stdout);
  if (!status) die("ow status returned non-JSON");

  const current = status.current;
  const nextAction = status.nextAction;
  const active = status.active;
  const focus = typeof flags.focus === "string" ? flags.focus.trim() : "";

  if (flags.statusOnly) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: "status",
          humanEntry: "/wiki",
          current,
          nextAction,
          active,
          workflowCommand: nextAction?.command || current?.command || null,
          message: "status only",
        },
        null,
        2,
      ),
    );
    return;
  }

  const needsFreeze =
    !active?.runId || Boolean(focus) || active?.status === "tampered" || active?.status === "sealed";

  if (needsFreeze) {
    if (!status.sources?.length) {
      die("workspace has no sources; host must run: ow source add clone|path …", { status });
    }
    const freezeArgs = ["run"];
    if (focus) freezeArgs.push("--focus", focus);
    if (flags.approvePlan) freezeArgs.push("--approve-plan");
    const freezeR = runOw(locator, freezeArgs, workspace);
    const freezeOut = parseJson(freezeR.stdout);
    if (freezeR.status !== 0 || !freezeOut?.ok) {
      die(freezeR.stderr || freezeOut?.error || freezeR.stdout || "ow run failed", {
        freeze: freezeOut,
      });
    }
    const command = freezeOut.workflow?.command || freezeOut.nextAction?.command || "/wiki-produce";
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: "freeze",
          humanEntry: "/wiki",
          runId: freezeOut.runId,
          workdir: freezeOut.workdir,
          workflowCommand: command,
          approvePlan: Boolean(freezeOut.nextAction?.approvePlan),
          message: `Frozen run ${freezeOut.runId}. Invoke Claude workflow ${command} with no args.`,
          nextAction: freezeOut.nextAction,
          current: freezeOut.current,
        },
        null,
        2,
      ),
    );
    return;
  }

  const command = nextAction?.command || current?.command || "/wiki-produce";
  if (command === "done" || active?.status === "sealed") {
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: "done",
          humanEntry: "/wiki",
          runId: active.runId,
          workdir: active.workdir,
          workflowCommand: null,
          message:
            "Active candidate is sealed. To regenerate: host ow retry --from write|plan, then /wiki again. Or pass a new focus to freeze a new run.",
          active,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        action: "resume",
        humanEntry: "/wiki",
        runId: active.runId,
        workdir: active.workdir,
        workflowCommand: command,
        approvePlan: Boolean(current?.approvePlan || nextAction?.approvePlan),
        message: `Active run ${active.runId} (${active.status || current?.phase || "unknown"}). Invoke Claude workflow ${command} with no args.`,
        current,
        nextAction,
        active,
      },
      null,
      2,
    ),
  );
}

main();
