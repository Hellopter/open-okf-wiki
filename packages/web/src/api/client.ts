/**
 * Shared HTTP transport for the operator Web UI.
 */

/**
 * API origin for fetch / EventSource.
 *
 * Default: **same origin** (empty string) so the UI works for any host:port
 * you open (127.0.0.1, localhost, or LAN IP). In dev, Vite proxies `/api` →
 * the local server (see vite.config.ts).
 *
 * Optional override: `VITE_API_BASE=http://host:8787` when the API is not
 * reverse-proxied on the same origin.
 */
function resolveApiBase(): string {
  const raw = (import.meta.env.VITE_API_BASE as string | undefined)?.trim();
  if (raw) {
    return raw.replace(/\/$/, "");
  }
  return "";
}

const API_BASE = resolveApiBase();

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** Test a structured error code returned by an API adapter without parsing text. */
export function hasApiErrorCode(error: unknown, code: string): boolean {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") return false;
  const details = (error.body as Record<string, unknown>).details;
  return (
    details !== null &&
    typeof details === "object" &&
    (details as Record<string, unknown>).code === code
  );
}

export function messageFromErrorBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) {
      if (record.details !== undefined) {
        const details =
          typeof record.details === "string" ? record.details : JSON.stringify(record.details);
        return `${record.error}: ${details}`;
      }
      return record.error;
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body;
  }
  return fallback;
}

/**
 * Read JSON at the transport boundary. API modules must decode this `unknown`
 * with their endpoint schema before exposing it to React.
 */
export async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/json");

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(0, `Network error: ${message}`);
  }

  const text = await response.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      messageFromErrorBody(body, `Request failed (${response.status})`),
      body,
    );
  }

  return body;
}

export function getApiBase(): string {
  return API_BASE;
}
