#!/usr/bin/env node
/**
 * Verify that Pi loads @okf-wiki/pi-wiki-agent and exposes /wiki + aliases.
 *
 * Usage (from a trusted project that has the package installed):
 *   node packages/pi-wiki-agent/scripts/verify-pi-install.mjs
 *   pnpm -C packages/pi-wiki-agent verify:pi
 *
 * Spawns `pi --mode rpc --no-session`, sends get_commands, and asserts the
 * expected command names are present.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = ["wiki", "wiki-help", "wiki-status", "wiki-init", "wiki-run", "wiki-source"];
const TIMEOUT_MS = 30_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

function resolvePiBinary() {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  try {
    const require = createRequire(join(packageRoot, "package.json"));
    return require.resolve("@earendil-works/pi-coding-agent/dist/cli.js");
  } catch {
    // fall through
  }
  return "pi";
}

function trustHints(missing) {
  return [
    "",
    "OKF Wiki commands were not found in `pi --mode rpc` get_commands.",
    missing.length ? `Missing: ${missing.join(", ")}` : "",
    "",
    "Trust / install checklist:",
    "  1. Build the package:  pnpm -C packages/pi-wiki-agent build",
    "  2. Install locally:    pi install ./packages/pi-wiki-agent --local --approve",
    "     (or global path):   pi install /absolute/path/to/packages/pi-wiki-agent --approve",
    "  3. Trust the project:  open Pi interactively once and approve project trust,",
    "                         or set defaultProjectTrust / pass --approve for this run.",
    "  4. Confirm settings:   pi list   # should show @okf-wiki/pi-wiki-agent",
    "  5. Re-run:             pnpm -C packages/pi-wiki-agent verify:pi",
    "",
    "Note: non-interactive modes ignore untrusted project packages (defaultProjectTrust=ask).",
    "This package is NOT pi-llm-wiki; look for commands named wiki / wiki-status / wiki-run.",
  ]
    .filter(Boolean)
    .join("\n");
}

function runRpcGetCommands(piBin) {
  return new Promise((resolve, reject) => {
    const child = spawn(piBin, ["--mode", "rpc", "--no-session", "--approve"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Timed out after ${TIMEOUT_MS}ms waiting for get_commands.\nstderr: ${stderr}`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      // Scan complete JSONL lines for the get_commands response.
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "response" && msg.command === "get_commands") {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill("SIGTERM");
          resolve(msg);
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`pi exited early with code ${code}.\nstderr: ${stderr}\nstdout: ${stdout.slice(0, 2000)}`));
    });

    // Wait briefly for rpc mode to come up, then request commands.
    setTimeout(() => {
      child.stdin.write(`${JSON.stringify({ id: "verify-1", type: "get_commands" })}\n`);
    }, 500);
  });
}

async function main() {
  const piBin = resolvePiBinary();
  console.log(`verify-pi-install: using ${piBin}`);
  console.log(`verify-pi-install: cwd ${process.cwd()}`);

  let response;
  try {
    response = await runRpcGetCommands(piBin);
  } catch (error) {
    console.error(String(error?.message ?? error));
    console.error(trustHints(REQUIRED));
    process.exit(1);
  }

  if (!response.success) {
    console.error("get_commands failed:", JSON.stringify(response, null, 2));
    console.error(trustHints(REQUIRED));
    process.exit(1);
  }

  const names = new Set((response.data?.commands ?? []).map((cmd) => cmd.name));
  const missing = REQUIRED.filter((name) => !names.has(name));
  if (missing.length > 0) {
    console.error("Registered commands:", [...names].sort().join(", ") || "(none)");
    console.error(trustHints(missing));
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
