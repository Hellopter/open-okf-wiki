#!/usr/bin/env node
/**
 * Cross-platform test runner for @okf-wiki/pi-wiki-agent.
 *
 * - Expands test globs without shell globbing (Windows cmd/PowerShell).
 * - Preflight-imports peer modules that pi-coding-agent needs (notably
 *   `@earendil-works/pi-ai/compat`). Uses dynamic `import()` so pure-ESM
 *   packages with conditional "exports" resolve correctly (createRequire does not).
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_MODULES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
  "@okf-wiki/wiki-agent-kit",
];

async function preflight() {
  const missing = [];
  for (const id of REQUIRED_MODULES) {
    try {
      await import(id);
    } catch (error) {
      missing.push({ id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (missing.length === 0) return;

  console.error("error: missing modules required to run pi-wiki-agent tests:");
  for (const entry of missing) {
    console.error(`  - ${entry.id}`);
    console.error(`      ${entry.message.split("\n")[0]}`);
  }
  console.error(
    [
      "",
      "This usually means monorepo dependencies were not installed, or peer",
      "packages for Pi (@earendil-works/pi-ai, pi-coding-agent, pi-tui) are missing.",
      "",
      "From the monorepo root run:",
      "",
      "  pnpm install",
      "  pnpm -C packages/pi-wiki-agent test",
      "",
      "If install was interrupted, retry with:",
      "",
      "  CI=true pnpm install",
    ].join("\n"),
  );
  process.exit(1);
}

function listTestFiles() {
  const testsDir = join(packageRoot, "tests");
  return readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => join(testsDir, name))
    .sort();
}

await preflight();

const files = listTestFiles();
if (files.length === 0) {
  console.error("error: no tests/*.test.mjs files found");
  process.exit(1);
}

// Prefer file URLs on Windows so drive-letter paths are unambiguous.
const args = [
  "--test",
  ...files.map((file) => (process.platform === "win32" ? pathToFileURL(file).href : file)),
];

const result = spawnSync(process.execPath, args, {
  cwd: packageRoot,
  stdio: "inherit",
  env: process.env,
  shell: false,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
