/**
 * Cross-platform process helpers for monorepo scripts.
 * Windows: pnpm is pnpm.cmd; process trees via taskkill; listeners via netstat.
 * Unix: pgrep / lsof / process.kill.
 */
import { execFileSync, spawn } from "node:child_process";

export const isWin = process.platform === "win32";

/**
 * Resolve a CLI name so spawn works without a shell.
 * On Windows, bare `pnpm` is not found (needs `pnpm.cmd`).
 * @param {string} command
 */
export function resolveCommand(command) {
  if (!isWin) return command;
  if (command === "pnpm") return "pnpm.cmd";
  return command;
}

/**
 * Kill pid and descendants (pnpm → node grandchildren).
 * @param {number} pid
 * @param {NodeJS.Signals | number} [signal]
 */
export function killTree(pid, signal = "SIGTERM") {
  if (!pid) return;
  if (isWin) {
    // /T = tree; /F for SIGKILL (and soft taskkill often fails on node).
    const args =
      signal === "SIGKILL" || signal === 9
        ? ["/pid", String(pid), "/T", "/F"]
        : ["/pid", String(pid), "/T"];
    try {
      execFileSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    } catch {
      // already gone or access denied
    }
    return;
  }
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

/**
 * Parse local address:port from netstat (IPv4 or [IPv6]).
 * @param {string} local
 * @returns {number | null}
 */
function localAddressPort(local) {
  if (!local) return null;
  if (local.startsWith("[") && local.includes("]:")) {
    const n = Number(local.slice(local.lastIndexOf("]:") + 2));
    return Number.isInteger(n) ? n : null;
  }
  const idx = local.lastIndexOf(":");
  if (idx < 0) return null;
  const n = Number(local.slice(idx + 1));
  return Number.isInteger(n) ? n : null;
}

/**
 * PIDs listening on a TCP port. Empty if none / tooling missing.
 * @param {number} port
 * @returns {number[]}
 */
export function pidsListeningOnPort(port) {
  if (isWin) {
    try {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        // TCP  0.0.0.0:8787  0.0.0.0:0  LISTENING  1234
        if (parts.length < 5 || parts[0].toUpperCase() !== "TCP") continue;
        const localPort = localAddressPort(parts[1]);
        if (localPort !== port) continue;
        const pid = Number(parts[parts.length - 1]);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
      }
      return [...pids];
    } catch {
      return [];
    }
  }
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

/**
 * Hint for freeing a port when automated kill fails.
 * @param {number} port
 */
export function portKillHint(port) {
  if (isWin) {
    return `netstat -ano -p tcp | findstr :${port}   then   taskkill /PID <pid> /T /F`;
  }
  return `lsof -tiTCP:${port} -sTCP:LISTEN | xargs -r kill -9`;
}

/**
 * spawn with resolved command (Windows pnpm.cmd) and stdio inherit defaults.
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 */
export function spawnResolved(command, args, options = {}) {
  return spawn(resolveCommand(command), args, {
    shell: false,
    windowsHide: true,
    ...options,
  });
}
