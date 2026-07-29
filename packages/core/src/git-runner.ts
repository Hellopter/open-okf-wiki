import { spawn } from "node:child_process";

export type GitRunResult = { stdout: string; stderr: string; code: number };

export type GitRunner = (
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<GitRunResult>;

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Default host `git` runner via `spawn`. No shell; credentials come from the host.
 */
export function createDefaultGitRunner(): GitRunner {
  return (cwd, args, opts) =>
    new Promise((resolve, reject) => {
      if (opts?.signal?.aborted) {
        reject(abortError());
        return;
      }
      const child = spawn("git", args, {
        cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let aborted = false;
      const signal = opts?.signal;
      const onAbort = () => {
        if (settled) return;
        aborted = true;
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            // The process may have already exited between abort and kill.
          }
        }
        child.kill("SIGTERM");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutMs = opts?.timeoutMs;
      const timer =
        typeof timeoutMs === "number" && timeoutMs > 0
          ? setTimeout(() => {
              if (!settled) {
                child.kill("SIGTERM");
              }
            }, timeoutMs)
          : null;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      child.on("error", (error) => {
        if (settled) return;
        cleanup();
        settled = true;
        if (aborted) {
          reject(abortError());
          return;
        }
        resolve({ code: 127, stdout: "", stderr: error.message });
      });
      child.on("close", (code) => {
        if (settled) return;
        cleanup();
        settled = true;
        if (aborted) {
          reject(abortError());
          return;
        }
        resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });
}
