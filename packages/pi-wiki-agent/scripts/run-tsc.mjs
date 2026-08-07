#!/usr/bin/env node
/**
 * Cross-platform TypeScript runner.
 *
 * Avoids bare `tsc` (not on PATH on many Windows shells) and fragile relative
 * paths when pnpm's node_modules layout differs. Resolves the local
 * `typescript` package the same way Node module resolution does.
 *
 * Usage (from package root, via package scripts):
 *   node scripts/run-tsc.mjs -p tsconfig.json
 *   node scripts/run-tsc.mjs -p tsconfig.json --noEmit
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(packageRoot, "package.json"));
const tscArgs = process.argv.slice(2);

let tscJs;
try {
  tscJs = require.resolve("typescript/lib/tsc.js");
} catch {
  console.error(
    [
      "error: local TypeScript not found for @okf-wiki/pi-wiki-agent.",
      "Install workspace deps from the monorepo root, then rebuild:",
      "",
      "  pnpm install",
      "  pnpm -C packages/pi-wiki-agent build",
      "",
      "Do not run bare `tsc` — it is not required and is usually not on PATH.",
    ].join("\n"),
  );
  process.exit(1);
}

// TypeScript does not remove output for deleted source files.
if (!tscArgs.includes("--noEmit")) {
  rmSync(join(packageRoot, "dist"), { recursive: true, force: true });
}

const result = spawnSync(process.execPath, [tscJs, ...tscArgs], {
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
