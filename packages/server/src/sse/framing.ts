/**
 * Shared SSE framing primitives for Server routes.
 *
 * One wire dialect for named control frames (Run / index / transcript) and one
 * data-only dialect for Session Pi events. Both share headers, Last-Event-ID
 * parsing, heartbeats, and stream lifecycle — not two competing protocols.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
export const DEFAULT_SSE_POLL_MS = 500;

/** Standard response headers for an open SSE dialog. */
export const SSE_RESPONSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/**
 * Parse a Last-Event-ID header into a safe integer cursor.
 * Rejects empty, non-decimal, and non-safe-integer values.
 */
export function parseLastEventId(
  value: string | string[] | undefined,
): number | undefined {
  const raw = Array.isArray(value) ? value.at(-1) : value;
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Open the 200 SSE response (headers only; caller writes frames). */
export function openSseResponse(res: ServerResponse): void {
  res.writeHead(200, { ...SSE_RESPONSE_HEADERS });
}

/**
 * Named-event SSE frame used by durable Run control, index, and attempt
 * transcript streams (`event:` + optional `id:` + JSON `data:`).
 */
export function writeSse(
  res: ServerResponse,
  event: string,
  payload: unknown,
  eventId?: number,
): void {
  if (res.writableEnded || res.destroyed) return;
  const id = eventId === undefined ? "" : `id: ${eventId}\n`;
  res.write(`${id}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Data-only SSE frame used by Session Pi SSE (payload already carries `kind`).
 * Distinct from named control frames — keeps Session vs Run separation.
 */
export function writeSseData(res: ServerResponse, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** Comment-line heartbeat that keeps proxies alive without a client event. */
export function writeSseHeartbeatComment(res: ServerResponse): void {
  if (!res.writableEnded && !res.destroyed) res.write(": heartbeat\n\n");
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export type SseLifecycle = {
  /** True after cleanup has run (client close or caller). */
  isClosed: () => boolean;
  /** Idempotent teardown of heartbeat + close listeners. */
  cleanup: () => void;
};

export type AttachSseLifecycleOptions = {
  /** When set with onHeartbeat, starts a recurring heartbeat timer. */
  heartbeatMs?: number;
  /** Heartbeat writer; defaults to comment-line heartbeat. */
  onHeartbeat?: (res: ServerResponse) => void;
};

/**
 * Attach request/response close handlers and optional heartbeat for an open SSE
 * stream. Does not write headers or end the response — callers own that.
 */
export function attachSseLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  options: AttachSseLifecycleOptions = {},
): SseLifecycle {
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const onHeartbeat = options.onHeartbeat ?? writeSseHeartbeatComment;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    req.off("close", onRequestClose);
    res.off("close", cleanup);
  };

  const onRequestClose = (): void => {
    // Node fires `close` for completed requests too; only tear down on abort.
    if (req.aborted || !req.complete) cleanup();
  };

  req.once("close", onRequestClose);
  res.once("close", cleanup);

  const heartbeatMs = options.heartbeatMs;
  if (heartbeatMs !== undefined && heartbeatMs > 0) {
    heartbeat = setInterval(() => onHeartbeat(res), heartbeatMs);
  }

  return {
    isClosed: () => closed,
    cleanup,
  };
}

/** End the response if the socket is still open. */
export function endSseResponse(res: ServerResponse): void {
  if (!res.writableEnded && !res.destroyed) res.end();
}
