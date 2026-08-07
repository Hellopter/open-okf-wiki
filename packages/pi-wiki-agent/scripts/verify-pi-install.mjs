#!/usr/bin/env node
/**
 * Verify that Pi loads @okf-wiki/pi-wiki-agent and exposes /wiki + aliases.
 *
 * Usage (from monorepo root, project trusted once in interactive Pi):
 *   node packages/pi-wiki-agent/scripts/verify-pi-install.mjs
 *   pnpm -C packages/pi-wiki-agent verify:pi
 *
 * Spawns `pi --mode rpc --no-session`, sends get_commands, asserts command names.
 * Compatible with older Pi CLIs that lack `--approve` on the main entrypoint.
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = [
  "wiki",
  "wiki-help",
  "wiki-init",
  "wiki-run",
  "wiki-source",
];
const TIMEOUT_MS = 45_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

function resolvePiBinary() {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  const require = createRequire(join(packageRoot, "package.json"));
  const candidates = [
    () => require.resolve("@earendil-works/pi-coding-agent/dist/cli.js"),
    () => join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi"),
    () => join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
  ];
  for (const pick of candidates) {
    try {
      const resolved = pick();
      if (resolved) return resolved;
    } catch {
      // try next
    }
  }
  return "pi";
}

/** Older Pi builds only accept --approve on package subcommands, not `pi --mode rpc`. */
function supportsMainApproveFlag(piBin) {
  const probe = spawnSync(piBin, ["--help"], {
    encoding: "utf8",
    env: process.env,
    timeout: 15_000,
  });
  const text = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  return /--approve\b/.test(text) || /\s-a,\s*--approve\b/.test(text);
}

function diagnoseStderr(stderr) {
  const lines = [];
  if (/Unknown option:\s*--approve/i.test(stderr)) {
    lines.push(
      "DIAGNOSIS: this Pi CLI does not accept `--approve` on the main entrypoint.",
      "  → Trust the project once in interactive Pi (open the repo and approve),",
      "    then re-run verify without relying on --approve.",
      "  → Or upgrade Pi:  pi update --self   (need a build that documents --approve in `pi --help`).",
    );
  }
  if (/index\.js[/\\]compat|dist[/\\]index\.js[/\\]compat/i.test(stderr)) {
    lines.push(
      "DIAGNOSIS: jiti resolved `@earendil-works/pi-ai/compat` as `…/dist/index.js/compat`.",
      "  That is a known Pi host alias bug on older hosts: the alias maps the package root to",
      "  `dist/index.js`, then appends `/compat` instead of using `dist/compat.js`.",
      "  → Upgrade the global/host Pi to >= 0.80 (prefer latest 0.82+):",
      "      pi update --self",
      "      # or: npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
      "  → Then reinstall broken extensions:",
      "      pi remove npm:pi-web-access",
      "      pi remove npm:pi-subagents",
      "      pi install npm:pi-web-access",
      "      pi install npm:pi-subagents",
      "  This is NOT fixed inside @okf-wiki/pi-wiki-agent; the host must provide correct aliases.",
    );
  }
  if (/Failed to load extension/i.test(stderr) && /pi-web-access|pi-subagents/i.test(stderr)) {
    lines.push(
      "NOTE: pi-web-access / pi-subagents failed to load. That can abort or pollute startup.",
      "  Fix or temporarily remove them if you only need to verify OKF wiki commands:",
      "      pi remove npm:pi-web-access",
      "      pi remove npm:pi-subagents",
    );
  }
  return lines;
}

function trustHints(missing, stderr = "") {
  const diagnosis = diagnoseStderr(stderr);
  return [
    "",
    "OKF Wiki commands were not found (or Pi failed before get_commands).",
    missing.length ? `Missing command names: ${missing.join(", ")}` : "",
    "",
    ...diagnosis,
    diagnosis.length ? "" : null,
    "Install / trust checklist for @okf-wiki/pi-wiki-agent:",
    "  1. Build:   pnpm -C packages/pi-wiki-agent build",
    "  2. Install: pi install ./packages/pi-wiki-agent --local",
    "     (if `pi install --help` shows -a/--approve, add it when trusting for that command)",
    "  3. Trust:   open Pi interactively in this repo once and approve project trust",
    "  4. List:    pi list",
    "  5. Re-run:  pnpm -C packages/pi-wiki-agent verify:pi",
    "",
    "This package is NOT pi-llm-wiki; expect /wiki, /wiki-run, /wiki-source, …",
  ]
    .filter((line) => line !== null && line !== undefined)
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n");
}

function runRpcGetCommands(piBin, useApprove) {
  return new Promise((resolve, reject) => {
    const args = ["--mode", "rpc", "--no-session"];
    if (useApprove) args.push("--approve");

    const child = spawn(piBin, args, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(Object.assign(new Error(`Timed out after ${TIMEOUT_MS}ms waiting for get_commands.`), { stderr, stdout }));
    }, TIMEOUT_MS);

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      fn();
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "response" && msg.command === "get_commands") {
          finish(() => resolve({ response: msg, stderr, stdout, usedApprove: useApprove }));
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish(() => reject(Object.assign(error, { stderr, stdout })));
    });
    child.on("exit", (code) => {
      if (settled) return;
      finish(() =>
        reject(
          Object.assign(new Error(`pi exited early with code ${code}.`), {
            stderr,
            stdout,
            code,
          }),
        ),
      );
    });

    setTimeout(() => {
      try {
        child.stdin.write(`${JSON.stringify({ id: "verify-1", type: "get_commands" })}\n`);
      } catch {
        // process already dead
      }
    }, 800);
  });
}

async function main() {
  const piBin = resolvePiBinary();
  console.log(`verify-pi-install: using ${piBin}`);
  console.log(`verify-pi-install: cwd ${process.cwd()}`);

  const canApprove = supportsMainApproveFlag(piBin);
  console.log(`verify-pi-install: main --approve support: ${canApprove ? "yes" : "no (will omit)"}`);

  let result;
  try {
    result = await runRpcGetCommands(piBin, canApprove);
  } catch (error) {
    const stderr = error?.stderr ?? "";
    const stdout = error?.stdout ?? "";
    console.error(String(error?.message ?? error));
    if (stderr) {
      console.error("stderr:");
      console.error(stderr.slice(0, 4000));
    }
    if (stdout) {
      console.error("stdout (truncated):");
      console.error(String(stdout).slice(0, 1500));
    }
    console.error(trustHints(REQUIRED, stderr));
    process.exit(1);
  }

  const { response, stderr } = result;
  if (stderr && /Failed to load extension/i.test(stderr)) {
    console.warn("warn: some extensions failed to load (see diagnosis if verify fails):");
    console.warn(stderr.slice(0, 2000));
  }

  if (!response.success) {
    console.error("get_commands failed:", JSON.stringify(response, null, 2));
    console.error(trustHints(REQUIRED, stderr));
    process.exit(1);
  }

  const names = new Set((response.data?.commands ?? []).map((cmd) => cmd.name));
  const missing = REQUIRED.filter((name) => !names.has(name));
  if (missing.length > 0) {
    console.error("Registered commands:", [...names].sort().join(", ") || "(none)");
    console.error(trustHints(missing, stderr));
    process.exit(1);
  }

  console.log("OK: Pi exposes wiki commands:");
  for (const name of REQUIRED) {
    const cmd = (response.data.commands ?? []).find((entry) => entry.name === name);
    console.log(`  /${name}${cmd?.description ? ` — ${cmd.description}` : ""}`);
  }
  process.exit(0);
}

main();
