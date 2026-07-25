import { spawn } from "node:child_process";

export type GitRunResult = { stdout: string; stderr: string; code: number };

export type GitRunner = (
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<GitRunResult>;

/**
 * Default host `git` runner via `spawn`. No shell; credentials come from the host.
 */
export function createDefaultGitRunner(): GitRunner {
  return (cwd, args, opts) =>
    new Promise((resolve) => {
      const child = spawn("git", args, {
        cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
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
      child.on("error", (error) => {
        if (timer) {
          clearTimeout(timer);
        }
        settled = true;
        resolve({ code: 127, stdout: "", stderr: error.message });
      });
      child.on("close", (code) => {
        if (timer) {
          clearTimeout(timer);
        }
        settled = true;
        resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });
}
