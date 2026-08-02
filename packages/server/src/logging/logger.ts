/**
 * Root pino logger for the localhost server process.
 * Stdout always; optional JSONL file under product home logs/.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { type ServerLogConfig, loadServerLogConfig } from "./config.ts";

const REDACT_PATHS = [
  "apiKey",
  "authorization",
  "password",
  "token",
  "*.apiKey",
  "*.authorization",
  "*.password",
  "req.headers.authorization",
] as const;

let root: Logger | null = null;
let lastConfig: ServerLogConfig | null = null;

function baseOptions(config: ServerLogConfig): LoggerOptions {
  return {
    level: config.level,
    base: { service: "okf-wiki-server" },
    redact: {
      paths: [...REDACT_PATHS],
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

function createPrettyStream(): DestinationStream | null {
  try {
    // pino-pretty is a devDependency; missing in minimal installs falls back to JSON stdout.
    const requireFromHere = createRequire(import.meta.url);
    const prettyFactory = requireFromHere("pino-pretty") as (opts: object) => DestinationStream;
    return prettyFactory({
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    });
  } catch {
    return null;
  }
}

/**
 * Create a logger from config. Prefer {@link getLogger} for process singleton.
 * File sink failures degrade to stdout-only (never throw).
 */
export function createRootLogger(config: ServerLogConfig = loadServerLogConfig()): Logger {
  const opts = baseOptions(config);
  // Level is enforced on the logger; stream entries only need destinations.
  const streams: Array<{ stream: DestinationStream | NodeJS.WritableStream }> = [];

  if (config.pretty) {
    const prettyStream = createPrettyStream();
    streams.push({ stream: prettyStream ?? process.stdout });
  } else {
    streams.push({ stream: process.stdout });
  }

  if (config.filePath) {
    try {
      mkdirSync(path.dirname(config.filePath), { recursive: true });
      const dest = createWriteStream(config.filePath, { flags: "a" });
      dest.on("error", (error) => {
        process.stderr.write(
          `okf-wiki server: log file write error (${config.filePath}): ${error.message}\n`,
        );
      });
      streams.push({ stream: dest });
    } catch (error) {
      process.stderr.write(
        `okf-wiki server: log file unavailable (${config.filePath}): ${
          error instanceof Error ? error.message : String(error)
        }; continuing with stdout only\n`,
      );
    }
  }

  if (streams.length === 1) {
    return pino(opts, streams[0]!.stream);
  }
  return pino(opts, pino.multistream(streams));
}

/** Lazy process singleton from env. */
export function getLogger(): Logger {
  if (!root) {
    lastConfig = loadServerLogConfig();
    root = createRootLogger(lastConfig);
  }
  return root;
}

/** Last loaded config (for HTTP access flags). */
export function getLogConfig(): ServerLogConfig {
  if (!lastConfig) {
    lastConfig = loadServerLogConfig();
  }
  return lastConfig;
}

/** Test seam: inject a silent or mock logger; null resets to lazy env init. */
export function setLoggerForTests(logger: Logger | null, config?: ServerLogConfig | null): void {
  root = logger;
  lastConfig = config === undefined ? (logger ? lastConfig : null) : config;
}

export function childLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}

export type { Logger };
