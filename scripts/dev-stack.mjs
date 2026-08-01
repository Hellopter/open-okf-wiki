#!/usr/bin/env node
import { access } from "node:fs/promises";
/**
 * Ordered monorepo dev stack (no Turbo).
 *
 * Profiles:
 *   full   (default) — libs tsc -b -w + server → health → vite
 *   server           — libs tsc -b -w + server → health (no Vite)
 *   web              — vite only (expects contract dist or Vite src alias)
 *
 * Process count (full): 3 = libs-watch + server + vite
 * (was 5: contract/core/agent tsc-w + server + vite)
 *
 * Windows-compatible: shell spawn for pnpm.cmd, taskkill, netstat (process-compat.mjs).
 */
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killTree, pidsListeningOnPort, portKillHint, spawnResolved } from "./process-compat.mjs";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = Number(process.env.OKF_WIKI_PORT ?? "8787");
const apiHost = process.env.OKF_WIKI_HOST ?? "127.0.0.1";
const apiProbeHost = apiProbeHostForBind(apiHost);
const vitePort = Number(process.env.VITE_DEV_PORT ?? "5173");
const healthUrl = `http://${formatHttpHost(apiProbeHost)}:${apiPort}/api/health`;
const healthTimeoutMs = Number(process.env.OKF_DEV_HEALTH_TIMEOUT_MS ?? "90000");
/** Default true: free stale listeners so re-running `pnpm dev` is reliable. Set 0 to refuse. */
const killBusyPorts = process.env.OKF_DEV_KILL_PORTS !== "0";

const agentDistEntry = path.join(monorepoRoot, "packages/agent/dist/index.js");
const contractDistEntry = path.join(monorepoRoot, "packages/contract/dist/index.js");

const children = [];
let shuttingDown = false;

/** @typedef {'full' | 'server' | 'web'} DevProfile */

export { killTree, pidsListeningOnPort };

/** A wildcard bind address cannot be used as a local client destination. */
export function apiProbeHostForBind(bindHost) {
  if (bindHost === "0.0.0.0") return "127.0.0.1";
  if (bindHost === "::" || bindHost === "[::]") return "::1";
  return bindHost;
}

function formatHttpHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function killChild(child, signal = "SIGTERM") {
  if (child.killed || !child.pid) return;
  killTree(child.pid, signal);
}

/** True if something accepts TCP on host:port. */
export function isPortOpen(port, host = "127.0.0.1", timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Ensure port is free. When killBusyPorts, SIGTERM then SIGKILL listeners.
 * Throws if still busy.
 */
export async function ensurePortFree(
  port,
  label,
  { kill = killBusyPorts, host = "127.0.0.1" } = {},
) {
  const open = await isPortOpen(port, host);
  const pids = pidsListeningOnPort(port);
  if (!open && pids.length === 0) return;

  const pidLabel = pids.length ? pids.join(", ") : "unknown";
  if (!kill) {
    throw new Error(
      `${label} port ${port} is already in use (pid ${pidLabel}). ` +
        `Stop it, or re-run with OKF_DEV_KILL_PORTS=1 (default).`,
    );
  }

  process.stdout.write(
    `[dev-stack] ${label} port ${port} busy (pid ${pidLabel}) — freeing for a clean start\n`,
  );
  for (const pid of pids) {
    killTree(pid, "SIGTERM");
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const still = pidsListeningOnPort(port);
    const stillOpen = await isPortOpen(port, host);
    if (still.length === 0 && !stillOpen) return;
    if (i === 15) {
      for (const pid of still) killTree(pid, "SIGKILL");
    }
  }
  const left = pidsListeningOnPort(port);
  if (left.length > 0 || (await isPortOpen(port, host))) {
    throw new Error(
      `${label} port ${port} still in use after free attempt (pid ${left.join(", ") || "unknown"}). ` +
        `Kill manually: ${portKillHint(port)}`,
    );
  }
}

function spawnCmd(command, args, env = {}) {
  const child = spawnResolved(command, args, {
    cwd: monorepoRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const exitCode = code ?? (signal ? 1 : 0);
    shuttingDown = true;
    for (const other of children) {
      if (other !== child) killChild(other, "SIGTERM");
    }
    setTimeout(() => {
      for (const other of children) killChild(other, "SIGKILL");
      process.exit(exitCode);
    }, 300).unref?.();
  });
  child.on("error", (err) => {
    if (shuttingDown) return;
    console.error(`[dev-stack] failed to start ${command}: ${err.message}`);
    shuttingDown = true;
    for (const other of children) {
      if (other !== child) killChild(other, "SIGTERM");
    }
    setTimeout(() => {
      for (const other of children) killChild(other, "SIGKILL");
      process.exit(1);
    }, 300).unref?.();
  });
  return child;
}

function spawnPnpm(args, env = {}) {
  return spawnCmd("pnpm", args, env);
}

/** One-shot command; rejects on non-zero exit. */
export function runOnce(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnResolved(command, args, {
      cwd: monorepoRoot,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}`));
    });
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killChild(child, "SIGTERM");
  setTimeout(() => {
    for (const child of children) killChild(child, "SIGKILL");
    process.exit(code);
  }, 300).unref?.();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

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

export async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Parse --profile=full|server|web or first positional arg. */
export function parseProfile(argv = process.argv.slice(2)) {
  for (const arg of argv) {
    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length).trim();
      if (value === "full" || value === "server" || value === "web") return value;
      throw new Error(`Unknown profile "${value}" (use full|server|web)`);
    }
    if (arg === "--profile") {
      throw new Error("Use --profile=full|server|web");
    }
    if (arg === "full" || arg === "server" || arg === "web") return arg;
    if (arg === "--help" || arg === "-h") return "help";
  }
  const fromEnv = (process.env.OKF_DEV_PROFILE ?? "full").trim();
  if (fromEnv === "full" || fromEnv === "server" || fromEnv === "web") return fromEnv;
  throw new Error(`Unknown OKF_DEV_PROFILE="${fromEnv}" (use full|server|web)`);
}

async function buildLibsOnce() {
  process.stdout.write(`[dev-stack] building libs (tsc -b tsconfig.libs.json)…\n`);
  await runOnce("pnpm", ["exec", "tsc", "-b", "tsconfig.libs.json", "--pretty", "false"]);
  if (!(await pathExists(agentDistEntry))) {
    throw new Error(`libs build finished but missing ${agentDistEntry}`);
  }
}

function startLibsWatch() {
  process.stdout.write(`[dev-stack] watching libs (tsc -b tsconfig.libs.json --watch)\n`);
  // Single composite watch for contract → core → agent (replaces 3× package tsc -w).
  return spawnCmd("pnpm", [
    "exec",
    "tsc",
    "-b",
    "tsconfig.libs.json",
    "--watch",
    "--preserveWatchOutput",
    "--pretty",
    "false",
  ]);
}

function startServer() {
  process.stdout.write(`[dev-stack] starting server\n`);
  return spawnPnpm(["--filter", "@okf-wiki/server", "dev"]);
}

function startVite() {
  process.stdout.write(`[dev-stack] starting Vite\n`);
  return spawnPnpm(["--filter", "@okf-wiki/web", "dev"]);
}

async function waitApiHealthy() {
  process.stdout.write(`[dev-stack] waiting for ${healthUrl}\n`);
  try {
    await waitForUrl(healthUrl, Number.isFinite(healthTimeoutMs) ? healthTimeoutMs : 90_000);
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n` +
        `[dev-stack] Is the API free on ${apiHost}:${apiPort}? Check OKF_WIKI_PORT / EADDRINUSE.`,
    );
  }
  process.stdout.write(`[dev-stack] API healthy\n`);
}

async function main() {
  const profile = parseProfile();
  if (profile === "help") {
    process.stdout.write(
      `Usage: node scripts/dev-stack.mjs [--profile=full|server|web]\n` +
        `  full   (default) libs watch + server + vite after /api/health\n` +
        `  server           libs watch + server (no vite)\n` +
        `  web              vite only\n` +
        `Env: OKF_DEV_PROFILE, OKF_DEV_KILL_PORTS=0, OKF_WIKI_PORT, VITE_DEV_PORT\n`,
    );
    process.exit(0);
  }

  process.stdout.write(
    `[dev-stack] profile=${profile} api=${apiPort} vite=${vitePort} health=${healthUrl}\n`,
  );

  if (profile === "web") {
    await ensurePortFree(vitePort, "Vite", { host: "127.0.0.1" });
    // Vite aliases contract to src; dist optional but helpful for types outside Vite.
    if (!(await pathExists(contractDistEntry))) {
      process.stdout.write(
        `[dev-stack] contract dist missing — running one-shot libs build for types/tooling\n`,
      );
      await buildLibsOnce();
    }
    startVite();
    return;
  }

  // full | server
  await ensurePortFree(apiPort, "API", { host: apiProbeHost });
  if (profile === "full") {
    await ensurePortFree(vitePort, "Vite", { host: "127.0.0.1" });
  }

  // One composite build so server never boots against empty/partial dist, then one watch.
  await buildLibsOnce();
  startLibsWatch();
  startServer();
  await waitApiHealthy();

  if (profile === "full") {
    startVite();
  } else {
    process.stdout.write(
      `[dev-stack] server-only profile — open API at http://${apiProbeHost}:${apiPort}\n`,
    );
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    shutdown(1);
  });
}
