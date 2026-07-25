#!/usr/bin/env node
/**
 * Ordered monorepo dev stack:
 *   1) contract/core/agent tsc --watch
 *   2) server (node --watch)
 *   3) wait for GET /api/health
 *   4) web (vite)
 *
 * Avoids the startup race where Vite proxies /api before the API listens
 * (browser sees 502 Bad Gateway). Aligns with packages/web/scripts/e2e-dev.mjs.
 */
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.OKF_WIKI_PORT ?? "8787";
const host = process.env.OKF_WIKI_HOST ?? "127.0.0.1";
const healthUrl = `http://${host}:${port}/api/health`;
const healthTimeoutMs = Number(process.env.OKF_DEV_HEALTH_TIMEOUT_MS ?? "90000");

const children = [];

/** Kill pid and descendants (pnpm → node grandchildren). Linux/macOS via pgrep. */
function killTree(pid, signal = "SIGTERM") {
  if (!pid) return;
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim();
    for (const line of out.split("\n")) {
      const childPid = Number(line);
      if (childPid) killTree(childPid, signal);
    }
  } catch {
    // no children
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

function killChild(child, signal = "SIGTERM") {
  if (child.killed || !child.pid) return;
  killTree(child.pid, signal);
}

function spawnPnpm(args, env = {}) {
  const child = spawn("pnpm", args, {
    cwd: monorepoRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: false,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    const exitCode = code ?? (signal ? 1 : 0);
    for (const other of children) {
      if (other !== child) killChild(other, "SIGTERM");
    }
    process.exit(exitCode);
  });
  return child;
}

function shutdown() {
  for (const child of children) killChild(child, "SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export async function waitForUrl(url, timeoutMs = 90_000) {
  const start = Date.now();
  let lastError = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url} (${lastError || "unreachable"})`);
}

async function main() {
  process.stdout.write(
    `[dev-stack] starting lib watches + server; will wait for ${healthUrl} before Vite\n`,
  );

  // Library watches first so dist stays warm while server boots.
  spawnPnpm(["--filter", "@okf-wiki/contract", "dev"]);
  spawnPnpm(["--filter", "@okf-wiki/core", "dev"]);
  spawnPnpm(["--filter", "@okf-wiki/agent", "dev"]);
  spawnPnpm(["--filter", "@okf-wiki/server", "dev"]);

  try {
    await waitForUrl(healthUrl, Number.isFinite(healthTimeoutMs) ? healthTimeoutMs : 90_000);
  } catch (err) {
    process.stderr.write(
      `[dev-stack] ${err instanceof Error ? err.message : String(err)}\n` +
        `[dev-stack] Is the API free on ${host}:${port}? Check OKF_WIKI_PORT / EADDRINUSE.\n`,
    );
    shutdown();
    process.exit(1);
  }

  process.stdout.write(`[dev-stack] API healthy — starting Vite\n`);
  spawnPnpm(["--filter", "@okf-wiki/web", "dev"]);
}

// Only auto-run when executed as the main script (not when imported by tests).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    shutdown();
    process.exit(1);
  });
}
