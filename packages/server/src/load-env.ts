/**
 * Load monorepo-root `.env` into process.env (never overrides existing keys).
 *
 * Must be imported first from main.ts so host/port/log config see the values.
 * No dotenv dependency — small parser for KEY=VALUE lines.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Parse a dotenv-style file body into key/value pairs. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Optional leading `export `
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Apply env file into process.env. Existing process env always wins
 * (does not override). Returns paths that were applied.
 */
export function applyEnvFile(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!existsSync(filePath)) return false;
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  const parsed = parseEnvFile(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
  return true;
}

/** Monorepo root: packages/server/src → ../../.. */
export function monorepoRootFromServerSrc(
  fromUrl: string = import.meta.url,
): string {
  return path.resolve(path.dirname(fileURLToPath(fromUrl)), "../../..");
}

/**
 * Load `.env` from monorepo root, then optional `packages/server/.env`.
 * Safe to call multiple times; process env still wins on each key.
 */
export function loadEnvFiles(
  env: NodeJS.ProcessEnv = process.env,
  root: string = monorepoRootFromServerSrc(),
): string[] {
  const candidates = [
    path.join(root, ".env"),
    path.join(root, "packages", "server", ".env"),
  ];
  const loaded: string[] = [];
  for (const file of candidates) {
    if (applyEnvFile(file, env)) loaded.push(file);
  }
  return loaded;
}

// Side-effect import path: evaluating this module loads env immediately.
loadEnvFiles();
