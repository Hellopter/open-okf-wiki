#!/usr/bin/env node
/**
 * Fail if pure modules import @earendil-works/* (Pi packages).
 * See ARCHITECTURE.md → Import rules.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

/** Pure modules that must not depend on @earendil-works/* */
const PURE_MODULES = [
  "producer-types.ts",
  "delegate-contracts.ts",
  "run-ledger.ts",
  "cli.ts",
  "observability.ts",
  "failures.ts",
  "util.ts",
  "path-policy.ts",
];

const FORBIDDEN = /from\s+["']@earendil-works\//;
const FORBIDDEN_REQUIRE = /require\s*\(\s*["']@earendil-works\//;

const violations = [];

for (const rel of PURE_MODULES) {
  const file = path.join(SRC, rel);
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    violations.push(`${rel}: missing (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip block/line comments that merely mention the package name.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    if (FORBIDDEN.test(line) || FORBIDDEN_REQUIRE.test(line)) {
      violations.push(`${rel}:${i + 1}: ${trimmed}`);
    }
  }
}

if (violations.length) {
  console.error("Import boundary check failed — pure modules must not import @earendil-works/*:\n");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`Import boundary check passed (${PURE_MODULES.length} pure modules).`);
