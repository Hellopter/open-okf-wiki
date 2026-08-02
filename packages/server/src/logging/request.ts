/**
 * Per-request logging: requestId header + HTTP access lines.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";
import { getLogConfig, getLogger } from "./logger.ts";

export function newRequestId(): string {
  return randomUUID();
}

export type RequestLogContext = {
  requestId: string;
  method: string;
  path: string;
  log: Logger;
};

/**
 * Attach x-request-id and finish-time access logging.
 * Call once per request after trust/CORS gates.
 */
export function beginRequestLog(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): RequestLogContext {
  const requestId = newRequestId();
  const method = req.method ?? "GET";
  const path = pathname || "/";
  res.setHeader("x-request-id", requestId);

  const log = getLogger().child({ requestId, method, path });
  const started = Date.now();
  const config = getLogConfig();

  const onFinish = () => {
    res.removeListener("finish", onFinish);
    res.removeListener("close", onFinish);
    if (!config.logHttp) return;
    if (!config.logHttpHealth && method === "GET" && path === "/api/health") return;

    const status = res.statusCode || 0;
    const durationMs = Date.now() - started;
    const fields = {
      event: "http.request" as const,
      status,
      durationMs,
    };
    if (status >= 500) {
      log.error(fields, "request completed");
    } else if (status >= 400) {
      log.warn(fields, "request completed");
    } else {
      log.info(fields, "request completed");
    }
  };

  res.on("finish", onFinish);
  res.on("close", onFinish);

  return { requestId, method, path, log };
}

/** Log untrusted Host/Origin rejection. */
export function logHttpReject(
  log: Logger,
  reason: "host" | "origin",
  detail: string,
): void {
  log.warn({ event: "http.reject", reason, detail }, "untrusted request rejected");
}
