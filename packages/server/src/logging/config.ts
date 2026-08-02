/**
 * Server runtime log configuration from environment.
 *
 * Paths resolve cross-platform via path.join / product home
 * ($OKF_WIKI_HOME or ~/.okf-wiki; Windows: %USERPROFILE%\.okf-wiki).
 */
import path from "node:path";
import { defaultServerLogDir } from "@okf-wiki/core";

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export type ServerLogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export type ServerLogConfig = {
  level: ServerLogLevel;
  /** Human-readable console (pino-pretty). */
  pretty: boolean;
  /** Absolute path to JSONL file, or null when file sink disabled. */
  filePath: string | null;
  /** Emit http.request access lines. */
  logHttp: boolean;
  /** When logHttp, also log GET /api/health. */
  logHttpHealth: boolean;
};

function envFlag(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return defaultValue;
}

function parseLevel(raw: string | undefined, fallback: ServerLogLevel): ServerLogLevel {
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  return LEVELS.has(v) ? (v as ServerLogLevel) : fallback;
}

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

/**
 * Resolve log directory:
 * 1. OKF_LOG_DIR
 * 2. defaultServerLogDir (OKF_WIKI_HOME/logs or ~/.okf-wiki/logs)
 */
export function resolveLogDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.OKF_LOG_DIR?.trim();
  if (dir) return path.resolve(dir);
  return defaultServerLogDir(env);
}

/**
 * Resolve file path:
 * - OKF_LOG_FILE=0|false|off → null (disabled)
 * - OKF_LOG_FILE=/abs/path → that path
 * - unset → <logDir>/server.jsonl
 */
export function resolveLogFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.OKF_LOG_FILE?.trim();
  if (raw !== undefined && raw !== "") {
    const lower = raw.toLowerCase();
    if (lower === "0" || lower === "false" || lower === "off" || lower === "no") {
      return null;
    }
    return path.resolve(raw);
  }
  return path.join(resolveLogDir(env), "server.jsonl");
}

export function loadServerLogConfig(env: NodeJS.ProcessEnv = process.env): ServerLogConfig {
  const production = isProduction(env);
  const defaultLevel: ServerLogLevel = production ? "info" : "debug";
  const prettyExplicit = env.OKF_LOG_PRETTY?.trim();
  const pretty =
    prettyExplicit !== undefined && prettyExplicit !== ""
      ? envFlag(prettyExplicit, false)
      : !production && Boolean(process.stdout.isTTY);

  return {
    level: parseLevel(env.OKF_LOG_LEVEL, defaultLevel),
    pretty,
    filePath: resolveLogFilePath(env),
    logHttp: envFlag(env.OKF_LOG_HTTP, true),
    logHttpHealth: envFlag(env.OKF_LOG_HTTP_HEALTH, false),
  };
}
