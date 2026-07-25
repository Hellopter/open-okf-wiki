#!/usr/bin/env node
/**
 * Ordered monorepo dev stack:
 *   0) ensure API + Vite ports are free (clear stale listeners from prior runs)
 *   1) contract/core/agent tsc --watch
 *   2) server (node --watch)
 *   3) wait for GET /api/health
 *   4) web (vite)
 *
 * Avoids:
 * - Vite proxy 502 before API listens
 * - "Port 5173 is already in use" from orphaned Vite after a previous crash
 * - Health succeeding against a *stale* API while the new server never binds
 */
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = Number(process.env.OKF_WIKI_PORT ?? "8787");
const apiHost = process.env.OKF_WIKI_HOST ?? "127.0.0.1";
const vitePort = Number(process.env.VITE_DEV_PORT ?? "5173");
const healthUrl = `http://${apiHost}:${apiPort}/api/health`;
const healthTimeoutMs = Number(process.env.OKF_DEV_HEALTH_TIMEOUT_MS ?? "90000");
/** Default true: free stale listeners so re-running `pnpm dev` is reliable. Set 0 to refuse. */
const killBusyPorts = process.env.OKF_DEV_KILL_PORTS !== "0";

const children = [];
let shuttingDown = false;

/** Kill pid and descendants (pnpm → node grandchildren). Linux/macOS via pgrep. */
export function killTree(pid, signal = "SIGTERM") {
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

/** PIDs listening on a TCP port (Linux lsof). Empty if none / lsof missing. */
export function pidsListeningOnPort(port) {
  try {
    const out = execFileSync("lsof", ["-tiTCP:" + String(port), "-sTCP:LISTEN"], {
      encoding: "utf8",
    }).trim();
    if (!out) return [];
    return [
      ...new Set(
        out
          .split(/\s+/)
          .map((s) => Number(s))
          .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid),
      ),
    ];
  } catch {
    return [];
  }
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
        `Stop it, or re-run with OKF_DEV_KILL_PORTS=1 (default) after setting OKF_DEV_KILL_PORTS=0 was used.`,
    );
  }

  process.stdout.write(
    `[dev-stack] ${label} port ${port} busy (pid ${pidLabel}) — freeing for a clean start\n`,
  );
  for (const pid of pids) {
    killTree(pid, "SIGTERM");
  }
  // Brief wait for TIME_WAIT / graceful exit
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
        `Kill manually: lsof -tiTCP:${port} -sTCP:LISTEN | xargs -r kill -9`,
    );
  }
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
    if (shuttingDown) return;
    const exitCode = code ?? (signal ? 1 : 0);
    shuttingDown = true;
    for (const other of children) {
      if (other !== child) killChild(other, "SIGTERM");
    }
    // Give grandchildren a moment, then hard-kill trees
    setTimeout(() => {
      for (const other of children) killChild(other, "SIGKILL");
      process.exit(exitCode);
    }, 300).unref?.();
  });
  return child;
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

async function main() {
  process.stdout.write(
    `[dev-stack] preparing ports api=${apiPort} vite=${vitePort}; health gate ${healthUrl}\n`,
  );

  await ensurePortFree(apiPort, "API", { host: apiHost === "0.0.0.0" ? "127.0.0.1" : apiHost });
  await ensurePortFree(vitePort, "Vite", { host: "127.0.0.1" });

  process.stdout.write(
    `[dev-stack] starting lib watches + server; will wait for ${healthUrl} before Vite\n`,
  );

  spawnPnpm(["--filter", "@okf-wiki/contract", "dev"]);
  spawnPnpm(["--filter", "@okf-wiki/core", "dev"]);
  spawnPnpm(["--filter", "@okf-wiki/agent", "dev"]);
  spawnPnpm(["--filter", "@okf-wiki/server", "dev"]);

  try {
    await waitForUrl(healthUrl, Number.isFinite(healthTimeoutMs) ? healthTimeoutMs : 90_000);
  } catch (err) {
    process.stderr.write(
      `[dev-stack] ${err instanceof Error ? err.message : String(err)}\n` +
        `[dev-stack] Is the API free on ${apiHost}:${apiPort}? Check OKF_WIKI_PORT / EADDRINUSE.\n`,
    );
    shutdown(1);
    return;
  }

  process.stdout.write(`[dev-stack] API healthy — starting Vite\n`);
  spawnPnpm(["--filter", "@okf-wiki/web", "dev"]);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    shutdown(1);
  });
}
